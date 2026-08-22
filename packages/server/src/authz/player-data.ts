import type { WorldContext } from '../data/context'
import { ForbiddenError } from './errors'

/**
 * Player-data rows (notes, characters) are owned by an account. The owning
 * player reads/writes only their own; the DM (owner role) may READ all of a
 * world's player-data but never write it. These helpers centralize that rule so
 * each player-data repo applies the same scope instead of reinventing it.
 */

/**
 * The owner-account a read must be filtered to, or null meaning "no restriction"
 * (the DM sees every player's data in the world).
 */
export function playerDataReadScope(ctx: WorldContext): { ownerId: string } | null {
  return ctx.actor.role === 'owner' ? null : { ownerId: ctx.actor.accountId }
}

/** A player-data write is allowed only by the row's owning account (not the DM). */
export function assertPlayerDataWrite(ctx: WorldContext, rowOwnerId: string): void {
  if (ctx.actor.accountId !== rowOwnerId) {
    throw new ForbiddenError(`player data is owned by another account (world ${ctx.worldId})`)
  }
}
