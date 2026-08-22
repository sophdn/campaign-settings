import type { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { createContentRepository } from '../authz/content'
import { CONTENT_REPOS } from './content-repos'
import { createDb } from '../db/kysely'
import { migrateToLatest } from '../db/migrator'
import { withTestDatabase } from '../db/test-database'
import type { WorldContext } from './context'
import {
  createPin,
  listPinsForMap,
  PinOutOfBoundsError,
  PinTargetNotFoundError,
  updatePin,
} from './map-pins'

/**
 * The pin data layer's own guards, exercised directly rather than through HTTP.
 *
 * The routes bound x and y with zod first, so these throws are unreachable from
 * a request — which is exactly why they need a test here. They exist for the
 * callers that are NOT routes (the e2e seeder, a future importer, a script), and
 * an untested guard on a path nobody watches is a guard that quietly stops
 * working.
 */

const maps = createContentRepository('maps')
// The kind is a property of the REPO, not of the payload — the seam supplies it.
const npcs = CONTENT_REPOS.npc!

async function withWorld(body: (ctx: WorldContext, mapId: string, npcId: string) => Promise<void>) {
  await withTestDatabase(async (pool: Pool) => {
    const db = createDb(pool)
    await migrateToLatest(db)
    await db
      .insertInto('accounts')
      .values({ id: 'acc1', username: 'dm', password_hash: 'h' })
      .execute()
    await db
      .insertInto('worlds')
      .values({ id: 'w1', owner_id: 'acc1', name: 'W', slug: 'w' })
      .execute()
    const ctx: WorldContext = {
      db,
      worldId: 'w1',
      actor: { accountId: 'acc1', role: 'owner' },
    }
    const map = await maps.create(ctx, { name: 'Saltmarsh' })
    const npc = await npcs.create(ctx, { name: 'The Harbourmaster' })
    await body(ctx, map.id, npc.id)
  })
}

describe('coordinate guards', () => {
  it('refuses a coordinate outside the unit square on create', async () => {
    await withWorld(async (ctx, mapId, npcId) => {
      for (const bad of [
        { x: 1.5, y: 0.5 },
        { x: -0.5, y: 0.5 },
        { x: 0.5, y: 2 },
        { x: 0.5, y: -1 },
      ]) {
        await expect(
          createPin(ctx, { map_id: mapId, entity_id: npcId, ...bad }),
        ).rejects.toBeInstanceOf(PinOutOfBoundsError)
      }
      expect(await listPinsForMap(ctx, mapId)).toHaveLength(0)
    })
  })

  it('refuses a coordinate that is not a number at all', async () => {
    // The schema's CHECK compares against 0 and 1, and NaN compares false to
    // both — so an unguarded NaN would be REJECTED by Postgres with an opaque
    // constraint error, and Infinity likewise. Naming it here is kinder.
    await withWorld(async (ctx, mapId, npcId) => {
      for (const bad of [
        { x: Number.NaN, y: 0.5 },
        { x: 0.5, y: Number.POSITIVE_INFINITY },
      ]) {
        await expect(
          createPin(ctx, { map_id: mapId, entity_id: npcId, ...bad }),
        ).rejects.toBeInstanceOf(PinOutOfBoundsError)
      }
    })
  })

  it('refuses an out-of-range MOVE, and leaves the pin where it was', async () => {
    await withWorld(async (ctx, mapId, npcId) => {
      const pin = await createPin(ctx, { map_id: mapId, entity_id: npcId, x: 0.25, y: 0.75 })

      await expect(updatePin(ctx, pin.id, { x: 3 })).rejects.toBeInstanceOf(PinOutOfBoundsError)
      await expect(updatePin(ctx, pin.id, { y: -1 })).rejects.toBeInstanceOf(PinOutOfBoundsError)

      const [after] = await listPinsForMap(ctx, mapId)
      expect(after?.x).toBeCloseTo(0.25)
      expect(after?.y).toBeCloseTo(0.75)
    })
  })

  it('patches each field on its own, leaving the others where they were', async () => {
    // Three independent optional fields: a patch naming one must not blank the
    // other two, which is what a naive `set` of the whole row would do.
    await withWorld(async (ctx, mapId, npcId) => {
      const pin = await createPin(ctx, {
        map_id: mapId,
        entity_id: npcId,
        x: 0.2,
        y: 0.3,
        label: 'The docks',
      })

      const movedX = await updatePin(ctx, pin.id, { x: 0.8 })
      expect(movedX?.x).toBeCloseTo(0.8)
      expect(movedX?.y).toBeCloseTo(0.3)
      expect(movedX?.label).toBe('The docks')

      const movedY = await updatePin(ctx, pin.id, { y: 0.9 })
      expect(movedY?.x).toBeCloseTo(0.8)
      expect(movedY?.y).toBeCloseTo(0.9)
      expect(movedY?.label).toBe('The docks')
    })
  })

  it('allows a label-only patch, which touches no coordinate to validate', async () => {
    await withWorld(async (ctx, mapId, npcId) => {
      const pin = await createPin(ctx, { map_id: mapId, entity_id: npcId, x: 0.5, y: 0.5 })
      const patched = await updatePin(ctx, pin.id, { label: 'The docks' })
      expect(patched?.label).toBe('The docks')
      expect(patched?.x).toBeCloseTo(0.5)
    })
  })

  it('accepts the exact edges, which the schema considers inside', async () => {
    await withWorld(async (ctx, mapId, npcId) => {
      await createPin(ctx, { map_id: mapId, entity_id: npcId, x: 0, y: 0 })
      await createPin(ctx, { map_id: mapId, entity_id: npcId, x: 1, y: 1 })
      expect(await listPinsForMap(ctx, mapId)).toHaveLength(2)
    })
  })

  it('refuses a pin whose target does not exist, before writing anything', async () => {
    // Resolved through the seam BEFORE the insert, so there is no row to clean
    // up when the target turns out not to be there.
    await withWorld(async (ctx, mapId) => {
      await expect(
        createPin(ctx, { map_id: mapId, entity_id: 'no-such-entity', x: 0.5, y: 0.5 }),
      ).rejects.toBeInstanceOf(PinTargetNotFoundError)
      expect(await listPinsForMap(ctx, mapId)).toHaveLength(0)
    })
  })

  it('returns undefined for a patch to a pin that is not there', async () => {
    await withWorld(async (ctx) => {
      expect(await updatePin(ctx, 'no-such-pin', { label: 'x' })).toBeUndefined()
    })
  })
})

describe('a pin created with an explicit label', () => {
  it('keeps the label, and defaults it to null when omitted', async () => {
    await withWorld(async (ctx, mapId, npcId) => {
      const labelled = await createPin(ctx, {
        map_id: mapId,
        entity_id: npcId,
        x: 0.1,
        y: 0.1,
        label: 'The docks',
      })
      expect(labelled.label).toBe('The docks')

      const bare = await createPin(ctx, { map_id: mapId, entity_id: npcId, x: 0.2, y: 0.2 })
      expect(bare.label).toBeNull()
    })
  })
})
