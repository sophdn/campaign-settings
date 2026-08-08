import { describe, expect, it } from 'vitest'
import { createPool } from './pool'

describe('createPool', () => {
  it('builds a pool from a connection string (with and without extra config)', async () => {
    const a = createPool('postgres://u:p@localhost:5433/db')
    const b = createPool('postgres://u:p@localhost:5433/db', { max: 2 })
    // Pools are lazy — constructing one does not connect, so this needs no server.
    expect(a).toBeDefined()
    expect(b).toBeDefined()
    await a.end()
    await b.end()
  })
})
