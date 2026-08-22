import type { Visibility } from '@campaign-settings/shared'
import { assertContentWrite, createContentRepository } from '../authz/content'
import { newId } from '../db/ids'
import type { PassageStatus } from '../db/schema'
import type { WorldContext } from './context'

/**
 * Passages — an entity's prose, revealed in stages.
 *
 * An entity's `visibility` is all-or-nothing, so a DM whose NPC write-up is
 * half public face and half spoiler has no way to show one without the other.
 * A passage is a chunk of that write-up with its OWN visibility. What a viewer
 * reads is the entity's base `description` followed by the passages they may
 * see; `description` itself is untouched and always visible.
 *
 * ## Unlike relationships and pins, the seam CAN filter these
 *
 * `data/relationships.ts` and `data/map-pins.ts` both open by explaining why
 * the seam cannot filter them: each names an entity OTHER than its owner, so
 * the row has no meaningful visibility of its own and both endpoints have to be
 * resolved by hand. A passage is the easy case — it names only its parent, and
 * it has a real visibility of its own. So it is shaped as a content table
 * (id/world_id/visibility/deleted_at, which is exactly what `ContentTableName`
 * tests for) and the seam does the whole job.
 *
 * ## The invariant the seam does NOT enforce: a passage never outranks its parent
 *
 * The seam filters a passage by the passage's own visibility. Nothing in it
 * knows that a `public` passage on a `dm_only` entity would be a leak.
 *
 * That invariant is held STRUCTURALLY rather than by a check: there is no route
 * and no exported function here that reaches a passage without going through
 * its parent entity first. `composeForEntities` takes entities the caller has
 * already resolved through the seam, and the write helpers resolve the parent
 * before touching anything. Adding a "list all passages in a world" door would
 * break this, which is why there isn't one — a check can be forgotten at a new
 * call site, an absent door cannot.
 *
 * ## Proposals need no exception
 *
 * A player-proposed passage is `status='proposed'`, `visibility='restricted'`,
 * plus exactly one `passage_visibility` row naming its author. The author sees
 * it because the ordinary grant rule admits them; the owner sees it because
 * owners see everything. There is deliberately no author-clause in `visible()`
 * — if one ever seems necessary, something here was built wrong.
 */

/** The seam instance for passages, with its own ACL and its parent column. */
const passages = createContentRepository('entity_passages', {
  kind: 'passage',
  grantTable: { table: 'passage_visibility', subjectColumn: 'passage_id' },
  parentColumn: 'entity_id',
})

/** A passage as the API returns it. */
export interface PassageView {
  id: string
  entity_id: string
  author_id: string | null
  body: string
  position: number
  status: PassageStatus
  visibility: Visibility
}

/** The subset of an entity the composer needs — whatever the seam returned. */
export interface ComposableEntity {
  id: string
  description: string
}

interface PassageRow {
  id: string
  entity_id: string
  author_id: string | null
  body: string
  position: number
  status: string
  visibility: string
}

function toView(row: PassageRow): PassageView {
  return {
    id: row.id,
    entity_id: row.entity_id,
    author_id: row.author_id,
    body: row.body,
    position: row.position,
    status: row.status as PassageStatus,
    visibility: row.visibility as Visibility,
  }
}

/**
 * The passages of each given entity that this actor may see, keyed by entity id
 * and in render order.
 *
 * ONE query for every entity passed, so composing a fifty-row list costs the
 * same as composing one page.
 *
 * Render order is (position, created_at). The query orders by `created_at` —
 * the seam's generic ordering — and the stable sort below layers `position` on
 * top, which leaves ties broken by creation time without the seam having to
 * know that `position` exists.
 */
export async function listPassagesForEntities(
  ctx: WorldContext,
  entityIds: readonly string[],
): Promise<Map<string, PassageView[]>> {
  // No short-circuit for an empty id set: the seam already returns without
  // touching the database, and a second guard here would be a second place to
  // keep in step for no gain.
  const byEntity = new Map<string, PassageView[]>()
  const rows = (await passages.listByParents(ctx, entityIds)) as unknown as PassageRow[]
  for (const row of rows) {
    const bucket = byEntity.get(row.entity_id)
    if (bucket) bucket.push(toView(row))
    else byEntity.set(row.entity_id, [toView(row)])
  }
  for (const list of byEntity.values()) list.sort((a, b) => a.position - b.position)
  return byEntity
}

/** One entity's authorized passages, in render order. */
export async function listPassagesForEntity(
  ctx: WorldContext,
  entityId: string,
): Promise<PassageView[]> {
  return (await listPassagesForEntities(ctx, [entityId])).get(entityId) ?? []
}

/**
 * THE composer. Given entities the caller has ALREADY resolved through the
 * seam, return each one's viewer-scoped prose: its base description followed by
 * the passages this actor may see.
 *
 * This is the only place composition happens anywhere in the codebase. The web
 * package never composes — it renders what the server sends — and the wiki
 * graph reads through here too, which is what keeps a link inside a hidden
 * passage from becoming a visible edge. Two composers would mean two answers to
 * "what text does this viewer see", and the graph would eventually get the
 * other one.
 */
export async function composeForEntities(
  ctx: WorldContext,
  entities: ReadonlyArray<ComposableEntity>,
): Promise<Map<string, string>> {
  const byEntity = await listPassagesForEntities(
    ctx,
    entities.map((e) => e.id),
  )
  const out = new Map<string, string>()
  for (const entity of entities) {
    out.set(entity.id, compose(entity.description, byEntity.get(entity.id) ?? []))
  }
  return out
}

/**
 * The same entities back, each with its viewer-scoped `body` attached.
 *
 * What the HTTP layer actually wants. Returning the objects rather than a Map
 * means the caller never has to look an id back up and handle a miss that
 * cannot happen — the lookup stays in here, where the map was built and the
 * only real absence (an entity with no passages) is a genuine case.
 */
export async function withComposedBodies<T extends ComposableEntity>(
  ctx: WorldContext,
  entities: readonly T[],
): Promise<Array<T & { body: string }>> {
  const byEntity = await listPassagesForEntities(
    ctx,
    entities.map((e) => e.id),
  )
  return entities.map((e) => ({ ...e, body: compose(e.description, byEntity.get(e.id) ?? []) }))
}

/** One entity's viewer-scoped prose. */
export async function composeForEntity(
  ctx: WorldContext,
  entity: ComposableEntity,
): Promise<string> {
  return compose(entity.description, await listPassagesForEntity(ctx, entity.id))
}

/**
 * Base description first, then each authorized passage, blank-separated. Empty
 * parts drop out so an entity with no description does not open with a blank
 * line, and both entry points share this so they can never disagree about what
 * "composed" means.
 */
function compose(description: string, passages: readonly PassageView[]): string {
  return [description, ...passages.map((p) => p.body)]
    .filter((part) => part.trim() !== '')
    .join('\n\n')
}

export interface NewPassage {
  entityId: string
  body: string
  position?: number | undefined
  visibility?: Visibility | undefined
}

/**
 * Add a passage (owner-only).
 *
 * The parent is NOT resolved here: the caller is the route, which has already
 * fetched the entity through the seam in order to know it exists. Re-resolving
 * would be a second query for an answer already held.
 */
export async function createPassage(
  ctx: WorldContext,
  input: NewPassage,
  authorId: string,
): Promise<PassageView> {
  assertContentWrite(ctx)
  const row = await passages.create(ctx, {
    entity_id: input.entityId,
    author_id: authorId,
    body: input.body,
    position: input.position ?? 0,
    status: 'published',
    // No fallback to 'public'. The column default is dm_only and an omitted
    // visibility must stay closed.
    ...(input.visibility === undefined ? {} : { visibility: input.visibility }),
  })
  return toView(row as unknown as PassageRow)
}

export interface PassagePatch {
  body?: string | undefined
  position?: number | undefined
  visibility?: Visibility | undefined
}

/** Edit a passage (owner-only). Returns undefined when it is not visible here. */
export async function updatePassage(
  ctx: WorldContext,
  id: string,
  patch: PassagePatch,
): Promise<PassageView | undefined> {
  assertContentWrite(ctx)
  const row = await passages.update(ctx, id, {
    ...(patch.body === undefined ? {} : { body: patch.body }),
    ...(patch.position === undefined ? {} : { position: patch.position }),
    ...(patch.visibility === undefined ? {} : { visibility: patch.visibility }),
  })
  return row === undefined ? undefined : toView(row as unknown as PassageRow)
}

/** Soft-delete a passage (owner-only). Returns whether one was removed. */
export async function deletePassage(ctx: WorldContext, id: string): Promise<boolean> {
  assertContentWrite(ctx)
  return passages.softDelete(ctx, id)
}

/** Read one passage through the seam — used by the write routes to 404 early. */
export async function getPassage(ctx: WorldContext, id: string): Promise<PassageView | undefined> {
  const row = await passages.get(ctx, id)
  return row === undefined ? undefined : toView(row as unknown as PassageRow)
}

/** Grant one account sight of one restricted passage (owner-only). */
export async function grantPassageVisibility(
  ctx: WorldContext,
  passageId: string,
  accountId: string,
): Promise<void> {
  assertContentWrite(ctx)
  await ctx.db
    .insertInto('passage_visibility')
    .values({ world_id: ctx.worldId, passage_id: passageId, account_id: accountId })
    .onConflict((oc) => oc.columns(['world_id', 'passage_id', 'account_id']).doNothing())
    .execute()
}

/** Withdraw a grant (owner-only). */
export async function revokePassageVisibility(
  ctx: WorldContext,
  passageId: string,
  accountId: string,
): Promise<void> {
  assertContentWrite(ctx)
  await ctx.db
    .deleteFrom('passage_visibility')
    .where('world_id', '=', ctx.worldId)
    .where('passage_id', '=', passageId)
    .where('account_id', '=', accountId)
    .execute()
}

/** The accounts holding a grant on this passage (owner-only). */
export async function listPassageGrants(ctx: WorldContext, passageId: string): Promise<string[]> {
  assertContentWrite(ctx)
  const rows = await ctx.db
    .selectFrom('passage_visibility')
    .select('account_id')
    .where('world_id', '=', ctx.worldId)
    .where('passage_id', '=', passageId)
    .orderBy('created_at')
    .execute()
  return rows.map((r) => r.account_id)
}

// ── player proposals ────────────────────────────────────────────────────────

/**
 * A player proposes a passage on an entity they can see.
 *
 * THIS IS THE ONLY WRITE IN THE CODEBASE THAT DOES NOT GO THROUGH
 * `assertContentWrite`. Everywhere else, content writes are owner-only and
 * unconditional — `authz/content.ts` refuses a player before the query is even
 * built, and that being exceptionless is load-bearing. So the exception is kept
 * as narrow as it can be made:
 *
 * - `status`, `author_id`, `visibility` and the grant row are set HERE, from
 *   the authenticated actor and constants. Nothing about them is taken from the
 *   caller, so there is no field a player can send that changes who sees this.
 * - `position` is computed, not accepted, so a proposal cannot be inserted
 *   into the middle of the DM's prose.
 * - `entity_id` is whatever the ROUTE already resolved through the seam. A
 *   player therefore cannot propose against an entity they cannot see, because
 *   they cannot name one.
 *
 * ## Why this needs no change to the authorization seam
 *
 * A proposal is `restricted` plus exactly one `passage_visibility` row naming
 * its author. The author sees it because the ordinary grant rule admits them;
 * the owner sees it because owners see everything; every other player is
 * excluded by the same rule that excludes them from any restricted row. There
 * is no author-clause in `visible()` and there must never be one — if writing
 * this had seemed to need one, the design was wrong.
 */
export async function proposePassage(
  ctx: WorldContext,
  input: { entityId: string; body: string },
  authorId: string,
): Promise<PassageView> {
  const id = newId()
  return ctx.db.transaction().execute(async (trx) => {
    // Proposals land at the END of the page. A player choosing where their
    // suggestion sits among the DM's reveals would be editing the DM's prose
    // by another name.
    const last = await trx
      .selectFrom('entity_passages')
      .select((eb) => eb.fn.max<number | null>('position').as('n'))
      .where('world_id', '=', ctx.worldId)
      .where('entity_id', '=', input.entityId)
      .where('deleted_at', 'is', null)
      .executeTakeFirst()
    const row = await trx
      .insertInto('entity_passages')
      .values({
        id,
        world_id: ctx.worldId,
        entity_id: input.entityId,
        author_id: authorId,
        body: input.body,
        position: (last?.n ?? 0) + 1,
        status: 'proposed',
        visibility: 'restricted',
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    // The self-grant IS the visibility model here — without it the author
    // could not read back what they just wrote.
    await trx
      .insertInto('passage_visibility')
      .values({ world_id: ctx.worldId, passage_id: id, account_id: authorId })
      .execute()
    return toView(row as unknown as PassageRow)
  })
}

/**
 * Accept a proposal (owner-only): publish it at a visibility the OWNER picks.
 *
 * The author's self-grant is dropped, because it has done its job. From here
 * their access comes from the chosen visibility like everyone else's — leaving
 * the grant would silently make every accepted proposal restricted-to-its-author
 * as well, which is invisible until the owner wonders why a `public` passage
 * has a grant on it.
 */
export async function acceptPassage(
  ctx: WorldContext,
  id: string,
  visibility: Visibility,
): Promise<PassageView | undefined> {
  assertContentWrite(ctx)
  const existing = await getPassage(ctx, id)
  if (!existing || existing.status !== 'proposed') return undefined
  const updated = await passages.update(ctx, id, { status: 'published', visibility })
  if (!updated) return undefined
  if (existing.author_id !== null) {
    await ctx.db
      .deleteFrom('passage_visibility')
      .where('world_id', '=', ctx.worldId)
      .where('passage_id', '=', id)
      .where('account_id', '=', existing.author_id)
      .execute()
  }
  return toView(updated as unknown as PassageRow)
}

/**
 * Reject a proposal (owner-only). A soft delete, like any other passage —
 * the row survives so a DM can see that a suggestion was made and declined,
 * rather than the record simply evaporating.
 */
export async function rejectPassage(ctx: WorldContext, id: string): Promise<boolean> {
  assertContentWrite(ctx)
  const existing = await getPassage(ctx, id)
  if (!existing || existing.status !== 'proposed') return false
  return passages.softDelete(ctx, id)
}

/** Live proposals this account has pending in this world, for the per-author cap. */
export async function countPendingProposals(ctx: WorldContext, authorId: string): Promise<number> {
  const row = await ctx.db
    .selectFrom('entity_passages')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('world_id', '=', ctx.worldId)
    .where('author_id', '=', authorId)
    .where('status', '=', 'proposed')
    .where('deleted_at', 'is', null)
    .executeTakeFirstOrThrow()
  return Number(row.n)
}
