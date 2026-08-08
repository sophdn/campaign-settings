import type { Kysely } from 'kysely'
import type { Database } from '../db/schema'
import { importWorldRows } from './mappers'
import { openWorldDb } from './sqlite-reader'

/** Per-table count of rows imported. */
export type ImportCounts = Record<string, number>

/**
 * Import a dm-manager SQLite world DB into Postgres under `worldId`, preserving
 * existing ids and converting each column to its Postgres-native type. Tables
 * are imported in FK-dependency order. Read-only on the source.
 */
export async function importWorldDb(
  db: Kysely<Database>,
  worldId: string,
  sqlitePath: string,
): Promise<ImportCounts> {
  const reader = openWorldDb(sqlitePath)
  try {
    return await importWorldRows(db, worldId, reader)
  } finally {
    reader.close()
  }
}
