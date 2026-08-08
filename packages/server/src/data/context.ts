import type { Kysely } from 'kysely'
import type { Database, MemberRole } from '../db/schema'

/**
 * Who is performing an operation. The authorization filter (task:
 * authorization-read-write-filter) keys off `role` to enforce dm_only reads and
 * player-data ownership — repositories thread it now so that layer plugs in
 * without changing call sites.
 */
export interface Actor {
  accountId: string
  role: MemberRole
}

/**
 * A data-access handle bound to exactly ONE world. Every repository operation
 * filters/injects `worldId`, so a context for world A can never read or write
 * world B's rows — tenant isolation is structural, not a per-query convention.
 */
export interface WorldContext {
  db: Kysely<Database>
  worldId: string
  actor: Actor
}
