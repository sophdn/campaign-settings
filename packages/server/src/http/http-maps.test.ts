import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify'
import type { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { createScryptAuth } from '../auth/service'
import { grantEntityVisibility } from '../data/entity-visibility'
import { createDb } from '../db/kysely'
import { migrateToLatest } from '../db/migrator'
import { withTestDatabase } from '../db/test-database'
import { openFlags } from '../flags/config'
import { makePng } from '../testing/images'
import { buildApp } from './app'

/**
 * Maps, their images, and their pins.
 *
 * The assertion this suite exists for is the last describe block: a pin names an
 * entity, and a map a player MAY see can carry a pin pointing at one they may
 * NOT. The content seam has no opinion about that on its own — a pin's owner is
 * the map — so the filter is explicit, and so is its test.
 */

const SECRET = 'test-secret-test-secret-test-secret'
const PW = 'pw-123456'

interface Harness {
  app: FastifyInstance
  slug: string
  dm: string
  /** A member with a grant on the `restricted` NPC. */
  granted: string
  grantedId: string
  /** A member with no grants at all. */
  ungranted: string
  publicNpc: string
  dmOnlyNpc: string
  restrictedNpc: string
  mapId: string
}

async function withHarness(body: (h: Harness) => Promise<void>): Promise<void> {
  await withTestDatabase(async (pool: Pool) => {
    const uploadsDir = mkdtempSync(join(tmpdir(), 'cs-maps-'))
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
    })
    await app.ready()
    try {
      const dmAccount = await auth.createAccount('dm', PW)
      const grantedAccount = await auth.createAccount('granted', PW)
      const ungrantedAccount = await auth.createAccount('ungranted', PW)
      const dm = await login(app, 'dm')

      const world = await app.inject({
        method: 'POST',
        url: '/api/worlds',
        headers: { cookie: dm },
        payload: { name: 'W' },
      })
      const slug = world.json().world.slug as string
      const worldId = world.json().world.id as string
      for (const account of [grantedAccount, ungrantedAccount]) {
        await app.inject({
          method: 'POST',
          url: `/api/worlds/${slug}/members`,
          headers: { cookie: dm },
          payload: { accountId: account.id },
        })
      }

      const npc = async (name: string, visibility: string): Promise<string> => {
        const res = await app.inject({
          method: 'POST',
          url: `/api/worlds/${slug}/entities/npc`,
          headers: { cookie: dm },
          payload: { name, visibility },
        })
        return res.json().entity.id as string
      }
      const publicNpc = await npc('The Harbourmaster', 'public')
      const dmOnlyNpc = await npc('The Hollow Man', 'dm_only')
      const restrictedNpc = await npc('Silas Crow', 'restricted')
      await grantEntityVisibility(
        { db, worldId, actor: { accountId: dmAccount.id, role: 'owner' } },
        restrictedNpc,
        grantedAccount.id,
      )

      const map = await app.inject({
        method: 'POST',
        url: `/api/worlds/${slug}/maps`,
        headers: { cookie: dm },
        payload: { name: 'Saltmarsh', visibility: 'public' },
      })

      await body({
        app,
        slug,
        dm,
        granted: await login(app, 'granted'),
        grantedId: grantedAccount.id,
        ungranted: await login(app, 'ungranted'),
        publicNpc,
        dmOnlyNpc,
        restrictedNpc,
        mapId: map.json().map.id as string,
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

const get = (h: Harness, url: string, cookie: string): Promise<LightMyRequestResponse> =>
  h.app.inject({ method: 'GET', url: `/api/worlds/${h.slug}${url}`, headers: { cookie } })

const send = (
  h: Harness,
  method: 'POST' | 'PATCH' | 'DELETE',
  url: string,
  cookie: string,
  payload?: Record<string, unknown>,
): Promise<LightMyRequestResponse> => {
  const init: InjectOptions = {
    method,
    url: `/api/worlds/${h.slug}${url}`,
    headers: { cookie },
  }
  if (payload !== undefined) init.payload = payload
  return h.app.inject(init)
}

const pin = (
  h: Harness,
  cookie: string,
  entityId: string,
  over: Record<string, unknown> = {},
): Promise<LightMyRequestResponse> =>
  send(h, 'POST', `/maps/${h.mapId}/pins`, cookie, {
    kind: 'npc',
    entityId,
    x: 0.5,
    y: 0.5,
    ...over,
  })

describe('map CRUD', () => {
  it('creates, reads, lists, renames and removes a map', async () => {
    await withHarness(async (h) => {
      const created = await send(h, 'POST', '/maps', h.dm, {
        name: 'The North',
        description: 'Everything above the pass.',
      })
      expect(created.statusCode).toBe(201)
      const id = created.json().map.id as string
      expect(created.json().map.visibility).toBe('public') // the column's default

      const read = await get(h, `/maps/${id}`, h.dm)
      expect(read.json().map.name).toBe('The North')
      // The image travels with the map: a viewer cannot draw without both.
      expect(read.json().image).toBeNull()

      const list = await get(h, '/maps', h.dm)
      expect((list.json().maps as { name: string }[]).map((m) => m.name).sort()).toEqual([
        'Saltmarsh',
        'The North',
      ])

      const renamed = await send(h, 'PATCH', `/maps/${id}`, h.dm, { name: 'The Frozen North' })
      expect(renamed.json().map.name).toBe('The Frozen North')

      expect((await send(h, 'DELETE', `/maps/${id}`, h.dm)).statusCode).toBe(200)
      expect((await get(h, `/maps/${id}`, h.dm)).statusCode).toBe(404)
      expect((await get(h, '/maps', h.dm)).json().maps).toHaveLength(1)
    })
  })

  it('404s an unknown map rather than reporting an empty one', async () => {
    await withHarness(async (h) => {
      expect((await get(h, '/maps/no-such-map', h.dm)).statusCode).toBe(404)
      expect((await send(h, 'PATCH', '/maps/no-such-map', h.dm, { name: 'x' })).statusCode).toBe(
        404,
      )
      expect((await send(h, 'DELETE', '/maps/no-such-map', h.dm)).statusCode).toBe(404)
    })
  })

  it('refuses every map mutation for a player, server-side', async () => {
    await withHarness(async (h) => {
      expect((await send(h, 'POST', '/maps', h.ungranted, { name: 'Mine' })).statusCode).toBe(403)
      expect(
        (await send(h, 'PATCH', `/maps/${h.mapId}`, h.ungranted, { name: 'Mine' })).statusCode,
      ).toBe(403)
      expect((await send(h, 'DELETE', `/maps/${h.mapId}`, h.ungranted)).statusCode).toBe(403)
    })
  })

  it('rejects a client trying to set the source dimensions or the stored path', async () => {
    await withHarness(async (h) => {
      // These describe bytes on disk. A client that could set them could put
      // every pin on the map somewhere other than where it was placed.
      const res = await send(h, 'PATCH', `/maps/${h.mapId}`, h.dm, {
        source_width: 10,
        source_height: 10,
        image_path: '/etc/passwd',
      })
      expect(res.statusCode).toBe(200)
      const read = await get(h, `/maps/${h.mapId}`, h.dm)
      expect(read.json().map.source_width).toBeNull()
      expect(read.json().map.image_path).toBeNull()
    })
  })
})

describe('map visibility rides the same seam as an entity', () => {
  it('hides a dm_only map from every player and shows it to the owner', async () => {
    await withHarness(async (h) => {
      const secret = await send(h, 'POST', '/maps', h.dm, {
        name: 'The Cabal Safehouses',
        visibility: 'dm_only',
      })
      const id = secret.json().map.id as string

      expect((await get(h, `/maps/${id}`, h.dm)).statusCode).toBe(200)
      for (const cookie of [h.granted, h.ungranted]) {
        expect((await get(h, `/maps/${id}`, cookie)).statusCode).toBe(404)
        const names = ((await get(h, '/maps', cookie)).json().maps as { name: string }[]).map(
          (m) => m.name,
        )
        expect(names).not.toContain('The Cabal Safehouses')
      }
    })
  })

  /**
   * Maps were the one place the visibility model did not work the same way as
   * everywhere else. Until 0016 `restricted` was refused, and correctly so — a
   * grant naming a map could not be stored, because `entity_visibility.
   * entity_id` is foreign-keyed to `entities`. Maps now carry their own ACL and
   * the refusal is gone.
   */
  it('accepts `restricted` on a map and shares it with named players only', async () => {
    await withHarness(async (h) => {
      const made = await send(h, 'POST', '/maps', h.dm, {
        name: 'The Splinter Route',
        visibility: 'restricted',
      })
      expect(made.statusCode).toBe(201)
      const mapId = made.json().map.id as string

      const listFor = async (cookie: string): Promise<string[]> =>
        ((await get(h, '/maps', cookie)).json().maps as Array<{ id: string }>).map((m) => m.id)

      // ungranted members see nothing of it, through list OR by id
      expect(await listFor(h.granted)).not.toContain(mapId)
      expect((await get(h, `/maps/${mapId}`, h.granted)).statusCode).toBe(404)

      await send(h, 'POST', `/maps/${mapId}/grants`, h.dm, { accountId: h.grantedId })

      expect(await listFor(h.granted)).toContain(mapId)
      expect((await get(h, `/maps/${mapId}`, h.granted)).statusCode).toBe(200)
      // ...and the OTHER player still cannot, so the grant is per-account
      expect(await listFor(h.ungranted)).not.toContain(mapId)
      expect((await get(h, `/maps/${mapId}`, h.ungranted)).statusCode).toBe(404)

      expect((await get(h, `/maps/${mapId}/grants`, h.dm)).json().accountIds).toEqual([h.grantedId])

      await send(h, 'DELETE', `/maps/${mapId}/grants/${h.grantedId}`, h.dm)
      expect((await get(h, `/maps/${mapId}`, h.granted)).statusCode).toBe(404)
    })
  })

  it('refuses a player every map-grant action, and hides the map it cannot see', async () => {
    await withHarness(async (h) => {
      // A map the player CAN see, so the refusal is about ROLE and reads 403.
      const open = (
        await send(h, 'POST', '/maps', h.dm, { name: 'Open', visibility: 'public' })
      ).json().map.id as string
      expect(
        (await send(h, 'POST', `/maps/${open}/grants`, h.granted, { accountId: h.grantedId }))
          .statusCode,
      ).toBe(403)
      expect(
        (await send(h, 'DELETE', `/maps/${open}/grants/${h.grantedId}`, h.granted)).statusCode,
      ).toBe(403)
      expect((await get(h, `/maps/${open}/grants`, h.granted)).statusCode).toBe(403)

      // A restricted map they hold no grant for is a 404 instead — the refusal
      // must not confirm that the map exists.
      const secret = (
        await send(h, 'POST', '/maps', h.dm, { name: 'Secret', visibility: 'restricted' })
      ).json().map.id as string
      expect(
        (await send(h, 'POST', `/maps/${secret}/grants`, h.granted, { accountId: h.grantedId }))
          .statusCode,
      ).toBe(404)
      expect(
        (await send(h, 'POST', '/maps/no-such-map/grants', h.dm, { accountId: h.grantedId }))
          .statusCode,
      ).toBe(404)
    })
  })

  /**
   * The interaction that matters most: sharing a map shares the MAP, not what
   * is on it. A granted player still does not see a pin whose target entity
   * they cannot see — the per-pin filter in data/map-pins.ts is unchanged and
   * applies on top of the map's own visibility.
   */
  it('a granted player still does not see pins pointing at entities they cannot', async () => {
    await withHarness(async (h) => {
      const mapId = (
        await send(h, 'POST', '/maps', h.dm, { name: 'Shared', visibility: 'restricted' })
      ).json().map.id as string
      await send(h, 'POST', `/maps/${mapId}/grants`, h.dm, { accountId: h.grantedId })

      const place = (entityId: string, label: string, x: number) =>
        send(h, 'POST', `/maps/${mapId}/pins`, h.dm, { kind: 'npc', entityId, x, y: 0.2, label })
      expect((await place(h.publicNpc, 'harbour', 0.1)).statusCode).toBe(201)
      expect((await place(h.dmOnlyNpc, 'THE HOLLOW MAN HIDES HERE', 0.2)).statusCode).toBe(201)

      const pins = (await get(h, `/maps/${mapId}/pins`, h.granted)).json()
      expect(pins.pins).toHaveLength(1)
      // the label is withheld with the row, not just the resolved name
      expect(JSON.stringify(pins)).not.toContain('HOLLOW MAN')

      expect((await get(h, `/maps/${mapId}/pins`, h.dm)).json().pins).toHaveLength(2)
    })
  })
})

describe('map image upload', () => {
  it('records the source dimensions the pin transform is built on', async () => {
    await withHarness(async (h) => {
      const res = await h.app.inject({
        method: 'POST',
        url: `/api/worlds/${h.slug}/maps/${h.mapId}/image?filename=saltmarsh.png`,
        headers: { cookie: h.dm, 'content-type': 'image/png' },
        payload: makePng(900, 600),
      })
      expect(res.statusCode).toBe(201)
      expect(res.json().sourceWidth).toBe(900)
      expect(res.json().sourceHeight).toBe(600)

      // Read from the header, not accepted from the client, and persisted on the
      // map — without them a normalized pin has nothing to be normalized against.
      const read = await get(h, `/maps/${h.mapId}`, h.dm)
      expect(read.json().map.source_width).toBe(900)
      expect(read.json().map.source_height).toBe(600)
      expect(read.json().image.media_kind).toBe('map')
    })
  })

  it('replaces an image, and the map reports the newest one', async () => {
    await withHarness(async (h) => {
      const upload = (w: number, hgt: number): Promise<LightMyRequestResponse> =>
        h.app.inject({
          method: 'POST',
          url: `/api/worlds/${h.slug}/maps/${h.mapId}/image`,
          headers: { cookie: h.dm, 'content-type': 'image/png' },
          payload: makePng(w, hgt),
        })
      await upload(400, 300)
      await upload(800, 200)

      const read = await get(h, `/maps/${h.mapId}`, h.dm)
      expect(read.json().map.source_width).toBe(800)
      expect(read.json().map.source_height).toBe(200)
    })
  })

  it('refuses an upload from a player and 404s one to a map they cannot see', async () => {
    await withHarness(async (h) => {
      const asPlayer = await h.app.inject({
        method: 'POST',
        url: `/api/worlds/${h.slug}/maps/${h.mapId}/image`,
        headers: { cookie: h.ungranted, 'content-type': 'image/png' },
        payload: makePng(10, 10),
      })
      expect(asPlayer.statusCode).toBe(403)

      const secret = await send(h, 'POST', '/maps', h.dm, { name: 'S', visibility: 'dm_only' })
      const hidden = await h.app.inject({
        method: 'POST',
        url: `/api/worlds/${h.slug}/maps/${secret.json().map.id}/image`,
        headers: { cookie: h.ungranted, 'content-type': 'image/png' },
        payload: makePng(10, 10),
      })
      expect(hidden.statusCode).toBe(404)
    })
  })

  it('never serves a hidden map’s image bytes to a player', async () => {
    await withHarness(async (h) => {
      const secret = await send(h, 'POST', '/maps', h.dm, { name: 'S', visibility: 'dm_only' })
      const mapId = secret.json().map.id as string
      const uploaded = await h.app.inject({
        method: 'POST',
        url: `/api/worlds/${h.slug}/maps/${mapId}/image`,
        headers: { cookie: h.dm, 'content-type': 'image/png' },
        payload: makePng(50, 50),
      })
      const mediaId = uploaded.json().media.id as string

      // The raw route re-resolves the attachment's owner through the seam, and
      // `ENTITY_REPOS.map` is what makes 'map' an owner kind it can resolve.
      expect((await get(h, `/media/${mediaId}/raw`, h.dm)).statusCode).toBe(200)
      expect((await get(h, `/media/${mediaId}/raw`, h.ungranted)).statusCode).toBe(404)
    })
  })
})

describe('map pins', () => {
  it('places, moves, relabels and removes a pin', async () => {
    await withHarness(async (h) => {
      const created = await pin(h, h.dm, h.publicNpc, { x: 0.25, y: 0.75, label: 'The docks' })
      expect(created.statusCode).toBe(201)
      const id = created.json().pin.id as string
      expect(created.json().pin.target).toEqual({
        kind: 'npc',
        id: h.publicNpc,
        name: 'The Harbourmaster',
      })

      const listed = await get(h, `/maps/${h.mapId}/pins`, h.dm)
      expect(listed.json().pins).toHaveLength(1)
      expect(listed.json().pins[0].x).toBeCloseTo(0.25)

      const moved = await send(h, 'PATCH', `/maps/${h.mapId}/pins/${id}`, h.dm, {
        x: 0.9,
        label: 'The far docks',
      })
      expect(moved.json().pin.x).toBeCloseTo(0.9)
      expect(moved.json().pin.y).toBeCloseTo(0.75) // untouched by a partial patch
      expect(moved.json().pin.label).toBe('The far docks')

      expect((await send(h, 'DELETE', `/maps/${h.mapId}/pins/${id}`, h.dm)).statusCode).toBe(200)
      expect((await get(h, `/maps/${h.mapId}/pins`, h.dm)).json().pins).toHaveLength(0)
    })
  })

  it('stores coordinates as fractions, so they are independent of any zoom level', async () => {
    await withHarness(async (h) => {
      const created = await pin(h, h.dm, h.publicNpc, { x: 0.123456, y: 0.987654 })
      expect(created.json().pin.x).toBeCloseTo(0.123456, 6)

      const listed = await get(h, `/maps/${h.mapId}/pins`, h.dm)
      // Round-tripped through double precision unchanged: what the viewer placed
      // is what a later render reads back.
      expect(listed.json().pins[0].x).toBeCloseTo(0.123456, 6)
      expect(listed.json().pins[0].y).toBeCloseTo(0.987654, 6)
    })
  })

  it('refuses a coordinate outside the image with a 400, not a constraint 500', async () => {
    await withHarness(async (h) => {
      // The schema's 0..1 CHECKs would otherwise surface as an opaque failure.
      for (const bad of [
        { x: 1.5, y: 0.5 },
        { x: -0.1, y: 0.5 },
        { x: 0.5, y: 2 },
      ]) {
        const res = await pin(h, h.dm, h.publicNpc, bad)
        expect(res.statusCode).toBe(400)
        expect(res.json().error.code).toBe('invalid_request')
      }
      expect((await get(h, `/maps/${h.mapId}/pins`, h.dm)).json().pins).toHaveLength(0)
    })
  })

  it('accepts the exact edges, which are inside the constraint', async () => {
    await withHarness(async (h) => {
      expect((await pin(h, h.dm, h.publicNpc, { x: 0, y: 0 })).statusCode).toBe(201)
      expect((await pin(h, h.dm, h.publicNpc, { x: 1, y: 1 })).statusCode).toBe(201)
    })
  })

  it('refuses every pin mutation for a player, server-side', async () => {
    await withHarness(async (h) => {
      expect((await pin(h, h.ungranted, h.publicNpc)).statusCode).toBe(403)

      const id = (await pin(h, h.dm, h.publicNpc)).json().pin.id as string
      expect(
        (await send(h, 'PATCH', `/maps/${h.mapId}/pins/${id}`, h.ungranted, { x: 0.1 })).statusCode,
      ).toBe(403)
      expect((await send(h, 'DELETE', `/maps/${h.mapId}/pins/${id}`, h.ungranted)).statusCode).toBe(
        403,
      )
    })
  })

  it('404s a pin on a map the actor cannot see, and an unknown pin', async () => {
    await withHarness(async (h) => {
      const secret = await send(h, 'POST', '/maps', h.dm, { name: 'S', visibility: 'dm_only' })
      const hiddenMap = secret.json().map.id as string
      expect((await get(h, `/maps/${hiddenMap}/pins`, h.ungranted)).statusCode).toBe(404)
      expect((await send(h, 'DELETE', `/maps/${h.mapId}/pins/no-such-pin`, h.dm)).statusCode).toBe(
        404,
      )
    })
  })

  it('refuses a pin whose target the actor cannot see', async () => {
    await withHarness(async (h) => {
      // A player cannot write anyway; the point is that the entity is not even
      // acknowledged, so this is not an existence oracle for the DM-only NPC.
      const res = await pin(h, h.ungranted, h.dmOnlyNpc)
      expect(res.statusCode).toBe(404)
    })
  })
})

describe('a pin must never reveal an entity the reader cannot see', () => {
  // The acceptance criterion the task calls the one that matters most. The
  // content seam filters content ROWS; a pin's owner is its MAP, so nothing in
  // the seam covers this on its own.

  it('withholds a pin on a VISIBLE map whose target is dm_only', async () => {
    await withHarness(async (h) => {
      await pin(h, h.dm, h.publicNpc, { x: 0.1, y: 0.1, label: 'The docks' })
      await pin(h, h.dm, h.dmOnlyNpc, { x: 0.8, y: 0.8, label: 'The Hollow Man sleeps here' })

      // The map itself is public and both players can open it.
      expect((await get(h, `/maps/${h.mapId}`, h.ungranted)).statusCode).toBe(200)

      const asOwner = (await get(h, `/maps/${h.mapId}/pins`, h.dm)).json().pins
      expect(asOwner).toHaveLength(2)

      for (const cookie of [h.granted, h.ungranted]) {
        const pins = (await get(h, `/maps/${h.mapId}/pins`, cookie)).json().pins as unknown[]
        expect(pins).toHaveLength(1)
        // Not the id, not the name, not the coordinates, and — the part a
        // name-only filter would miss — not the label either. The label is free
        // text the DM writes; it spells out the secret independently.
        const body = JSON.stringify(pins)
        expect(body).not.toContain(h.dmOnlyNpc)
        expect(body).not.toContain('Hollow Man')
        expect(body).not.toContain('0.8')
      }
    })
  })

  it('withholds a pin whose target is restricted, until that player is granted', async () => {
    await withHarness(async (h) => {
      await pin(h, h.dm, h.restrictedNpc, { x: 0.4, y: 0.4, label: 'Silas drinks here' })

      const forUngranted = (await get(h, `/maps/${h.mapId}/pins`, h.ungranted)).json().pins
      expect(forUngranted).toHaveLength(0)

      // The granted player holds a grant for exactly this entity, so the pin
      // resolves for them and for nobody else.
      const forGranted = (await get(h, `/maps/${h.mapId}/pins`, h.granted)).json().pins
      expect(forGranted).toHaveLength(1)
      expect(forGranted[0].target.name).toBe('Silas Crow')
      expect(forGranted[0].label).toBe('Silas drinks here')
    })
  })

  it('drops a pin whose target is deleted rather than leaving it dangling', async () => {
    await withHarness(async (h) => {
      await pin(h, h.dm, h.publicNpc)
      expect((await get(h, `/maps/${h.mapId}/pins`, h.dm)).json().pins).toHaveLength(1)

      await send(h, 'DELETE', `/entities/npc/${h.publicNpc}`, h.dm)
      // A marker that navigates nowhere is worse than no marker, and it still
      // reports that something used to be there.
      expect((await get(h, `/maps/${h.mapId}/pins`, h.dm)).json().pins).toHaveLength(0)
    })
  })

  it('drops a pin as soon as its target is reclassified as hidden', async () => {
    await withHarness(async (h) => {
      await pin(h, h.dm, h.publicNpc)
      expect((await get(h, `/maps/${h.mapId}/pins`, h.ungranted)).json().pins).toHaveLength(1)

      await send(h, 'PATCH', `/entities/npc/${h.publicNpc}`, h.dm, { visibility: 'dm_only' })
      // Nothing about the PIN changed — the filter reads the target's current
      // visibility on every request rather than a copy made when it was placed.
      expect((await get(h, `/maps/${h.mapId}/pins`, h.ungranted)).json().pins).toHaveLength(0)
      expect((await get(h, `/maps/${h.mapId}/pins`, h.dm)).json().pins).toHaveLength(1)
    })
  })
})

describe('the maps an entity is pinned on', () => {
  it('lists them on the entity, and hides a map the reader cannot see', async () => {
    await withHarness(async (h) => {
      const hidden = await send(h, 'POST', '/maps', h.dm, {
        name: 'The Cabal Safehouses',
        visibility: 'dm_only',
      })
      const hiddenMapId = hidden.json().map.id as string
      await pin(h, h.dm, h.publicNpc, { x: 0.2, y: 0.2 })
      await send(h, 'POST', `/maps/${hiddenMapId}/pins`, h.dm, {
        kind: 'npc',
        entityId: h.publicNpc,
        x: 0.3,
        y: 0.3,
      })

      const asOwner = (await get(h, `/entities/npc/${h.publicNpc}/maps`, h.dm)).json().maps
      expect((asOwner as { mapName: string }[]).map((m) => m.mapName).sort()).toEqual([
        'Saltmarsh',
        'The Cabal Safehouses',
      ])

      // The mirror-image leak: the ENTITY is visible, so a player reads its
      // page — but learning it appears on a dm_only map names that map.
      const asPlayer = (await get(h, `/entities/npc/${h.publicNpc}/maps`, h.ungranted)).json().maps
      expect((asPlayer as { mapName: string }[]).map((m) => m.mapName)).toEqual(['Saltmarsh'])
    })
  })

  it('404s the reverse lookup for an entity the actor cannot see', async () => {
    await withHarness(async (h) => {
      expect((await get(h, `/entities/npc/${h.dmOnlyNpc}/maps`, h.ungranted)).statusCode).toBe(404)
    })
  })

  it('is empty for an entity nobody has pinned', async () => {
    await withHarness(async (h) => {
      expect((await get(h, `/entities/npc/${h.publicNpc}/maps`, h.dm)).json().maps).toEqual([])
    })
  })
})
