import type { MemberRole } from '../db/schema'

/**
 * The tenancy seam (port). Worlds + membership are what grant visibility into
 * domain data; the authorization filter (next task) keys off the role this
 * layer assigns. Callers depend only on this interface.
 */

/** A world as seen by a specific account, carrying that account's role in it. */
export interface WorldView {
  id: string
  name: string
  /** Unique, human-readable URL key derived from the name (e.g. `chicago-2`). */
  slug: string
  ownerId: string
  /** The requesting account's role in this world. */
  role: MemberRole
}

/**
 * One member of a world as the member list shows them. Deliberately carries no
 * email — every member of a world can read this list, so it stays to the
 * identity the app already publishes (the username) plus the role.
 */
export interface MemberView {
  accountId: string
  username: string
  role: MemberRole
  joinedAt: Date
}

/** An outstanding ownership offer: who it names. Null when there is none. */
export interface PendingTransfer {
  accountId: string
  username: string
}

export interface TenancyService {
  /** Create a world owned by `ownerId` (who becomes its `owner` member). */
  createWorld(ownerId: string, name: string): Promise<WorldView>
  /**
   * Everyone in the world, owner first. Readable by any MEMBER, not just the
   * owner: a player needs to know who else is in the campaign, and the names
   * are already visible through suggestions and shared content. Mutating the
   * list stays owner-only.
   */
  listMembers(worldId: string): Promise<MemberView[]>
  /** Worlds the account owns or is a member of (nothing else is visible). */
  listWorlds(accountId: string): Promise<WorldView[]>
  /** A single world iff the account is a member, else null. */
  getWorld(accountId: string, worldId: string): Promise<WorldView | null>
  /**
   * Rename a world. Owner only. The slug follows the name, so the world's URL
   * changes with it and links to the old one stop resolving — the recorded
   * decision, revisitable once there is a public deployment.
   *
   * Idempotent on a name that slugifies to what it already had: the URL stays
   * where it is rather than drifting to `-2` by colliding with itself.
   */
  renameWorld(actorId: string, worldId: string, name: string): Promise<WorldView>
  /** Delete a world (cascades to all its data). Owner only. */
  deleteWorld(actorId: string, worldId: string): Promise<void>
  /** Grant `accountId` player membership. Owner only; idempotent. */
  grantMember(actorId: string, worldId: string, accountId: string): Promise<void>
  /** Revoke `accountId`'s membership. Owner only; cannot revoke the owner. */
  revokeMember(actorId: string, worldId: string, accountId: string): Promise<void>

  /**
   * Leave a world of your own accord. Rejects for the OWNER — a world may never
   * be ownerless, so their exits are transfer-then-leave, or delete.
   *
   * Leaving deletes the leaver's notes, characters, and entity grants for that
   * world. The UI offers a download of the first two beforehand.
   */
  leaveWorld(accountId: string, worldId: string): Promise<void>
  /** Offer the world to an existing member. An offer only — they must accept. */
  offerOwnership(actorId: string, worldId: string, toAccountId: string): Promise<void>
  /** Withdraw an outstanding offer. Owner only; idempotent. */
  cancelOwnershipOffer(actorId: string, worldId: string): Promise<void>
  /** The outstanding offer for a world, or null. Readable by any member. */
  pendingTransfer(worldId: string): Promise<PendingTransfer | null>
  /** Accept the offer naming you. Transactional; the old owner becomes a player. */
  acceptOwnership(accountId: string, worldId: string): Promise<void>
  /** Create a world and grant a player in one step. */
  createWorldWithPlayer(ownerId: string, name: string, playerId: string): Promise<WorldView>
}

/** Raised when an actor lacks ownership of the target world (or it's absent). */
export class ForbiddenError extends Error {
  constructor(worldId: string) {
    super(`forbidden: ${worldId}`)
    this.name = 'ForbiddenError'
  }
}
