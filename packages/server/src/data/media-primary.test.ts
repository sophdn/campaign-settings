import type { Kysely } from 'kysely'
import { describe, expect, it } from 'vitest'
import { ForbiddenError } from '../authz/errors'
import { resolveWorldContext } from '../authz/context'
import { newId } from '../db/ids'
import { createDb } from '../db/kysely'
import { migrateToLatest } from '../db/migrator'
import type { Database } from '../db/schema'
import { withTestDatabase } from '../db/test-database'
import { createTenancy } from '../tenancy'
import { CONTENT_REPOS } from './content-repos'
import type { WorldContext } from './context'
import { createMediaAttachment, findPrimaryMedia, setPrimaryMedia } from './media'

const npcs = () => CONTENT_REPOS.npc!

async function makeAccount(db: Kysely<Database>, username: string): Promise<string> {
  const id = newId()
  await db.insertInto('accounts').values({ id, username, password_hash: 'h' }).execute()
  return id
}

async function setup(db: Kysely<Database>) {
  const tenancy = createTenancy(db)
  const dmId = await makeAccount(db, 'dm')
  const playerId = await makeAccount(db, 'rowan')
  const world = await tenancy.createWorldWithPlayer(dmId, 'W', playerId)
  const dm = (await resolveWorldContext(db, dmId, world.slug)) as WorldContext
  const player = (await resolveWorldContext(db, playerId, world.slug)) as WorldContext
  return { dm, player }
}

/** Attach an image to an owner. Bytes are irrelevant here — only the row is. */
const attach = (ctx: WorldContext, ownerId: string, name: string) =>
  createMediaAttachment(ctx, {
    owner_kind: 'npc',
    owner_id: ownerId,
    media_kind: 'image',
    file_path: `w/${name}`,
    original_filename: name,
    mime_type: 'image/png',
    byte_size: 1,
  })

describe('the primary image', () => {
  it('starts unset, so an entity with images still leads with none', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const { dm } = await setup(db)
      const npc = await npcs().create(dm, { name: 'Mira', visibility: 'public' })
      await attach(dm, npc.id, 'a.png')

      // An entity whose owner has never been asked the question has no answer.
      expect(await findPrimaryMedia(dm, 'npc', npc.id)).toBeUndefined()
    })
  })

  it('nominates one image, and moves the seat rather than refusing the second', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const { dm } = await setup(db)
      const npc = await npcs().create(dm, { name: 'Mira', visibility: 'public' })
      const a = await attach(dm, npc.id, 'a.png')
      const b = await attach(dm, npc.id, 'b.png')

      expect(await setPrimaryMedia(dm, 'npc', npc.id, a.id)).toBe(true)
      expect((await findPrimaryMedia(dm, 'npc', npc.id))?.id).toBe(a.id)

      // The partial unique index permits one primary per owner, so setting the
      // second must CLEAR the first rather than collide with it.
      expect(await setPrimaryMedia(dm, 'npc', npc.id, b.id)).toBe(true)
      expect((await findPrimaryMedia(dm, 'npc', npc.id))?.id).toBe(b.id)
    })
  })

  it('clears the primary without deleting the file', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const { dm } = await setup(db)
      const npc = await npcs().create(dm, { name: 'Mira', visibility: 'public' })
      const a = await attach(dm, npc.id, 'a.png')
      await setPrimaryMedia(dm, 'npc', npc.id, a.id)

      // An owner who decides no image should lead the page says so here; the
      // attachment stays in the gallery.
      expect(await setPrimaryMedia(dm, 'npc', npc.id, null)).toBe(true)
      expect(await findPrimaryMedia(dm, 'npc', npc.id)).toBeUndefined()
      const rows = await db
        .selectFrom('media_attachments')
        .selectAll()
        .where('id', '=', a.id)
        .execute()
      expect(rows).toHaveLength(1)
    })
  })

  it('keeps each entity’s primary its own', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const { dm } = await setup(db)
      const mira = await npcs().create(dm, { name: 'Mira', visibility: 'public' })
      const silas = await npcs().create(dm, { name: 'Silas', visibility: 'public' })
      const a = await attach(dm, mira.id, 'a.png')
      const b = await attach(dm, silas.id, 'b.png')

      await setPrimaryMedia(dm, 'npc', mira.id, a.id)
      await setPrimaryMedia(dm, 'npc', silas.id, b.id)

      // The index is per-owner, so two entities each holding one is legal.
      expect((await findPrimaryMedia(dm, 'npc', mira.id))?.id).toBe(a.id)
      expect((await findPrimaryMedia(dm, 'npc', silas.id))?.id).toBe(b.id)
    })
  })

  it('refuses an attachment belonging to another entity, the same as a missing one', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const { dm } = await setup(db)
      const mira = await npcs().create(dm, { name: 'Mira', visibility: 'public' })
      const silas = await npcs().create(dm, { name: 'Silas', visibility: 'public' })
      const theirs = await attach(dm, silas.id, 'b.png')
      await setPrimaryMedia(dm, 'npc', silas.id, theirs.id)

      // "Make this OTHER entity's photograph my portrait" has no sensible
      // outcome, so it gets the same answer an unknown id gets.
      expect(await setPrimaryMedia(dm, 'npc', mira.id, theirs.id)).toBe(false)
      expect(await setPrimaryMedia(dm, 'npc', mira.id, 'no-such-id')).toBe(false)
      expect(await findPrimaryMedia(dm, 'npc', mira.id)).toBeUndefined()
      // And the refusal happened BEFORE the clear, so the entity that does own
      // the attachment still leads with it.
      expect((await findPrimaryMedia(dm, 'npc', silas.id))?.id).toBe(theirs.id)
    })
  })

  it('refuses a player outright — hiding the control is not the enforcement', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const { dm, player } = await setup(db)
      const npc = await npcs().create(dm, { name: 'Mira', visibility: 'public' })
      const a = await attach(dm, npc.id, 'a.png')

      await expect(setPrimaryMedia(player, 'npc', npc.id, a.id)).rejects.toBeInstanceOf(
        ForbiddenError,
      )
    })
  })
})
