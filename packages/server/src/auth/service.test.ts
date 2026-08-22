import { describe, expect, it } from 'vitest'
import { createDb } from '../db/kysely'
import { migrateToLatest } from '../db/migrator'
import { withTestDatabase } from '../db/test-database'
import { createScryptAuth } from './service'
import { DuplicateUsernameError } from './types'

/**
 * Behaviour contract for AuthService. Written against the interface (only the
 * factory is implementation-specific) so a future provider can be validated by
 * pointing these tests at its factory.
 */
describe('AuthService (scrypt implementation)', () => {
  it('creates an account, logs in, authenticates a session, and logs out', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const auth = createScryptAuth(db) // bare: exercises the default ttl/clock

      const account = await auth.createAccount('dm', 'pw-12345')
      expect(account).toEqual({ id: expect.any(String), username: 'dm' })

      // wrong password and unknown username both fail without distinction
      expect(await auth.login('dm', 'wrong')).toBeNull()
      expect(await auth.login('nobody', 'pw-12345')).toBeNull()

      const result = await auth.login('dm', 'pw-12345')
      expect(result?.account).toEqual(account)
      expect(result?.sessionId).toBeTruthy()

      expect(await auth.authenticate(result!.sessionId)).toEqual(account)
      // an unknown session id resolves to null, not an error
      expect(await auth.authenticate('no-such-session')).toBeNull()

      await auth.logout(result!.sessionId)
      expect(await auth.authenticate(result!.sessionId)).toBeNull()
    })
  })

  it('stores an optional email when given, and never returns it in the public account', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const auth = createScryptAuth(db)

      const account = await auth.createAccount('dm', 'pw-12345', 'DM@Example.com')
      // the public account carries only id + username — never the email
      expect(account).toEqual({ id: expect.any(String), username: 'dm' })

      const row = await db
        .selectFrom('accounts')
        .select('email')
        .where('id', '=', account.id)
        .executeTakeFirstOrThrow()
      expect(row.email).toBe('DM@Example.com')
    })
  })

  it('rejects a duplicate username without overwriting the original', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const auth = createScryptAuth(db)

      await auth.createAccount('dm', 'first-password')
      await expect(auth.createAccount('dm', 'second-password')).rejects.toBeInstanceOf(
        DuplicateUsernameError,
      )

      // the original credentials still work; the second password never took
      expect(await auth.login('dm', 'first-password')).not.toBeNull()
      expect(await auth.login('dm', 'second-password')).toBeNull()
    })
  })

  it('treats usernames case-insensitively for uniqueness and for login', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const auth = createScryptAuth(db)

      const account = await auth.createAccount('Sophi', 'pw-12345')
      // the capitalisation the person chose is what gets stored and shown
      expect(account.username).toBe('Sophi')

      // a case variant is the same name, so it cannot be registered
      await expect(auth.createAccount('sophi', 'other-password')).rejects.toBeInstanceOf(
        DuplicateUsernameError,
      )
      await expect(auth.createAccount('SOPHI', 'other-password')).rejects.toBeInstanceOf(
        DuplicateUsernameError,
      )

      // ...and any capitalisation logs in with the one password
      for (const typed of ['Sophi', 'sophi', 'SOPHI', 'sOpHi']) {
        const result = await auth.login(typed, 'pw-12345')
        expect(result?.account, `login as ${typed}`).toEqual(account)
      }
      // the password is still the password
      expect(await auth.login('SOPHI', 'wrong')).toBeNull()
    })
  })

  it('lets someone re-capitalise their own name but not take a case variant of another', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const auth = createScryptAuth(db)

      const sophi = await auth.createAccount('sophi', 'pw-12345')
      await auth.createAccount('player', 'pw-12345')

      // re-capitalising yourself resolves to your own account, so it is allowed
      expect(await auth.setUsername(sophi.id, 'Sophi')).toEqual({ id: sophi.id, username: 'Sophi' })
      expect((await auth.login('sophi', 'pw-12345'))?.account.username).toBe('Sophi')

      // but a case variant of somebody else's name is taken
      await expect(auth.setUsername(sophi.id, 'Player')).rejects.toBeInstanceOf(
        DuplicateUsernameError,
      )
    })
  })

  it('expires sessions at the configured TTL', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      let clock = new Date('2026-01-01T00:00:00Z')
      const auth = createScryptAuth(db, { sessionTtlMs: 60_000, now: () => clock })

      await auth.createAccount('dm', 'pw-12345')
      const { sessionId } = (await auth.login('dm', 'pw-12345'))!
      expect(await auth.authenticate(sessionId)).not.toBeNull()

      clock = new Date(clock.getTime() + 61_000) // advance past the TTL
      expect(await auth.authenticate(sessionId)).toBeNull()
    })
  })

  it('reaps expired session rows at the next login rather than leaving them to accumulate', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      let clock = new Date('2026-01-01T00:00:00Z')
      const auth = createScryptAuth(db, { sessionTtlMs: 60_000, now: () => clock })

      const account = await auth.createAccount('dm', 'pw-12345')
      const dead = (await auth.login('dm', 'pw-12345'))!.sessionId

      const countRows = async (): Promise<number> =>
        (
          await db
            .selectFrom('auth_sessions')
            .where('account_id', '=', account.id)
            .selectAll()
            .execute()
        ).length

      clock = new Date(clock.getTime() + 61_000)
      // rejected at read time, but the row is still sitting there
      expect(await auth.authenticate(dead)).toBeNull()
      expect(await countRows()).toBe(1)

      // the next sign-in cleans up on the way in: only the fresh session remains
      await auth.login('dm', 'pw-12345')
      expect(await countRows()).toBe(1)
      expect(await auth.authenticate(dead)).toBeNull()
    })
  })

  it('verifies the current password against an account without exposing the hash', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const auth = createScryptAuth(db)

      const account = await auth.createAccount('dm', 'pw-12345')
      expect(await auth.verifyAccountPassword(account.id, 'pw-12345')).toBe(true)
      expect(await auth.verifyAccountPassword(account.id, 'not-it')).toBe(false)
      // an unknown account is a plain false, never a throw
      expect(await auth.verifyAccountPassword('no-such-account', 'pw-12345')).toBe(false)
    })
  })

  it('renames an account, rejects a name held by someone else, and allows a no-op rename', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const auth = createScryptAuth(db)

      const dm = await auth.createAccount('dm', 'pw-12345')
      await auth.createAccount('player', 'pw-12345')

      expect(await auth.setUsername(dm.id, 'game-master')).toEqual({
        id: dm.id,
        username: 'game-master',
      })
      // the new name is the login key; the old one is gone
      expect(await auth.login('game-master', 'pw-12345')).not.toBeNull()
      expect(await auth.login('dm', 'pw-12345')).toBeNull()

      await expect(auth.setUsername(dm.id, 'player')).rejects.toBeInstanceOf(DuplicateUsernameError)
      // renaming to the name you already hold is a no-op, not a conflict
      expect(await auth.setUsername(dm.id, 'game-master')).toEqual({
        id: dm.id,
        username: 'game-master',
      })
    })
  })

  it('invalidates every session except the one named', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const auth = createScryptAuth(db)

      const account = await auth.createAccount('dm', 'pw-12345')
      const keep = (await auth.login('dm', 'pw-12345'))!.sessionId
      const dropA = (await auth.login('dm', 'pw-12345'))!.sessionId
      const dropB = (await auth.login('dm', 'pw-12345'))!.sessionId

      await auth.invalidateOtherSessions(account.id, keep)

      expect(await auth.authenticate(keep)).toEqual(account)
      expect(await auth.authenticate(dropA)).toBeNull()
      expect(await auth.authenticate(dropB)).toBeNull()
    })
  })

  it('rotates a session to a new id and retires the old one', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      const auth = createScryptAuth(db)

      const account = await auth.createAccount('dm', 'pw-12345')
      const before = (await auth.login('dm', 'pw-12345'))!.sessionId

      const after = await auth.rotateSession(account.id, before, {
        deviceLabel: 'Firefox on Linux',
      })
      expect(after).not.toBe(before)
      expect(await auth.authenticate(after)).toEqual(account)
      expect(await auth.authenticate(before)).toBeNull()
    })
  })

  it('lists live sessions newest-activity-first, marks the caller, and never returns ids', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      let clock = new Date('2026-01-01T00:00:00Z')
      const auth = createScryptAuth(db, { sessionTtlMs: 600_000, now: () => clock })

      const account = await auth.createAccount('dm', 'pw-12345')
      const laptop = (await auth.login('dm', 'pw-12345', { deviceLabel: 'Firefox on Linux' }))!
        .sessionId
      clock = new Date(clock.getTime() + 60_000)
      const phone = (await auth.login('dm', 'pw-12345', { deviceLabel: 'Safari on iOS' }))!
        .sessionId

      const sessions = await auth.listSessions(account.id, phone)
      expect(sessions).toHaveLength(2)
      // ordered by recency: the phone signed in later
      expect(sessions.map((s) => s.deviceLabel)).toEqual(['Safari on iOS', 'Firefox on Linux'])
      expect(sessions.map((s) => s.current)).toEqual([true, false])
      // the bearer credential never rides along
      for (const s of sessions) {
        expect(s).not.toHaveProperty('id')
        expect(Object.values(s)).not.toContain(laptop)
      }
    })
  })

  it('refreshes last-seen only once a session has gone stale, and drops expired rows from the list', async () => {
    await withTestDatabase(async (pool) => {
      const db = createDb(pool)
      await migrateToLatest(db)
      let clock = new Date('2026-01-01T00:00:00Z')
      const auth = createScryptAuth(db, { sessionTtlMs: 600_000, now: () => clock })

      const account = await auth.createAccount('dm', 'pw-12345')
      const sessionId = (await auth.login('dm', 'pw-12345'))!.sessionId
      const seenAt = async (): Promise<Date> =>
        (
          await db
            .selectFrom('auth_sessions')
            .select('last_seen_at')
            .where('id', '=', sessionId)
            .executeTakeFirstOrThrow()
        ).last_seen_at
      const atLogin = await seenAt()

      // a request a minute later is not worth a write
      clock = new Date(clock.getTime() + 60_000)
      await auth.authenticate(sessionId)
      expect((await seenAt()).getTime()).toBe(atLogin.getTime())

      // once past the refresh interval, recency is recorded
      clock = new Date(clock.getTime() + 5 * 60_000)
      await auth.authenticate(sessionId)
      expect((await seenAt()).getTime()).toBe(clock.getTime())

      // and an expired session leaves the list entirely
      clock = new Date(clock.getTime() + 600_001)
      expect(await auth.listSessions(account.id, sessionId)).toEqual([])
    })
  })
})

describe('sessionTtlMs is part of the contract (bug 1205)', () => {
  it('reports the configured TTL, so the transport cannot take its own copy', () => {
    // No DB traffic: the factory is pure up to this property, so a live pool
    // would only slow the assertion down.
    const db = null as never
    expect(createScryptAuth(db, { sessionTtlMs: 1234 }).sessionTtlMs).toBe(1234)
    // and the default is the real 30 days, not zero or undefined
    expect(createScryptAuth(db).sessionTtlMs).toBe(30 * 24 * 60 * 60 * 1000)
  })
})
