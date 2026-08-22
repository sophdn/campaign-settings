import { nextAvailableSlug, slugify } from '@campaign-settings/shared'
import type { Kysely } from 'kysely'
import { newId } from '../db/ids'
import type { Database } from '../db/schema'
import {
  acceptOwnership,
  cancelOwnershipOffer,
  getPendingTransfer,
  leaveWorld,
  offerOwnership,
  removeMembership,
} from './lifecycle'
import { listMembers, upsertMember } from './members'
import { ForbiddenError, type TenancyService, type WorldView } from './types'
import {
  deleteWorldRow,
  getWorldForAccount,
  getWorldRow,
  insertWorld,
  listWorldsForAccount,
  renameWorldRow,
  slugsWithPrefix,
  type WorldRow,
} from './worlds'

/**
 * World lifecycle + membership over the kysely DB. Ownership is the gate for
 * mutating a world (delete / grant / revoke); membership is the gate for seeing
 * it. Nothing here grants implicit cross-tenant access.
 */
export function createTenancy(db: Kysely<Database>): TenancyService {
  /** Fetch the world iff `actorId` owns it, else reject (also rejects absent). */
  async function requireOwnedWorld(actorId: string, worldId: string): Promise<WorldRow> {
    const world = await getWorldRow(db, worldId)
    if (!world || world.owner_id !== actorId) throw new ForbiddenError(worldId)
    return world
  }

  /**
   * A slug unique against the worlds that already share its prefix. The DB's
   * unique index is the real backstop (a rare concurrent same-name create would
   * collide there); this keeps the common case clean and human-readable.
   */
  async function uniqueWorldSlug(name: string): Promise<string> {
    const base = slugify(name)
    const taken = new Set(await slugsWithPrefix(db, base))
    return nextAvailableSlug(base, taken)
  }

  /**
   * The slug a rename should land on.
   *
   * A name that slugifies to what this world already answers to keeps the URL
   * it has: renaming "Chicago" to "chicago!" must not move anybody's links, and
   * must not read its own slug as a collision and drift to `chicago-2`. Only a
   * genuinely different name goes looking for a free slug — and the world's own
   * is excluded from the taken set there too, so no history of the row can turn
   * a rename into a collision with itself.
   */
  async function slugForRename(world: WorldRow, name: string): Promise<string> {
    const base = slugify(name)
    if (base === slugify(world.name)) return world.slug
    const taken = new Set((await slugsWithPrefix(db, base)).filter((s) => s !== world.slug))
    return nextAvailableSlug(base, taken)
  }

  async function createWorld(ownerId: string, name: string): Promise<WorldView> {
    const id = newId()
    const slug = await uniqueWorldSlug(name)
    await insertWorld(db, { id, owner_id: ownerId, name, slug })
    await upsertMember(db, { world_id: id, account_id: ownerId, role: 'owner' })
    return { id, name, slug, ownerId, role: 'owner' }
  }

  async function grantMember(actorId: string, worldId: string, accountId: string): Promise<void> {
    await requireOwnedWorld(actorId, worldId)
    await upsertMember(db, { world_id: worldId, account_id: accountId, role: 'player' })
  }

  return {
    createWorld,
    grantMember,

    listMembers(worldId) {
      return listMembers(db, worldId)
    },

    listWorlds(accountId) {
      return listWorldsForAccount(db, accountId)
    },

    async getWorld(accountId, worldId) {
      return (await getWorldForAccount(db, accountId, worldId)) ?? null
    },

    async renameWorld(actorId, worldId, name) {
      const world = await requireOwnedWorld(actorId, worldId)
      const slug = await slugForRename(world, name)
      await renameWorldRow(db, worldId, { name, slug })
      // Nothing else moves: membership, content, grants and invitations all
      // hang off the world id, which a rename never touches.
      return { id: worldId, name, slug, ownerId: world.owner_id, role: 'owner' }
    },

    async deleteWorld(actorId, worldId) {
      await requireOwnedWorld(actorId, worldId)
      await deleteWorldRow(db, worldId)
    },

    async revokeMember(actorId, worldId, accountId) {
      const world = await requireOwnedWorld(actorId, worldId)
      if (accountId === world.owner_id) throw new ForbiddenError(worldId)
      // The SAME purge as leaving, on purpose. Two paths out of a world that
      // disagreed about what leaving destroys is how a removed player gets
      // their restricted pages back the day they are re-added.
      await removeMembership(db, worldId, accountId)
    },

    leaveWorld(accountId, worldId) {
      return leaveWorld(db, worldId, accountId)
    },

    async offerOwnership(actorId, worldId, toAccountId) {
      await requireOwnedWorld(actorId, worldId)
      await offerOwnership(db, worldId, toAccountId)
    },

    async cancelOwnershipOffer(actorId, worldId) {
      await requireOwnedWorld(actorId, worldId)
      await cancelOwnershipOffer(db, worldId)
    },

    pendingTransfer(worldId) {
      return getPendingTransfer(db, worldId)
    },

    acceptOwnership(accountId, worldId) {
      return acceptOwnership(db, worldId, accountId)
    },

    async createWorldWithPlayer(ownerId, name, playerId) {
      const world = await createWorld(ownerId, name)
      await grantMember(ownerId, world.id, playerId)
      return world
    },
  }
}
