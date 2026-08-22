import { type ContentKind, contentKinds, ENTITY_FIELDS } from '@campaign-settings/shared'
import { sql } from 'kysely'
import { describe, expect, it } from 'vitest'
import { createDb } from '../db/kysely'
import { migrateToLatest } from '../db/migrator'
import { withTestDatabase } from '../db/test-database'
import { DETAIL_SPECS } from './entity-details'

/**
 * The registry lives in `packages/shared` and the schema lives here, so nothing
 * in the type system stops a field key from naming a column that does not
 * exist, or a migration from adding a column no field renders. This file is
 * that gate — the same discipline `content-repos.test.ts` applies to
 * CONTENT_REPOS, one layer down.
 */

/**
 * Detail columns the registry deliberately does NOT render, and why. A column
 * that is neither rendered nor listed here fails the coverage test below, so
 * adding one to a migration forces a decision instead of quietly shipping a
 * field the UI cannot edit.
 */
const DELIBERATELY_UNRENDERED: Partial<Record<ContentKind, readonly string[]>> = {
  // All three belong to the bespoke currency panel.
  //   denominations — a JSON array; no scalar input can edit it.
  //   base_rate_to + rate — one coupled control, not two fields: a rate means
  //     nothing without an anchor, and an anchor's validity depends on every
  //     other currency in the world (not itself, no cycle), which the generic
  //     ref picker cannot check.
  currency: ['denominations', 'base_rate_to', 'rate'],
}

const CONTENT_KINDS = contentKinds().map((k) => k.kind as ContentKind)

describe('ENTITY_FIELDS ⋈ the detail-table specs', () => {
  it('every field key is a column of its kind’s detail table', () => {
    for (const kind of CONTENT_KINDS) {
      const columns = DETAIL_SPECS[kind]?.columns ?? []
      for (const field of ENTITY_FIELDS[kind]) {
        expect(columns, `${kind}.${field.key} is not a column of ${kind}'s detail table`).toContain(
          field.key,
        )
      }
    }
  })

  it('a kind with no detail table declares no fields', () => {
    for (const kind of CONTENT_KINDS) {
      if (DETAIL_SPECS[kind]) continue
      expect(ENTITY_FIELDS[kind], `${kind} has no detail table but declares fields`).toEqual([])
    }
  })

  it('every detail column is either rendered or listed as deliberately unrendered', () => {
    for (const kind of CONTENT_KINDS) {
      const spec = DETAIL_SPECS[kind]
      if (!spec) continue
      const rendered = new Set(ENTITY_FIELDS[kind].map((f) => f.key))
      const excused = new Set(DELIBERATELY_UNRENDERED[kind] ?? [])
      const orphans = spec.columns.filter((c) => !rendered.has(c) && !excused.has(c))
      expect(orphans, `${kind} has detail columns with no field and no exemption`).toEqual([])
    }
  })

  it('nothing is excused that is not actually a column', () => {
    // A stale exemption would silently keep a real orphan out of the check above.
    for (const [kind, excused] of Object.entries(DELIBERATELY_UNRENDERED)) {
      const columns = DETAIL_SPECS[kind as ContentKind]?.columns ?? []
      for (const col of excused) {
        expect(columns, `${kind} excuses '${col}', which is not a column`).toContain(col)
      }
    }
  })
})

describe('ENTITY_FIELDS ⋈ the real database', () => {
  it('every field key is a live column in the migrated schema', async () => {
    // The specs above are hand-maintained too, so the end of the chain has to be
    // the database itself: this is what makes a rename in a migration break the
    // registry loudly instead of at render time.
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)

      const rows = await sql<{
        table_name: string
        column_name: string
        is_nullable: 'YES' | 'NO'
      }>`
        select table_name, column_name, is_nullable
        from information_schema.columns
        where table_schema = 'public'
      `.execute(db)

      const byTable = new Map<string, Map<string, boolean>>()
      for (const r of rows.rows) {
        const cols = byTable.get(r.table_name) ?? new Map<string, boolean>()
        cols.set(r.column_name, r.is_nullable === 'YES')
        byTable.set(r.table_name, cols)
      }

      for (const kind of CONTENT_KINDS) {
        const fields = ENTITY_FIELDS[kind]
        if (fields.length === 0) continue
        const spec = DETAIL_SPECS[kind]
        expect(spec, `${kind} declares fields but has no detail spec`).toBeDefined()
        const live = byTable.get(spec!.table)
        expect(live, `${spec!.table} is not a table in the migrated schema`).toBeDefined()
        for (const field of fields) {
          expect(
            live?.has(field.key),
            `${kind}.${field.key} is not a column of ${spec!.table}`,
          ).toBe(true)
        }
      }
    })
  })

  it('every `nullable` flag matches the column’s actual nullability', async () => {
    // The flag decides what CLEARING an input means — `null` for a nullable
    // column, `''`/`0` for a NOT NULL one. Guessing it wrong is a constraint
    // violation on save or a second stored meaning for "unset", and neither
    // shows up until someone empties that particular field in the UI. The
    // database already knows the answer, so it is the one that gets asked.
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)

      const rows = await sql<{
        table_name: string
        column_name: string
        is_nullable: 'YES' | 'NO'
      }>`
        select table_name, column_name, is_nullable
        from information_schema.columns
        where table_schema = 'public'
      `.execute(db)

      const nullableOf = new Map(
        rows.rows.map((r) => [`${r.table_name}.${r.column_name}`, r.is_nullable === 'YES']),
      )

      for (const kind of CONTENT_KINDS) {
        const spec = DETAIL_SPECS[kind]
        if (!spec) continue
        for (const field of ENTITY_FIELDS[kind]) {
          const live = nullableOf.get(`${spec.table}.${field.key}`)
          expect(
            field.nullable,
            `${kind}.${field.key}: registry says nullable=${field.nullable}, ` +
              `${spec.table} says ${live}`,
          ).toBe(live)
        }
      }
    })
  })
})
