import {
  BRACKET_RESOLVER_ORDER,
  buildNameIndex,
  parseBrackets,
  resolveBracket,
  type Visibility,
} from '@campaign-settings/shared'
import { assertContentWrite, createContentRepository } from '../authz/content'
import { newId } from '../db/ids'
import type { WorldContext } from './context'

/**
 * Reconcile an entity's `[[brackets]]` against the relationship store.
 *
 * `[[bracket]]` mentions and typed relationships were two implementations of
 * one concept, and readers already read them as one. Saving an entity now
 * derives relationships from its prose: a `[[link]]` produces a `related_to`
 * row the GM may specify further, and removing the link retires the row again.
 *
 * ## Per TEXT SOURCE, not per merged body
 *
 * An entity's prose is its base `description` PLUS its passages, and a reader's
 * copy is the subset of those they may see. Reconciling the merged body would
 * lose which part of it produced each link — and a bracket written inside a
 * `dm_only` reveal must produce a relationship only that reveal's audience can
 * see. So each source is parsed on its own and every derived row records the
 * source that made it: null for the base description, the passage id for a
 * bracket inside a reveal.
 *
 * The row's audience is then DERIVED from that passage at read time (see
 * `listRelationshipsForEntity`). Nothing copies the passage's visibility onto
 * the relationship. That is the whole design: one place defines a reveal's
 * audience, revealing it reveals its relationships with no second write, and
 * there is no copy to fall out of step.
 *
 * ## Source precedence
 *
 * A pair may be linked from several sources at once — named in the description
 * AND in a secret reveal. One row is held, at its MOST VISIBLE source, because
 * the alternatives are both wrong: two rows would show the pair twice, and
 * picking the least visible source would hide a link the public description
 * already states.
 *
 * The order is: hand-authored, then the base description, then passages by
 * visibility (public, then restricted, then dm_only). When a source goes away
 * the row falls back to the next one that remains, and is retired only when
 * none do.
 *
 * ## What reconciliation may NOT touch
 *
 * A hand-authored row (`origin='authored'`) is never retired, moved, or
 * re-sourced. A GM's typed statement is not reconciliation's to revise, and a
 * rewording of a sentence must not destroy curated data.
 *
 * A bracket-derived row that the GM has SPECIFIED — given a real type, a
 * qualifier, or a note — is also never retired. The literal rule would delete
 * it the moment someone rephrased the sentence that first produced it. It KEEPS
 * its `source_passage_id` when its brackets go, because losing reconciliation
 * provenance is not the same as losing visibility provenance: dropping the
 * source would publish a secret the moment the GM typed it more precisely.
 */

/** The type every bracket-derived row starts at, until a GM says otherwise. */
const DERIVED_TYPE = 'related_to'

/** Passage rows as reconciliation needs them: text, and how visible it is. */
interface PassageSource {
  id: string
  body: string
  visibility: Visibility
}

/** One text source of an entity: the base description, or one passage. */
interface TextSource {
  /** Null for the base description. */
  passageId: string | null
  text: string
  /** Lower sorts first — see the precedence note above. */
  rank: number
}

/**
 * How visible a passage is, as a sort key. Lower is more visible.
 *
 * `+1` on every value keeps the base description (rank 0) ahead of even a
 * `public` passage, which is the stated order: what the description says is the
 * page's plainest statement of the link.
 */
const VISIBILITY_RANK: Record<Visibility, number> = {
  public: 1,
  restricted: 2,
  dm_only: 3,
}

/** A bracket-derived row as reconciliation reads it. */
interface DerivedRow {
  id: string
  to_id: string
  type: string
  note: string
  qualifier: string | null
  source_passage_id: string | null
}

/**
 * Has a GM said anything about this row beyond "these two are connected"?
 *
 * A row still at `related_to` with no note and no qualifier carries no
 * information the bracket did not, so retiring it with the bracket loses
 * nothing. Anything more is curated data, and the whole point of scoping
 * retirement is that a rewording must not destroy it.
 */
export function isUnspecified(row: {
  type: string
  note: string
  qualifier: string | null
}): boolean {
  return row.type === DERIVED_TYPE && row.note.trim() === '' && row.qualifier === null
}

/**
 * Pick the best source for each bracket target across all of an entity's text.
 *
 * Exported for its own test: precedence is the one piece of this module that is
 * pure, and it is the rule most likely to be got subtly wrong.
 */
export function bestSources(
  sources: readonly TextSource[],
  resolve: (name: string) => string | null,
  selfId: string,
): Map<string, string | null> {
  const best = new Map<string, { rank: number; passageId: string | null }>()
  for (const source of sources) {
    const seen = new Set<string>()
    for (const marker of parseBrackets(source.text)) {
      const key = marker.name.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      const targetId = resolve(marker.name)
      // Unresolved names point at nothing, and an entity cannot be related to
      // itself — the table has a CHECK saying so.
      if (targetId === null || targetId === selfId) continue
      const held = best.get(targetId)
      if (held === undefined || source.rank < held.rank) {
        best.set(targetId, { rank: source.rank, passageId: source.passageId })
      }
    }
  }
  return new Map([...best].map(([targetId, { passageId }]) => [targetId, passageId]))
}

/**
 * Reconcile one entity's bracket-derived relationships after a write.
 *
 * Owner-only, like every content write. Reads the entity's OWN text — not a
 * viewer's composed copy — because reconciliation is the GM's save taking
 * effect, and a viewer-scoped read would derive rows from a subset of the prose.
 *
 * Idempotent: saving an unchanged body writes nothing. That matters more than
 * it looks — this runs on every entity save, and a version that rewrote its
 * rows each time would churn `updated_at` on data nobody touched.
 */
export async function reconcileBrackets(ctx: WorldContext, entityId: string): Promise<void> {
  assertContentWrite(ctx)

  const entity = await ctx.db
    .selectFrom('entities')
    .select(['id', 'description'])
    .where('world_id', '=', ctx.worldId)
    .where('id', '=', entityId)
    .where('deleted_at', 'is', null)
    .executeTakeFirst()
  // Nothing to reconcile against. A caller reconciling a soft-deleted or absent
  // entity is asking for its links to be correct, and "it has no text" is a
  // truthful answer rather than an error.
  if (!entity) return

  const passages = await ctx.db
    .selectFrom('entity_passages')
    .select(['id', 'body', 'visibility'])
    .where('world_id', '=', ctx.worldId)
    .where('entity_id', '=', entityId)
    .where('deleted_at', 'is', null)
    .orderBy('position')
    .orderBy('created_at')
    .execute()

  const sources: TextSource[] = [
    { passageId: null, text: entity.description, rank: 0 },
    ...(passages as unknown as PassageSource[]).map((p) => ({
      passageId: p.id,
      text: p.body,
      rank: VISIBILITY_RANK[p.visibility],
    })),
  ]

  // The name index is built from EVERY entity in the world, not a viewer's
  // subset: the GM writing the link can see all of them, and resolving against
  // less would silently drop links to things they can see perfectly well.
  const all = await ctx.db
    .selectFrom('entities')
    .select(['id', 'kind', 'name'])
    .where('world_id', '=', ctx.worldId)
    .where('deleted_at', 'is', null)
    .execute()
  const index = buildNameIndex(
    BRACKET_RESOLVER_ORDER.map((kind) => ({
      kind,
      rows: all.filter((e) => e.kind === kind).map((e) => ({ id: e.id, name: e.name })),
    })),
  )
  const desired = bestSources(sources, (name) => resolveBracket(name, index)?.id ?? null, entityId)

  // Every relationship this entity is an endpoint of, in either direction. Both
  // directions matter: a pair the GM has already typed by hand should not also
  // collect a bare "Related to" from a passing mention, whichever way round the
  // hand-authored row happens to be stored.
  const existing = await ctx.db
    .selectFrom('entity_relationships')
    .select(['id', 'from_id', 'to_id', 'type', 'note', 'qualifier', 'origin', 'source_passage_id'])
    .where('world_id', '=', ctx.worldId)
    .where((eb) => eb.or([eb('from_id', '=', entityId), eb('to_id', '=', entityId)]))
    .execute()

  const authoredPartners = new Set(
    existing
      .filter((r) => r.origin === 'authored')
      .map((r) => (r.from_id === entityId ? r.to_id : r.from_id)),
  )
  const derived = new Map<string, DerivedRow>(
    existing
      .filter((r) => r.origin === 'bracket' && r.from_id === entityId)
      .map((r) => [
        r.to_id,
        {
          id: r.id,
          to_id: r.to_id,
          type: r.type,
          note: r.note,
          qualifier: r.qualifier,
          source_passage_id: r.source_passage_id,
        },
      ]),
  )

  // Targets that must exist. An id resolved from the world's own name index is
  // real by construction, but a concurrent delete between the two reads is not
  // impossible — so the insert's foreign key stays the guarantee and this is
  // only the ordering that avoids provoking it.
  const wanted = new Set(desired.keys())

  for (const [targetId, passageId] of desired) {
    // Already stated by hand, in either direction. A bare "Related to" beside
    // "Leads" says strictly less than the row already there.
    if (authoredPartners.has(targetId)) continue
    const held = derived.get(targetId)
    if (held === undefined) {
      await insertDerived(ctx, entityId, targetId, passageId)
      continue
    }
    // Idempotence lives here: an unchanged source writes nothing at all.
    if (held.source_passage_id !== passageId) {
      await ctx.db
        .updateTable('entity_relationships')
        .set({ source_passage_id: passageId })
        .where('world_id', '=', ctx.worldId)
        .where('id', '=', held.id)
        .execute()
    }
  }

  for (const [targetId, row] of derived) {
    if (wanted.has(targetId)) continue
    // The bracket is gone. An unspecified row carried nothing the bracket did
    // not, so it goes with it; a specified one is curated data and stays —
    // KEEPING its source, which is what governs who may see it.
    if (!isUnspecified(row)) continue
    await ctx.db
      .deleteFrom('entity_relationships')
      .where('world_id', '=', ctx.worldId)
      .where('id', '=', row.id)
      .execute()
  }
}

/**
 * Insert one bracket-derived row, tolerating the pair already holding a
 * `related_to` in the OTHER direction.
 *
 * That happens whenever two entities name each other: A's save writes A→B, and
 * B's save then tries to write B→A. The unique index is on the ordered triple,
 * so it does not catch this — but two rows for one mutual mention would render
 * the pair twice on each page. The pre-check is why the insert is here rather
 * than inline.
 */
async function insertDerived(
  ctx: WorldContext,
  fromId: string,
  toId: string,
  passageId: string | null,
): Promise<void> {
  const inverse = await ctx.db
    .selectFrom('entity_relationships')
    .select('id')
    .where('world_id', '=', ctx.worldId)
    .where('from_id', '=', toId)
    .where('to_id', '=', fromId)
    .where('type', '=', DERIVED_TYPE)
    .executeTakeFirst()
  if (inverse) return

  await ctx.db
    .insertInto('entity_relationships')
    .values({
      id: newId(),
      world_id: ctx.worldId,
      from_id: fromId,
      to_id: toId,
      type: DERIVED_TYPE,
      note: '',
      qualifier: null,
      origin: 'bracket',
      source_passage_id: passageId,
    })
    .onConflict((oc) => oc.doNothing())
    .execute()
}

/**
 * Which of these passages the actor may see.
 *
 * The read path's half of the derived-visibility rule. A relationship sourced
 * from a passage is readable only by someone who can see that passage — IN
 * ADDITION to the existing rule that both endpoints must be visible, never
 * instead of it.
 *
 * One batched read through the passage seam, so an entity with thirty
 * relationships across five reveals costs one query rather than thirty.
 */
const passageRepo = createContentRepository('entity_passages', {
  kind: 'passage',
  grantTable: { table: 'passage_visibility', subjectColumn: 'passage_id' },
  parentColumn: 'entity_id',
})

export async function visiblePassageIds(
  ctx: WorldContext,
  ids: readonly string[],
): Promise<Set<string>> {
  if (ids.length === 0) return new Set()
  const rows = await passageRepo.listByIds(ctx, [...ids])
  return new Set(rows.map((r) => r.id))
}
