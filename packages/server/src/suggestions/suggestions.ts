import { type Selectable } from 'kysely'
import { assertContentWrite } from '../authz/content'
import { ForbiddenError } from '../authz/errors'
import { CONTENT_REPOS } from '../data/content-repos'
import type { WorldContext } from '../data/context'
import { newId } from '../db/ids'
import { jsonb } from '../db/json'
import type { SuggestionsTable } from '../db/schema'

/**
 * The player suggestion queue. A player proposes an edit to an entity they can
 * SEE; the DM reviews and either accepts (applies a parameterized update to the
 * canonical entity) or rejects (discards). Both the visible-entity gate and the
 * accept update flow through the content-authorization seam.
 */

export type Suggestion = Selectable<SuggestionsTable>

export interface ProposeInput {
  targetKind: string
  targetId: string
  proposed: Record<string, unknown>
}

/**
 * Fields a suggestion may never set on accept — structural columns and the
 * `visibility` flag the player couldn't see or control. Stripping them is what
 * guarantees "accept cannot touch fields the player couldn't see".
 */
const PROTECTED_FIELDS: ReadonlySet<string> = new Set([
  'id',
  'world_id',
  'kind',
  'entity_id',
  'visibility',
  'created_at',
  'updated_at',
  'deleted_at',
])

/**
 * Whether a proposed value carries content, as opposed to being an instruction
 * to erase one. Empty strings, whitespace, null and undefined are all "nothing";
 * `false` and `0` are content and must survive.
 */
function isMeaningful(v: unknown): boolean {
  if (v === null || v === undefined) return false
  if (typeof v === 'string') return v.trim() !== ''
  if (Array.isArray(v)) return v.length > 0
  return true
}

/**
 * The fields an accept may write: protected columns removed, and empty values
 * dropped.
 *
 * DROPPING EMPTIES IS THE POINT (bug 1180). A suggestion is a player proposing
 * CONTENT to a GM, and the propose form sends every field it renders — so a
 * player who fills in one field and leaves another blank was submitting one
 * edit, not one edit and one deletion. Before this, accepting that suggestion
 * overwrote a carefully-written description with `''`. The peer-dev report this
 * came from describes the same shape costing a team a fully-statted character.
 *
 * The rule: an accept can ADD a field or REPLACE it with something, never blank
 * it. A GM who wants a field emptied edits the entity directly, where the
 * intent is unambiguous and it is their own decision.
 */
function sanitizeProposed(proposed: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(proposed)) {
    if (!PROTECTED_FIELDS.has(k) && isMeaningful(v)) out[k] = v
  }
  return out
}

/** Raised when a proposal carries nothing an accept could apply. */
export class EmptySuggestionError extends Error {
  constructor() {
    super('a suggestion must propose at least one non-empty field')
    this.name = 'EmptySuggestionError'
  }
}

export async function proposeSuggestion(
  ctx: WorldContext,
  input: ProposeInput,
): Promise<Suggestion> {
  const repo = CONTENT_REPOS[input.targetKind]
  if (!repo) throw new ForbiddenError(`not a suggestable entity kind: ${input.targetKind}`)
  // Visible-entity gate: the author must be able to see the target through the
  // authorization seam — a player can't propose against a dm_only entity.
  const target = await repo.get(ctx, input.targetId)
  if (!target) throw new ForbiddenError('target entity is not visible')
  // Refuse a proposal that would apply nothing. Checked here as well as at
  // accept time so the GM's queue never fills with cards that do nothing when
  // accepted — the alternative is a reviewer learning the rule by finding it.
  if (Object.keys(sanitizeProposed(input.proposed)).length === 0) throw new EmptySuggestionError()
  return ctx.db
    .insertInto('suggestions')
    .values({
      id: newId(),
      world_id: ctx.worldId,
      author_id: ctx.actor.accountId,
      target_entity_id: input.targetId,
      proposed: jsonb(input.proposed),
    })
    .returningAll()
    .executeTakeFirstOrThrow()
}

/** A pending suggestion enriched with the target's current kind (for display). */
export type SuggestionView = Suggestion & { target_entity_kind: string | null }

/**
 * Pending suggestions: the DM sees all of the world's; a player sees only their
 * own. The target's kind is no longer stored on the suggestion (it lives on
 * entities.kind), so we derive it via a left join for the UI to render + to
 * resolve the target's name.
 */
export async function listSuggestions(ctx: WorldContext): Promise<SuggestionView[]> {
  let q = ctx.db
    .selectFrom('suggestions')
    .leftJoin('entities', 'entities.id', 'suggestions.target_entity_id')
    .where('suggestions.world_id', '=', ctx.worldId)
    .where('suggestions.status', '=', 'pending')
    .selectAll('suggestions')
    .select('entities.kind as target_entity_kind')
  if (ctx.actor.role !== 'owner') q = q.where('suggestions.author_id', '=', ctx.actor.accountId)
  return q.orderBy('suggestions.created_at').execute()
}

function getPendingSuggestion(ctx: WorldContext, id: string): Promise<Suggestion | undefined> {
  return ctx.db
    .selectFrom('suggestions')
    .selectAll()
    .where('world_id', '=', ctx.worldId)
    .where('id', '=', id)
    .where('status', '=', 'pending')
    .executeTakeFirst()
}

/**
 * Accept a pending suggestion: apply its sanitized proposed fields to the target
 * entity (a parameterized update via the seam) and mark it accepted. Owner only.
 */
export async function acceptSuggestion(
  ctx: WorldContext,
  id: string,
): Promise<Suggestion | undefined> {
  assertContentWrite(ctx) // owner-only
  const sug = await getPendingSuggestion(ctx, id)
  if (!sug) return undefined
  // The kind is no longer stored on the suggestion — it lives on entities.kind,
  // so resolve the live target and pick the matching kind's repo (which knows the
  // base/detail split). A null/deleted/hard-removed target (FK set null) → no-op.
  const target =
    sug.target_entity_id === null
      ? undefined
      : await ctx.db
          .selectFrom('entities')
          .select('kind')
          .where('world_id', '=', ctx.worldId)
          .where('id', '=', sug.target_entity_id)
          .where('deleted_at', 'is', null)
          .executeTakeFirst()
  const repo = target ? CONTENT_REPOS[target.kind] : undefined
  if (!repo || sug.target_entity_id === null) {
    throw new ForbiddenError('suggestion has no valid target')
  }
  await repo.update(ctx, sug.target_entity_id, sanitizeProposed(sug.proposed))
  return ctx.db
    .updateTable('suggestions')
    .set({ status: 'accepted' })
    .where('world_id', '=', ctx.worldId)
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirst()
}

/** Reject a pending suggestion: discard it without touching canonical data. Owner only. */
export async function rejectSuggestion(
  ctx: WorldContext,
  id: string,
): Promise<Suggestion | undefined> {
  assertContentWrite(ctx) // owner-only
  const sug = await getPendingSuggestion(ctx, id)
  if (!sug) return undefined
  return ctx.db
    .updateTable('suggestions')
    .set({ status: 'rejected' })
    .where('world_id', '=', ctx.worldId)
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirst()
}
