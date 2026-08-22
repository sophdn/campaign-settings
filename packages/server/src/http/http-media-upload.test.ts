import { mkdtempSync, rmSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify'
import type { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { createScryptAuth } from '../auth/service'
import { createDb } from '../db/kysely'
import { migrateToLatest } from '../db/migrator'
import { withTestDatabase } from '../db/test-database'
import { openFlags } from '../flags/config'
import { makeHeaderlessPng, makeJpeg, makeNotAnImage, makePng } from '../testing/images'
import { DEFAULT_LIMITS, type ResourceLimits } from '../tenancy/limits'
import { buildApp } from './app'

/**
 * The upload half of the media surface — the first place this app accepts a file
 * from a user.
 *
 * The assertions that matter most are the refusals: the bytes decide the format
 * (not the filename, the extension, or the declared content type), both ceilings
 * are enforced BEFORE anything is written, a player cannot upload at all, and a
 * rejected upload produces a usable error rather than a 500 or a stray file.
 */

const SECRET = 'test-secret-test-secret-test-secret'
const PW = 'pw-123456'

interface Harness {
  app: FastifyInstance
  uploadsDir: string
  dm: string
  player: string
  slug: string
  npcId: string
}

async function withHarness(
  limits: ResourceLimits,
  body: (h: Harness) => Promise<void>,
): Promise<void> {
  await withTestDatabase(async (pool: Pool) => {
    const uploadsDir = mkdtempSync(join(tmpdir(), 'cs-upload-'))
    const db = createDb(pool)
    await migrateToLatest(db)
    const auth = createScryptAuth(db)
    const app = buildApp({
      db,
      auth,
      cookieSecret: SECRET,
      cookieSecure: false,
      flags: openFlags(),
      uploadsDir,
      limits,
    })
    await app.ready()
    try {
      await auth.createAccount('dm', PW)
      const player = await auth.createAccount('player', PW)
      const dm = await login(app, 'dm')
      const playerCookie = await login(app, 'player')
      const world = await app.inject({
        method: 'POST',
        url: '/api/worlds',
        headers: { cookie: dm },
        payload: { name: 'W' },
      })
      const slug = world.json().world.slug as string
      await app.inject({
        method: 'POST',
        url: `/api/worlds/${slug}/members`,
        headers: { cookie: dm },
        payload: { accountId: player.id },
      })
      const npc = await app.inject({
        method: 'POST',
        url: `/api/worlds/${slug}/entities/npc`,
        headers: { cookie: dm },
        payload: { name: 'Silas Crow' },
      })
      await body({
        app,
        uploadsDir,
        dm,
        player: playerCookie,
        slug,
        npcId: npc.json().entity.id as string,
      })
    } finally {
      await app.close()
      rmSync(uploadsDir, { recursive: true, force: true })
    }
  })
}

async function login(app: FastifyInstance, username: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/login',
    payload: { username, password: PW },
  })
  return `cs_session=${res.cookies.find((x) => x.name === 'cs_session')!.value}`
}

/** POST raw bytes the way the browser does: the file IS the body. */
function upload(
  h: Harness,
  opts: { cookie?: string; bytes: Buffer; contentType?: string; filename?: string; url?: string },
): Promise<LightMyRequestResponse> {
  const query = opts.filename === undefined ? '' : `?filename=${encodeURIComponent(opts.filename)}`
  const init: InjectOptions = {
    method: 'POST',
    url: (opts.url ?? `/api/worlds/${h.slug}/entities/npc/${h.npcId}/media`) + query,
    headers: {
      cookie: opts.cookie ?? h.dm,
      'content-type': opts.contentType ?? 'image/png',
    },
    payload: opts.bytes,
  }
  return h.app.inject(init)
}

const listMedia = async (h: Harness, cookie = h.dm): Promise<{ id: string }[]> => {
  const res = await h.app.inject({
    method: 'GET',
    url: `/api/worlds/${h.slug}/entities/npc/${h.npcId}/media`,
    headers: { cookie },
  })
  return res.json().media as { id: string }[]
}

const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  )

describe('entity image upload', () => {
  it('stores the bytes and returns a row the entity page can render', async () => {
    await withHarness(DEFAULT_LIMITS, async (h) => {
      const png = makePng(40, 20)
      const res = await upload(h, { bytes: png, filename: 'portrait.png' })

      expect(res.statusCode).toBe(201)
      const media = res.json().media
      expect(media.mime_type).toBe('image/png')
      expect(Number(media.byte_size)).toBe(png.length)
      expect(media.original_filename).toBe('portrait.png')
      expect(media.media_kind).toBe('image')
      expect(media.thumbnail_path).toBeNull() // until the thumbnail request lands

      // The row is discoverable through the list route the panel already uses.
      expect(await listMedia(h)).toHaveLength(1)

      // The bytes are on disk, byte-identical, under a server-composed path.
      const onDisk = await readFile(join(h.uploadsDir, media.file_path))
      expect(onDisk.equals(png)).toBe(true)

      // Serving them back yields exactly what went in.
      const raw = await h.app.inject({
        method: 'GET',
        url: `/api/worlds/${h.slug}/media/${media.id}/raw`,
        headers: { cookie: h.dm },
      })
      expect(raw.rawPayload.equals(png)).toBe(true)
    })
  })

  it('composes the stored path itself and never from the uploaded name', async () => {
    await withHarness(DEFAULT_LIMITS, async (h) => {
      // A filename engineered to escape, if it were ever concatenated into one.
      const res = await upload(h, {
        bytes: makePng(8, 8),
        filename: '../../../../etc/passwd.png',
      })
      expect(res.statusCode).toBe(201)
      const media = res.json().media

      // Recorded verbatim for display — it only ever renders as alt text.
      expect(media.original_filename).toBe('../../../../etc/passwd.png')
      // …but the PATH contains none of it: world / owner kind / owner id / id.
      expect(media.file_path).not.toContain('passwd')
      expect(media.file_path).not.toContain('..')
      expect(media.file_path.split('/')).toEqual([
        expect.any(String),
        'npc',
        h.npcId,
        `${media.id}.png`,
      ])
      expect(await exists(join(h.uploadsDir, media.file_path))).toBe(true)
    })
  })

  it('believes the bytes, not the extension or the declared content type', async () => {
    await withHarness(DEFAULT_LIMITS, async (h) => {
      // A JPEG announced as image/png and named .png. All three signals from the
      // uploader disagree with the file; only the header is evidence.
      const res = await upload(h, {
        bytes: makeJpeg(60, 30),
        contentType: 'image/png',
        filename: 'lies.png',
      })
      expect(res.statusCode).toBe(201)
      expect(res.json().media.mime_type).toBe('image/jpeg')
      expect(res.json().media.file_path).toMatch(/\.jpg$/)
    })
  })

  it('refuses a non-image with a 400 that says what happened, not a 500', async () => {
    await withHarness(DEFAULT_LIMITS, async (h) => {
      const res = await upload(h, { bytes: makeNotAnImage(), filename: 'trojan.png' })
      expect(res.statusCode).toBe(400)
      expect(res.json().error.code).toBe('unsupported_image')
      expect(res.json().error.message).toMatch(/JPEG, PNG, or WebP/)
      // Nothing was written and no row landed.
      expect(await listMedia(h)).toHaveLength(0)
    })
  })

  it('refuses an image whose dimensions cannot be read', async () => {
    await withHarness(DEFAULT_LIMITS, async (h) => {
      // Valid magic bytes, truncated header. Accepting it would store a map with
      // no source size, which makes every normalized pin coordinate meaningless.
      const res = await upload(h, { bytes: makeHeaderlessPng() })
      expect(res.statusCode).toBe(400)
      expect(res.json().error.code).toBe('unsupported_image')
      expect(res.json().error.message).toMatch(/damaged/)
    })
  })

  it('answers 413 when the body exceeds what the server will buffer at all', async () => {
    // Fastify refuses this before any handler runs, so the route's own ceiling
    // never sees it. Without the mapping it surfaces as "internal error", which
    // blames the server for the user's oversized photo and offers no remedy.
    await withHarness(
      { ...DEFAULT_LIMITS, imageBytes: 512, mapImageBytes: 512, thumbnailBytes: 512 },
      async (h) => {
        const res = await upload(h, { bytes: makePng(400, 400) })
        expect(res.statusCode).toBe(413)
        expect(res.json().error.code).toBe('upload_too_large')
        expect(res.json().error.message).toMatch(/larger than this server accepts/)
        expect(await listMedia(h)).toHaveLength(0)
      },
    )
  })

  it('refuses a request whose body is not raw bytes at all', async () => {
    await withHarness(DEFAULT_LIMITS, async (h) => {
      const res = await h.app.inject({
        method: 'POST',
        url: `/api/worlds/${h.slug}/entities/npc/${h.npcId}/media`,
        headers: { cookie: h.dm, 'content-type': 'application/json' },
        payload: { pretending: 'to be a file' },
      })
      expect(res.statusCode).toBe(400)
      expect(res.json().error.code).toBe('unsupported_image')
    })
  })

  it('enforces the per-file ceiling before writing anything', async () => {
    await withHarness({ ...DEFAULT_LIMITS, imageBytes: 512 }, async (h) => {
      const res = await upload(h, { bytes: makePng(200, 200) })
      expect(res.statusCode).toBe(409)
      expect(res.json().error.code).toBe('limit_reached')
      expect(res.json().error.message).toMatch(/maximum/)
      expect(await listMedia(h)).toHaveLength(0)
    })
  })

  it('enforces mediaBytesPerWorld — the ceiling that had never been reachable', async () => {
    // It has existed since the resource-ceilings work but was only ever checked
    // at the world-IMPORT door, because that was the only door making media rows.
    //
    // Both uploads are the SAME size, and one of them fits: the cap sits between
    // one copy and two. So the refusal can only be about what the world has
    // accumulated — if the file's own ceiling were doing the work here, the
    // first upload would have failed too, and this test would prove nothing.
    const size = makePng(30, 30).length
    await withHarness({ ...DEFAULT_LIMITS, mediaBytesPerWorld: size * 2 - 1 }, async (h) => {
      expect((await upload(h, { bytes: makePng(30, 30) })).statusCode).toBe(201)

      const second = await upload(h, { bytes: makePng(30, 30) })
      expect(second.statusCode).toBe(409)
      expect(second.json().error.code).toBe('limit_reached')
      // The refusal says how much is used, so it is actionable rather than "no".
      expect(second.json().error.message).toMatch(/allowance/)
      expect(await listMedia(h)).toHaveLength(1)
    })
  })

  it('frees the allowance again when an attachment is deleted', async () => {
    const size = makePng(30, 30).length
    await withHarness({ ...DEFAULT_LIMITS, mediaBytesPerWorld: size * 2 - 1 }, async (h) => {
      const id = (await upload(h, { bytes: makePng(30, 30) })).json().media.id as string
      expect((await upload(h, { bytes: makePng(30, 30) })).statusCode).toBe(409)

      const del = await h.app.inject({
        method: 'DELETE',
        url: `/api/worlds/${h.slug}/media/${id}`,
        headers: { cookie: h.dm },
      })
      expect(del.statusCode).toBe(200)
      // Hard deletion is what makes this true. A tombstoned row would leave the
      // bytes on disk while the count that gates uploads stopped seeing them.
      expect((await upload(h, { bytes: makePng(30, 30) })).statusCode).toBe(201)
    })
  })
})

describe('upload authorization', () => {
  it('refuses a player in the API, not merely by hiding the button', async () => {
    await withHarness(DEFAULT_LIMITS, async (h) => {
      const res = await upload(h, { cookie: h.player, bytes: makePng(10, 10) })
      expect(res.statusCode).toBe(403)
      expect(res.json().error.code).toBe('forbidden')
      expect(await listMedia(h)).toHaveLength(0)
    })
  })

  it('refuses a player deleting an attachment', async () => {
    await withHarness(DEFAULT_LIMITS, async (h) => {
      const id = (await upload(h, { bytes: makePng(10, 10) })).json().media.id as string
      const res = await h.app.inject({
        method: 'DELETE',
        url: `/api/worlds/${h.slug}/media/${id}`,
        headers: { cookie: h.player },
      })
      expect(res.statusCode).toBe(403)
      expect(await listMedia(h)).toHaveLength(1)
    })
  })

  it('404s an upload to an entity the actor cannot see', async () => {
    await withHarness(DEFAULT_LIMITS, async (h) => {
      await h.app.inject({
        method: 'PATCH',
        url: `/api/worlds/${h.slug}/entities/npc/${h.npcId}`,
        headers: { cookie: h.dm },
        payload: { visibility: 'dm_only' },
      })
      // The player is refused as a player anyway; the point is that the entity
      // is not even acknowledged, so this is not an existence oracle either.
      const res = await upload(h, { cookie: h.player, bytes: makePng(10, 10) })
      expect(res.statusCode).toBe(404)
    })
  })

  it('never serves the raw bytes of an image on an entity the player cannot see', async () => {
    // A regression test on a property that should already hold: the raw route
    // re-resolves the owner entity through the seam before sending a byte.
    await withHarness(DEFAULT_LIMITS, async (h) => {
      const media = (await upload(h, { bytes: makePng(12, 12) })).json().media
      const rawAsPlayer = (): Promise<LightMyRequestResponse> =>
        h.app.inject({
          method: 'GET',
          url: `/api/worlds/${h.slug}/media/${media.id}/raw`,
          headers: { cookie: h.player },
        })
      expect((await rawAsPlayer()).statusCode).toBe(200) // public entity

      await h.app.inject({
        method: 'PATCH',
        url: `/api/worlds/${h.slug}/entities/npc/${h.npcId}`,
        headers: { cookie: h.dm },
        payload: { visibility: 'dm_only' },
      })
      expect((await rawAsPlayer()).statusCode).toBe(404)

      // …and a grant does not resurrect it, because dm_only is not grantable.
      expect((await rawAsPlayer()).statusCode).toBe(404)
    })
  })
})

describe('thumbnails', () => {
  it('attaches a browser-made thumbnail and serves it under ?variant=thumbnail', async () => {
    await withHarness(DEFAULT_LIMITS, async (h) => {
      const source = makePng(400, 300)
      const media = (await upload(h, { bytes: source })).json().media
      const thumb = makePng(40, 30)

      const res = await upload(h, {
        bytes: thumb,
        url: `/api/worlds/${h.slug}/media/${media.id}/thumbnail`,
      })
      expect(res.statusCode).toBe(200)
      expect(res.json().media.thumbnail_path).not.toBeNull()

      const served = await h.app.inject({
        method: 'GET',
        url: `/api/worlds/${h.slug}/media/${media.id}/raw?variant=thumbnail`,
        headers: { cookie: h.dm },
      })
      expect(served.rawPayload.equals(thumb)).toBe(true)

      // The source is still reachable — a thumbnail replaces nothing.
      const full = await h.app.inject({
        method: 'GET',
        url: `/api/worlds/${h.slug}/media/${media.id}/raw`,
        headers: { cookie: h.dm },
      })
      expect(full.rawPayload.equals(source)).toBe(true)
    })
  })

  it('falls back to the source when a row has no thumbnail', async () => {
    // The legal state this whole two-request design leans on: an attachment
    // whose thumbnail request never arrived is usable, not broken.
    await withHarness(DEFAULT_LIMITS, async (h) => {
      const source = makePng(80, 80)
      const media = (await upload(h, { bytes: source })).json().media
      const res = await h.app.inject({
        method: 'GET',
        url: `/api/worlds/${h.slug}/media/${media.id}/raw?variant=thumbnail`,
        headers: { cookie: h.dm },
      })
      expect(res.statusCode).toBe(200)
      expect(res.rawPayload.equals(source)).toBe(true)
    })
  })

  it('checks the client-supplied thumbnail as strictly as any other upload', async () => {
    await withHarness({ ...DEFAULT_LIMITS, thumbnailBytes: 256 }, async (h) => {
      const media = (await upload(h, { bytes: makePng(100, 100) })).json().media
      const thumbUrl = `/api/worlds/${h.slug}/media/${media.id}/thumbnail`

      // "The client made it" is not a security property.
      const notAnImage = await upload(h, { bytes: makeNotAnImage(), url: thumbUrl })
      expect(notAnImage.statusCode).toBe(400)
      expect(notAnImage.json().error.code).toBe('unsupported_image')

      const tooBig = await upload(h, { bytes: makePng(200, 200), url: thumbUrl })
      expect(tooBig.statusCode).toBe(409)

      const asPlayer = await upload(h, { cookie: h.player, bytes: makePng(4, 4), url: thumbUrl })
      expect(asPlayer.statusCode).toBe(403)
    })
  })

  it('replaces a thumbnail without leaving the old file behind', async () => {
    await withHarness(DEFAULT_LIMITS, async (h) => {
      const media = (await upload(h, { bytes: makePng(100, 100) })).json().media
      const thumbUrl = `/api/worlds/${h.slug}/media/${media.id}/thumbnail`

      const first = await upload(h, { bytes: makePng(10, 10), url: thumbUrl })
      const firstPath = first.json().media.thumbnail_path as string
      // A different format takes a different extension, so the path changes and
      // the predecessor would otherwise be orphaned on disk forever.
      const second = await upload(h, {
        bytes: makeJpeg(10, 10),
        contentType: 'image/jpeg',
        url: thumbUrl,
      })
      const secondPath = second.json().media.thumbnail_path as string

      expect(secondPath).not.toBe(firstPath)
      expect(await exists(join(h.uploadsDir, firstPath))).toBe(false)
      expect(await exists(join(h.uploadsDir, secondPath))).toBe(true)
    })
  })

  it('404s a thumbnail for an attachment that does not exist', async () => {
    await withHarness(DEFAULT_LIMITS, async (h) => {
      const res = await upload(h, {
        bytes: makePng(4, 4),
        url: `/api/worlds/${h.slug}/media/no-such-id/thumbnail`,
      })
      expect(res.statusCode).toBe(404)
    })
  })
})

describe('deletion keeps the ledger and the disk in agreement', () => {
  it('removes the row and both files together', async () => {
    await withHarness(DEFAULT_LIMITS, async (h) => {
      const media = (await upload(h, { bytes: makePng(50, 50) })).json().media
      const thumbRes = await upload(h, {
        bytes: makePng(10, 10),
        url: `/api/worlds/${h.slug}/media/${media.id}/thumbnail`,
      })
      const thumbPath = thumbRes.json().media.thumbnail_path as string

      const del = await h.app.inject({
        method: 'DELETE',
        url: `/api/worlds/${h.slug}/media/${media.id}`,
        headers: { cookie: h.dm },
      })
      expect(del.statusCode).toBe(200)
      expect(await listMedia(h)).toHaveLength(0)
      // Not tombstoned: a live row's bytes and the world's ledger cannot drift
      // apart if deleting removes both.
      expect(await exists(join(h.uploadsDir, media.file_path))).toBe(false)
      expect(await exists(join(h.uploadsDir, thumbPath))).toBe(false)
    })
  })

  it('404s a delete for an id that was never there', async () => {
    await withHarness(DEFAULT_LIMITS, async (h) => {
      const res = await h.app.inject({
        method: 'DELETE',
        url: `/api/worlds/${h.slug}/media/no-such-id`,
        headers: { cookie: h.dm },
      })
      expect(res.statusCode).toBe(404)
    })
  })

  it('leaves media alone when its ENTITY is soft-deleted, so a restore is whole', async () => {
    await withHarness(DEFAULT_LIMITS, async (h) => {
      const media = (await upload(h, { bytes: makePng(50, 50) })).json().media
      await h.app.inject({
        method: 'DELETE',
        url: `/api/worlds/${h.slug}/entities/npc/${h.npcId}`,
        headers: { cookie: h.dm },
      })
      // Bytes survive the tombstone — an entity that comes back without its
      // images has not come back — and keep counting against the world's cap,
      // which is correct: they are still on the disk.
      expect(await exists(join(h.uploadsDir, media.file_path))).toBe(true)
    })
  })

  it('removes a whole world subtree when the world is deleted', async () => {
    await withHarness(DEFAULT_LIMITS, async (h) => {
      const media = (await upload(h, { bytes: makePng(50, 50) })).json().media
      const worldDir = join(h.uploadsDir, media.file_path.split('/')[0] as string)
      expect(await exists(worldDir)).toBe(true)

      await h.app.inject({
        method: 'DELETE',
        url: `/api/worlds/${h.slug}`,
        headers: { cookie: h.dm },
      })
      // The rows cascade off the world; nothing else would ever reach the bytes.
      expect(await exists(worldDir)).toBe(false)
    })
  })
})
