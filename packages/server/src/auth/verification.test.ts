import type { Kysely } from 'kysely'
import { describe, expect, it } from 'vitest'
import { createDb } from '../db/kysely'
import { migrateToLatest } from '../db/migrator'
import type { Database } from '../db/schema'
import { withTestDatabase } from '../db/test-database'
import { createScryptAuth } from './service'
import {
  createVerificationToken,
  debugVerifyAccount,
  isVerificationOutstanding,
} from './verification'

const HOUR = 60 * 60 * 1000

async function seed(db: Kysely<Database>, username: string, email: string | null): Promise<string> {
  const auth = createScryptAuth(db)
  const account = await auth.createAccount(username, 'pw-12345', email ?? undefined)
  return account.id
}

async function verifiedAt(db: Kysely<Database>, id: string): Promise<Date | null> {
  const row = await db
    .selectFrom('accounts')
    .select('email_verified_at')
    .where('id', '=', id)
    .executeTakeFirst()
  return row?.email_verified_at ?? null
}

describe('debugVerifyAccount', () => {
  it('verifies an account that has an unproven address, and closes the gate it opens', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const id = await seed(db, 'dm', 'dm@example.test')

      expect(await isVerificationOutstanding(db, id)).toBe(true)

      const at = new Date('2026-07-31T22:00:00Z')
      const result = await debugVerifyAccount(db, 'dm', at)

      expect(result).toMatchObject({ status: 'verified', accountId: id, email: 'dm@example.test' })
      expect(await verifiedAt(db, id)).toEqual(at)
      // The point of the tool: the thing that was gated is no longer gated.
      expect(await isVerificationOutstanding(db, id)).toBe(false)
    })
  })

  it('is idempotent and does NOT rewrite the original verification time', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const id = await seed(db, 'dm', 'dm@example.test')

      const first = new Date('2026-07-01T09:00:00Z')
      await debugVerifyAccount(db, 'dm', first)

      const later = new Date('2026-07-31T22:00:00Z')
      const again = await debugVerifyAccount(db, 'dm', later)

      expect(again).toMatchObject({ status: 'already-verified', accountId: id, at: first })
      // "When" is the answer to "whether" — moving it would destroy the record.
      expect(await verifiedAt(db, id)).toEqual(first)
    })
  })

  it('refuses an account with no address rather than asserting something false', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const id = await seed(db, 'operator', null)

      const result = await debugVerifyAccount(db, 'operator')

      expect(result).toEqual({ status: 'no-email', accountId: id, username: 'operator' })
      expect(await verifiedAt(db, id)).toBeNull()
      // Such an account was never gated in the first place.
      expect(await isVerificationOutstanding(db, id)).toBe(false)
    })
  })

  it('reports an unknown username instead of silently succeeding', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      await seed(db, 'dm', 'dm@example.test')

      expect(await debugVerifyAccount(db, 'nobody')).toEqual({
        status: 'no-such-account',
        username: 'nobody',
      })
    })
  })

  it('matches the username case-insensitively, as every other lookup does (0009)', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const id = await seed(db, 'Casey-DM', 'dm@example.test')

      const result = await debugVerifyAccount(db, 'casey-dm')

      // The stored capitalisation survives; only the comparison folds.
      expect(result).toMatchObject({ status: 'verified', accountId: id, username: 'Casey-DM' })
    })
  })

  it('deletes any outstanding token, so an emailed link cannot be replayed afterwards', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const id = await seed(db, 'dm', 'dm@example.test')

      const raw = await createVerificationToken(db, id, new Date(), HOUR, 0)
      expect(raw).not.toBeNull()

      await debugVerifyAccount(db, 'dm')

      const left = await db
        .selectFrom('email_verification_tokens')
        .select('id')
        .where('account_id', '=', id)
        .execute()
      expect(left).toHaveLength(0)
    })
  })
})
