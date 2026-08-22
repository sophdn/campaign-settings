import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'kysely'
import type { Pool } from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { ForbiddenError } from '../authz/errors'
import { createDb } from '../db/kysely'
import { migrateToLatest } from '../db/migrator'
import { withTestDatabase } from '../db/test-database'
import { CONTENT_REPOS, ENTITY_REPOS } from './content-repos'
import type { WorldContext } from './context'
import { createMediaAttachment } from './media'
import { createPin, listPinsForMap } from './map-pins'
import { createTouch, listTouchesForSession } from './touches'
import { listTrash, purgeTrashed, restoreTrashed } from './trash'

const npcs = CONTENT_REPOS.npc!
const species = CONTENT_REPOS.species!
const maps = ENTITY_REPOS.map!
const sessions = ENTITY_REPOS.session!

/** An owner context and a player context on the same world. */
async function withWorld(
  body: (ctx: WorldContext, playerCtx: WorldContext, uploadsDir: string) => Promise<void>,
): Promise<void> {
  await withTestDatabase(async (pool: Pool) => {
    const db = createDb(pool)
    await migrateToLatest(db)
    await db
      .insertInto('accounts')
      .values([
        { id: 'acc1', username: 'dm', password_hash: 'h' },
        { id: 'acc2', username: 'player', password_hash: 'h' },
      ])
      .execute()
    await db
      .insertInto('worlds')
      .values({ id: 'w1', owner_id: 'acc1', name: 'W', slug: 'w' })
      .execute()
    await db
      .insertInto('world_members')
      .values({ world_id: 'w1', account_id: 'acc2', role: 'player' })
      .execute()
    const ctx: WorldContext = { db, worldId: 'w1', actor: { accountId: 'acc1', role: 'owner' } }
    const playerCtx: WorldContext = {
      db,
      worldId: 'w1',
      actor: { accountId: 'acc2', role: 'player' },
    }
    await body(ctx, playerCtx, await mkdtemp(join(tmpdir(), 'trash-test-')))
  })
}

describe('the trash: what is in it, and what comes back', () => {
  it('holds a deleted entity, and a restore returns it to the live list', async () => {
    await withWorld(async (ctx) => {
      const npc = await npcs.create(ctx, { name: 'The Harbourmaster' })
      expect(await listTrash(ctx)).toHaveLength(0)

      await npcs.softDelete(ctx, npc.id)
      expect(await npcs.list(ctx)).toHaveLength(0)
      expect(await listTrash(ctx)).toMatchObject([{ kind: 'npc', name: 'The Harbourmaster' }])

      expect(await restoreTrashed(ctx, 'npc', npc.id)).toBe(true)
      expect(await listTrash(ctx)).toHaveLength(0)
      expect(await npcs.list(ctx)).toMatchObject([{ name: 'The Harbourmaster' }])
    })
  })

  it('a restore brings back the row’s OWN visibility, not a safe default', async () => {
    // The failure this guards is a disclosure caused by an undo: a dm_only page
    // that came back public would put a secret on the players' wiki at exactly
    // the moment nobody was looking for it.
    await withWorld(async (ctx, playerCtx) => {
      const secret = await npcs.create(ctx, { name: 'The Prince', visibility: 'dm_only' })
      await npcs.softDelete(ctx, secret.id)
      await restoreTrashed(ctx, 'npc', secret.id)

      expect(await npcs.get(ctx, secret.id)).toMatchObject({ visibility: 'dm_only' })
      expect(await npcs.get(playerCtx, secret.id)).toBeUndefined()
    })
  })

  it('spans every content table and lists the newest deletion first', async () => {
    await withWorld(async (ctx) => {
      const npc = await npcs.create(ctx, { name: 'An NPC' })
      const map = await maps.create(ctx, { name: 'A Map' })
      const session = await sessions.create(ctx, { name: 'A Session' })

      // Deleted in a known order, each timestamp distinct.
      await npcs.softDelete(ctx, npc.id)
      await sql`select pg_sleep(0.01)`.execute(ctx.db)
      await maps.softDelete(ctx, map.id)
      await sql`select pg_sleep(0.01)`.execute(ctx.db)
      await sessions.softDelete(ctx, session.id)

      expect((await listTrash(ctx)).map((e) => e.kind)).toEqual(['session', 'map', 'npc'])
    })
  })

  it('a player has no door to the trash at all', async () => {
    await withWorld(async (ctx, playerCtx) => {
      const npc = await npcs.create(ctx, { name: 'X' })
      await npcs.softDelete(ctx, npc.id)

      await expect(listTrash(playerCtx)).rejects.toBeInstanceOf(ForbiddenError)
      await expect(restoreTrashed(playerCtx, 'npc', npc.id)).rejects.toBeInstanceOf(ForbiddenError)
      await expect(purgeTrashed(playerCtx, '/tmp', 'npc', npc.id)).rejects.toBeInstanceOf(
        ForbiddenError,
      )
      // and the refusal was not merely cosmetic
      expect(await listTrash(ctx)).toHaveLength(1)
    })
  })

  it('restoring or purging something that is not in the trash is a miss, not a success', async () => {
    await withWorld(async (ctx, _playerCtx, uploadsDir) => {
      const live = await npcs.create(ctx, { name: 'Still Here' })

      // A LIVE row: purging it must not work, or deletion would be one act
      // rather than two and a mistyped request would be permanent.
      expect(await purgeTrashed(ctx, uploadsDir, 'npc', live.id)).toBe(false)
      expect(await restoreTrashed(ctx, 'npc', live.id)).toBe(false)
      expect(await npcs.get(ctx, live.id)).toMatchObject({ name: 'Still Here' })

      // An id under the wrong kind, and an id that never existed.
      await npcs.softDelete(ctx, live.id)
      expect(await purgeTrashed(ctx, uploadsDir, 'species', live.id)).toBe(false)
      expect(await restoreTrashed(ctx, 'npc', 'no-such-id')).toBe(false)
      expect(await restoreTrashed(ctx, 'not-a-kind', live.id)).toBe(false)
      expect(await listTrash(ctx)).toHaveLength(1)
    })
  })
})

describe('purge: the row, its dependents, and nothing else', () => {
  it('clears the references other entities hold, and leaves those entities standing', async () => {
    await withWorld(async (ctx, _playerCtx, uploadsDir) => {
      const elf = await species.create(ctx, { name: 'Elf' })
      const npc = await npcs.create(ctx, { name: 'Aelin', species_id: elf.id })
      expect(await npcs.get(ctx, npc.id)).toMatchObject({ species_id: elf.id })

      await species.softDelete(ctx, elf.id)
      expect(await purgeTrashed(ctx, uploadsDir, 'species', elf.id)).toBe(true)

      // The NPC survives with its own prose intact; it simply no longer names a
      // species that no longer exists.
      expect(await npcs.get(ctx, npc.id)).toMatchObject({ name: 'Aelin', species_id: null })
      expect(await species.get(ctx, elf.id)).toBeUndefined()
    })
  })

  it('takes a map’s pins and a session’s touches with it', async () => {
    await withWorld(async (ctx, _playerCtx, uploadsDir) => {
      const map = await maps.create(ctx, { name: 'Saltmarsh' })
      const session = await sessions.create(ctx, { name: 'Session One' })
      const npc = await npcs.create(ctx, { name: 'The Harbourmaster' })
      await createPin(ctx, { map_id: map.id, entity_id: npc.id, x: 0.5, y: 0.5 })
      await createTouch(ctx, { session_id: session.id, entity_id: npc.id, touch_type: 'met' })

      await maps.softDelete(ctx, map.id)
      await sessions.softDelete(ctx, session.id)
      expect(await purgeTrashed(ctx, uploadsDir, 'map', map.id)).toBe(true)
      expect(await purgeTrashed(ctx, uploadsDir, 'session', session.id)).toBe(true)

      expect(await listPinsForMap(ctx, map.id)).toHaveLength(0)
      expect(await listTouchesForSession(ctx, session.id)).toHaveLength(0)
      // The NPC both of them pointed AT is untouched.
      expect(await npcs.get(ctx, npc.id)).toMatchObject({ name: 'The Harbourmaster' })
    })
  })

  it('removes the uploaded bytes along with the rows, so nothing outlives its entity', async () => {
    await withWorld(async (ctx, _playerCtx, uploadsDir) => {
      const npc = await npcs.create(ctx, { name: 'Aelin' })
      const dir = join(uploadsDir, 'w1', 'npc', npc.id)
      await mkdir(dir, { recursive: true })
      for (const file of ['a.png', 'a-thumb.png', 'b.png']) {
        await writeFile(join(dir, file), 'bytes')
      }
      const attach = (file: string, thumb: string | null): Promise<unknown> =>
        createMediaAttachment(ctx, {
          owner_kind: 'npc',
          owner_id: npc.id,
          media_kind: 'image',
          file_path: join('w1', 'npc', npc.id, file),
          thumbnail_path: thumb === null ? null : join('w1', 'npc', npc.id, thumb),
          original_filename: file,
          mime_type: 'image/png',
          byte_size: 5,
        })
      await attach('a.png', 'a-thumb.png')
      // A row with no thumbnail is a legal state — the importer makes them, and
      // so does an upload whose thumbnail request never arrived. Its source
      // bytes still have to go.
      await attach('b.png', null)

      await npcs.softDelete(ctx, npc.id)
      expect(await purgeTrashed(ctx, uploadsDir, 'npc', npc.id)).toBe(true)

      expect(await readdir(dir)).toEqual([])
      const rows = await ctx.db
        .selectFrom('media_attachments')
        .selectAll()
        .where('owner_id', '=', npc.id)
        .execute()
      expect(rows).toHaveLength(0)
    })
  })

  it('a kind that is not a kind at all is a miss at both doors', async () => {
    await withWorld(async (ctx, _playerCtx, uploadsDir) => {
      expect(await purgeTrashed(ctx, uploadsDir, 'not-a-kind', 'whatever')).toBe(false)
      expect(await restoreTrashed(ctx, 'not-a-kind', 'whatever')).toBe(false)
    })
  })

  it('a real failure propagates rather than being reported as “not in the trash”', async () => {
    // The purge transaction distinguishes its own rollback signal from every
    // other error. Collapsing the two would turn a database outage into a
    // silent 404, and the owner would be told their entity was already gone.
    await withWorld(async (ctx, _playerCtx, uploadsDir) => {
      const npc = await npcs.create(ctx, { name: 'Aelin' })
      await npcs.softDelete(ctx, npc.id)
      const boom = vi
        .spyOn(ENTITY_REPOS.npc!, 'purge')
        .mockRejectedValue(new Error('connection terminated'))
      try {
        await expect(purgeTrashed(ctx, uploadsDir, 'npc', npc.id)).rejects.toThrow(
          'connection terminated',
        )
      } finally {
        boom.mockRestore()
      }
      // and the rollback held: the row is still there to try again on
      expect(await listTrash(ctx)).toHaveLength(1)
    })
  })

  it('one world cannot purge or restore another world’s trash', async () => {
    await withWorld(async (ctx, _playerCtx, uploadsDir) => {
      const npc = await npcs.create(ctx, { name: 'Mine' })
      await npcs.softDelete(ctx, npc.id)
      const otherWorld: WorldContext = { ...ctx, worldId: 'w-other' }

      expect(await purgeTrashed(otherWorld, uploadsDir, 'npc', npc.id)).toBe(false)
      expect(await restoreTrashed(otherWorld, 'npc', npc.id)).toBe(false)
      expect(await listTrash(ctx)).toHaveLength(1)
    })
  })
})

describe('the blocking-reference list is checked against the real schema', () => {
  /**
   * `purgeTrashed` clears a hand-written list of columns that point at
   * `entities.id` with neither a cascade nor a set-null, because Postgres
   * refuses to delete a row any of them still names.
   *
   * A hand-written list of schema facts is exactly the thing that rots: the
   * next migration to add such a column would turn every purge of that kind
   * into a foreign-key 500, and nothing in the feature would notice. So the
   * list is not trusted — it is compared against what the database actually
   * reports, and this test is what makes the migration author's problem
   * visible at the moment they cause it.
   */
  it('knows about every reference that would block a delete, and no others', async () => {
    await withTestDatabase(async (pool: Pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const blocking = await sql<{ table_name: string; column_name: string }>`
        select kcu.table_name, kcu.column_name
          from information_schema.table_constraints tc
          join information_schema.key_column_usage kcu
            on kcu.constraint_name = tc.constraint_name
          join information_schema.constraint_column_usage ccu
            on ccu.constraint_name = tc.constraint_name
          join information_schema.referential_constraints rc
            on rc.constraint_name = tc.constraint_name
         where tc.constraint_type = 'FOREIGN KEY'
           and ccu.table_name = 'entities'
           and rc.delete_rule = 'NO ACTION'
         order by kcu.table_name, kcu.column_name
      `.execute(db)

      expect(blocking.rows.map((r) => `${r.table_name}.${r.column_name}`)).toEqual([
        'currency_details.base_rate_to',
        'npc_details.culture_id',
        'npc_details.species_id',
        'pc_details.species_id',
        'settlement_details.culture_id',
      ])
    })
  })
})
