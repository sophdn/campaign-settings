import { describe, expect, it } from 'vitest'
import { createScryptAuth } from '../auth/service'
import { createDb } from '../db/kysely'
import { migrateToLatest } from '../db/migrator'
import { withTestDatabase } from '../db/test-database'
import { createTenancy } from './service'
import { acceptInvitation, createInvitation } from './invitations'

const NOW = new Date('2026-01-01T00:00:00Z')
const HOUR = 60 * 60 * 1000

describe('acceptInvitation under concurrency', () => {
  it('lets exactly one of two simultaneous redemptions win', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const auth = createScryptAuth(db)
      const tenancy = createTenancy(db)

      const owner = await auth.createAccount('dm', 'pw-123456')
      const first = await auth.createAccount('first', 'pw-123456')
      const second = await auth.createAccount('second', 'pw-123456')
      const world = await tenancy.createWorld(owner.id, 'W')

      // an OPEN link — no invitee pinned, so both racers are equally entitled
      const { token } = await createInvitation(db, {
        worldId: world.id,
        invitedBy: owner.id,
        inviteeAccountId: null,
        now: NOW,
        ttlMs: HOUR,
      })

      // both resolve the same live invitation before either claims it; only the
      // one that wins the conditional update may join
      const results = await Promise.all([
        acceptInvitation(db, first.id, token, NOW),
        acceptInvitation(db, second.id, token, NOW),
      ])

      const winners = results.filter((r) => r !== null)
      expect(winners).toHaveLength(1)

      // and exactly one membership exists — the loser was not quietly added
      const joined = [
        ...(await tenancy.listWorlds(first.id)),
        ...(await tenancy.listWorlds(second.id)),
      ]
      expect(joined).toHaveLength(1)
      expect(joined[0]!.id).toBe(world.id)
    })
  })
})
