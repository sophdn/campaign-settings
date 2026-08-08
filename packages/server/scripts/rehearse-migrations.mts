/**
 * rehearse-migrations.mts — run the pending migration sequence against a THROWAWAY
 * database restored from a live backup, and report row-count deltas either side.
 *
 * This is task 3637's rehearsal step. It exists because migrations run on BOOT:
 * without a rehearsal the first sign of a bad migration is a service that will not
 * come up. Point DATABASE_URL at a restored copy, never at the live database.
 *
 *   DATABASE_URL=postgres://…/campaign_rehearsal node --import tsx \
 *     packages/server/scripts/rehearse-migrations.mts
 */
import { createDb } from '../src/db/kysely'
import { migrateToLatest } from '../src/db/migrator'
import { Pool } from 'pg'
import { sql } from 'kysely'

const url = process.env.DATABASE_URL
if (!url) {
  console.error('rehearse-migrations: DATABASE_URL is required')
  process.exit(2)
}
if (/\/campaign(_dev)?$/.test(new URL(url).pathname === '/' ? '' : url)) {
  console.error(`rehearse-migrations: refusing to run against "${url}" — use a restored COPY`)
  process.exit(2)
}

const db = createDb(new Pool({ connectionString: url }))

const countOf = async (table: string): Promise<string> => {
  try {
    const r = await sql<{ n: string }>`select count(*)::text as n from ${sql.table(table)}`.execute(
      db,
    )
    return r.rows[0]?.n ?? 'NA'
  } catch {
    return '—'
  }
}

const TABLES = [
  'accounts',
  'worlds',
  'entities',
  'npcs',
  'pcs',
  'locations',
  'organizations',
  'lore_articles',
  'entity_visibility',
  'entity_touches',
  'sessions',
  'media_attachments',
]

try {
  const applied = await sql<{
    name: string
  }>`select name from kysely_migration order by timestamp`.execute(db)
  console.log(
    `before: ${applied.rows.length} migrations applied, latest = ${applied.rows.at(-1)?.name}`,
  )

  const before: Record<string, string> = {}
  for (const t of TABLES) before[t] = await countOf(t)

  console.log('\nrunning migrateToLatest()…')
  await migrateToLatest(db)

  const after: Record<string, string> = {}
  for (const t of TABLES) after[t] = await countOf(t)

  const now = await sql<{
    name: string
  }>`select name from kysely_migration order by timestamp`.execute(db)
  console.log(`\nafter: ${now.rows.length} migrations applied, latest = ${now.rows.at(-1)?.name}`)

  console.log('\nrow counts (— = table absent at that point):')
  for (const t of TABLES) {
    const flag =
      before[t] === after[t] || before[t] === '—' || after[t] === '—' ? '' : '  <-- CHANGED'
    console.log(
      `  ${t.padEnd(20)} before=${String(before[t]).padEnd(6)} after=${String(after[t]).padEnd(6)}${flag}`,
    )
  }

  const byKind = await sql<{
    kind: string
    n: string
  }>`select kind, count(*)::text as n from entities group by kind order by kind`.execute(db)
  console.log('\nentities by kind after 0005:')
  for (const r of byKind.rows) console.log(`  ${r.kind.padEnd(20)} ${r.n}`)
} finally {
  await db.destroy()
}
