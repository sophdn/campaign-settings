import {
  type BracketableKind,
  BRACKET_RESOLVER_ORDER,
  buildNameIndex,
  type EntityRef,
  type NameIndex,
  parseBrackets,
  resolveBracket,
} from '@campaign-settings/shared'
import { createContentRepository } from '../authz/content'
import type { WorldContext } from '../data/context'
import { type ComposableEntity, composeForEntities } from '../data/passages'
import { listRelationshipsForEntity } from '../data/relationships'
import { listTouches } from '../data/touches'

/**
 * A bracketable entity reduced to what link-resolution needs.
 *
 * `description` is the viewer-COMPOSED prose, not the raw column — see
 * `listBracketableEntities`. This type is server-internal: it never reaches the
 * client, which receives `GraphNode` (kind/id/name only).
 */
export interface BracketEntity {
  kind: BracketableKind
  id: string
  name: string
  description: string
}

export interface GraphNode {
  kind: string
  id: string
  name: string
}

/**
 * Edge provenance: an entity↔entity `description` link, an entity↔entity
 * `relationship` (a TYPED relation the GM recorded, or one derived from a
 * bracket), or an entity↔session link that is either a `touch` (an explicit
 * EntityTouch interaction) or a `bracket` (a `[[mention]]` parsed from the
 * session's captured_text).
 *
 * `relationship` arrived with chain 470: the fifteen-type vocabulary a DM
 * records was invisible in the graph, so the graph and the entity pages
 * disagreed about how connected the world was.
 */
export type GraphEdgeType = 'description' | 'relationship' | 'touch' | 'bracket'

export interface GraphEdge {
  from: { kind: string; id: string }
  to: { kind: string; id: string }
  type: GraphEdgeType
}

export interface EntityGraph {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

/**
 * One authorized lister over the shared `entities` base table (no kind filter →
 * every content kind, since maps/sessions are separate tables). The content seam
 * applies the full per-player visibility model: a player's reads exclude
 * `dm_only` rows and any `restricted` row they lack a grant for, while a granted
 * player DOES see their restricted rows here — keeping the wiki/graph consistent
 * with the entity list/detail. Both-endpoints-visible then falls out for free.
 * (The 16 content kinds are exactly the bracketable kinds — session/map alone
 * are non-bracketable, and neither lives in `entities`.)
 */
const entitiesLister = createContentRepository('entities')

/**
 * Every bracketable entity the actor may see, across all kinds, grouped in
 * bracket-precedence order. Reads flow through the authorization seam, so a
 * player's result already excludes rows they can't see (dm_only, and restricted
 * rows without a grant) — which is what makes the graph's both-endpoints rule
 * automatic.
 *
 * `description` here is the COMPOSED prose — the base column plus the passages
 * this actor may see — not the raw column. That is what keeps a `[[link]]`
 * written inside a hidden passage from becoming a visible edge, and it is why
 * composition happens once, here, rather than at each consumer. See the note on
 * `buildEntityGraph` for the leak this closes.
 */
export async function listBracketableEntities(ctx: WorldContext): Promise<BracketEntity[]> {
  const rows = await entitiesLister.list(ctx)
  const composed = await composeForEntities(ctx, rows as unknown as ComposableEntity[])
  const byKind = new Map<string, BracketEntity[]>()
  for (const r of rows) {
    const e: BracketEntity = {
      kind: r.kind as BracketableKind,
      id: r.id,
      name: r.name,
      description: composed.get(r.id) ?? r.description,
    }
    const bucket = byKind.get(r.kind)
    if (bucket) bucket.push(e)
    else byKind.set(r.kind, [e])
  }
  const out: BracketEntity[] = []
  for (const kind of BRACKET_RESOLVER_ORDER) out.push(...(byKind.get(kind) ?? []))
  return out
}

/** A wiki row reduced to what the browse list needs. */
export interface WikiEntry {
  kind: string
  id: string
  name: string
}

/** Lists just (id, name); sessions have no `description`, so the narrower shape. */
interface NamedLister {
  list(ctx: WorldContext): Promise<ReadonlyArray<{ id: string; name: string }>>
}

const sessionLister: NamedLister = createContentRepository('sessions', { kind: 'session' })

/**
 * Every wiki-surface entity the actor may see: the bracketable kinds plus
 * sessions. Authorization-correct by construction (each list flows through the
 * content seam, so a player never sees a row they can't — dm_only, or restricted
 * without a grant). Maps (no detail surface) are intentionally excluded. The
 * aggregate the wiki index renders.
 */
export async function listWikiEntities(ctx: WorldContext): Promise<WikiEntry[]> {
  const entries: WikiEntry[] = (await listBracketableEntities(ctx)).map((e) => ({
    kind: e.kind,
    id: e.id,
    name: e.name,
  }))
  for (const s of await sessionLister.list(ctx)) {
    entries.push({ kind: 'session', id: s.id, name: s.name })
  }
  return entries
}

/** A session reduced to what the graph + history need (incl. captured_text). */
interface SessionRow {
  id: string
  name: string
  played_at: string | null
  captured_text: string
}

interface SessionGraphLister {
  list(ctx: WorldContext): Promise<ReadonlyArray<SessionRow>>
}

// Sessions ride the content seam (with the `session` kind), so this list is
// already visibility-filtered for players — a session they can't see (dm_only,
// or restricted without a grant) never reaches their graph or history.
const sessionGraphLister: SessionGraphLister = createContentRepository('sessions', {
  kind: 'session',
})

/** A resolved session link: a touch or a bracket between an entity and a session. */
type SessionLinkType = 'touch' | 'bracket'
interface SessionLink {
  entity: EntityRef
  sessionId: string
  type: SessionLinkType
}

/** The authorized inputs every graph/history computation reads. */
async function gatherGraphInputs(ctx: WorldContext): Promise<{
  entities: BracketEntity[]
  index: NameIndex
  sessions: ReadonlyArray<SessionRow>
  touches: ReadonlyArray<{ session_id: string; entity_id: string }>
}> {
  const entities = await listBracketableEntities(ctx)
  const index = buildNameIndex(
    BRACKET_RESOLVER_ORDER.map((k) => ({
      kind: k,
      rows: entities.filter((e) => e.kind === k).map((e) => ({ id: e.id, name: e.name })),
    })),
  )
  const [sessions, touches] = await Promise.all([sessionGraphLister.list(ctx), listTouches(ctx)])
  return { entities, index, sessions, touches }
}

/**
 * Resolve every entity↔session link the actor may see: a `touch` per
 * (visible entity, visible session) pair with an EntityTouch, and a `bracket`
 * per unique resolved `[[mention]]` in a session's captured_text — minus any
 * pair already joined by a touch (touch wins, mirroring dm-manager). Because the
 * name-index and the entity/session lists are built only from authorized rows,
 * both endpoints of every link are visible by construction.
 */
export function computeSessionLinks(inputs: {
  entities: BracketEntity[]
  index: NameIndex
  sessions: ReadonlyArray<SessionRow>
  touches: ReadonlyArray<{ session_id: string; entity_id: string }>
}): SessionLink[] {
  const { entities, index, sessions, touches } = inputs
  // Touches no longer carry the kind; derive it from the visible entity list.
  // An id absent here is an entity the actor can't see → the touch is skipped.
  const kindById = new Map(entities.map((e) => [e.id, e.kind]))
  const sessionIds = new Set(sessions.map((s) => s.id))
  const links: SessionLink[] = []
  const touchPairs = new Set<string>()

  for (const t of touches) {
    if (!sessionIds.has(t.session_id)) continue
    const kind = kindById.get(t.entity_id)
    if (kind === undefined) continue
    const key = `${kind}:${t.entity_id}|${t.session_id}`
    if (touchPairs.has(key)) continue
    touchPairs.add(key)
    links.push({
      entity: { kind, id: t.entity_id },
      sessionId: t.session_id,
      type: 'touch',
    })
  }

  for (const s of sessions) {
    const seenNames = new Set<string>()
    for (const marker of parseBrackets(s.captured_text)) {
      const lower = marker.name.toLowerCase()
      if (seenNames.has(lower)) continue
      seenNames.add(lower)
      const ref = resolveBracket(marker.name, index)
      if (!ref) continue
      const key = `${ref.kind}:${ref.id}|${s.id}`
      if (touchPairs.has(key)) continue // touch wins
      links.push({ entity: ref, sessionId: s.id, type: 'bracket' })
    }
  }
  return links
}

/**
 * Build the entity graph for a world. Nodes are the entities AND sessions the
 * actor may see; edges are entity↔entity `[[name]]` links from descriptions
 * (`description`), plus entity↔session `touch` and `bracket` links. Because every
 * list + the name-index is built from authorized rows only, an edge exists only
 * when BOTH endpoints are visible — a player never sees a link to (or from) an
 * entity or session they can't see (dm_only, or restricted without a grant).
 * Self-links and duplicate links are dropped.
 *
 * ## Why edges are also filtered by PASSAGE, not just by endpoint
 *
 * Both-endpoints-visible is necessary but, since passages, no longer
 * sufficient. A `[[link]]` written inside a `dm_only` passage on a PUBLIC npc,
 * pointing at another PUBLIC entity, joins two entities the player is entitled
 * to see — so the endpoint rule admits it. But the secret was never either
 * endpoint; it was that the two are connected at all.
 *
 * The fix is not a second pass over the edges. `listBracketableEntities`
 * returns the viewer's COMPOSED text, so a bracket inside a passage they cannot
 * see is not in the text being parsed here, and the edge cannot be constructed.
 * The guarantee is restored by the same construction argument as before, with
 * no extra check to forget — which is the point, because a check added here
 * would have to be repeated in every future consumer of the same text.
 */
export async function buildEntityGraph(ctx: WorldContext): Promise<EntityGraph> {
  const inputs = await gatherGraphInputs(ctx)
  const { entities, index, sessions } = inputs

  const nodes: GraphNode[] = [
    ...entities.map((e) => ({ kind: e.kind, id: e.id, name: e.name })),
    ...sessions.map((s) => ({ kind: 'session', id: s.id, name: s.name })),
  ]

  const edges: GraphEdge[] = []
  const seen = new Set<string>()
  for (const e of entities) {
    for (const marker of parseBrackets(e.description)) {
      const ref = resolveBracket(marker.name, index)
      if (!ref) continue
      if (ref.kind === e.kind && ref.id === e.id) continue
      const key = `${e.kind}:${e.id}->${ref.kind}:${ref.id}`
      if (seen.has(key)) continue
      seen.add(key)
      edges.push({
        from: { kind: e.kind, id: e.id },
        to: { kind: ref.kind, id: ref.id },
        type: 'description',
      })
    }
  }
  for (const link of computeSessionLinks(inputs)) {
    edges.push({
      from: { kind: link.entity.kind, id: link.entity.id },
      to: { kind: 'session', id: link.sessionId },
      type: link.type,
    })
  }

  // TYPED relationships, which were invisible here until chain 470. Read
  // through `listRelationshipsForEntity`, which is the ONE place both the
  // both-endpoints rule and the source-passage rule are applied — so a relation
  // derived from a bracket inside a hidden reveal is not an edge for a viewer
  // who cannot see that reveal, by exactly the route that hides it on the page.
  //
  // Read per visible entity rather than as one table scan, for that reason: a
  // scan would need its own copy of both filters, and a second copy of a
  // visibility rule is how two surfaces come to disagree.
  const relationshipEdges = await Promise.all(
    entities.map(async (e) =>
      (await listRelationshipsForEntity(ctx, e.id))
        .filter((r) => r.outgoing)
        .map((r) => ({
          from: { kind: e.kind as string, id: e.id },
          to: { kind: r.other.kind, id: r.other.id },
          type: 'relationship' as const,
        })),
    ),
  )
  // No dedupe pass. Each relationship is ONE stored row and is read only from
  // the end that owns it (`outgoing`), so the same pair cannot arrive twice —
  // a guard here would be a branch nothing can take.
  edges.push(...relationshipEdges.flat())
  return { nodes, edges }
}

/** One session in an entity's history: the session + how it references the entity. */
export interface EntitySessionRef {
  id: string
  name: string
  played_at: string | null
  link: SessionLinkType
}

/**
 * The per-entity session history: every session the actor may see that touches
 * or brackets the given entity, newest-derived first by the same touch-wins
 * resolution the graph uses. Authorization-correct — only visible sessions, and
 * only when the entity itself is visible (the link wouldn't resolve otherwise).
 */
export async function listSessionsForEntity(
  ctx: WorldContext,
  kind: string,
  id: string,
): Promise<EntitySessionRef[]> {
  const inputs = await gatherGraphInputs(ctx)
  const byId = new Map(inputs.sessions.map((s) => [s.id, s]))
  const out: EntitySessionRef[] = []
  // computeSessionLinks yields at most one link per (entity, session) pair
  // (touch-wins + per-session bracket dedup), so no extra dedup is needed here.
  for (const link of computeSessionLinks(inputs)) {
    if (link.entity.kind !== kind || link.entity.id !== id) continue
    const s = byId.get(link.sessionId)
    if (s) out.push({ id: s.id, name: s.name, played_at: s.played_at, link: link.type })
  }
  return out
}
