import type { Visibility } from '@campaign-settings/shared'
import { type Kysely, type Selectable, type SqlBool, sql } from 'kysely'
import type { WorldContext } from '../data/context'
import { type DetailSpec, ENTITY_BASE_COLUMNS } from '../data/entity-details'
import { newId } from '../db/ids'
import { jsonb } from '../db/json'
import type { Database } from '../db/schema'
import { ForbiddenError } from './errors'

const NOW = sql<Date>`now()`

/**
 * The names of world-scoped, dm_only, soft-deletable content tables — derived
 * structurally so every such table is covered automatically. Since 0005 this
 * resolves to `entities` (the shared base for the 16 kinds), the bespoke
 * `sessions`/`maps`, and the currency-attachment tables. The per-kind detail
 * tables (no `id`/`visibility`/`deleted_at`) correctly fall out.
 */
export type ContentTableName = {
  [K in keyof Database]: Database[K] extends {
    id: unknown
    world_id: unknown
    visibility: unknown
    deleted_at: unknown
  }
    ? K
    : never
}[keyof Database] &
  string

/**
 * The columns the authorization seam reasons about — common to every content
 * table. We run the query builder through this narrow view (kysely can't keep a
 * generic table name well-typed), so the security-critical filters below are
 * concretely type-checked; table-specific payload passes through opaquely.
 */
interface ContentRow {
  id: string
  world_id: string
  kind: string
  visibility: Visibility
  deleted_at: Date | string | null
  created_at: Date | string
  updated_at: Date | string
}
type ContentView = Record<string, ContentRow>

/** Narrow view of a detail table for the merge/split (opaque payload columns). */
interface DetailRow {
  entity_id: string
  world_id: string
  [column: string]: unknown
}
type DetailView = Record<string, DetailRow>

/**
 * Which ACL table holds the per-player grants for a content table, and which
 * column in it names the row being granted.
 *
 * The seam consults an ACL only for `restricted` rows. That ACL is a PARAMETER
 * rather than a constant because the grant table is foreign-keyed to the thing
 * it grants: `entity_visibility.entity_id` references `entities`, so it cannot
 * express a grant on any other content table. Without this option a table that
 * is not `entities` can only ever be `public` or `dm_only` — which is exactly
 * why a map cannot yet be shared with SOME players (suggestion 71).
 *
 * The alternatives were worse. A polymorphic `(subject_kind, subject_id)` ACL
 * would drop the foreign key, and this schema is deliberate about keeping them
 * (see migration 0014, which cascades both relationship endpoints on purpose).
 * A second ACL table with its own copy of the exists-subquery would put the
 * per-player visibility decision in two places, and a second copy of a security
 * check is how two call sites end up disagreeing about what it means.
 *
 * Both fields are SQL identifiers. They are compile-time constants declared
 * where a repo is defined — never request input — and they are rendered through
 * `sql.ref` so they are quoted rather than interpolated.
 */
export interface GrantTableSpec {
  /** The ACL table: one row per (granted row, account) pair. */
  table: string
  /** The column in that table naming the granted row — joined to `<table>.id`. */
  subjectColumn: string
}

/** The ACL every `entities`-backed repo uses, and the default when none is given. */
const DEFAULT_GRANT_TABLE: GrantTableSpec = {
  table: 'entity_visibility',
  subjectColumn: 'entity_id',
}

/** Options for a content repo: the entity kind it serves + its detail-table spec. */
export interface ContentRepoOptions {
  kind?: string | undefined
  detail?: DetailSpec | undefined
  /** Where this table's per-player grants live; defaults to `entity_visibility`. */
  grantTable?: GrantTableSpec | undefined
  /**
   * The column naming the entity this row hangs off, which enables
   * `listByParents`. A SQL identifier, declared where the repo is defined —
   * never request input.
   */
  parentColumn?: string | undefined
}

/**
 * THE owner gate. Every owner-only operation states its own name so the refusal
 * is legible, but the role comparison lives here once — a second copy is how
 * two call sites end up disagreeing about what "owner" means.
 */
export function assertWorldOwner(ctx: WorldContext, action: string): void {
  if (ctx.actor.role !== 'owner') {
    throw new ForbiddenError(`${action} requires owner role (world ${ctx.worldId})`)
  }
}

/** Writes to content are owner-only; players can never mutate domain content. */
export function assertContentWrite(ctx: WorldContext): void {
  assertWorldOwner(ctx, 'content write')
}

/** Split a write payload into base-table columns vs this kind's detail columns. */
function splitPayload(
  table: string,
  detail: DetailSpec | undefined,
  input: Record<string, unknown>,
): { base: Record<string, unknown>; detail: Record<string, unknown> } {
  // Non-entity content tables (sessions) carry their own columns — pass through.
  if (table !== 'entities') return { base: { ...input }, detail: {} }
  const base: Record<string, unknown> = {}
  const det: Record<string, unknown> = {}
  for (const col of ENTITY_BASE_COLUMNS) if (col in input) base[col] = input[col]
  if (detail) for (const col of detail.columns) if (col in input) det[col] = input[col]
  return { base, detail: det }
}

/** jsonb-wrap the array-valued detail columns (pg mistakes JS arrays for pg arrays). */
function wrapDetail(detail: DetailSpec, values: Record<string, unknown>): Record<string, unknown> {
  if (!detail.jsonbArrayColumns) return values
  const out: Record<string, unknown> = { ...values }
  for (const col of detail.jsonbArrayColumns) {
    if (col in out && Array.isArray(out[col])) out[col] = jsonb(out[col])
  }
  return out
}

/**
 * The single content-authorization seam. Every content repo is an instance of
 * this factory, so world-scoping, soft-delete hiding, the visibility read filter
 * (owner sees all; player sees `public` rows plus `restricted` rows they hold a
 * grant for; `dm_only` never), and owner-only writes are defined ONCE here and
 * never reimplemented per table/endpoint.
 *
 * Since 0005 a content kind is served by `createContentRepository('entities',
 * {kind, detail})`: `visible()` additionally filters `kind`, reads merge the
 * detail row onto the flat entity object, and writes split across base + detail
 * in one transaction. The bespoke `sessions` table is served with no detail.
 *
 * The ACL consulted for `restricted` rows is a parameter (`opts.grantTable`),
 * not a constant — `entity_visibility` is only the DEFAULT. A table whose rows
 * need per-player grants brings its own ACL, because the grant table is
 * foreign-keyed to what it grants. See `GrantTableSpec`.
 */
export function createContentRepository<TB extends ContentTableName>(
  table: TB,
  opts: ContentRepoOptions = {},
) {
  type Row = Selectable<Database[TB]>
  const { kind, detail, parentColumn } = opts
  const grant = opts.grantTable ?? DEFAULT_GRANT_TABLE
  const name: keyof ContentView = table
  const isEntities = table === 'entities'

  /**
   * Reads scoped to the world, hiding soft-deleted rows, filtered to this kind
   * (for the shared `entities` table). For players, the visibility filter admits
   * `public` rows and `restricted` rows they hold a grant for, and never
   * `dm_only`. Owners see everything. This is the ONE place the per-player
   * visibility decision is made.
   *
   * The grant lookup reads from `grant.table`, which defaults to
   * `entity_visibility` but is a per-repo parameter so a table that is not
   * `entities` can still be `restricted` — see `GrantTableSpec`.
   */
  function visible(view: Kysely<ContentView>, ctx: WorldContext) {
    let q = view
      .selectFrom(name)
      .where('world_id', '=', ctx.worldId)
      .where('deleted_at', 'is', null)
    if (isEntities && kind !== undefined) q = q.where('kind', '=', kind)
    if (ctx.actor.role !== 'owner') {
      q = q.where(
        sql<SqlBool>`(
          ${sql.ref(name)}.visibility = 'public'
          or (
            ${sql.ref(name)}.visibility = 'restricted'
            and exists (
              select 1 from ${sql.ref(grant.table)} ev
              where ev.world_id = ${ctx.worldId}
                and ${sql.ref(`ev.${grant.subjectColumn}`)} = ${sql.ref(name)}.id
                and ev.account_id = ${ctx.actor.accountId}
            )
          )
        )`,
      )
    }
    return q
  }

  /**
   * Does this row belong to the kind this repo serves?
   *
   * `visible()` carries the kind filter for every READ, but a write states its
   * own `where` clauses and so does not inherit it. That is survivable for
   * `update` and `softDelete` — the worst case is an owner renaming their own
   * NPC through the `species` URL — but not for `restore`/`purge`: without this
   * check, `DELETE /trash/species/<an npc id>` would destroy the NPC. That is
   * precisely the case a confirm dialog cannot catch, because the owner is
   * looking at a row that is not the row being deleted.
   *
   * The same gap in `update`/`softDelete` is filed separately rather than
   * widened into here — closing it there changes the behaviour of routes the
   * trash task does not touch.
   *
   * Ignores `deleted_at` on purpose: this answers only "is it this kind", and
   * the caller's own query decides whether the row must be live or trashed.
   */
  async function belongsToKind(ctx: WorldContext, id: string): Promise<boolean> {
    if (!isEntities || kind === undefined) return true
    const view = ctx.db as unknown as Kysely<ContentView>
    const row = await view
      .selectFrom(name)
      .select('id')
      .where('world_id', '=', ctx.worldId)
      .where('id', '=', id)
      .where('kind', '=', kind)
      .executeTakeFirst()
    return row !== undefined
  }

  /** Merge each row's detail columns (minus entity_id/world_id) onto it — flat. */
  async function attachDetails(
    db: Kysely<Database>,
    rows: ReadonlyArray<Record<string, unknown>>,
  ): Promise<Row[]> {
    if (!detail || rows.length === 0) return rows as unknown as Row[]
    const ids = rows.map((r) => r.id as string)
    const dview = db as unknown as Kysely<DetailView>
    const details = await dview
      .selectFrom(detail.table)
      .where('entity_id', 'in', ids)
      .selectAll()
      .execute()
    const byId = new Map(details.map((d) => [d.entity_id, d]))
    return rows.map((r) => {
      const d = byId.get(r.id as string)
      if (!d) return r
      // merge the detail columns onto the base row, minus the join key + the
      // duplicated world_id, so the API sees one flat entity object
      const merged: Record<string, unknown> = { ...r }
      for (const [col, val] of Object.entries(d)) {
        if (col !== 'entity_id' && col !== 'world_id') merged[col] = val
      }
      return merged
    }) as unknown as Row[]
  }

  return {
    async create(
      ctx: WorldContext,
      input: Record<string, unknown>,
      id: string = newId(),
    ): Promise<Row> {
      assertContentWrite(ctx)
      const { base, detail: detailInput } = splitPayload(table, detail, input)
      return ctx.db.transaction().execute(async (trx) => {
        const view = trx as unknown as Kysely<ContentView>
        const values = {
          ...base,
          id,
          world_id: ctx.worldId,
          ...(isEntities && kind !== undefined ? { kind } : {}),
        } as unknown as ContentRow
        const row = await view
          .insertInto(name)
          .values(values)
          .returningAll()
          .executeTakeFirstOrThrow()
        if (detail) {
          const dview = trx as unknown as Kysely<DetailView>
          await dview
            .insertInto(detail.table)
            .values({
              entity_id: id,
              world_id: ctx.worldId,
              ...wrapDetail(detail, detailInput),
            } as unknown as DetailRow)
            .execute()
        }
        return (await attachDetails(trx, [row as unknown as Record<string, unknown>]))[0] as Row
      })
    },

    async get(ctx: WorldContext, id: string): Promise<Row | undefined> {
      const view = ctx.db as unknown as Kysely<ContentView>
      const row = await visible(view, ctx).where('id', '=', id).selectAll().executeTakeFirst()
      if (!row) return undefined
      return (await attachDetails(ctx.db, [row as unknown as Record<string, unknown>]))[0]
    },

    async list(ctx: WorldContext): Promise<Row[]> {
      const view = ctx.db as unknown as Kysely<ContentView>
      const rows = await visible(view, ctx).selectAll().orderBy('created_at').execute()
      return attachDetails(ctx.db, rows as unknown as Record<string, unknown>[])
    },

    /**
     * The subset of `ids` the actor may see — same filter as `get`, one query.
     *
     * Exists so a surface that references content by id (a map's pins, a typed
     * relationship's endpoints) can resolve a batch of them WITHOUT reaching
     * around the seam. The alternative shapes are both worse: listing every row
     * in the world and intersecting reads far more than asked, and calling
     * `get` per id turns one page into N round trips. Both are also easy to get
     * subtly wrong in a way that leaks, which is precisely why the filter lives
     * here and not at the call site.
     */
    async listByIds(ctx: WorldContext, ids: readonly string[]): Promise<Row[]> {
      if (ids.length === 0) return []
      const view = ctx.db as unknown as Kysely<ContentView>
      const rows = await visible(view, ctx)
        .where('id', 'in', [...ids])
        .selectAll()
        .orderBy('created_at')
        .execute()
      return attachDetails(ctx.db, rows as unknown as Record<string, unknown>[])
    },

    /**
     * Every visible row hanging off any of `parentIds` — same filter as `list`,
     * one query, in `created_at` order.
     *
     * The sibling of `listByIds`, for the other direction. `listByIds` answers
     * "which of THESE rows may I see"; this answers "which rows belonging to
     * these PARENTS may I see", which is what composing an entity's prose (or a
     * list of fifty entities' prose) needs. Doing it per parent would turn one
     * page into N queries, and doing it outside the seam would mean writing the
     * visibility filter a second time — the reason `listByIds` exists at all.
     *
     * Requires `opts.parentColumn`; a repo without one has no parent to filter
     * on and calling this is a programming error rather than an empty result.
     */
    async listByParents(ctx: WorldContext, parentIds: readonly string[]): Promise<Row[]> {
      if (parentColumn === undefined) {
        throw new Error(`listByParents on '${table}' requires a parentColumn option`)
      }
      if (parentIds.length === 0) return []
      const view = ctx.db as unknown as Kysely<ContentView>
      const rows = await visible(view, ctx)
        .where(sql.ref(parentColumn), 'in', [...parentIds])
        .selectAll()
        .orderBy('created_at')
        .execute()
      return attachDetails(ctx.db, rows as unknown as Record<string, unknown>[])
    },

    async update(
      ctx: WorldContext,
      id: string,
      patch: Record<string, unknown>,
    ): Promise<Row | undefined> {
      assertContentWrite(ctx)
      const { base, detail: detailInput } = splitPayload(table, detail, patch)
      return ctx.db.transaction().execute(async (trx) => {
        const view = trx as unknown as Kysely<ContentView>
        const row = await view
          .updateTable(name)
          .set({ ...base, updated_at: NOW } as unknown as ContentRow)
          .where('world_id', '=', ctx.worldId)
          .where('id', '=', id)
          .where('deleted_at', 'is', null)
          .returningAll()
          .executeTakeFirst()
        if (!row) return undefined
        if (detail && Object.keys(detailInput).length > 0) {
          const dview = trx as unknown as Kysely<DetailView>
          await dview
            .updateTable(detail.table)
            .set(wrapDetail(detail, detailInput) as unknown as DetailRow)
            .where('entity_id', '=', id)
            .execute()
        }
        return (await attachDetails(trx, [row as unknown as Record<string, unknown>]))[0] as Row
      })
    },

    /** Soft-delete; returns whether a live row was actually deleted. */
    async softDelete(ctx: WorldContext, id: string): Promise<boolean> {
      assertContentWrite(ctx)
      const view = ctx.db as unknown as Kysely<ContentView>
      const res = await view
        .updateTable(name)
        .set({ deleted_at: NOW } as unknown as ContentRow)
        .where('world_id', '=', ctx.worldId)
        .where('id', '=', id)
        .where('deleted_at', 'is', null)
        .executeTakeFirstOrThrow()
      return res.numUpdatedRows > 0n
    },

    /**
     * The soft-deleted rows — the exact complement of `list`, and the only read
     * door that returns them.
     *
     * Deliberately NOT routed through `visible()`. That builder's whole purpose
     * is hiding these rows, and adding a "unless you are looking in the trash"
     * branch to it would put a second mode into the one query every read in the
     * app depends on. So this states its own filter, and states it narrowly:
     * `assertWorldOwner` first, then world scope and kind. There is no
     * player-visibility clause because there is no player case — a player has no
     * door to this at all, and one that returned "the deleted rows you were
     * allowed to see" would be a feature nobody asked for guarding a list of
     * things that are supposed to be gone.
     *
     * Ordered newest-deleted first: a trash list is read to undo the last
     * mistake far more often than to browse.
     */
    async listDeleted(ctx: WorldContext): Promise<Row[]> {
      assertWorldOwner(ctx, 'trash read')
      const view = ctx.db as unknown as Kysely<ContentView>
      let q = view
        .selectFrom(name)
        .where('world_id', '=', ctx.worldId)
        .where('deleted_at', 'is not', null)
      if (isEntities && kind !== undefined) q = q.where('kind', '=', kind)
      const rows = await q.selectAll().orderBy('deleted_at', 'desc').execute()
      return attachDetails(ctx.db, rows as unknown as Record<string, unknown>[])
    },

    /**
     * Clear `deleted_at`, putting the row back exactly as it was.
     *
     * Nothing else is touched — in particular `visibility` is not reset to a
     * safe default. A `dm_only` page that came back `public` would be a
     * disclosure caused by an undo, which is the worst possible time for one;
     * the row's own visibility column survived the soft delete untouched and is
     * still the right answer.
     *
     * `updated_at` is left alone too. Restoring is not an edit to the content,
     * and moving the timestamp would misreport when the prose last changed.
     *
     * Returns false when no soft-deleted row matched, so the route can 404
     * rather than report success for a row that is live, purged, or someone
     * else's.
     */
    async restore(ctx: WorldContext, id: string): Promise<boolean> {
      assertWorldOwner(ctx, 'restore')
      if (!(await belongsToKind(ctx, id))) return false
      const view = ctx.db as unknown as Kysely<ContentView>
      const res = await view
        .updateTable(name)
        .set({ deleted_at: null } as unknown as ContentRow)
        .where('world_id', '=', ctx.worldId)
        .where('id', '=', id)
        .where('deleted_at', 'is not', null)
        .executeTakeFirstOrThrow()
      return res.numUpdatedRows > 0n
    },

    /**
     * Hard-delete a row that is ALREADY in the trash. Irreversible.
     *
     * The `deleted_at is not null` guard is the load-bearing part: it means the
     * only way to destroy content is to delete it and then destroy it, two
     * deliberate acts. A purge route that accepted a live id would turn one
     * mistyped request into permanent data loss with no intermediate state to
     * catch it.
     *
     * This does NOT clean up what points at the row — see `data/trash.ts`, which
     * wraps this in the transaction that does. That split is on purpose: the
     * cleanup is specific to what `entities` is referenced BY, and teaching the
     * generic table factory about `npc_details.species_id` would make every
     * future content table inherit knowledge that is true of exactly one.
     */
    async purge(ctx: WorldContext, id: string): Promise<boolean> {
      assertWorldOwner(ctx, 'purge')
      if (!(await belongsToKind(ctx, id))) return false
      const view = ctx.db as unknown as Kysely<ContentView>
      const res = await view
        .deleteFrom(name)
        .where('world_id', '=', ctx.worldId)
        .where('id', '=', id)
        .where('deleted_at', 'is not', null)
        .executeTakeFirstOrThrow()
      return res.numDeletedRows > 0n
    },
  }
}
