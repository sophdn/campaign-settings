import { type Kysely, sql } from 'kysely'

/**
 * World invitations: the door into a world for someone the owner names, or for
 * a stranger holding a shareable link. Only the SHA-256 hash of the token is
 * stored, exactly as password_reset_tokens does — the raw secret exists once,
 * in the link the owner copies.
 *
 * `invitee_account_id` distinguishes the two shapes with ONE table:
 *   - set    -> a targeted invitation; only that account may accept it
 *   - null   -> an open link; whoever holds it may accept, once
 *
 * `role` carries a CHECK pinning it to 'player'. Owner is conferred by creating
 * a world, never by invitation, so there is no request field that could ask for
 * it — the column exists to make the bound explicit and to survive the day
 * MemberRole grows, rather than to be read from a payload.
 *
 * `status` stores only pending / accepted / revoked. Expiry is DERIVED from
 * `expires_at` against the request clock and never written, for the same reason
 * auth_sessions does not carry an is_expired flag: a stored value that time can
 * falsify needs a sweeper to stay true, and until the sweeper runs the column
 * is lying. The API still reports 'expired' — it is computed at read time.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('world_invitations')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('world_id', 'text', (c) => c.notNull().references('worlds.id').onDelete('cascade'))
    .addColumn('invited_by', 'text', (c) =>
      c.notNull().references('accounts.id').onDelete('cascade'),
    )
    .addColumn('invitee_account_id', 'text', (c) => c.references('accounts.id').onDelete('cascade'))
    .addColumn('token_hash', 'text', (c) => c.notNull().unique())
    .addColumn('role', 'text', (c) => c.notNull().check(sql`role in ('player')`))
    .addColumn('status', 'text', (c) =>
      c.notNull().check(sql`status in ('pending', 'accepted', 'revoked')`),
    )
    .addColumn('expires_at', 'timestamptz', (c) => c.notNull())
    .addColumn('accepted_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute()
  await db.schema
    .createIndex('world_invitations_world_idx')
    .on('world_invitations')
    .column('world_id')
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('world_invitations').execute()
}
