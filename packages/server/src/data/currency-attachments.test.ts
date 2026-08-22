import { sql } from 'kysely'
import type { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { createDb } from '../db/kysely'
import { migrateToLatest } from '../db/migrator'
import { withTestDatabase } from '../db/test-database'
import type { WorldContext } from './context'
import { attachCurrency, listAttachmentsForOwner, updateAttachment } from './currency-attachments'

/**
 * The two database constraints this module leans on, exercised directly.
 *
 * Both were shipped in migration 0001 and neither had ever been enforced by
 * anything, because until chain 455 nothing but the importer wrote these tables:
 *
 *   `<table>_unique_pair`  — unique (owner, currency) where deleted_at is null
 *   `<table>_one_primary`  — unique (owner)           where is_primary and live
 *
 * They are tested at the SQL level rather than only through HTTP because the
 * module's behaviour is built on them being true — the duplicate refusal is a
 * translated 23505, and `clearPrimary` exists to make a promotion expressible
 * against the second index rather than to re-state it. A test that only went
 * through the routes would still pass if the indexes were dropped and the module
 * quietly started storing two primaries.
 */

/** The ids every test reaches for, named rather than indexed out of a map. */
interface Ids {
  settlement: string
  coin: string
  crown: string
}

async function withWorld(body: (ctx: WorldContext, ids: Ids) => Promise<void>) {
  await withTestDatabase(async (pool: Pool) => {
    const db = createDb(pool)
    await migrateToLatest(db)
    await db
      .insertInto('accounts')
      .values({ id: 'a1', username: 'dm', password_hash: 'h' })
      .execute()
    await db
      .insertInto('worlds')
      .values({ id: 'w1', owner_id: 'a1', name: 'W', slug: 'w' })
      .execute()
    await db
      .insertInto('entities')
      .values([
        { id: 'st1', world_id: 'w1', kind: 'settlement', name: 'Blackmoor Hold' },
        { id: 'cu1', world_id: 'w1', kind: 'currency', name: 'Iron Mark' },
        { id: 'cu2', world_id: 'w1', kind: 'currency', name: 'Sunlit Crown' },
      ])
      .execute()
    await body(
      { db, worldId: 'w1', actor: { accountId: 'a1', role: 'owner' } },
      {
        settlement: 'st1',
        coin: 'cu1',
        crown: 'cu2',
      },
    )
  })
}

/** Insert an attachment row straight past the data module. */
const rawAttach = (
  ctx: WorldContext,
  id: string,
  opts: { isPrimary?: boolean; currencyId?: string; deleted?: boolean } = {},
): Promise<unknown> =>
  sql`
    insert into settlement_currency_attachments
      (id, world_id, settlement_id, currency_id, is_primary, deleted_at)
    values (
      ${id}, 'w1', 'st1', ${opts.currencyId ?? 'cu1'}, ${opts.isPrimary ?? false},
      ${opts.deleted === true ? sql`now()` : sql`null`}
    )`.execute(ctx.db)

describe('unique_pair — one live attachment per (owner, currency)', () => {
  it('refuses a second live row for the same pair', async () => {
    await withWorld(async (ctx) => {
      await rawAttach(ctx, 'at1')
      await expect(rawAttach(ctx, 'at2')).rejects.toThrow()
    })
  })

  it('is partial: a soft-deleted row does not hold the pair', async () => {
    // Load-bearing for detach. If this index were total, a row that the importer
    // or `change-kind.ts` soft-deleted would block re-attaching that currency
    // forever, and the panel would have no way to explain the refusal.
    await withWorld(async (ctx) => {
      await rawAttach(ctx, 'at1', { deleted: true })
      await expect(rawAttach(ctx, 'at2')).resolves.toBeDefined()
    })
  })

  it('does not constrain a DIFFERENT currency on the same owner', async () => {
    await withWorld(async (ctx, ids) => {
      await rawAttach(ctx, 'at1')
      await expect(rawAttach(ctx, 'at2', { currencyId: ids.crown })).resolves.toBeDefined()
    })
  })
})

describe('one_primary — at most one primary per owner', () => {
  it('refuses a second live primary row on the same owner', async () => {
    await withWorld(async (ctx, ids) => {
      await rawAttach(ctx, 'at1', { isPrimary: true })
      await expect(
        rawAttach(ctx, 'at2', { isPrimary: true, currencyId: ids.crown }),
      ).rejects.toThrow()
    })
  })

  it('is what makes `clearPrimary` necessary — the module can still swap', async () => {
    // The point of the pair of tests: the raw insert above is refused, and the
    // module's promotion is not, because it demotes first inside the same
    // transaction. Delete `clearPrimary` and this test stops passing with a
    // constraint violation rather than with two primaries.
    await withWorld(async (ctx, ids) => {
      const first = await attachCurrency(ctx, 'settlement', ids.settlement, {
        currencyId: ids.coin,
        isPrimary: true,
      })
      const second = await attachCurrency(ctx, 'settlement', ids.settlement, {
        currencyId: ids.crown,
        isPrimary: true,
      })

      const rows = await listAttachmentsForOwner(ctx, 'settlement', ids.settlement)
      expect(rows.filter((r) => r.isPrimary).map((r) => r.id)).toEqual([second.id])
      expect(rows.find((r) => r.id === first.id)?.isPrimary).toBe(false)
    })
  })

  it('a PATCH promotion demotes the incumbent in the same transaction', async () => {
    await withWorld(async (ctx, ids) => {
      const first = await attachCurrency(ctx, 'settlement', ids.settlement, {
        currencyId: ids.coin,
        isPrimary: true,
      })
      const second = await attachCurrency(ctx, 'settlement', ids.settlement, {
        currencyId: ids.crown,
      })

      const updated = await updateAttachment(ctx, 'settlement', second.id, { isPrimary: true })
      expect(updated?.isPrimary).toBe(true)

      const rows = await listAttachmentsForOwner(ctx, 'settlement', ids.settlement)
      expect(rows.find((r) => r.id === first.id)?.isPrimary).toBe(false)
    })
  })

  it('is partial too: a soft-deleted primary does not block a new one', async () => {
    await withWorld(async (ctx, ids) => {
      await rawAttach(ctx, 'at1', { isPrimary: true, deleted: true })
      await expect(
        rawAttach(ctx, 'at2', { isPrimary: true, currencyId: ids.crown }),
      ).resolves.toBeDefined()
    })
  })
})
