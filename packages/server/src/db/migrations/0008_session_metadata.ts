import { type Kysely, sql } from 'kysely'

/**
 * Session metadata for the account-settings session list (task
 * session-lifecycle-hardening): enough detail to RECOGNISE a session without
 * exposing its id.
 *
 * `last_seen_at` starts at the row's creation moment — for pre-0008 rows that
 * is `now()`, which is a lie by at most one session TTL and self-corrects on
 * the next authenticated request. Behaviour-preserving: nothing reads these
 * columns until the new routes do.
 *
 * `device_label` deliberately holds a DERIVED, coarse string ("Firefox on
 * Linux"), never the raw User-Agent header. The task's constraint is that this
 * is a privacy choice: a full UA string is a fingerprinting surface and a
 * cross-account correlation key, and the only thing the list needs is enough
 * for a human to tell their phone from their laptop. Nullable because the
 * header is optional (API clients, the operator CLI, curl).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('auth_sessions')
    .addColumn('last_seen_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute()
  await db.schema.alterTable('auth_sessions').addColumn('device_label', 'text').execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('auth_sessions').dropColumn('device_label').execute()
  await db.schema.alterTable('auth_sessions').dropColumn('last_seen_at').execute()
}
