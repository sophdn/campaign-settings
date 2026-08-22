import type { Kysely } from 'kysely'
import { hashToken, newToken } from '../auth/tokens'
import { newId } from '../db/ids'
import type { Database, InvitationStatus } from '../db/schema'
import { upsertMember } from './members'

/**
 * World invitations. Token handling mirrors password reset exactly — hashed at
 * rest, single-use, expiring — via the shared primitives in auth/tokens.
 */

/** How an invitation looks to the owner who created it. */
export interface InvitationView {
  id: string
  /** Effective status: the stored one, or `expired` when the clock has passed it. */
  status: InvitationStatus | 'expired'
  /** Username of the account this was aimed at, or null for an open link. */
  invitee: string | null
  createdAt: Date
  expiresAt: Date
  acceptedAt: Date | null
}

/** A valid, still-usable invitation resolved from a raw token. */
export interface ResolvedInvitation {
  id: string
  worldId: string
  worldName: string
  worldSlug: string
  /** Set when the invitation is aimed at one account; null for an open link. */
  inviteeAccountId: string | null
}

/**
 * Create an invitation and return the RAW token — the only moment it exists in
 * the clear. `inviteeAccountId` null makes it an open shareable link.
 */
export async function createInvitation(
  db: Kysely<Database>,
  input: {
    worldId: string
    invitedBy: string
    inviteeAccountId: string | null
    now: Date
    ttlMs: number
  },
): Promise<{ id: string; token: string }> {
  const raw = newToken()
  const id = newId()
  await db
    .insertInto('world_invitations')
    .values({
      id,
      world_id: input.worldId,
      invited_by: input.invitedBy,
      invitee_account_id: input.inviteeAccountId,
      token_hash: hashToken(raw),
      // Never read from the request — the bound is expressed here and in the
      // column's CHECK, so no payload can ask for more.
      role: 'player',
      status: 'pending',
      expires_at: new Date(input.now.getTime() + input.ttlMs),
    })
    .execute()
  return { id, token: raw }
}

/** Every invitation for a world, newest first, with expiry folded into status. */
export async function listInvitations(
  db: Kysely<Database>,
  worldId: string,
  now: Date,
): Promise<InvitationView[]> {
  const rows = await db
    .selectFrom('world_invitations')
    .leftJoin('accounts', 'accounts.id', 'world_invitations.invitee_account_id')
    .where('world_invitations.world_id', '=', worldId)
    .select([
      'world_invitations.id as id',
      'world_invitations.status as status',
      'world_invitations.expires_at as expires_at',
      'world_invitations.accepted_at as accepted_at',
      'world_invitations.created_at as created_at',
      'accounts.username as invitee',
    ])
    .orderBy('world_invitations.created_at', 'desc')
    .execute()

  return rows.map((row) => ({
    id: row.id,
    // Only a still-pending invitation can age into `expired`; one already
    // accepted or revoked keeps the state it reached.
    status: row.status === 'pending' && row.expires_at <= now ? 'expired' : row.status,
    invitee: row.invitee,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    acceptedAt: row.accepted_at,
  }))
}

/**
 * Mark a pending invitation revoked. Returns false if it does not belong to the
 * world or has already been accepted — an accepted invitation is history, and
 * revoking it would imply removing a member, which is `revokeMember`'s job.
 */
export async function revokeInvitation(
  db: Kysely<Database>,
  worldId: string,
  invitationId: string,
): Promise<boolean> {
  const result = await db
    .updateTable('world_invitations')
    .set({ status: 'revoked' })
    .where('id', '=', invitationId)
    .where('world_id', '=', worldId)
    .where('status', '=', 'pending')
    .executeTakeFirst()
  return Number(result.numUpdatedRows) > 0
}

/**
 * Resolve a raw token to a usable invitation, or null. Null covers unknown,
 * revoked, already-accepted, and expired alike: the caller maps every one to
 * the SAME opaque refusal, so a rejected token reveals nothing about whether it
 * ever existed or which world it pointed at.
 */
export async function resolveInvitation(
  db: Kysely<Database>,
  raw: string,
  now: Date,
): Promise<ResolvedInvitation | null> {
  const row = await db
    .selectFrom('world_invitations')
    .innerJoin('worlds', 'worlds.id', 'world_invitations.world_id')
    .where('world_invitations.token_hash', '=', hashToken(raw))
    .select([
      'world_invitations.id as id',
      'world_invitations.status as status',
      'world_invitations.expires_at as expires_at',
      'world_invitations.invitee_account_id as invitee_account_id',
      'worlds.id as world_id',
      'worlds.name as world_name',
      'worlds.slug as world_slug',
    ])
    .executeTakeFirst()
  if (!row || row.status !== 'pending' || row.expires_at <= now) return null
  return {
    id: row.id,
    worldId: row.world_id,
    worldName: row.world_name,
    worldSlug: row.world_slug,
    inviteeAccountId: row.invitee_account_id,
  }
}

/**
 * Mark an invitation accepted, iff it is still pending. The conditional update
 * is what makes a token single-use under concurrency: two simultaneous accepts
 * both resolve, but only one wins the row, and the loser is refused.
 */
async function markInvitationAccepted(
  db: Kysely<Database>,
  invitationId: string,
  now: Date,
): Promise<boolean> {
  const result = await db
    .updateTable('world_invitations')
    .set({ status: 'accepted', accepted_at: now })
    .where('id', '=', invitationId)
    .where('status', '=', 'pending')
    .executeTakeFirst()
  return Number(result.numUpdatedRows) > 0
}

/**
 * Redeem a token: join `accountId` to the world it points at, as a player.
 * Returns the world joined, or null for every refusal — unknown, revoked,
 * expired, already used, or aimed at somebody else.
 *
 * This is the ONE place membership is granted without the actor owning the
 * world, which is why the whole sequence lives here rather than exposing a
 * bare "add this member, trust me" call: the token IS the authorization, and
 * it is checked immediately above the grant with nothing in between.
 *
 * A targeted invitation aimed at another account is refused identically to an
 * invalid one. Saying "this is not yours" would confirm both that the token is
 * real and that some other named account exists.
 */
export async function acceptInvitation(
  db: Kysely<Database>,
  accountId: string,
  raw: string,
  now: Date,
): Promise<{ worldName: string; worldSlug: string } | null> {
  const invitation = await resolveInvitation(db, raw, now)
  if (!invitation) return null
  if (invitation.inviteeAccountId !== null && invitation.inviteeAccountId !== accountId) return null
  // Claim the token BEFORE granting: if the claim loses a concurrent race the
  // grant never happens, so a token can never produce two memberships.
  if (!(await markInvitationAccepted(db, invitation.id, now))) return null
  await upsertMember(db, {
    world_id: invitation.worldId,
    account_id: accountId,
    role: 'player',
  })
  return { worldName: invitation.worldName, worldSlug: invitation.worldSlug }
}
