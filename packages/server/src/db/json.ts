import { type RawBuilder, sql } from 'kysely'

/**
 * Serialize a value for a jsonb column. kysely/pg auto-serialize plain objects,
 * but JS arrays get mistaken for Postgres array literals — so always route jsonb
 * writes through here.
 */
export function jsonb<T>(value: T): RawBuilder<T> {
  return sql<T>`${JSON.stringify(value)}::jsonb`
}
