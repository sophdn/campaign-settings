import { type Kysely, sql } from 'kysely'

/**
 * Fold the nine dormant junction tables into `entity_relationships`.
 *
 * ## What was here
 *
 * Nine tables carried over from dm-manager recorded relations the typed
 * relationship vocabulary could not say: which languages an NPC SPEAKS, which
 * magic systems a culture PRACTISES, which pantheon it VENERATES, where a
 * resource is FOUND. They were written only by the importer, read by no route,
 * and reachable from no UI — dormant, but not redundant, because collapsing
 * them into `related_to` would have thrown away the very distinction that made
 * them worth storing.
 *
 * ## Why they go
 *
 * Migration 0014 argued in writing against the per-kind junction pattern
 * ("a combinatorial explosion of tables that all say the same thing") and 0005
 * moved the same direction for per-kind columns. Keeping eleven tables alive so
 * four of them can express "speaks" is the shape both migrations rejected. The
 * vocabulary widens instead, and the junction rows become relationship rows.
 *
 * The real prize is the seam: `data/relationships.ts` already resolves both
 * endpoints through the content seam and drops a row whole when either is
 * invisible. Rows moved here inherit that. Left as junctions they would each
 * have needed their own visibility-correct read, which is nine chances to write
 * that filter slightly wrong.
 *
 * ## The two tables that do NOT move
 *
 * `settlement_currency_attachments` and `organization_currency_attachments` are
 * not junctions. They carry `id`, `is_primary`, `notes`, timestamps, `deleted_at`
 * AND `visibility` — they satisfy `ContentTableName` and already ride the seam
 * as content rows. `entity_relationships` deliberately has neither `visibility`
 * nor `deleted_at`, so folding them in would DESTROY per-row visibility and
 * soft-delete on rows that have it. They stay exactly as they are.
 *
 * ## `qualifier`
 *
 * The four language junctions carry a `role` and this table had nowhere to put it
 * — only a free-text `note`. Folding a small controlled vocabulary into prose
 * would make it unfilterable, so the column is added.
 * `resource_locations.notes` needs nothing new: it maps onto `note`.
 *
 * The vocabulary is the UNION of four CHECK constraints, and it is four values
 * rather than the three you get from reading one table: `culture_languages`
 * allowed native/secondary/liturgical, and the npc/pc/settlement tables allowed
 * native/secondary/trade. `LANGUAGE_ROLES` in `packages/shared` is that union, so
 * no existing row is refused on the way in. Like `type`, `qualifier` gets no
 * CHECK — for the reason 0014 gives at length: the vocabulary lives in `shared`
 * where every surface reads one copy, and a CHECK here would be a second.
 */

/**
 * Junctions that become one relationship type each.
 *
 * ONE list, read by both `up` (which folds these tables in) and `down` (which
 * recreates them), so the two directions cannot disagree about which nine tables
 * this migration is about or what their columns are called.
 *
 * `roleValues` is the table's own `role` CHECK vocabulary, which is NOT uniform —
 * `culture_languages` allowed `liturgical` where the other three allowed `trade`.
 * `down` needs the per-table list to restore the constraint exactly; `up` needs
 * only their union, which is `LANGUAGE_ROLES` in `packages/shared`.
 */
const FOLDS: ReadonlyArray<{
  table: string
  from: string
  to: string
  type: string
  /** Column carrying the role qualifier, if any, and the values it accepted. */
  role?: string
  roleValues?: readonly string[]
  /** Column carrying free text, if any. */
  note?: string
}> = [
  {
    table: 'culture_languages',
    from: 'culture_id',
    to: 'language_id',
    type: 'speaks',
    role: 'role',
    roleValues: ['native', 'secondary', 'liturgical'],
  },
  {
    table: 'npc_languages',
    from: 'npc_id',
    to: 'language_id',
    type: 'speaks',
    role: 'role',
    roleValues: ['native', 'secondary', 'trade'],
  },
  {
    table: 'pc_languages',
    from: 'pc_id',
    to: 'language_id',
    type: 'speaks',
    role: 'role',
    roleValues: ['native', 'secondary', 'trade'],
  },
  {
    table: 'settlement_languages',
    from: 'settlement_id',
    to: 'language_id',
    type: 'speaks',
    role: 'role',
    roleValues: ['native', 'secondary', 'trade'],
  },
  {
    table: 'culture_magic_systems',
    from: 'culture_id',
    to: 'magic_system_id',
    type: 'practises',
  },
  { table: 'npc_magic_systems', from: 'npc_id', to: 'magic_system_id', type: 'practises' },
  { table: 'pc_magic_systems', from: 'pc_id', to: 'magic_system_id', type: 'practises' },
  { table: 'culture_pantheons', from: 'culture_id', to: 'pantheon_id', type: 'venerates' },
  {
    table: 'resource_locations',
    from: 'resource_id',
    to: 'location_id',
    type: 'found_at',
    note: 'notes',
  },
]

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('entity_relationships').addColumn('qualifier', 'text').execute()

  for (const fold of FOLDS) {
    // Three guards. Only one of them can actually fire here, and saying which is
    // the point — a guard described as protecting against something the schema
    // already forbids teaches the next reader the wrong thing about the data.
    //
    //   - `join entities` on both endpoints: DEFENSIVE, cannot fire. Since 0005
    //     every one of these tables FKs both endpoint columns to `entities(id)`
    //     ON DELETE CASCADE, so an orphaned pair cannot exist to be found. Kept
    //     because the insert targets two more FKs and an inner join is a cheaper
    //     failure than an aborted migration if that ever stops being true. The
    //     join deliberately does NOT filter `deleted_at`: a soft-deleted endpoint
    //     is still a row, and dropping its relations would lose data the fold
    //     promises to preserve.
    //   - `from <> to`: LOAD-BEARING. The junction PKs are composite over the
    //     pair, which permits `(cu1, cu1)`, and `entity_relationships` carries
    //     CHECK `from_id <> to_id`. Without this the migration would abort on a
    //     self-pair that the source schema was happy to store.
    //   - ON CONFLICT DO NOTHING: LOAD-BEARING, though only across tables. The
    //     unique index allows a pair to hold several DIFFERENT relations but not
    //     the same one twice, and two tables can fold to one type — an id present
    //     in both `npc_languages` and `pc_languages` yields `speaks` twice for
    //     the same pair. Within a single table the composite PK already makes a
    //     duplicate impossible.
    await sql`
      insert into entity_relationships (id, world_id, from_id, to_id, type, note, qualifier)
      select
        gen_random_uuid()::text,
        j.world_id,
        j.${sql.ref(fold.from)},
        j.${sql.ref(fold.to)},
        ${fold.type},
        ${fold.note ? sql`coalesce(j.${sql.ref(fold.note)}, '')` : sql`''`},
        ${fold.role ? sql`nullif(j.${sql.ref(fold.role)}, '')` : sql`null`}
      from ${sql.ref(fold.table)} j
      join entities ef on ef.id = j.${sql.ref(fold.from)}
      join entities et on et.id = j.${sql.ref(fold.to)}
      where j.${sql.ref(fold.from)} <> j.${sql.ref(fold.to)}
      on conflict do nothing
    `.execute(db)
  }

  for (const fold of FOLDS) {
    await db.schema.dropTable(fold.table).execute()
  }
}

/**
 * Reverse the SCHEMA, and deliberately move no rows back.
 *
 * ## What comes back, and what does not
 *
 * The nine tables are recreated in the shape 0017 found them in — post-0005, so
 * both endpoint columns reference `entities(id)` — and `qualifier` is dropped.
 * They come back EMPTY, and the folded rows are left where `up` put them, still
 * in `entity_relationships`. So this destroys no relationship: it un-does the
 * structural change and leaves the data addressable, which means `up` → `down` →
 * `up` is stable (the second `up` finds nine empty tables and copies nothing).
 *
 * The one real loss is `qualifier` values, which go with the column. A language
 * role recorded after this migration ran does not survive a rollback.
 *
 * ## Why not route the rows back
 *
 * Because the fold is not injective and forcing it would corrupt rather than
 * restore. A `speaks` row says which entity speaks which language; WHICH of the
 * four `*_languages` tables it belongs to is a function of the subject's kind, and
 * three things break that:
 *
 *   - a relationship asserted through the UI AFTER this migration never came from
 *     a junction, and filing it in one would invent history
 *   - nothing constrains a relationship's endpoint kinds (see `change-kind.ts`),
 *     so `speaks` is now assertable from a kind that never had a junction table —
 *     an organization, an item — and those rows have no destination at all
 *   - `qualifier`'s vocabulary is the UNION of the four old CHECK constraints, so
 *     a culture whose qualifier is `trade` cannot go back into
 *     `culture_languages` at all: its CHECK allows only native/secondary/liturgical
 *
 * A `down` that tried anyway would either abort partway or silently drop the rows
 * it could not place. Leaving them in `entity_relationships` loses nothing and
 * tells the truth about where they are.
 */
export async function down(db: Kysely<unknown>): Promise<void> {
  for (const fold of FOLDS) {
    let table = db.schema
      .createTable(fold.table)
      .addColumn('world_id', 'text', (c) => c.notNull().references('worlds.id').onDelete('cascade'))
      // Both endpoints reference `entities` rather than a per-kind table: that is
      // the shape 0005 left them in and therefore the shape reversing 0017 must
      // restore. Restoring the pre-0005 references would reverse two migrations.
      .addColumn(fold.from, 'text', (c) =>
        c.notNull().references('entities.id').onDelete('cascade'),
      )
      .addColumn(fold.to, 'text', (c) => c.notNull().references('entities.id').onDelete('cascade'))
      .addPrimaryKeyConstraint(`${fold.table}_pkey`, [fold.from, fold.to])

    if (fold.role && fold.roleValues) {
      const values = sql.join(fold.roleValues.map((v) => sql.lit(v)))
      table = table
        .addColumn(fold.role, 'text', (c) => c.notNull())
        .addCheckConstraint(`${fold.table}_role_check`, sql`${sql.ref(fold.role)} in (${values})`)
    }
    if (fold.note) {
      table = table.addColumn(fold.note, 'text', (c) => c.notNull().defaultTo(''))
    }
    await table.execute()

    // The reverse-direction index every one of these carried: the composite PK
    // covers lookups by the subject, so without this the object side scans.
    await db.schema
      .createIndex(`${fold.table}_by_${fold.to.replace(/_id$/, '')}`)
      .on(fold.table)
      .column(fold.to)
      .execute()
  }

  await db.schema.alterTable('entity_relationships').dropColumn('qualifier').execute()
}
