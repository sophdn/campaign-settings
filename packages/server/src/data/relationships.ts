import { type RelationshipType, relationshipLabel } from '@campaign-settings/shared'
import { assertContentWrite, createContentRepository } from '../authz/content'
import { newId } from '../db/ids'
import type { WorldContext } from './context'

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
  /** The entity at the OTHER end, proven visible to this actor. */
  other: { kind: string; id: string; name: string }
}

export interface NewRelationship {
  fromId: string
  toId: string
  type: RelationshipType
  note?: string
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
    .select(['id', 'from_id', 'to_id', 'type', 'note'])
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
  const visible = await entities.listByIds(ctx, [...otherIds])
  const byId = new Map(
    visible.map((e) => {
      const row = e as unknown as { id: string; kind: string; name: string }
      return [row.id, { kind: row.kind, id: row.id, name: row.name }]
    }),
  )

  const out: RelationshipView[] = []
  for (const row of rows) {
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
      })
      .returning(['id', 'from_id', 'to_id', 'type', 'note'])
      .executeTakeFirstOrThrow()
    return (await toViews(ctx, input.fromId, [row]))[0] as RelationshipView
  } catch (err) {
    // The unique index is what actually prevents a double-click from creating
    // the same relation twice; translating it here means the UI gets a sentence
    // rather than a 500 naming an index.
    if (isUniqueViolation(err)) throw new DuplicateRelationshipError()
    throw err
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
