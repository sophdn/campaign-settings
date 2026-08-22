import type { Kysely } from 'kysely'
import { describe, expect, it } from 'vitest'
import { createDb } from '../db/kysely'
import { migrateToLatest } from '../db/migrator'
import type { Database } from '../db/schema'
import { withTestDatabase } from '../db/test-database'
import { consumeResetToken, createResetToken } from './reset-tokens'
import { hashToken } from './tokens'
import { createScryptAuth } from './service'

const HOUR = 60 * 60 * 1000
const MIN = 60 * 1000

async function seedAccount(db: Kysely<Database>): Promise<string> {
  return (await createScryptAuth(db).createAccount('dm', 'pw-12345')).id
}

describe('reset-tokens', () => {
  it('hashes a token to a stable, non-reversible digest', () => {
    expect(hashToken('abc')).toBe(hashToken('abc'))
    expect(hashToken('abc')).not.toBe('abc')
    expect(hashToken('abc')).not.toBe(hashToken('abd'))
  })

  it('issues a raw token, stores only its hash, and consumes it exactly once', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const accountId = await seedAccount(db)
      const now = new Date('2026-01-01T00:00:00Z')

      const raw = await createResetToken(db, accountId, now, HOUR, MIN)
      expect(raw).toBeTruthy()

      // only the hash is stored — never the raw secret
      const stored = await db
        .selectFrom('password_reset_tokens')
        .select('token_hash')
        .executeTakeFirstOrThrow()
      expect(stored.token_hash).toBe(hashToken(raw!))
      expect(stored.token_hash).not.toBe(raw)

      // consuming returns the account and makes the token single-use
      expect(await consumeResetToken(db, raw!, now)).toBe(accountId)
      expect(await consumeResetToken(db, raw!, now)).toBeNull() // already consumed
    })
  })

  it('supersedes outstanding tokens but throttles rapid re-requests', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const accountId = await seedAccount(db)
      const t0 = new Date('2026-01-01T00:00:00Z')

      const first = await createResetToken(db, accountId, t0, HOUR, MIN)
      expect(first).toBeTruthy()

      // within the throttle window → no new token, and the first still stands
      const throttled = await createResetToken(
        db,
        accountId,
        new Date(t0.getTime() + 30_000),
        HOUR,
        MIN,
      )
      expect(throttled).toBeNull()
      expect(await consumeResetToken(db, first!, t0)).toBe(accountId)

      // past the throttle window → a fresh token issues and supersedes the old
      const t1 = new Date(t0.getTime() + 2 * MIN)
      const second = await createResetToken(db, accountId, t1, HOUR, MIN)
      expect(second).toBeTruthy()
      const rows = await db
        .selectFrom('password_reset_tokens')
        .select('id')
        .where('account_id', '=', accountId)
        .execute()
      expect(rows).toHaveLength(1) // exactly one token row remains
    })
  })

  it('rejects unknown and expired tokens', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const accountId = await seedAccount(db)
      const now = new Date('2026-01-01T00:00:00Z')

      expect(await consumeResetToken(db, 'no-such-token', now)).toBeNull()

      const raw = await createResetToken(db, accountId, now, HOUR, MIN)
      // one hour and a second later, the token has expired
      expect(await consumeResetToken(db, raw!, new Date(now.getTime() + HOUR + 1000))).toBeNull()
    })
  })
})
