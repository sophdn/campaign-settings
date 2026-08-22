import { type Kysely } from 'kysely'
import { describe, expect, it } from 'vitest'
import { resolveWorldContext } from '../authz/context'
import type { WorldContext } from './context'
import { CurrencyValidationError } from '@campaign-settings/shared'
import { newId } from '../db/ids'
import { createDb } from '../db/kysely'
import { migrateToLatest } from '../db/migrator'
import type { Database } from '../db/schema'
import { withTestDatabase } from '../db/test-database'
import { createTenancy } from '../tenancy'
import { CONTENT_REPOS } from './content-repos'
import { assertValidBaseRate } from './currency-anchor'

const currencies = CONTENT_REPOS.currency!

async function ownerContext(db: Kysely<Database>): Promise<WorldContext> {
  const id = newId()
  await db.insertInto('accounts').values({ id, username: 'cur-dm', password_hash: 'h' }).execute()
  const world = await createTenancy(db).createWorld(id, 'cur')
  return (await resolveWorldContext(db, id, world.slug)) as WorldContext
}

/** Run `fn` against a migrated database with an owner context. */
async function withOwner(fn: (ctx: WorldContext) => Promise<void>): Promise<void> {
  await withTestDatabase(async (pool) => {
    const db = createDb(pool)
    await migrateToLatest(db)
    await fn(await ownerContext(db))
  })
}

describe('the currency exchange anchor', () => {
  it('passes a patch that does not touch the anchor, and one that clears it', async () => {
    await withOwner(async (ctx) => {
      const crown = await currencies.create(ctx, { name: 'Crown' })
      // Removing an edge cannot create a cycle, so clearing needs no lookup.
      await expect(assertValidBaseRate(ctx, crown.id, { symbol: 'C' })).resolves.toBeUndefined()
      await expect(
        assertValidBaseRate(ctx, crown.id, { base_rate_to: null }),
      ).resolves.toBeUndefined()
      await expect(
        assertValidBaseRate(ctx, crown.id, { base_rate_to: '' }),
      ).resolves.toBeUndefined()
    })
  })

  it('accepts an anchor on another existing currency', async () => {
    await withOwner(async (ctx) => {
      const crown = await currencies.create(ctx, { name: 'Crown' })
      const mark = await currencies.create(ctx, { name: 'Mark' })
      await expect(
        assertValidBaseRate(ctx, crown.id, { base_rate_to: mark.id }),
      ).resolves.toBeUndefined()
    })
  })

  it('refuses a self-anchor', async () => {
    await withOwner(async (ctx) => {
      const crown = await currencies.create(ctx, { name: 'Crown' })
      await expect(
        assertValidBaseRate(ctx, crown.id, { base_rate_to: crown.id }),
      ).rejects.toBeInstanceOf(CurrencyValidationError)
    })
  })

  it('refuses an anchor on something that is not a currency in this world', async () => {
    await withOwner(async (ctx) => {
      const crown = await currencies.create(ctx, { name: 'Crown' })
      const npc = await CONTENT_REPOS.npc!.create(ctx, { name: 'Aelin' })
      // Not a currency, so it is not in the anchor map — the same refusal an id
      // from another world or a deleted row gets.
      await expect(
        assertValidBaseRate(ctx, crown.id, { base_rate_to: npc.id }),
      ).rejects.toBeInstanceOf(CurrencyValidationError)
      await expect(
        assertValidBaseRate(ctx, crown.id, { base_rate_to: 'no-such-id' }),
      ).rejects.toBeInstanceOf(CurrencyValidationError)
    })
  })

  it('refuses a chain that would cycle back, however long', async () => {
    await withOwner(async (ctx) => {
      // a -> b -> c, then asking c to anchor on a closes the loop.
      const a = await currencies.create(ctx, { name: 'A' })
      const b = await currencies.create(ctx, { name: 'B' })
      const c = await currencies.create(ctx, { name: 'C' })
      await currencies.update(ctx, a.id, { base_rate_to: b.id })
      await currencies.update(ctx, b.id, { base_rate_to: c.id })

      await expect(assertValidBaseRate(ctx, c.id, { base_rate_to: a.id })).rejects.toBeInstanceOf(
        CurrencyValidationError,
      )
      // The two-step version of the same shape.
      await expect(assertValidBaseRate(ctx, b.id, { base_rate_to: a.id })).rejects.toBeInstanceOf(
        CurrencyValidationError,
      )
    })
  })

  it('accepts an id that does not exist yet — the create path', async () => {
    await withOwner(async (ctx) => {
      const mark = await currencies.create(ctx, { name: 'Mark' })
      // A row nothing can point at yet cannot be in a cycle, so only the
      // target-exists clause can fail. This is what the POST route relies on
      // when it mints the id before calling create.
      await expect(
        assertValidBaseRate(ctx, newId(), { base_rate_to: mark.id }),
      ).resolves.toBeUndefined()
    })
  })
})
