import { type Kysely, sql } from 'kysely'

/**
 * Make account deletion safe at the SCHEMA level, before there is a route that
 * can trigger it. Two problems, both of which only become reachable the moment
 * accounts can be deleted at all:
 *
 * 1. `worlds.owner_id` was ON DELETE CASCADE. Deleting an account would take
 *    its worlds with it — and every member's notes, characters, and
 *    contributions inside them, since those cascade off `worlds.id`. The
 *    recorded decision is that deletion BLOCKS while the account owns worlds,
 *    resolved by transfer or an explicit per-world delete. Leaving the FK as
 *    CASCADE would mean that decision is enforced by one `if` in one handler,
 *    and the day something else deletes an account row the database would
 *    quietly destroy other people's campaigns. RESTRICT makes the invariant
 *    structural: the DB refuses, whatever the caller believed.
 *
 * 2. `entity_visibility.account_id` had NO foreign key at all (0004 declared it
 *    as a plain column). Deleting an account would leave orphan grant rows
 *    keyed to an id that no longer resolves — and since ids are not reused, they
 *    are dead weight rather than a live leak. Still wrong, and the fix is the
 *    constraint the column always wanted. CASCADE here: a grant is meaningless
 *    without the account it names.
 *
 * Behavior-preserving today: nothing in the app deletes an account, so no
 * existing row can violate either constraint. That is exactly why this lands
 * BEFORE the deletion route rather than alongside it.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table worlds drop constraint worlds_owner_id_fkey`.execute(db)
  await sql`
    alter table worlds
      add constraint worlds_owner_id_fkey
      foreign key (owner_id) references accounts (id) on delete restrict
  `.execute(db)

  await sql`
    alter table entity_visibility
      add constraint entity_visibility_account_id_fkey
      foreign key (account_id) references accounts (id) on delete cascade
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`alter table entity_visibility drop constraint entity_visibility_account_id_fkey`.execute(
    db,
  )
  await sql`alter table worlds drop constraint worlds_owner_id_fkey`.execute(db)
  await sql`
    alter table worlds
      add constraint worlds_owner_id_fkey
      foreign key (owner_id) references accounts (id) on delete cascade
  `.execute(db)
}
