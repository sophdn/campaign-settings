import { afterEach, describe, expect, it } from 'vitest'
import { requireDatabaseUrl, withTestDatabase } from './test-database'

describe('withTestDatabase', () => {
  it('provisions an isolated database, runs work in it, then drops it', async () => {
    let createdDb: string | undefined
    // Called without an explicit URL → exercises the DATABASE_URL default.
    const rows = await withTestDatabase(async (pool) => {
      const who = await pool.query<{ db: string }>('SELECT current_database() AS db')
      createdDb = who.rows[0]?.db
      await pool.query('CREATE TABLE t (id int primary key)')
      await pool.query('INSERT INTO t (id) VALUES (1)')
      const r = await pool.query<{ id: number }>('SELECT id FROM t ORDER BY id')
      return r.rows
    })
    expect(rows).toEqual([{ id: 1 }])
    expect(createdDb).toMatch(/^cs_test_/)

    // The throwaway DB is gone afterwards.
    const exists = await withTestDatabase((pool) =>
      pool
        .query('SELECT 1 FROM pg_database WHERE datname = $1', [createdDb])
        .then((r) => r.rowCount ?? 0),
    )
    expect(exists).toBe(0)
  })
})

describe('requireDatabaseUrl', () => {
  const original = process.env.DATABASE_URL
  afterEach(() => {
    if (original === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = original
  })

  it('returns the configured url', () => {
    process.env.DATABASE_URL = 'postgres://x:y@localhost:5433/z'
    expect(requireDatabaseUrl()).toBe('postgres://x:y@localhost:5433/z')
  })

  it('throws an actionable error when unset', () => {
    delete process.env.DATABASE_URL
    expect(() => requireDatabaseUrl()).toThrow('DATABASE_URL is not set')
  })
})
