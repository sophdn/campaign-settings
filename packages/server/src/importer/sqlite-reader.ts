import { DatabaseSync } from 'node:sqlite'
import type { Row } from './converters'

/** Read-only access to a dm-manager SQLite world DB, table by table. */
export interface TableReader {
  all(table: string): Row[]
  close(): void
}

export function openWorldDb(path: string): TableReader {
  const db = new DatabaseSync(path, { readOnly: true })
  const tables = new Set(
    db
      .prepare("select name from sqlite_master where type = 'table' and name not like 'sqlite_%'")
      .all()
      .map((r) => String((r as Row).name)),
  )
  return {
    all: (table) =>
      tables.has(table) ? (db.prepare(`select * from "${table}"`).all() as Row[]) : [],
    close: () => {
      db.close()
    },
  }
}
