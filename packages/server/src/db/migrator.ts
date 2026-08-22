import type { Kysely } from 'kysely'
import { type Migration, type MigrationProvider, Migrator } from 'kysely/migration'
import { MIGRATIONS } from './migrations'
import type { Database } from './schema'

class StaticMigrationProvider implements MigrationProvider {
  constructor(private readonly migrations: Record<string, Migration>) {}
  getMigrations(): Promise<Record<string, Migration>> {
    return Promise.resolve(this.migrations)
  }
}

export function createMigrator(
  db: Kysely<Database>,
  migrations: Record<string, Migration> = MIGRATIONS,
): Migrator {
  return new Migrator({ db, provider: new StaticMigrationProvider(migrations) })
}

/** Apply every pending migration; throws on the first failure. */
export async function migrateToLatest(
  db: Kysely<Database>,
  migrations: Record<string, Migration> = MIGRATIONS,
): Promise<void> {
  const { error } = await createMigrator(db, migrations).migrateToLatest()
  if (error) throw new Error(`migrate up failed: ${String(error)}`)
}

/** Roll back every applied migration; throws on the first failure. */
export async function migrateDown(
  db: Kysely<Database>,
  migrations: Record<string, Migration> = MIGRATIONS,
): Promise<void> {
  const migrator = createMigrator(db, migrations)
  let migrated = await migrator.migrateDown()
  while (!migrated.error && migrated.results && migrated.results.length > 0) {
    migrated = await migrator.migrateDown()
  }
  if (migrated.error) throw new Error(`migrate down failed: ${String(migrated.error)}`)
}
