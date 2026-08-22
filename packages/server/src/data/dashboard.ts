import { navKinds } from '@campaign-settings/shared'
import { createContentRepository } from '../authz/content'
import { ENTITY_REPOS } from './content-repos'
import type { WorldContext } from './context'
import { findPcForAccount, type LinkedPc, listParty } from './pc-account'
import { listMembers } from '../tenancy/members'
import { listTouchesForSession } from './touches'
import { listWikiEntities } from '../wiki'

/**
 * The world dashboard — what a viewer sees on arrival at `/worlds/:worldId`,
 * before they go looking for anything.
 *
 * ## No second authorization path
 *
 * Every field here is composed from a read that ALREADY goes through the
 * content-authorization seam: the session list is `ENTITY_REPOS.session`, the
 * counts are grouped off `listWikiEntities` plus `ENTITY_REPOS.map`, and the
 * party is `listParty`, which reads through the `pc` repo. Nothing in this
 * module writes a `visibility` clause of its own, and nothing reaches a table
 * directly. That is the task's hard constraint, and it is also why the GM and a
 * player see different counts for the same world without either number being
 * computed twice.
 *
 * ## Why "where you left off" and not "last session"
 *
 * Sessions are ordered by `played_at` descending with nulls last, falling back
 * to `updated_at` descending. Sophi chose `updated_at` over `created_at`
 * deliberately (2026-08-19): she reaches for what she has recently touched. The
 * consequence is load-bearing and must reach the screen — editing an old
 * undated session PROMOTES it, so the panel is about work-recency, not story
 * order. `ordering` says which of the two rules placed the row, so the web can
 * label it honestly instead of claiming a story-time "last session" that an
 * edit would turn into a lie.
 *
 * In the real data this is the normal case rather than an edge: every session
 * in the spirit-call world has a null `played_at`.
 */

/** A session row as the dashboard needs it. */
interface DashboardSessionRow {
  id: string
  name: string
  played_at: string | null
  captured_text: string
  updated_at: Date | string
}

interface DashboardSessionLister {
  list(ctx: WorldContext): Promise<ReadonlyArray<DashboardSessionRow>>
}

/**
 * The same seam instance shape `ENTITY_REPOS.session` is, re-declared here only
 * to name the columns this module reads. `ContentRepoLike` types its rows as
 * `{ id }` because it serves eighteen kinds with different payloads.
 */
const sessionLister: DashboardSessionLister = createContentRepository('sessions', {
  kind: 'session',
})

/** Which rule placed the session at the top of the list. */
export type SessionOrdering = 'played_at' | 'updated_at'

/** One entity a session interacted with, resolved to a name the page can render. */
export interface DashboardTouch {
  id: string
  entityId: string
  entityKind: string
  entityName: string
  /**
   * The raw `entity_touches.touch_type` value. Typed as `string`, not the
   * `TouchType` union: the column is a plain text column with no CHECK, so
   * narrowing here would assert something the database does not enforce. The
   * page groups on the `met` value and treats everything else as one bucket,
   * which stays correct whatever a legacy import wrote.
   */
  touchType: string
}

/** The session panel: the row, why it is the row, and who was in it. */
export interface DashboardSession {
  id: string
  name: string
  playedAt: string | null
  capturedText: string
  ordering: SessionOrdering
  touches: DashboardTouch[]
}

/** A party member: the character, and the player holding it if there is one. */
export interface PartyMember extends LinkedPc {
  /** The linked account's username, or null when the character has no player. */
  playerName: string | null
}

/** Everything the world dashboard renders, for whoever asked for it. */
export interface WorldDashboard {
  /** Null when the world has no session this viewer may see. */
  session: DashboardSession | null
  /** Every PC this viewer may see, with its player. Seam-filtered. */
  party: PartyMember[]
  /** The character this viewer plays here, or null. */
  myCharacter: LinkedPc | null
  /** Live count per registry kind, filtered to what this viewer may see. */
  counts: Record<string, number>
}

/**
 * Order sessions the way the panel presents them.
 *
 * A dated session always outranks an undated one — that is the `nulls last`
 * half, and it is what stops a freshly-edited undated session from displacing a
 * session the GM actually dated. Among equals the tiebreak is `updated_at`.
 *
 * Exported for its own test: the ordering is the one piece of this module that
 * is pure, and the rule it encodes was decided at some length.
 */
export function orderSessions<T extends { played_at: string | null; updated_at: Date | string }>(
  rows: readonly T[],
): T[] {
  return [...rows].sort((a, b) => {
    if (a.played_at !== b.played_at) {
      if (a.played_at === null) return 1
      if (b.played_at === null) return -1
      return b.played_at.localeCompare(a.played_at)
    }
    return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
  })
}

/**
 * Count every kind this viewer may see, including the kinds with none.
 *
 * A kind absent from the record and a kind at zero are the same fact to the
 * reader, and a missing key would make the quick-link row ragged, so every
 * registry kind is seeded at 0 before the visible rows are tallied onto it.
 */
async function countsByKind(ctx: WorldContext): Promise<Record<string, number>> {
  // listWikiEntities covers the 16 content kinds plus sessions; maps have no
  // wiki surface and are counted off their own repo. Both are seam reads.
  const [entries, maps] = await Promise.all([listWikiEntities(ctx), ENTITY_REPOS.map!.list(ctx)])

  // Tallied into a Map first, then projected onto the registry. Doing it the
  // other way — seeding the record and incrementing into it — needs a "is this
  // a kind I seeded" guard that no row can ever fail, because listWikiEntities
  // returns registry kinds only. This shape has no unreachable branch.
  const tally = new Map<string, number>()
  for (const e of entries) tally.set(e.kind, (tally.get(e.kind) ?? 0) + 1)

  const counts: Record<string, number> = {}
  for (const entry of navKinds()) counts[entry.kind] = tally.get(entry.kind) ?? 0
  counts.map = maps.length
  return counts
}

/** Resolve the top session and the entities it touched, or null if there is none. */
async function topSession(ctx: WorldContext): Promise<DashboardSession | null> {
  const sessions = orderSessions(await sessionLister.list(ctx))
  const top = sessions[0]
  if (!top) return null

  // Touch rows name an entity by id alone. Resolve names through the same
  // authorization-filtered wiki list every other surface uses, and DROP a touch
  // whose entity this viewer cannot see — the touch table has no visibility of
  // its own, so the endpoint's is the whole of the rule.
  const [touchRows, entries] = await Promise.all([
    listTouchesForSession(ctx, top.id),
    listWikiEntities(ctx),
  ])
  const byId = new Map(entries.map((e) => [e.id, e]))
  const touches: DashboardTouch[] = []
  for (const t of touchRows) {
    const entity = byId.get(t.entity_id)
    if (!entity) continue
    touches.push({
      id: t.id,
      entityId: t.entity_id,
      entityKind: entity.kind,
      entityName: entity.name,
      touchType: t.touch_type,
    })
  }

  return {
    id: top.id,
    name: top.name,
    playedAt: top.played_at,
    capturedText: top.captured_text,
    ordering: top.played_at === null ? 'updated_at' : 'played_at',
    touches,
  }
}

/** Compose the world dashboard for whoever is asking. */
export async function buildWorldDashboard(ctx: WorldContext): Promise<WorldDashboard> {
  const [session, party, myCharacter, counts, members] = await Promise.all([
    topSession(ctx),
    listParty(ctx),
    findPcForAccount(ctx, ctx.actor.accountId),
    countsByKind(ctx),
    listMembers(ctx.db, ctx.worldId),
  ])

  const usernameOf = new Map(members.map((m) => [m.accountId, m.username]))
  return {
    session,
    party: party.map((pc) => ({
      ...pc,
      playerName: pc.accountId === null ? null : (usernameOf.get(pc.accountId) ?? null),
    })),
    myCharacter: myCharacter ?? null,
    counts,
  }
}
