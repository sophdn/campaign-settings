import { type Kysely, sql } from 'kysely'

/**
 * Where a relationship came from, so a `[[bracket]]` can create one and a
 * reveal's secret can stay secret.
 *
 * `[[brackets]]` and typed relationships were two implementations of one
 * concept, and readers already read them as one. Unifying them means a save
 * creates relationship rows from the prose — which raises two questions the
 * table could not answer, and this migration adds a column for each.
 *
 * ## `origin` — may reconciliation touch this row?
 *
 * A GM's hand-authored relationship must survive any rewording of the prose.
 * A bracket-derived one is reconciliation's to maintain. Without the
 * distinction, a save would have to guess, and the safe guess (never delete)
 * would leave every removed bracket's row behind forever.
 *
 * DEFAULT 'authored', which is the correct reading of every row that exists
 * today: each was typed by a GM through the relationship form.
 *
 * ## `source_passage_id` — whose audience governs this row?
 *
 * A bracket inside a REVEAL creates a relationship too, and that relationship
 * must surface only for someone who can see the reveal. `entity_relationships`
 * deliberately has no `visibility` column of its own — a relationship names two
 * entities and is readable exactly when both are, which is a rule about the
 * endpoints rather than about the row.
 *
 * So visibility is not COPIED here. This is a foreign key to the passage whose
 * text produced the row, and the read path derives the audience from that
 * passage every time. Copying `entity_passages.visibility` onto the row would
 * create a second copy to keep in step, and raising a reveal's visibility would
 * then have to remember to rewrite every relationship it sourced. Deriving
 * means revealing a passage reveals its relationships with NO extra write.
 *
 * NULL means the base description — always visible, so no extra condition.
 *
 * ON DELETE CASCADE, and it is load-bearing rather than tidiness: a row whose
 * source passage was hard-deleted would have a dangling audience, and "readable
 * by whoever could see a passage that no longer exists" is not an answer.
 * Passages are normally SOFT-deleted, and that path is handled by
 * reconciliation instead — the deleted passage's text leaves the source set, so
 * its rows fall back to another source or retire.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('entity_relationships')
    .addColumn('origin', 'text', (c) => c.notNull().defaultTo('authored'))
    .execute()

  await db.schema
    .alterTable('entity_relationships')
    .addColumn('source_passage_id', 'text', (c) =>
      c.references('entity_passages.id').onDelete('cascade'),
    )
    .execute()

  // Reconciliation reads "every bracket-derived row from this entity" on every
  // save of that entity, which is the hottest query this feature adds.
  await db.schema
    .createIndex('entity_relationships_bracket_from')
    .on('entity_relationships')
    .columns(['world_id', 'from_id'])
    .where(sql.ref('origin'), '=', 'bracket')
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex('entity_relationships_bracket_from').execute()
  await db.schema.alterTable('entity_relationships').dropColumn('source_passage_id').execute()
  await db.schema.alterTable('entity_relationships').dropColumn('origin').execute()
}
