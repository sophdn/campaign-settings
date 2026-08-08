/** A raw row read from a dm-manager SQLite world DB. */
export type Row = Record<string, unknown>

// SQLite stores booleans as 0/1 integers and timestamps/JSON as TEXT; these
// converters re-express each into its Postgres-native form.

export const bool = (v: unknown): boolean => v === 1 || v === true || v === '1'
export const text = (v: unknown): string => String(v)
export const textOpt = (v: unknown): string | null => (v == null ? null : String(v))
export const num = (v: unknown): number => Number(v)
export const numOpt = (v: unknown): number | null => (v == null ? null : Number(v))
export const dateReq = (v: unknown): Date => new Date(String(v))
export const dateOpt = (v: unknown): Date | null => (v == null ? null : new Date(String(v)))

/**
 * Map a column that has a DB default. Present in the source → converted; absent
 * (the source predates the column — schema drift) → undefined, so the Postgres
 * default applies. Use plain converters for always-present / required columns.
 */
export function field<T>(row: Row, key: string, conv: (v: unknown) => T): T | undefined {
  return key in row ? conv(row[key]) : undefined
}
