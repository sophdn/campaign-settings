import type { FastifyInstance, HTTPMethods } from 'fastify'
import { Kysely, PostgresDialect } from 'kysely'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ContentTableName } from '../authz/content'
import { createScryptAuth } from '../auth/service'
import type { Database } from '../db/schema'
import { openFlags } from '../flags/config'
import { buildApp } from '../http/app'
import { ENTITY_REPOS } from './content-repos'

/**
 * THE DORMANT-TABLE GATE. Every content table must have a door, or say why not.
 *
 * Chain 398 found dormant tables twice and both times by accident. Task 4 found
 * nine junction tables written only by the importer and reachable from no route
 * or UI; closing the chain found two more — the currency attachments — the same
 * way. Both discoveries were incidental to other work, and both tables had been
 * dormant for months. There is no reason a third occurrence should also be found
 * by luck.
 *
 * The structure is copied from `entity-fields-parity.test.ts` (chain 398 task 1)
 * rather than invented: a hand-declared map, a coverage test that fails on an
 * entry with neither a door nor an exemption, and a STALE-EXEMPTION test so the
 * exemption list cannot quietly become a graveyard.
 *
 * ## What "reachable" is defined as, and why not something broader
 *
 * A content table is REACHABLE when the declaration below names at least one
 * route that (a) EXISTS in the built app's router, verified through Fastify's own
 * `hasRoute`, and (b) says HOW that route reaches the table — either by a
 * dedicated path, or by a `:kind` path segment resolved through `ENTITY_REPOS`,
 * in which case the named kind must be a live key of that registry.
 *
 * What this deliberately does NOT assert is that the route's handler BODY touches
 * the table. Nothing can check that without either a brittle grep of route files
 * — a table named in a file is not proof it is readable, and a table absent from
 * one may still be reached through a generic repo, which is exactly the case for
 * `entities` and `sessions` here — or a runtime trace that would turn a
 * structural gate into an integration suite. A gate that fails spuriously gets
 * weakened or deleted, which is worse than no gate, so this asserts the narrower
 * thing that is TRUE.
 *
 * The narrower claim still catches the failure that actually happened twice: a
 * table with no declared door at all. It also catches the next one — a door that
 * is renamed or deleted while the declaration still claims it, because `hasRoute`
 * is checked against the real router rather than against a comment.
 *
 * ## Why the exhaustiveness is a COMPILE-time check
 *
 * `ContentTableName` is a structural type derived from `Database` — a table
 * becomes one by growing `id`/`world_id`/`visibility`/`deleted_at`, with nothing
 * to add to a list. Typing the map as `Record<ContentTableName, …>` is therefore
 * the only enumeration that cannot drift: a missing key and a key that is not a
 * content table are both `tsc` errors, so adding such a table to `db/schema.ts`
 * fails the build here until it is given a door or an exemption — at the
 * migration, not months later and by accident.
 */

/** How a route reaches its table. */
interface Door {
  method: HTTPMethods
  url: string
  /**
   * Set when the route reaches the table through the `:kind` segment rather than
   * a dedicated path — `ENTITY_REPOS[kind]` is the repo, so the KIND is the part
   * that has to still exist. `entities` and `sessions` share one route and are
   * told apart by exactly this.
   */
  viaEntityKind?: string
}

/**
 * Every content table's read door. One is enough to prove the table is not
 * dormant; the write doors are not enumerated, because a table nothing can READ
 * is the shape both dormant discoveries actually took.
 */
const CONTENT_TABLE_DOORS: Readonly<Record<ContentTableName, readonly Door[]>> = {
  entities: [
    { method: 'GET', url: '/api/worlds/:worldId/entities/:kind', viaEntityKind: 'npc' },
    { method: 'GET', url: '/api/worlds/:worldId/entities/:kind/:id', viaEntityKind: 'npc' },
  ],
  // The same route as `entities`, dispatched on the `:kind` segment. Sessions are
  // a bespoke table riding the content seam; `ENTITY_REPOS` is where that join is
  // made, so the registry key is what this asserts.
  sessions: [
    { method: 'GET', url: '/api/worlds/:worldId/entities/:kind', viaEntityKind: 'session' },
  ],
  maps: [
    { method: 'GET', url: '/api/worlds/:worldId/maps' },
    { method: 'GET', url: '/api/worlds/:worldId/maps/:id' },
  ],
  entity_passages: [{ method: 'GET', url: '/api/worlds/:worldId/entities/:kind/:id/passages' }],
  // Dormant from 0001 until chain 455 gave them these. The gate exists because of
  // them, so they are the first entries anyone reading it should see.
  settlement_currency_attachments: [
    { method: 'GET', url: '/api/worlds/:worldId/entities/:kind/:id/currencies' },
    { method: 'GET', url: '/api/worlds/:worldId/currencies/:id/users' },
  ],
  organization_currency_attachments: [
    { method: 'GET', url: '/api/worlds/:worldId/entities/:kind/:id/currencies' },
    { method: 'GET', url: '/api/worlds/:worldId/currencies/:id/users' },
  ],
}

/**
 * Content tables that are deliberately unreachable, and why.
 *
 * EMPTY, and that is a fact about the tree rather than an omission: after chain
 * 455 every content table has a door. A future entry needs a real sentence — the
 * reason is the whole value of the exemption, and "not yet" is not one.
 *
 * The two rules that govern this map are both tested below against synthetic
 * inputs rather than only against this map, so neither is dormant while the map
 * is empty. A rule that only runs when someone happens to add an exemption is a
 * rule nobody knows still works.
 */
const DELIBERATELY_UNREACHABLE: Partial<Record<ContentTableName, string>> = {}

// ── the checker, as a pure function so both rules can be tested directly ─────

interface Verdict {
  /** Tables with neither a door nor an exemption — the dormant-table case. */
  undeclared: string[]
  /** Exemptions for tables that DO have a door — the stale-exemption case. */
  stale: string[]
  /** Exemptions whose reason is missing or a placeholder. */
  reasonless: string[]
}

/** A reason has to be a sentence someone wrote, not a shrug. */
const PLACEHOLDERS = ['', 'todo', 'tbd', 'n/a', 'na', 'not yet', 'unknown', '-']

export function checkReachability(
  doors: Readonly<Record<string, readonly Door[]>>,
  exemptions: Readonly<Record<string, string | undefined>>,
): Verdict {
  const verdict: Verdict = { undeclared: [], stale: [], reasonless: [] }
  for (const [table, list] of Object.entries(doors)) {
    const exemption = exemptions[table]
    if (list.length === 0 && exemption === undefined) verdict.undeclared.push(table)
    if (list.length > 0 && exemption !== undefined) verdict.stale.push(table)
  }
  for (const [table, reason] of Object.entries(exemptions)) {
    if (PLACEHOLDERS.includes((reason ?? '').trim().toLowerCase())) verdict.reasonless.push(table)
  }
  return verdict
}

// ── the gate ────────────────────────────────────────────────────────────────

/**
 * The app, built with a pg pool that is never queried.
 *
 * Registering routes touches no connection, and this gate asks the ROUTER a
 * question rather than the database. Standing a Postgres up for it would make a
 * structural check fail whenever the container is down, which is precisely the
 * kind of spurious failure that gets a gate deleted.
 */
let app: FastifyInstance

beforeAll(async () => {
  const db = new Kysely<Database>({
    dialect: new PostgresDialect({ pool: {} as unknown as Pool }),
  })
  app = buildApp({
    db,
    auth: createScryptAuth(db),
    cookieSecret: 'test-secret-test-secret-test-secret',
    cookieSecure: false,
    flags: openFlags(),
  })
  await app.ready()
})

afterAll(async () => {
  await app.close()
})

describe('every content table has a door, or says why not', () => {
  it('declares a door or an exemption for each one', () => {
    // The union itself is enforced by `satisfies` at compile time; this is the
    // runtime half — an entry declared with an empty list and no exemption.
    const { undeclared } = checkReachability(CONTENT_TABLE_DOORS, DELIBERATELY_UNREACHABLE)
    expect(undeclared, 'content tables with no route and no exemption').toEqual([])
  })

  it('every declared door is a route that actually exists', () => {
    // Against the real router, not against a comment: renaming a path in
    // `app.ts` without updating the declaration fails here.
    for (const [table, doors] of Object.entries(CONTENT_TABLE_DOORS)) {
      for (const door of doors) {
        expect(
          app.hasRoute({ method: door.method, url: door.url }),
          `${table} claims ${door.method} ${door.url}, which is not a registered route`,
        ).toBe(true)
      }
    }
  })

  it('every door reached through a :kind segment names a live repo', () => {
    // The other half of the `:kind` case. `entities` and `sessions` share a route
    // path, so the path alone proves nothing about sessions — the registry key is
    // what makes that door real, and dropping it from `ENTITY_REPOS` would make
    // the table unreachable while the path still resolved.
    for (const [table, doors] of Object.entries(CONTENT_TABLE_DOORS)) {
      for (const door of doors) {
        if (door.viaEntityKind === undefined) continue
        expect(
          Object.keys(ENTITY_REPOS),
          `${table} is reached as kind '${door.viaEntityKind}', which no repo serves`,
        ).toContain(door.viaEntityKind)
      }
    }
  })

  it('rejects a STALE exemption — one for a table that is now reachable', () => {
    const { stale } = checkReachability(CONTENT_TABLE_DOORS, DELIBERATELY_UNREACHABLE)
    expect(stale, 'exemptions for tables that now have a route').toEqual([])
  })

  it('every exemption carries a real reason', () => {
    const { reasonless } = checkReachability(CONTENT_TABLE_DOORS, DELIBERATELY_UNREACHABLE)
    expect(reasonless, 'exemptions with a placeholder reason').toEqual([])
  })
})

describe('the checker itself, on inputs the tree does not currently have', () => {
  /*
    The three rules above all pass trivially today: every content table has a
    door and the exemption map is empty. Testing them only against the live map
    would leave every one of them unexercised — a gate that has never once
    fired, which is indistinguishable from a gate that does not work.

    So the rules are also run against synthetic inputs here. This is what makes
    the stale-exemption rule real BEFORE the first exemption is ever written,
    rather than the day someone adds one and discovers it never checked anything.
  */
  const DOOR: Door = { method: 'GET', url: '/api/worlds/:worldId/maps' }

  it('catches a table with no door and no exemption — the dormant-table case', () => {
    expect(checkReachability({ dormant_table: [] }, {}).undeclared).toEqual(['dormant_table'])
  })

  it('accepts a table with no door WHEN it is exempted with a reason', () => {
    const verdict = checkReachability(
      { dormant_table: [] },
      { dormant_table: 'written by the importer only, pending a decision on whether it survives' },
    )
    expect(verdict).toEqual({ undeclared: [], stale: [], reasonless: [] })
  })

  it('catches a stale exemption — the table has a door again', () => {
    const verdict = checkReachability({ maps: [DOOR] }, { maps: 'unreachable' })
    expect(verdict.stale).toEqual(['maps'])
  })

  it('catches a placeholder reason', () => {
    for (const reason of ['', '  ', 'TODO', 'tbd', 'not yet']) {
      expect(checkReachability({ t: [] }, { t: reason }).reasonless).toEqual(['t'])
    }
  })

  it('passes a tree where everything has a door', () => {
    expect(checkReachability({ maps: [DOOR] }, {})).toEqual({
      undeclared: [],
      stale: [],
      reasonless: [],
    })
  })
})
