import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import type { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { createScryptAuth } from '../auth/service'
import type { WorldContext } from '../data/context'
import { createMediaAttachment, resolveUploadsDir } from '../data/media'
import { createDb } from '../db/kysely'
import { migrateToLatest } from '../db/migrator'
import { openFlags } from '../flags/config'
import { withTestDatabase } from '../db/test-database'
import { buildApp } from './app'

const SECRET = 'test-secret-test-secret-test-secret'
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) // PNG magic

async function login(app: FastifyInstance, username: string, password: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/login',
    payload: { username, password },
  })
  return `cs_session=${res.cookies.find((x) => x.name === 'cs_session')!.value}`
}

describe('media routes', () => {
  it('lists + serves entity media, gated by owner-entity visibility', async () => {
    await withTestDatabase(async (pool: Pool) => {
      const uploadsDir = mkdtempSync(join(tmpdir(), 'cs-uploads-'))
      const db = createDb(pool)
      await migrateToLatest(db)
      const auth = createScryptAuth(db)
      const app = buildApp({
        db,
        auth,
        cookieSecret: SECRET,
        cookieSecure: false,
        // This suite's subject is the flow, not the access gate — flags ship
        // fail-closed, and restating the policy in every setup is how setups
        // drift from the real defaults. The gate has its own suite.
        flags: openFlags(),
        uploadsDir,
      })
      await app.ready()
      try {
        await auth.createAccount('dm', 'pw-123456')
        const player = await auth.createAccount('player', 'pw-123456')
        const dm = await login(app, 'dm', 'pw-123456')
        const playerCookie = await login(app, 'player', 'pw-123456')

        const created = await app.inject({
          method: 'POST',
          url: '/api/worlds',
          headers: { cookie: dm },
          payload: { name: 'W' },
        })
        const slug = created.json().world.slug as string
        const worldId = created.json().world.id as string
        await app.inject({
          method: 'POST',
          url: `/api/worlds/${slug}/members`,
          headers: { cookie: dm },
          payload: { accountId: player.id },
        })

        // a location, plus an image attached to it (bytes staged under uploads root)
        const loc = await app.inject({
          method: 'POST',
          url: `/api/worlds/${slug}/entities/location`,
          headers: { cookie: dm },
          payload: { name: 'The Wilds' },
        })
        const locId = loc.json().entity.id as string
        const dmAccount = await db
          .selectFrom('accounts')
          .select('id')
          .where('username', '=', 'dm')
          .executeTakeFirstOrThrow()
        const ctx: WorldContext = { db, worldId, actor: { accountId: dmAccount.id, role: 'owner' } }
        await mkdir(join(uploadsDir, 'w'), { recursive: true })
        await writeFile(join(uploadsDir, 'w', 'pic.png'), PNG)
        const media = await createMediaAttachment(ctx, {
          owner_kind: 'location',
          owner_id: locId,
          media_kind: 'image',
          file_path: join('w', 'pic.png'),
          original_filename: 'pic.png',
          mime_type: 'image/png',
          byte_size: PNG.length,
        })

        // list: owner and player (public entity) both see it
        const list = await app.inject({
          method: 'GET',
          url: `/api/worlds/${slug}/entities/location/${locId}/media`,
          headers: { cookie: dm },
        })
        expect(list.statusCode).toBe(200)
        expect(list.json().media).toHaveLength(1)
        expect(list.json().media[0].original_filename).toBe('pic.png')

        // raw: streams the exact bytes with the stored mime
        const raw = await app.inject({
          method: 'GET',
          url: `/api/worlds/${slug}/media/${media.id}/raw`,
          headers: { cookie: dm },
        })
        expect(raw.statusCode).toBe(200)
        expect(raw.headers['content-type']).toContain('image/png')
        expect(raw.rawPayload.equals(PNG)).toBe(true)

        // hide the location from players → media list + raw both 404 for the player
        await app.inject({
          method: 'PATCH',
          url: `/api/worlds/${slug}/entities/location/${locId}`,
          headers: { cookie: dm },
          payload: { visibility: 'dm_only' },
        })
        const pList = await app.inject({
          method: 'GET',
          url: `/api/worlds/${slug}/entities/location/${locId}/media`,
          headers: { cookie: playerCookie },
        })
        expect(pList.statusCode).toBe(404)
        const pRaw = await app.inject({
          method: 'GET',
          url: `/api/worlds/${slug}/media/${media.id}/raw`,
          headers: { cookie: playerCookie },
        })
        expect(pRaw.statusCode).toBe(404)
        // owner still sees it
        expect(
          (
            await app.inject({
              method: 'GET',
              url: `/api/worlds/${slug}/media/${media.id}/raw`,
              headers: { cookie: dm },
            })
          ).statusCode,
        ).toBe(200)

        // raw route 404s on: unknown media id, a row whose file is missing on
        // disk, and a file_path that escapes the uploads root (path traversal).
        const rawGet = (id: string): Promise<{ statusCode: number }> =>
          app.inject({
            method: 'GET',
            url: `/api/worlds/${slug}/media/${id}/raw`,
            headers: { cookie: dm },
          })
        expect((await rawGet('no-such-media')).statusCode).toBe(404)
        const ghost = await createMediaAttachment(ctx, {
          owner_kind: 'location',
          owner_id: locId,
          media_kind: 'image',
          file_path: join('w', 'ghost.png'), // no file written here
          thumbnail_path: join('w', 'thumb.png'), // exercises the non-null thumbnail path
          original_filename: 'ghost.png',
          mime_type: 'image/png',
          byte_size: 1,
        })
        expect((await rawGet(ghost.id)).statusCode).toBe(404)
        const escape = await createMediaAttachment(ctx, {
          owner_kind: 'location',
          owner_id: locId,
          media_kind: 'image',
          file_path: join('..', '..', 'escape.png'),
          original_filename: 'escape.png',
          mime_type: 'image/png',
          byte_size: 1,
        })
        expect((await rawGet(escape.id)).statusCode).toBe(404)
      } finally {
        await app.close()
        rmSync(uploadsDir, { recursive: true, force: true })
      }
    })
  })
})

describe('resolveUploadsDir', () => {
  it('prefers the configured dir, then $UPLOADS_DIR, then the packaged default', () => {
    expect(resolveUploadsDir('/tmp/configured')).toBe('/tmp/configured')
    const prev = process.env.UPLOADS_DIR
    try {
      process.env.UPLOADS_DIR = '/tmp/from-env'
      expect(resolveUploadsDir()).toBe('/tmp/from-env')
      delete process.env.UPLOADS_DIR
      expect(resolveUploadsDir()).toContain('.uploads')
    } finally {
      if (prev === undefined) delete process.env.UPLOADS_DIR
      else process.env.UPLOADS_DIR = prev
    }
  })
})
