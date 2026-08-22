import { listMembers } from '../tenancy/members'
import { CONTENT_REPOS } from './content-repos'
import type { WorldContext } from './context'

/** Raised when a PC's `account_id` names someone who cannot hold it. */
export class PcAccountLinkError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PcAccountLinkError'
  }
}

/**
 * Refuse a PC→account link the database is about to refuse anyway, with a
 * sentence instead of a constraint violation.
 *
 * Neither rule here is the enforcement. Migration 0018 makes
 * `(world_id, account_id)` a foreign key into `world_members`, so a non-member
 * cannot be linked; 0019 adds a partial unique index, so a player cannot hold
 * two characters. Both hold against any caller, including one that never
 * reaches this function. What the database cannot do is explain itself — an
 * unguarded save surfaces a 500 that tells the GM nothing about what to fix.
 *
 * So this runs first and turns each into a 400 that names the problem, and in
 * the duplicate case names the character already holding the seat. Shaped after
 * `assertValidBaseRate` — the other per-kind rule the generic seam does not
 * know about — and called from the same two routes, `selfId` and all, which
 * keeps kind-specific logic out of the seam that serves all sixteen.
 *
 * `selfId` is why the route mints the id before creating: "is anyone else
 * already linked to this player" needs a "me" to exclude, or re-saving an
 * unchanged character would report itself as the conflict.
 *
 * A no-op when the patch does not touch the link. CLEARING it (`null` or `''`)
 * always passes: unlinking is how a retired character is recorded, and it
 * cannot name anyone wrongly.
 */
export async function assertLinkableAccount(
  ctx: WorldContext,
  selfId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  if (!('account_id' in patch)) return
  const target = patch.account_id
  if (target === null || target === undefined || target === '') return
  const accountId = String(target)

  // Resolved once and carried, not looked up twice: the membership check and
  // the duplicate message want the same row, and a second lookup would need a
  // fallback for a member we just proved is there.
  const member = (await listMembers(ctx.db, ctx.worldId)).find((m) => m.accountId === accountId)
  if (!member) {
    throw new PcAccountLinkError(
      'a character can only be linked to a member of this world — invite them first',
    )
  }

  const taken = (await listParty(ctx)).find((pc) => pc.accountId === accountId && pc.id !== selfId)
  if (taken) {
    throw new PcAccountLinkError(
      `${member.username} already plays ${taken.name} in this world. ` +
        'Clear that character’s player first — a retired character keeps its page, it just stops claiming the seat.',
    )
  }
}

/** A PC page as the party/character reads need it: the merged row plus its link. */
export interface LinkedPc {
  id: string
  name: string
  accountId: string | null
}

/**
 * The seam returns a flat merged row typed only as `{ id }`, so the two columns
 * this cares about are read off it by name.
 *
 * `name` gets no fallback: `entities.name` is NOT NULL and the create route
 * refuses an empty string, so a `?? ''` here would be a branch that cannot be
 * taken and cannot be tested. `account_id` gets a real one — it is nullable by
 * design, and an unlinked PC is the common case rather than an edge.
 */
function toLinkedPc(row: { id: string }): LinkedPc {
  const r = row as unknown as Record<string, unknown>
  return {
    id: String(r.id),
    name: String(r.name),
    accountId: typeof r.account_id === 'string' ? r.account_id : null,
  }
}

/**
 * Every PC page in the world with the account playing it — the DM dashboard's
 * party panel.
 *
 * Reads through the content seam rather than the table, so it is filtered to
 * what the CALLER may see. For an owner that is everything; for a player it
 * silently omits any PC the DM has hidden, which is the correct answer to
 * "who is in the party" from someone who is not supposed to know about the
 * ringer.
 */
export async function listParty(ctx: WorldContext): Promise<LinkedPc[]> {
  const rows = await CONTENT_REPOS.pc!.list(ctx)
  return rows.map(toLinkedPc)
}

/**
 * The PC page an account plays in this world — the player dashboard's "my
 * character".
 *
 * At most one, and the database says so: 0019's partial unique index over
 * `(world_id, account_id)` means a player holds one live character. A retired
 * one is recorded by clearing its link, which leaves its page — name, prose,
 * relationships, images — entirely intact while it stops claiming a seat.
 *
 * `undefined` covers three different situations that a caller cannot tell
 * apart and should not try to: this player has no character, or has one the DM
 * has hidden, or is not in this world at all. Seam-filtered like
 * {@link listParty}, so the hidden case resolves the same way as the absent
 * one. That is deliberate — the DM hid it, and the dashboard says "no
 * character yet" rather than reaching past the filter to contradict them.
 */
export async function findPcForAccount(
  ctx: WorldContext,
  accountId: string,
): Promise<LinkedPc | undefined> {
  return (await listParty(ctx)).find((pc) => pc.accountId === accountId)
}
