import type { Visibility } from '@campaign-settings/shared'
import { type Kysely, sql } from 'kysely'
import { assertContentWrite, createContentRepository } from '../authz/content'
import { newId } from '../db/ids'
import type { Database } from '../db/schema'
import type { WorldContext } from './context'

/**
 * Which currencies a settlement or an organization uses.
 *
 * ## The visibility rule, and why BOTH halves are required
 *
 * This is the FIRST module in the codebase that needs both of the visibility
 * patterns at once. Every other surface needs exactly one, so a later reader who
 * recognises one of them will otherwise assume it is the whole rule — and each
 * half alone is a leak.
 *
 * 1. THE ROW'S OWN VISIBILITY. Unlike a typed relationship, an attachment row
 *    carries `visibility` and `deleted_at` — it IS a `ContentTableName`. So the
 *    content seam covers it with no per-table code, and nothing here hand-rolls
 *    a `visibility` filter. (Contrast `data/calendars.ts`, which is deliberately
 *    OFF the seam with open reads: right for world config, where the shape being
 *    authorized is the world's NAME, and wrong here.)
 *
 * 2. THE CURRENCY IT NAMES. A `public` attachment pointing at a `dm_only`
 *    currency would disclose that currency's name and its existence — the coin
 *    the party has never heard of, listed on a settlement's page. The seam has no
 *    opinion about this, because a row's own visibility says nothing about its
 *    endpoint's. So every read resolves the currency through the seam's
 *    `listByIds` and DROPS THE ROW WHOLE when it does not come back, exactly as
 *    `data/relationships.ts` and `data/map-pins.ts` do. Not a row with the name
 *    blanked: "this settlement uses a currency you may not know about" is still
 *    the disclosure.
 *
 * Half 1 without half 2 leaks the hidden currency. Half 2 without half 1 shows a
 * `dm_only` attachment naming a public currency — where the secret is not the
 * coin but WHO uses it. Both, always, and in both directions of the read.
 *
 * ## Why not fold these into `entity_relationships`
 *
 * Chain 398 task 4 folded nine dormant junction tables into the one typed
 * relationship table and examined these two for the same treatment, refusing it
 * in writing (migration 0017): they carry `visibility` and `deleted_at`, and that
 * table deliberately has neither. The fold would destroy per-row visibility and
 * soft-delete, and `is_primary` has no home there either.
 *
 * ## `restricted` is not offered
 *
 * The seam consults an ACL for `restricted` rows, and an ACL is foreign-keyed to
 * what it grants (`GrantTableSpec` in authz/content.ts). No table can hold a
 * grant naming an attachment row, so `restricted` here would behave exactly like
 * `dm_only` — the situation maps were in before 0016, where the route refused the
 * value rather than sell a level that is not real. If an importer ever writes it,
 * the seam's grant subquery matches nothing and the row is hidden: fails closed.
 */

/** The two owner kinds an attachment hangs off. */
export const ATTACHMENT_OWNER_KINDS = ['settlement', 'organization'] as const
export type AttachmentOwnerKind = (typeof ATTACHMENT_OWNER_KINDS)[number]

export const isAttachmentOwnerKind = (kind: string): kind is AttachmentOwnerKind =>
  (ATTACHMENT_OWNER_KINDS as readonly string[]).includes(kind)

/** The visibility levels an attachment may hold — see "restricted is not offered". */
export const ATTACHMENT_VISIBILITIES = ['public', 'dm_only'] as const

/** The table an owner kind's attachments live in, and the column naming the owner. */
interface OwnerSpec {
  table: 'settlement_currency_attachments' | 'organization_currency_attachments'
  ownerColumn: 'settlement_id' | 'organization_id'
}

/**
 * One spec per owner kind. The two tables are structurally identical apart from
 * the owner column, so every function below is written once against a spec
 * rather than twice against a table — the shape 0017 and chain 398 task 4 both
 * chose over per-kind duplication.
 */
const SPECS: Readonly<Record<AttachmentOwnerKind, OwnerSpec>> = {
  settlement: { table: 'settlement_currency_attachments', ownerColumn: 'settlement_id' },
  organization: { table: 'organization_currency_attachments', ownerColumn: 'organization_id' },
}

/**
 * Half 1 of the rule, twice per table.
 *
 * Both instances are the same seam over the same table; they differ only in which
 * column `listByParents` filters on, which is what lets the forward read (an
 * owner's currencies) and the INVERSE read (a currency's owners) each be one
 * world-scoped, visibility-filtered query. The alternative — one instance plus a
 * `.filter()` in TypeScript — would read every attachment row in the world to
 * answer a question about one settlement.
 *
 * `get` / `update` / `delete` reach rows by id, where the parent column is
 * irrelevant, so they go through `BY_OWNER`.
 */
const BY_OWNER = {
  settlement: createContentRepository('settlement_currency_attachments', {
    parentColumn: 'settlement_id',
  }),
  organization: createContentRepository('organization_currency_attachments', {
    parentColumn: 'organization_id',
  }),
} as const

const BY_CURRENCY = {
  settlement: createContentRepository('settlement_currency_attachments', {
    parentColumn: 'currency_id',
  }),
  organization: createContentRepository('organization_currency_attachments', {
    parentColumn: 'currency_id',
  }),
} as const

/** The seam instance every endpoint — currency or owner — is resolved through. */
const entities = createContentRepository('entities')

/** An attachment as an owner's page reads it. */
export interface CurrencyAttachmentView {
  id: string
  ownerId: string
  isPrimary: boolean
  notes: string
  visibility: Visibility
  /** The currency this row names, already proven visible to this actor. */
  currency: { id: string; name: string }
}

/** An owner that uses a currency — one row of the currency page's inverse list. */
export interface CurrencyUserView {
  attachmentId: string
  ownerKind: AttachmentOwnerKind
  ownerId: string
  ownerName: string
  isPrimary: boolean
  notes: string
  visibility: Visibility
}

export interface NewCurrencyAttachment {
  currencyId: string
  isPrimary?: boolean | undefined
  notes?: string | undefined
  visibility?: Visibility | undefined
}

export interface CurrencyAttachmentPatch {
  isPrimary?: boolean | undefined
  notes?: string | undefined
  visibility?: Visibility | undefined
}

/** Raised when the owner or the currency is absent, invisible, or the wrong kind. */
export class AttachmentEndpointNotFoundError extends Error {
  constructor(what: string) {
    super(`that ${what} does not exist in this world`)
    this.name = 'AttachmentEndpointNotFoundError'
  }
}

/** Raised when this owner already holds a live attachment to this currency. */
export class DuplicateAttachmentError extends Error {
  constructor() {
    super('that currency is already attached here')
    this.name = 'DuplicateAttachmentError'
  }
}

/** The columns every read below reasons about; the seam types its rows opaquely. */
interface AttachmentRow {
  id: string
  currency_id: string
  is_primary: boolean
  notes: string
  visibility: Visibility
}

const asRow = (row: unknown): AttachmentRow => row as AttachmentRow
const ownerIdOf = (row: unknown, spec: OwnerSpec): string =>
  String((row as Record<string, unknown>)[spec.ownerColumn] ?? '')

/** A loose view for the dynamic-table writes — the seam uses the same cast idiom. */
type LooseView = Record<string, Record<string, unknown>>
const loose = (db: Kysely<Database>): Kysely<LooseView> => db as unknown as Kysely<LooseView>

/** An entity reduced to what a panel renders. */
interface EntityRef {
  id: string
  name: string
}

/**
 * Resolve a batch of ids through the seam and keep only those of `kind` — one
 * query, and half 2 of the visibility rule wherever it is applied.
 *
 * The kind check is not decoration. Since 0005 every kind shares the `entities`
 * base table, so `currency_id` is foreign-keyed to `entities` and the database
 * would accept an NPC's id there; the seam proves VISIBILITY, not kind. Without
 * this filter a mis-seeded row could put an NPC in the currency slot and the
 * panel would render its name as a coin.
 */
async function visibleOfKind(
  ctx: WorldContext,
  kind: string,
  ids: readonly string[],
): Promise<Map<string, EntityRef>> {
  if (ids.length === 0) return new Map()
  const rows = await entities.listByIds(ctx, [...new Set(ids)])
  const out = new Map<string, EntityRef>()
  for (const row of rows) {
    const e = row as unknown as { id: string; kind: string; name: string }
    if (e.kind === kind) out.set(e.id, { id: e.id, name: e.name })
  }
  return out
}

/**
 * Prove an owner id names a live, visible entity OF THIS KIND.
 *
 * A 404 rather than a 400 when the kind is wrong: from the caller's side an id of
 * the wrong kind is indistinguishable from one that does not exist, and
 * distinguishing them would report that the id exists as something else.
 */
async function requireOwner(
  ctx: WorldContext,
  ownerKind: AttachmentOwnerKind,
  ownerId: string,
): Promise<void> {
  if (!(await visibleOfKind(ctx, ownerKind, [ownerId])).has(ownerId)) {
    throw new AttachmentEndpointNotFoundError(ownerKind)
  }
}

/**
 * The currencies attached to one owner, filtered by both halves of the rule.
 *
 * `listByParents` applies half 1 (each row's own visibility, plus world scope and
 * soft-delete) in one query; `toViews` applies half 2 and drops whole the rows
 * whose currency does not come back.
 */
export async function listAttachmentsForOwner(
  ctx: WorldContext,
  ownerKind: AttachmentOwnerKind,
  ownerId: string,
): Promise<CurrencyAttachmentView[]> {
  await requireOwner(ctx, ownerKind, ownerId)
  const rows = await BY_OWNER[ownerKind].listByParents(ctx, [ownerId])
  return toViews(ctx, SPECS[ownerKind], rows)
}

/** Build the views, dropping every row whose currency the actor may not see. */
async function toViews(
  ctx: WorldContext,
  spec: OwnerSpec,
  rows: readonly unknown[],
): Promise<CurrencyAttachmentView[]> {
  if (rows.length === 0) return []
  const currencies = await visibleOfKind(
    ctx,
    'currency',
    rows.map((r) => asRow(r).currency_id),
  )
  const out: CurrencyAttachmentView[] = []
  for (const raw of rows) {
    const row = asRow(raw)
    const currency = currencies.get(row.currency_id)
    // No visible currency → the attachment does not exist for this actor. Not a
    // row with the name removed: "uses a currency you cannot see" still reports
    // that the currency exists.
    if (!currency) continue
    out.push({
      id: row.id,
      ownerId: ownerIdOf(raw, spec),
      isPrimary: row.is_primary,
      notes: row.notes,
      visibility: row.visibility,
      currency,
    })
  }
  // Primary first, then by currency name — the panel's reading order, decided
  // here so the two owner kinds cannot come to sort differently.
  return out.sort(
    (a, b) =>
      Number(b.isPrimary) - Number(a.isPrimary) || a.currency.name.localeCompare(b.currency.name),
  )
}

/**
 * The settlements and organizations that use a given currency — the INVERSE
 * read, and the cross-reference section chain 398 asked for and never got for
 * these two tables.
 *
 * Both halves apply again with the roles swapped. Half 1 is the seam's own filter
 * over the attachment rows; half 2 resolves the OWNERS through the seam, because
 * a player reading a public currency's page must not learn that a `dm_only`
 * settlement uses it — that reports the settlement's name and existence just as
 * surely as the forward direction would report the currency's. The currency
 * itself is already settled: the caller is reading its page.
 */
export async function listOwnersOfCurrency(
  ctx: WorldContext,
  currencyId: string,
): Promise<CurrencyUserView[]> {
  const out: CurrencyUserView[] = []
  for (const ownerKind of ATTACHMENT_OWNER_KINDS) {
    const spec = SPECS[ownerKind]
    const rows = await BY_CURRENCY[ownerKind].listByParents(ctx, [currencyId])
    const owners = await visibleOfKind(
      ctx,
      ownerKind,
      rows.map((r) => ownerIdOf(r, spec)),
    )
    for (const raw of rows) {
      const row = asRow(raw)
      const ownerId = ownerIdOf(raw, spec)
      const owner = owners.get(ownerId)
      if (!owner) continue
      out.push({
        attachmentId: row.id,
        ownerKind,
        ownerId,
        ownerName: owner.name,
        isPrimary: row.is_primary,
        notes: row.notes,
        visibility: row.visibility,
      })
    }
  }
  // Primary users first, then alphabetically: a currency page is read to find who
  // mints or backs it far more often than to browse everyone who accepts it.
  return out.sort(
    (a, b) => Number(b.isPrimary) - Number(a.isPrimary) || a.ownerName.localeCompare(b.ownerName),
  )
}

/**
 * Attach a currency to an owner (owner-only).
 *
 * Both endpoints are resolved through the seam BEFORE the insert, so an
 * attachment can never be created against something the actor cannot see — which,
 * for an owner, means something that does not exist in this world.
 */
export async function attachCurrency(
  ctx: WorldContext,
  ownerKind: AttachmentOwnerKind,
  ownerId: string,
  input: NewCurrencyAttachment,
): Promise<CurrencyAttachmentView> {
  assertContentWrite(ctx)
  await requireOwner(ctx, ownerKind, ownerId)
  const currency = (await visibleOfKind(ctx, 'currency', [input.currencyId])).get(input.currencyId)
  if (!currency) throw new AttachmentEndpointNotFoundError('currency')

  const spec = SPECS[ownerKind]
  const id = newId()
  try {
    const row = await ctx.db.transaction().execute(async (trx) => {
      if (input.isPrimary === true) await clearPrimary(trx, ctx, spec, ownerId, id)
      return loose(trx)
        .insertInto(spec.table)
        .values({
          id,
          world_id: ctx.worldId,
          [spec.ownerColumn]: ownerId,
          currency_id: input.currencyId,
          ...(input.isPrimary === undefined ? {} : { is_primary: input.isPrimary }),
          ...(input.notes === undefined ? {} : { notes: input.notes }),
          ...(input.visibility === undefined ? {} : { visibility: input.visibility }),
        })
        .returningAll()
        .executeTakeFirstOrThrow()
    })
    // Built from what the insert returned rather than by reading the row back:
    // the defaults (`notes`, `visibility`) live in the schema, and re-deriving
    // them here would be a second copy that can drift from the DDL.
    const stored = asRow(row)
    return {
      id,
      ownerId,
      isPrimary: stored.is_primary,
      notes: stored.notes,
      visibility: stored.visibility,
      currency,
    }
  } catch (err) {
    // `<table>_unique_pair` — a partial unique index on (owner, currency) where
    // `deleted_at is null`, shipped in 0001 and never enforced by anything until
    // this module existed — is what actually prevents a double-click from
    // attaching the same currency twice. A check-then-insert here could not: two
    // concurrent attaches would both see nothing and both proceed. Translating it
    // means the panel gets a sentence rather than a 500 naming an index.
    //
    // REFUSED rather than treated as a no-op: a silent success would report that
    // the `notes` and `is_primary` the caller sent had been applied when they
    // had not.
    if (isUniqueViolation(err)) throw new DuplicateAttachmentError()
    throw err
  }
}

/**
 * Edit an attachment's `is_primary` / `notes` / `visibility` (owner-only).
 * Returns undefined when no live attachment of this owner kind has that id.
 *
 * The row is resolved through the seam FIRST, so what may be edited is decided by
 * the same filter that decides what may be read, and the write below is scoped by
 * world and id exactly as `data/map-pins.ts` scopes its own.
 */
export async function updateAttachment(
  ctx: WorldContext,
  ownerKind: AttachmentOwnerKind,
  id: string,
  patch: CurrencyAttachmentPatch,
): Promise<CurrencyAttachmentView | undefined> {
  assertContentWrite(ctx)
  const spec = SPECS[ownerKind]
  const existing = await BY_OWNER[ownerKind].get(ctx, id)
  if (!existing) return undefined
  const ownerId = ownerIdOf(existing, spec)

  const updated = await ctx.db.transaction().execute(async (trx) => {
    // Both in ONE transaction: a promotion that demoted the old primary and then
    // failed would leave the owner with no primary at all.
    if (patch.isPrimary === true) await clearPrimary(trx, ctx, spec, ownerId, id)
    return loose(trx)
      .updateTable(spec.table)
      .set({
        ...(patch.isPrimary === undefined ? {} : { is_primary: patch.isPrimary }),
        ...(patch.notes === undefined ? {} : { notes: patch.notes }),
        ...(patch.visibility === undefined ? {} : { visibility: patch.visibility }),
        updated_at: sql`now()`,
      })
      .where('world_id', '=', ctx.worldId)
      .where('id', '=', id)
      .where('deleted_at', 'is', null)
      .returningAll()
      .executeTakeFirst()
  })
  if (!updated) return undefined
  return (await toViews(ctx, spec, [updated]))[0]
}

/**
 * At most one primary currency per OWNER — cleared inside the caller's
 * transaction, so a promotion can never leave two primaries or none.
 *
 * The DATABASE is what enforces the invariant: `<table>_one_primary` is a partial
 * unique index on the owner column `where is_primary and deleted_at is null`,
 * shipped in 0001. So this is not a second copy of the rule — it is what makes
 * the SWAP expressible at all. Without it, promoting a second currency inserts a
 * row the index refuses, and the caller sees a constraint violation rather than
 * the obvious thing happening.
 *
 * Which is why it runs inside the caller's transaction and not before it: demote
 * and promote have to land together or not at all, or a failure between them
 * leaves the owner with no primary.
 *
 * Scoped by BOTH `world_id` and the owner column. The owner alone would be enough
 * today (ids are globally unique, so an owner already implies its world) and the
 * index itself does not name `world_id` either, but every other write in this
 * codebase is world-scoped and a filter that is merely redundant is the one
 * nobody notices has become load-bearing.
 */
async function clearPrimary(
  trx: Kysely<Database>,
  ctx: WorldContext,
  spec: OwnerSpec,
  ownerId: string,
  exceptId: string,
): Promise<void> {
  await loose(trx)
    .updateTable(spec.table)
    .set({ is_primary: false, updated_at: sql`now()` })
    .where('world_id', '=', ctx.worldId)
    .where(sql.ref(spec.ownerColumn), '=', ownerId)
    .where('id', '!=', exceptId)
    .where('deleted_at', 'is', null)
    .execute()
}

/**
 * Detach a currency (owner-only). Returns whether a row was actually removed.
 *
 * HARD delete, unlike every other `ContentTableName` write. An attachment is a
 * link rather than authored content: losing one costs a re-attach, not prose, and
 * there is no trash surface that could ever restore one — a soft-deleted
 * attachment would be a row that is invisible, unreachable, and — but for the
 * fact that `<table>_unique_pair` is partial on `deleted_at is null` — holding
 * its (owner, currency) pair against a future re-attach. That partial scope
 * exists for the rows the IMPORTER and `change-kind.ts` soft-delete, which is a
 * different population and one this module never creates.
 *
 * Resolved through the seam FIRST rather than deleted blind, so the visibility
 * filter decides what exists before anything is destroyed.
 */
export async function detachCurrency(
  ctx: WorldContext,
  ownerKind: AttachmentOwnerKind,
  id: string,
): Promise<boolean> {
  assertContentWrite(ctx)
  if (!(await BY_OWNER[ownerKind].get(ctx, id))) return false
  const res = await loose(ctx.db)
    .deleteFrom(SPECS[ownerKind].table)
    .where('world_id', '=', ctx.worldId)
    .where('id', '=', id)
    .executeTakeFirstOrThrow()
  return res.numDeletedRows > 0n
}

/** Postgres reports a unique-index collision as SQLSTATE 23505. */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505'
}
