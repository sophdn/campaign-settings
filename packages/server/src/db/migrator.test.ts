import { sql } from 'kysely'
import type { Migration } from 'kysely/migration'
import type { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { jsonb } from './json'
import { createDb } from './kysely'
import { MIGRATIONS } from './migrations'
import { migrateDown, migrateToLatest } from './migrator'
import type { MemberRole } from './schema'
import { withTestDatabase } from './test-database'

// The full schema after 0005: the 16 per-kind entity tables collapsed into one
// `entities` base + 13 `<kind>_details` tables (location/organization/item have
// none), plus the bespoke maps/calendars/sessions, junctions, polymorphic, and
// the net-new auth/tenancy/player tables.
const EXPECTED_TABLES = [
  'accounts',
  'auth_sessions',
  'password_reset_tokens',
  'email_verification_tokens',
  'world_invitations',
  'worlds',
  'world_members',
  'entity_visibility',
  'entities',
  'species_details',
  'culture_details',
  'pantheon_details',
  'language_details',
  'magic_system_details',
  'currency_details',
  'deity_details',
  'resource_details',
  'event_details',
  'lore_article_details',
  'npc_details',
  'pc_details',
  'settlement_details',
  'maps',
  'calendars',
  'sessions',
  'settlement_currency_attachments',
  'organization_currency_attachments',
  'map_pins',
  'entity_relationships',
  'entity_passages',
  'passage_visibility',
  'map_visibility',
  'entity_touches',
  'media_attachments',
  'dm_toolkit_meta',
  'player_notes',
  'suggestions',
]

async function colType(pool: Pool, table: string, col: string): Promise<string | undefined> {
  const r = await pool.query<{ data_type: string }>(
    `select data_type from information_schema.columns where table_name = $1 and column_name = $2`,
    [table, col],
  )
  return r.rows[0]?.data_type
}

async function hasColumn(pool: Pool, table: string, col: string): Promise<boolean> {
  return (await colType(pool, table, col)) !== undefined
}

/**
 * Migrations up to and including `lastKey`. Keys sort lexicographically by their
 * numeric prefix, so this stays correct as new migrations are added — an
 * isolation test for an early migration never accidentally applies a later one
 * out of order.
 */
const onlyThrough = (lastKey: string): Record<string, Migration> =>
  Object.fromEntries(Object.entries(MIGRATIONS).filter(([k]) => k <= lastKey))

describe('migrations 0001–0005 — full schema port + class-table inheritance', () => {
  it('builds every table with world_id scoping, Postgres-native types, FKs/enums; down() reverses it', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)

      // — every expected table exists, and nothing extra —
      const present = await pool.query<{ table_name: string }>(
        `select table_name from information_schema.tables
         where table_schema = 'public' and table_name not like 'kysely_%'`,
      )
      const got = new Set(present.rows.map((r) => r.table_name))
      for (const t of EXPECTED_TABLES) expect(got.has(t), `table ${t} missing`).toBe(true)
      expect(got.size).toBe(EXPECTED_TABLES.length)

      // — world_id is on the base, the detail tables, attachments, meta — not auth roots —
      for (const t of [
        'entities',
        'npc_details',
        'settlement_currency_attachments',
        'dm_toolkit_meta',
        'map_pins',
        'entity_relationships',
        'entity_passages',
        'passage_visibility',
        'map_visibility',
      ]) {
        expect(await hasColumn(pool, t, 'world_id'), `${t}.world_id`).toBe(true)
      }
      expect(await hasColumn(pool, 'accounts', 'world_id')).toBe(false)
      // the base carries the kind discriminator + visibility; details do not
      expect(await hasColumn(pool, 'entities', 'kind')).toBe(true)
      expect(await hasColumn(pool, 'entities', 'visibility')).toBe(true)
      expect(await hasColumn(pool, 'npc_details', 'visibility')).toBe(false)

      // — distinctive typed columns kept their real Postgres types —
      expect(await colType(pool, 'settlement_details', 'population')).toBe('integer')
      expect(await colType(pool, 'currency_details', 'denominations')).toBe('jsonb')
      expect(await colType(pool, 'calendars', 'config')).toBe('jsonb')
      expect(await colType(pool, 'species_details', 'is_corporeal')).toBe('boolean')
      expect(await colType(pool, 'entities', 'created_at')).toBe('timestamp with time zone')
      expect(await colType(pool, 'media_attachments', 'byte_size')).toBe('bigint')
      expect(await colType(pool, 'map_pins', 'x')).toBe('double precision')
      // worlds carries a slug (added by migration 0003) for human-readable URLs
      expect(await hasColumn(pool, 'worlds', 'slug')).toBe(true)

      // — a world-scoped insert graph: base+detail split, FKs, jsonb, enum roles all round-trip —
      await db
        .insertInto('accounts')
        .values({ id: 'acc1', username: 'dm', password_hash: 'h' })
        .execute()
      await db
        .insertInto('worlds')
        .values({ id: 'w1', owner_id: 'acc1', name: 'Chicago', slug: 'chicago' })
        .execute()
      await db
        .insertInto('entities')
        .values([
          { id: 'sp1', world_id: 'w1', kind: 'species', name: 'Vampire' },
          { id: 'cu1', world_id: 'w1', kind: 'culture', name: 'Camarilla' },
          { id: 'lg1', world_id: 'w1', kind: 'language', name: 'Latin' },
          { id: 'npc1', world_id: 'w1', kind: 'npc', name: 'The Prince', visibility: 'dm_only' },
          { id: 'cur1', world_id: 'w1', kind: 'currency', name: 'Dollar' },
          { id: 'st1', world_id: 'w1', kind: 'settlement', name: 'Chicago' },
        ])
        .execute()
      await db.insertInto('species_details').values({ entity_id: 'sp1', world_id: 'w1' }).execute()
      await db.insertInto('culture_details').values({ entity_id: 'cu1', world_id: 'w1' }).execute()
      await db.insertInto('language_details').values({ entity_id: 'lg1', world_id: 'w1' }).execute()
      await db
        .insertInto('npc_details')
        .values({
          entity_id: 'npc1',
          world_id: 'w1',
          species_id: 'sp1',
          culture_id: 'cu1',
          occupation: 'Prince of the City',
        })
        .execute()
      await db
        .insertInto('currency_details')
        .values({
          entity_id: 'cur1',
          world_id: 'w1',
          denominations: jsonb([{ name: 'cent', value: 0.01 }]),
          rate: 1,
        })
        .execute()
      await db
        .insertInto('settlement_details')
        .values({ entity_id: 'st1', world_id: 'w1', culture_id: 'cu1', population: 2_700_000 })
        .execute()
      // What used to be two junction inserts (`npc_languages`, `culture_languages`)
      // is one table since 0017 — same two facts, carrying the role in `qualifier`.
      await db
        .insertInto('entity_relationships')
        .values([
          {
            id: 'rel1',
            world_id: 'w1',
            from_id: 'npc1',
            to_id: 'lg1',
            type: 'speaks',
            qualifier: 'native',
          },
          {
            id: 'rel2',
            world_id: 'w1',
            from_id: 'cu1',
            to_id: 'lg1',
            type: 'speaks',
            qualifier: 'liturgical',
          },
        ])
        .execute()

      const npc = await db
        .selectFrom('entities')
        .selectAll()
        .where('id', '=', 'npc1')
        .executeTakeFirstOrThrow()
      expect(npc.kind).toBe('npc')
      expect(npc.visibility).toBe('dm_only')
      expect(npc.imported_metadata).toBeNull()

      const npcDetail = await db
        .selectFrom('npc_details')
        .selectAll()
        .where('entity_id', '=', 'npc1')
        .executeTakeFirstOrThrow()
      expect(npcDetail.species_id).toBe('sp1') // detail FK → entities.id
      expect(npcDetail.occupation).toBe('Prince of the City')

      const sp = await db
        .selectFrom('species_details')
        .selectAll()
        .where('entity_id', '=', 'sp1')
        .executeTakeFirstOrThrow()
      expect(sp.is_corporeal).toBe(true) // default applied as a real boolean

      const cur = await db
        .selectFrom('currency_details')
        .selectAll()
        .where('entity_id', '=', 'cur1')
        .executeTakeFirstOrThrow()
      expect(cur.denominations).toEqual([{ name: 'cent', value: 0.01 }]) // jsonb round-trip

      const st = await db
        .selectFrom('settlement_details')
        .selectAll()
        .where('entity_id', '=', 'st1')
        .executeTakeFirstOrThrow()
      expect(st.population).toBe(2_700_000)

      // — the kind CHECK constraint is enforced —
      await expect(
        db
          .insertInto('entities')
          .values({ id: 'bad', world_id: 'w1', kind: 'banana', name: 'X' })
          .execute(),
      ).rejects.toThrow()

      // — enum CHECK constraints are enforced —
      await expect(
        db
          .insertInto('world_members')
          .values({ world_id: 'w1', account_id: 'acc1', role: 'intruder' as MemberRole })
          .execute(),
      ).rejects.toThrow()

      // — down() tears the whole schema back down (through 0005.down → 0001.down) —
      await migrateDown(db)
      const gone = await pool.query<{ e: string | null; n: string | null }>(
        `select to_regclass('public.entities') as e, to_regclass('public.npcs') as n`,
      )
      expect(gone.rows[0]?.e).toBeNull()
      expect(gone.rows[0]?.n).toBeNull()
    })
  })
})

describe('migration 0004 — visibility backfill from existing dm_only data', () => {
  it('maps pre-existing dm_only rows to visibility on upgrade (true→dm_only, false→public)', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      // migrate only through 0003 — the pre-visibility schema (dm_only still present)
      await migrateToLatest(db, onlyThrough('0003_world_slug'))

      // seed the OLD shape via raw sql (the typed schema no longer knows dm_only)
      await sql`insert into accounts (id, username, password_hash) values ('acc1', 'dm', 'h')`.execute(
        db,
      )
      await sql`insert into worlds (id, owner_id, name, slug) values ('w1', 'acc1', 'W', 'w')`.execute(
        db,
      )
      await sql`insert into npcs (id, world_id, name, dm_only) values ('n-secret', 'w1', 'Secret', true), ('n-open', 'w1', 'Open', false)`.execute(
        db,
      )

      // apply 0004 too (but not 0005, which would drop npcs) → visibility backfilled
      await migrateToLatest(db, onlyThrough('0004_entity_visibility'))

      const rows = await sql<{
        id: string
        visibility: string
      }>`select id, visibility from npcs order by id`.execute(db)
      expect(rows.rows).toEqual([
        { id: 'n-open', visibility: 'public' },
        { id: 'n-secret', visibility: 'dm_only' },
      ])
    })
  })
})

describe('migration 0006 — nullable email with case-insensitive uniqueness', () => {
  it('applies to a pre-0006 database, leaves existing accounts NULL, and enforces ci-unique email tolerating NULL', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      // migrate through 0005 — the pre-email schema (no accounts.email column)
      await migrateToLatest(db, onlyThrough('0005_class_table_inheritance'))
      await sql`insert into accounts (id, username, password_hash) values ('acc1', 'dm', 'h')`.execute(
        db,
      )

      // apply 0006 → the column exists and the pre-existing account is NULL
      await migrateToLatest(db)
      expect(await hasColumn(pool, 'accounts', 'email')).toBe(true)
      const existing = await sql<{
        email: string | null
      }>`select email from accounts where id = 'acc1'`.execute(db)
      expect(existing.rows[0]?.email).toBeNull()

      // multiple NULL-email accounts are allowed (the index is partial)
      await sql`insert into accounts (id, username, password_hash) values ('acc2', 'p2', 'h')`.execute(
        db,
      )

      // case-insensitive uniqueness: DM@Example.com collides with dm@example.com
      await sql`insert into accounts (id, username, password_hash, email) values ('acc3', 'p3', 'h', 'DM@Example.com')`.execute(
        db,
      )
      await expect(
        sql`insert into accounts (id, username, password_hash, email) values ('acc4', 'p4', 'h', 'dm@example.com')`.execute(
          db,
        ),
      ).rejects.toThrow()
    })
  })
})

describe('migration 0008 — session metadata on a populated table', () => {
  it('adds last_seen_at (non-null, defaulted) and nullable device_label to pre-existing sessions', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      // migrate through 0007 — the pre-metadata schema (auth_sessions has neither column)
      await migrateToLatest(db, onlyThrough('0007_password_reset_tokens'))
      await sql`insert into accounts (id, username, password_hash) values ('acc1', 'dm', 'h')`.execute(
        db,
      )
      await sql`insert into auth_sessions (id, account_id, expires_at)
                values ('s1', 'acc1', now() + interval '1 day')`.execute(db)

      await migrateToLatest(db)
      expect(await hasColumn(pool, 'auth_sessions', 'last_seen_at')).toBe(true)
      expect(await hasColumn(pool, 'auth_sessions', 'device_label')).toBe(true)

      // the pre-existing row survived: backfilled recency, unknown device
      const row = await sql<{
        last_seen_at: Date | null
        device_label: string | null
      }>`select last_seen_at, device_label from auth_sessions where id = 's1'`.execute(db)
      expect(row.rows[0]?.last_seen_at).not.toBeNull()
      expect(row.rows[0]?.device_label).toBeNull()

      // device_label stays optional for clients that send no User-Agent
      await sql`insert into auth_sessions (id, account_id, expires_at)
                values ('s2', 'acc1', now() + interval '1 day')`.execute(db)
      const added = await sql<{
        device_label: string | null
      }>`select device_label from auth_sessions where id = 's2'`.execute(db)
      expect(added.rows[0]?.device_label).toBeNull()
    })
  })
})

describe('migration 0009 — case-insensitive username uniqueness', () => {
  it('applies to a pre-0009 database and then refuses a name differing only by case', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db, onlyThrough('0008_session_metadata'))
      await sql`insert into accounts (id, username, password_hash) values ('acc1', 'Sophi', 'h')`.execute(
        db,
      )

      await migrateToLatest(db)

      // stored capitalisation survives — only comparison folds
      const kept = await sql<{
        username: string
      }>`select username from accounts where id = 'acc1'`.execute(db)
      expect(kept.rows[0]?.username).toBe('Sophi')

      // the case variant is now rejected by the DB, not merely by app code
      await expect(
        sql`insert into accounts (id, username, password_hash) values ('acc2', 'sophi', 'h')`.execute(
          db,
        ),
      ).rejects.toThrow()
      // an unrelated name is still fine
      await sql`insert into accounts (id, username, password_hash) values ('acc3', 'player', 'h')`.execute(
        db,
      )
    })
  })

  it('refuses to run — loudly, naming the offenders — when accounts already collide', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db, onlyThrough('0008_session_metadata'))
      // the pre-0009 schema permits both: this is exactly the state the
      // migration must not silently resolve by renaming somebody
      await sql`insert into accounts (id, username, password_hash)
                values ('acc1', 'Sophi', 'h'), ('acc2', 'sophi', 'h')`.execute(db)

      await expect(migrateToLatest(db)).rejects.toThrow(/Sophi, sophi/)
      // and it left the accounts alone rather than renaming one of them
      const rows = await sql<{
        username: string
      }>`select username from accounts order by id`.execute(db)
      expect(rows.rows.map((r) => r.username)).toEqual(['Sophi', 'sophi'])
    })
  })
})

describe('migrator error handling', () => {
  it('throws when a migration up fails', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      const broken: Record<string, Migration> = {
        '0001_boom': { up: () => Promise.reject(new Error('boom')), down: () => Promise.resolve() },
      }
      await expect(migrateToLatest(db, broken)).rejects.toThrow('migrate up failed')
    })
  })

  it('throws when a migration down fails', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      const m: Record<string, Migration> = {
        '0001_x': {
          up: (d) => sql`create table x (id int)`.execute(d).then(() => undefined),
          down: () => Promise.reject(new Error('boom')),
        },
      }
      await migrateToLatest(db, m)
      await expect(migrateDown(db, m)).rejects.toThrow('migrate down failed')
    })
  })
})
