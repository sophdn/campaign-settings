import {
  isValidQualifier,
  type RelationshipType,
  relationshipLabel,
} from '@campaign-settings/shared'
import { assertContentWrite, createContentRepository } from '../authz/content'
import { newId } from '../db/ids'
import type { WorldContext } from './context'
import { visiblePassageIds } from './relationship-reconcile'

/**
 * Typed relationships between entities.
 *
 * ## The visibility rule, and why the seam cannot apply it
 *
 * The content seam filters a row by ITS OWN `visibility` column. A relationship
 * has no meaningful visibility of its own: it names two entities, and it is
 * readable exactly when BOTH of them are. A player entitled to see an
 * organization may not be entitled to see the NPC who leads it, and a
 * relationship row naming that NPC would report their existence, their name, and
 * their exact standing in the world — without the entity ever being opened.
 *
 * So `entity_relationships` is deliberately NOT shaped like a content table (no
 * `visibility`, no `deleted_at`, so it is not a `ContentTableName`), and every
 * read here resolves both endpoints through the seam and drops the row whole
 * when either does not come back.
 *
 * This is the same rule the map-pin filter applies to a pin's target, and the
 * same one the wiki graph already gets by construction (`wiki/graph.ts` builds
 * edges from authorized rows only). Three surfaces, one rule.
 *
 * ## The SECOND condition, since brackets create relationships
 *
 * A `[[link]]` written inside a `dm_only` reveal produces a relationship, and
 * that relationship must surface only for the reveal's audience. Both endpoints
 * may be perfectly public — the secret was never either of them, it was that
 * the two are connected at all.
 *
 * So a row carrying a `source_passage_id` is readable only by an actor who can
 * also see that passage. This is an ADDITIONAL condition on top of
 * both-endpoints-visible, never a replacement for it: a row passing the passage
 * check still has both its endpoints resolved through the seam.
 *
 * The audience is DERIVED from the passage on every read rather than copied
 * onto the row (0021). Revealing the passage therefore reveals its
 * relationships with no second write, and there is no copy to fall out of step.
 *
 * ## One row, read from both ends
 *
 * A relationship is stored once, `from → to`. An entity's page shows the rows
 * where it is the `from` with the type's forward label, and the rows where it is
 * the `to` with the inverse — from the same row. `relationshipLabel` in `shared`
 * is what makes the two pages incapable of describing the relation differently.
 */

/** The seam instance both endpoints are resolved through — no kind filter. */
const entities = createContentRepository('entities')

/** A relationship as one entity's page reads it. */
export interface RelationshipView {
  id: string
  type: RelationshipType
  /** How it reads FROM the entity being viewed — already inverted if needed. */
  label: string
  /** True when the viewed entity is the row's `from`. */
  outgoing: boolean
  note: string
  /**
   * The controlled qualifier on the relation, or null. Carried through to the
   * client rather than folded into `label`, so the SPA can render it as its own
   * badge and a future filter can group by it — which is the whole reason 0017
   * gave it a column instead of appending it to `note`.
   */
  qualifier: string | null
  /** The entity at the OTHER end, proven visible to this actor. */
  other: { kind: string; id: string; name: string }
}

export interface NewRelationship {
  fromId: string
  toId: string
  type: RelationshipType
  note?: string
  qualifier?: string
}

/** Raised when a relationship would join an entity to itself. */
export class SelfRelationshipError extends Error {
  constructor() {
    super('an entity cannot be related to itself')
    this.name = 'SelfRelationshipError'
  }
}

/** Raised when the same pair already holds this exact relationship. */
export class DuplicateRelationshipError extends Error {
  constructor() {
    super('that relationship already exists between these two entries')
    this.name = 'DuplicateRelationshipError'
  }
}

interface RelationshipRow {
  id: string
  from_id: string
  to_id: string
  type: string
  note: string
  qualifier: string | null
  /** The reveal whose text produced this row, or null for the description. */
  source_passage_id: string | null
}

/** Raised when a qualifier is not in the vocabulary its type allows. */
export class InvalidQualifierError extends Error {
  constructor(type: RelationshipType) {
    super(`that qualifier is not one this relationship type accepts: ${type}`)
    this.name = 'InvalidQualifierError'
  }
}

/**
 * Every relationship touching `entityId`, in both directions, filtered to those
 * whose OTHER end the actor may see.
 *
 * The caller must have already resolved `entityId` itself through the seam —
 * they are reading its page — so what is checked here is the far end.
 */
export async function listRelationshipsForEntity(
  ctx: WorldContext,
  entityId: string,
): Promise<RelationshipView[]> {
  const rows = await ctx.db
    .selectFrom('entity_relationships')
    .select(['id', 'from_id', 'to_id', 'type', 'note', 'qualifier', 'source_passage_id'])
    .where('world_id', '=', ctx.worldId)
    .where((eb) => eb.or([eb('from_id', '=', entityId), eb('to_id', '=', entityId)]))
    .orderBy('created_at')
    .execute()
  return toViews(ctx, entityId, rows)
}

/**
 * Resolve each row's far endpoint through the seam and drop the ones that do not
 * come back. One batched read, so an entity with thirty relationships is not
 * thirty queries.
 */
async function toViews(
  ctx: WorldContext,
  entityId: string,
  rows: readonly RelationshipRow[],
): Promise<RelationshipView[]> {
  if (rows.length === 0) return []
  const otherIds = new Set(rows.map((r) => (r.from_id === entityId ? r.to_id : r.from_id)))
  // Two batched reads, one per condition. The passage set answers the newer
  // rule — a row sourced from a reveal belongs to that reveal's audience — and
  // is empty for the rows that carry no source, which is most of them.
  const sourceIds = [...new Set(rows.map((r) => r.source_passage_id).filter((v) => v !== null))]
  const [visible, visibleSources] = await Promise.all([
    entities.listByIds(ctx, [...otherIds]),
    visiblePassageIds(ctx, sourceIds),
  ])
  const byId = new Map(
    visible.map((e) => {
      const row = e as unknown as { id: string; kind: string; name: string }
      return [row.id, { kind: row.kind, id: row.id, name: row.name }]
    }),
  )

  const out: RelationshipView[] = []
  for (const row of rows) {
    // The reveal that produced this row is not this actor's to see, so neither
    // is the row. Checked BEFORE the endpoint lookup only because it is cheaper;
    // both conditions must hold.
    if (row.source_passage_id !== null && !visibleSources.has(row.source_passage_id)) continue
    const outgoing = row.from_id === entityId
    const other = byId.get(outgoing ? row.to_id : row.from_id)
    // The far end is not visible → the relationship does not exist for this
    // actor. Not a typed row with the name blanked out: that would still report
    // that this entity stands in a named relation to something hidden.
    if (!other) continue
    const type = row.type as RelationshipType
    out.push({
      id: row.id,
      type,
      label: relationshipLabel(type, outgoing),
      outgoing,
      note: row.note,
      qualifier: row.qualifier,
      other,
    })
  }
  return out
}

/**
 * Assert a relationship (owner-only).
 *
 * Both endpoints are resolved through the seam BEFORE the insert, so a
 * relationship can never be created against something the actor cannot see —
 * which for an owner means "something that does not exist in this world".
 */
export async function createRelationship(
  ctx: WorldContext,
  input: NewRelationship,
): Promise<RelationshipView> {
  assertContentWrite(ctx)
  if (input.fromId === input.toId) throw new SelfRelationshipError()
  // Refused here rather than by a CHECK, for the reason 0014 gives about `type`:
  // the vocabulary lives in `shared` so every surface reads one copy.
  if (!isValidQualifier(input.type, input.qualifier)) throw new InvalidQualifierError(input.type)

  const endpoints = await entities.listByIds(ctx, [input.fromId, input.toId])
  if (endpoints.length !== 2) throw new EndpointNotFoundError()

  try {
    const row = await ctx.db
      .insertInto('entity_relationships')
      .values({
        id: newId(),
        world_id: ctx.worldId,
        from_id: input.fromId,
        to_id: input.toId,
        type: input.type,
        note: input.note ?? '',
        qualifier: input.qualifier ?? null,
      })
      .returning(['id', 'from_id', 'to_id', 'type', 'note', 'qualifier', 'source_passage_id'])
      .executeTakeFirstOrThrow()
    return (await toViews(ctx, input.fromId, [row]))[0] as RelationshipView
  } catch (err) {
    throw asRelationshipError(err)
  }
}

/**
 * Translate a write failure the caller can act on, or hand it back untouched.
 *
 * The unique index is what actually prevents a double-click from creating the
 * same relation twice, and retyping a row onto one the pair already holds is
 * the same collision. Both deserve a sentence rather than a 500 naming an
 * index — and both go through here, so the two call sites cannot come to
 * describe the same collision differently.
 *
 * Anything else is returned as it arrived. A failure this function does not
 * recognise is not one it should dress up.
 */
export function asRelationshipError(err: unknown): unknown {
  return isUniqueViolation(err) ? new DuplicateRelationshipError() : err
}

/** What a GM may change about an existing relationship. */
export interface RelationshipPatch {
  type?: RelationshipType | undefined
  note?: string | undefined
  qualifier?: string | null | undefined
}

/**
 * Specify a relationship further (owner-only).
 *
 * The reason this exists: a `[[bracket]]` creates a row at `related_to` with no
 * note, and the GM has to be able to say what the link actually IS without
 * deleting it and typing a new one — deleting would lose the row's
 * `source_passage_id`, which is what governs who may see it.
 *
 * `origin` and `source_passage_id` are deliberately NOT patchable. Provenance
 * is reconciliation's record of where a row came from, not a field a user
 * edits; letting the form set it would let the UI publish a secret by moving a
 * row off the reveal that governs it.
 *
 * Returns undefined when no row was updated, so the route 404s rather than
 * reporting success for an id that is not there.
 */
export async function updateRelationship(
  ctx: WorldContext,
  id: string,
  patch: RelationshipPatch,
): Promise<RelationshipView | undefined> {
  assertContentWrite(ctx)
  const current = await ctx.db
    .selectFrom('entity_relationships')
    .select(['id', 'from_id', 'to_id', 'type', 'note', 'qualifier', 'source_passage_id'])
    .where('world_id', '=', ctx.worldId)
    .where('id', '=', id)
    .executeTakeFirst()
  if (!current) return undefined

  const type = patch.type ?? (current.type as RelationshipType)
  // The qualifier is validated against the RESULTING type, not the one the row
  // held: changing `speaks` to `ally_of` while leaving `liturgical` behind
  // would store a qualifier the new type has no vocabulary for.
  const qualifier = patch.qualifier === undefined ? current.qualifier : patch.qualifier
  if (!isValidQualifier(type, qualifier ?? undefined)) throw new InvalidQualifierError(type)

  try {
    const row = await ctx.db
      .updateTable('entity_relationships')
      .set({
        type,
        note: patch.note ?? current.note,
        qualifier,
        updated_at: new Date(),
      })
      .where('world_id', '=', ctx.worldId)
      .where('id', '=', id)
      .returning(['id', 'from_id', 'to_id', 'type', 'note', 'qualifier', 'source_passage_id'])
      // OrThrow, not a `!row` branch: the row was read a moment ago in this same
      // request, so a miss can only mean a concurrent delete. That is a race
      // rather than a state, and a branch for it could never be exercised.
      .executeTakeFirstOrThrow()
    return (await toViews(ctx, row.from_id, [row]))[0]
  } catch (err) {
    throw asRelationshipError(err)
  }
}

/** Raised when one end of a proposed relationship is absent or invisible. */
export class EndpointNotFoundError extends Error {
  constructor() {
    super('one of those entries does not exist')
    this.name = 'EndpointNotFoundError'
  }
}

/** Remove a relationship (owner-only). Returns whether one was actually removed. */
export async function deleteRelationship(ctx: WorldContext, id: string): Promise<boolean> {
  assertContentWrite(ctx)
  const res = await ctx.db
    .deleteFrom('entity_relationships')
    .where('world_id', '=', ctx.worldId)
    .where('id', '=', id)
    .executeTakeFirstOrThrow()
  return res.numDeletedRows > 0n
}

/** Postgres reports a unique-index collision as SQLSTATE 23505. */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505'
}
