import type { Kysely } from 'kysely'
import { describe, expect, it } from 'vitest'
import { resolveWorldContext } from '../authz/context'
import { ForbiddenError } from '../authz/errors'
import type { WorldContext } from '../data/context'
import { newId } from '../db/ids'
import { createDb } from '../db/kysely'
import { migrateToLatest } from '../db/migrator'
import type { Database } from '../db/schema'
import { withTestDatabase } from '../db/test-database'
import { createTenancy } from '../tenancy'
import { createNote, deleteNote, getNote, listNotes, updateNote } from './notes'

async function makeAccount(db: Kysely<Database>, username: string): Promise<string> {
  const id = newId()
  await db.insertInto('accounts').values({ id, username, password_hash: 'h' }).execute()
  return id
}

/** A world with a DM owner and two granted players, plus all three contexts. */
async function setup(db: Kysely<Database>, prefix = 'w') {
  const tenancy = createTenancy(db)
  const dmId = await makeAccount(db, `${prefix}-dm`)
  const p1Id = await makeAccount(db, `${prefix}-p1`)
  const p2Id = await makeAccount(db, `${prefix}-p2`)
  const world = await tenancy.createWorld(dmId, 'W')
  await tenancy.grantMember(dmId, world.id, p1Id)
  await tenancy.grantMember(dmId, world.id, p2Id)
  const dm = (await resolveWorldContext(db, dmId, world.slug)) as WorldContext
  const p1 = (await resolveWorldContext(db, p1Id, world.slug)) as WorldContext
  const p2 = (await resolveWorldContext(db, p2Id, world.slug)) as WorldContext
  return { world, dm, p1, p2 }
}

describe('player notes', () => {
  it('a player reads/writes only their own; the DM reads all but writes none', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const { dm, p1, p2 } = await setup(db)

      const n1 = await createNote(p1, { body: 'p1 secret' })
      await createNote(p2, { body: 'p2 secret' })

      // read isolation
      expect(await listNotes(p1)).toHaveLength(1)
      expect(await listNotes(p2)).toHaveLength(1)
      expect(await listNotes(dm)).toHaveLength(2) // DM sees all
      expect((await getNote(p1, n1.id))?.body).toBe('p1 secret')
      expect(await getNote(p2, n1.id)).toBeUndefined() // can't read another's
      expect((await getNote(dm, n1.id))?.body).toBe('p1 secret') // DM can

      // write isolation
      expect((await updateNote(p1, n1.id, { body: 'edited' }))?.body).toBe('edited')
      await expect(updateNote(p2, n1.id, { body: 'hijack' })).rejects.toBeInstanceOf(ForbiddenError)
      await expect(updateNote(dm, n1.id, { body: 'dm-edit' })).rejects.toBeInstanceOf(
        ForbiddenError,
      )
      await expect(deleteNote(p2, n1.id)).rejects.toBeInstanceOf(ForbiddenError)
      expect(await deleteNote(p1, n1.id)).toBe(true)
      // updating/deleting something gone is a no-op, not a throw
      expect(await updateNote(p1, n1.id, { body: 'x' })).toBeUndefined()
      expect(await deleteNote(p1, n1.id)).toBe(false)
    })
  })

  it('notes are scoped to their world', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const a = await setup(db, 'a')
      const b = await setup(db, 'b')
      await createNote(a.p1, { body: 'world A' })
      expect(await listNotes(b.dm)).toHaveLength(0)
    })
  })
})
