import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import { type Kysely, sql } from 'kysely'
import type { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { createScryptAuth } from '../auth/service'
import { createDb } from '../db/kysely'
import type { Database } from '../db/schema'
import { migrateToLatest } from '../db/migrator'
import { withTestDatabase } from '../db/test-database'
import { openFlags } from '../flags/config'
import { buildApp } from './app'

/**
 * Calendars over HTTP.
 *
 * The block that matters most is the authorization one, and it is deliberately
 * NOT the shape the rest of the content routes have. Calendars are world config:
 * every member reads them, only the owner writes them. So the negative tests here
 * assert a PLAYER CAN READ — which for a content route would be a leak and here is
 * the requirement — while every write refuses them.
 *
 * The other load-bearing block is `activate`, which has to keep "exactly one
 * active per world" true through a two-statement transaction and across worlds.
 */

const SECRET = 'test-secret-test-secret-test-secret'
const PW = 'pw-123456'

interface Harness {
  app: FastifyInstance
  db: Kysely<Database>
  slug: string
  otherSlug: string
  dm: string
  player: string
}

async function withHarness(body: (h: Harness) => Promise<void>): Promise<void> {
  await withTestDatabase(async (pool: Pool) => {
    const db = createDb(pool)
    await migrateToLatest(db)
    const auth = createScryptAuth(db)
    const app = buildApp({
      db,
      auth,
      cookieSecret: SECRET,
      cookieSecure: false,
      flags: openFlags(),
    })
    await app.ready()
    try {
      await auth.createAccount('dm', PW)
      const playerAccount = await auth.createAccount('player', PW)
      const dm = await login(app, 'dm')

      const make = async (name: string): Promise<string> => {
        const res = await app.inject({
          method: 'POST',
          url: '/api/worlds',
          headers: { cookie: dm },
          payload: { name },
        })
        return res.json().world.slug as string
      }
      const slug = await make('W')
      const otherSlug = await make('Other')
      await app.inject({
        method: 'POST',
        url: `/api/worlds/${slug}/members`,
        headers: { cookie: dm },
        payload: { accountId: playerAccount.id },
      })

      await body({ app, db, slug, otherSlug, dm, player: await login(app, 'player') })
    } finally {
      await app.close()
    }
  })
}

async function login(app: FastifyInstance, username: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/login',
    payload: { username, password: PW },
  })
  return `cs_session=${res.cookies.find((x) => x.name === 'cs_session')!.value}`
}

interface CalendarView {
  id: string
  name: string
  kind: string
  config: Record<string, unknown>
  isActive: boolean
  isUserDefined: boolean
}

const add = (
  h: Harness,
  cookie: string,
  payload: Record<string, unknown>,
  slug = h.slug,
): Promise<LightMyRequestResponse> =>
  h.app.inject({
    method: 'POST',
    url: `/api/worlds/${slug}/calendars`,
    headers: { cookie },
    payload,
  })

const list = async (h: Harness, cookie: string, slug = h.slug): Promise<CalendarView[]> => {
  const res = await h.app.inject({
    method: 'GET',
    url: `/api/worlds/${slug}/calendars`,
    headers: { cookie },
  })
  expect(res.statusCode).toBe(200)
  return res.json().calendars as CalendarView[]
}

const active = async (h: Harness, cookie: string, slug = h.slug): Promise<CalendarView | null> => {
  const res = await h.app.inject({
    method: 'GET',
    url: `/api/worlds/${slug}/calendars/active`,
    headers: { cookie },
  })
  expect(res.statusCode).toBe(200)
  return res.json().calendar as CalendarView | null
}

const activate = (h: Harness, cookie: string, id: string): Promise<LightMyRequestResponse> =>
  h.app.inject({
    method: 'POST',
    url: `/api/worlds/${h.slug}/calendars/${id}/activate`,
    headers: { cookie },
  })

const CUSTOM = {
  name: 'Reckoning',
  kind: 'custom',
  config: {
    months: [
      { name: 'Frostmoon', days: 30 },
      { name: 'Thawmoon', days: 31 },
    ],
    weekdays: ['Firstday', 'Secondday'],
    eras: ['AR'],
    leap_year_rule: 'none',
  },
}

describe('calendars', () => {
  it('stores a custom calendar with its whole structured config', async () => {
    await withHarness(async (h) => {
      const res = await add(h, h.dm, CUSTOM)
      expect(res.statusCode).toBe(201)
      const created = res.json().calendar as CalendarView

      expect(created).toMatchObject({ name: 'Reckoning', kind: 'custom', isUserDefined: true })
      // Created but NOT activated: activating changes how every existing session
      // date reads, so it is its own act rather than a side effect of creating.
      expect(created.isActive).toBe(false)
      expect(created.config).toEqual(CUSTOM.config)

      // …and it survives the round trip out of jsonb rather than only in memory.
      const [read] = await list(h, h.dm)
      expect(read?.config).toEqual(CUSTOM.config)
    })
  })

  it('starts a world with no active calendar, and says so with null', async () => {
    // A supported state, not an error: sessions fall back to a free-text date.
    await withHarness(async (h) => {
      expect(await active(h, h.dm)).toBeNull()
      expect(await list(h, h.dm)).toEqual([])
    })
  })

  it('keeps exactly ONE active calendar, clearing the previous one', async () => {
    await withHarness(async (h) => {
      const a = (await add(h, h.dm, { name: 'Alpha', kind: 'gregorian' })).json()
        .calendar as CalendarView
      const b = (await add(h, h.dm, CUSTOM)).json().calendar as CalendarView

      expect((await activate(h, h.dm, a.id)).statusCode).toBe(200)
      expect((await active(h, h.dm))?.id).toBe(a.id)

      expect((await activate(h, h.dm, b.id)).statusCode).toBe(200)
      expect((await active(h, h.dm))?.id).toBe(b.id)
      // The invariant, asserted as a count rather than by reading `active`: two
      // rows flagged active would still let that endpoint answer plausibly.
      expect((await list(h, h.dm)).filter((c) => c.isActive)).toHaveLength(1)
    })
  })

  it('re-activating the already-active calendar is a no-op, not a flap', async () => {
    await withHarness(async (h) => {
      const a = (await add(h, h.dm, { name: 'Alpha', kind: 'gregorian' })).json()
        .calendar as CalendarView
      await activate(h, h.dm, a.id)
      expect((await activate(h, h.dm, a.id)).statusCode).toBe(200)
      expect((await active(h, h.dm))?.id).toBe(a.id)
      expect((await list(h, h.dm)).filter((c) => c.isActive)).toHaveLength(1)
    })
  })

  it('activating in one world never touches another world’s active calendar', async () => {
    // The clear is scoped by world_id; without that scope this is how one GM's
    // change silently unsets a different world's calendar.
    await withHarness(async (h) => {
      const mine = (await add(h, h.dm, { name: 'Mine', kind: 'gregorian' })).json()
        .calendar as CalendarView
      const theirs = (await add(h, h.dm, { name: 'Theirs', kind: 'gregorian' }, h.otherSlug)).json()
        .calendar as CalendarView

      await h.app.inject({
        method: 'POST',
        url: `/api/worlds/${h.otherSlug}/calendars/${theirs.id}/activate`,
        headers: { cookie: h.dm },
      })
      await activate(h, h.dm, mine.id)

      expect((await active(h, h.dm))?.id).toBe(mine.id)
      expect((await active(h, h.dm, h.otherSlug))?.id).toBe(theirs.id)
    })
  })

  it('refuses to activate an id from another world', async () => {
    await withHarness(async (h) => {
      const theirs = (await add(h, h.dm, { name: 'Theirs', kind: 'gregorian' }, h.otherSlug)).json()
        .calendar as CalendarView
      const res = await activate(h, h.dm, theirs.id)
      expect(res.statusCode).toBe(404)
      expect(await active(h, h.dm)).toBeNull()
    })
  })

  it('edits a calendar’s name, kind and config', async () => {
    await withHarness(async (h) => {
      const c = (await add(h, h.dm, { name: 'Draft', kind: 'gregorian' })).json()
        .calendar as CalendarView
      const res = await h.app.inject({
        method: 'PATCH',
        url: `/api/worlds/${h.slug}/calendars/${c.id}`,
        headers: { cookie: h.dm },
        payload: {
          name: 'Renamed',
          kind: 'custom',
          config: { months: [{ name: 'One', days: 10 }] },
        },
      })
      expect(res.statusCode).toBe(200)
      expect(res.json().calendar).toMatchObject({ name: 'Renamed', kind: 'custom' })
      expect((res.json().calendar as CalendarView).config).toEqual({
        months: [{ name: 'One', days: 10 }],
      })
    })
  })

  it('deletes a calendar, and deleting the ACTIVE one leaves the world with none', async () => {
    await withHarness(async (h) => {
      const c = (await add(h, h.dm, CUSTOM)).json().calendar as CalendarView
      await activate(h, h.dm, c.id)
      expect((await active(h, h.dm))?.id).toBe(c.id)

      const res = await h.app.inject({
        method: 'DELETE',
        url: `/api/worlds/${h.slug}/calendars/${c.id}`,
        headers: { cookie: h.dm },
      })
      expect(res.statusCode).toBe(200)
      // Back to no calendar, which is where the world started — refusing this
      // would mean a world could never return to having none.
      expect(await active(h, h.dm)).toBeNull()
      expect(await list(h, h.dm)).toEqual([])
    })
  })

  it('patches ONE field at a time, leaving the others alone', async () => {
    // The `...(x === undefined ? {} : {x})` spreads: a patch naming only the name
    // must not blank the kind or the config, which is what a plain `set` would do.
    await withHarness(async (h) => {
      const c = (await add(h, h.dm, CUSTOM)).json().calendar as CalendarView
      const patch = async (payload: Record<string, unknown>): Promise<CalendarView> => {
        const res = await h.app.inject({
          method: 'PATCH',
          url: `/api/worlds/${h.slug}/calendars/${c.id}`,
          headers: { cookie: h.dm },
          payload,
        })
        expect(res.statusCode).toBe(200)
        return res.json().calendar as CalendarView
      }

      const renamed = await patch({ name: 'Just The Name' })
      expect(renamed).toMatchObject({ name: 'Just The Name', kind: 'custom' })
      expect(renamed.config).toEqual(CUSTOM.config)

      const rekinded = await patch({ kind: 'gregorian' })
      expect(rekinded).toMatchObject({ name: 'Just The Name', kind: 'gregorian' })
      expect(rekinded.config).toEqual(CUSTOM.config)

      const reconfigured = await patch({ config: { eras: ['BR'] } })
      expect(reconfigured).toMatchObject({ name: 'Just The Name', kind: 'gregorian' })
      expect(reconfigured.config).toEqual({ eras: ['BR'] })

      // An empty patch is legal and changes nothing but `updated_at`.
      expect(await patch({})).toMatchObject({ name: 'Just The Name', kind: 'gregorian' })
    })
  })

  it('reads a legacy row whose config is not an object as an empty config', async () => {
    // The column is jsonb and the importer copies dm-manager's blob verbatim, so a
    // row can hold a bare JSON scalar. One bad legacy row must render as an empty
    // config rather than throwing on somebody's settings page.
    await withHarness(async (h) => {
      const c = (await add(h, h.dm, CUSTOM)).json().calendar as CalendarView
      await h.app.inject({
        method: 'PATCH',
        url: `/api/worlds/${h.slug}/calendars/${c.id}`,
        headers: { cookie: h.dm },
        payload: { name: 'Legacy' },
      })
      // Written past the route's schema on purpose — a bare jsonb SCALAR is the
      // shape the route would never accept but the table can already contain.
      await sql`update calendars set config = '42'::jsonb where id = ${c.id}`.execute(h.db)

      const [read] = await list(h, h.dm)
      expect(read?.config).toEqual({})
    })
  })

  it('404s an unknown id on patch, activate and delete', async () => {
    await withHarness(async (h) => {
      for (const req of [
        {
          method: 'PATCH' as const,
          url: `/api/worlds/${h.slug}/calendars/nope`,
          payload: { name: 'x' },
        },
        { method: 'POST' as const, url: `/api/worlds/${h.slug}/calendars/nope/activate` },
        { method: 'DELETE' as const, url: `/api/worlds/${h.slug}/calendars/nope` },
      ]) {
        const res = await h.app.inject({ ...req, headers: { cookie: h.dm } })
        expect(res.statusCode, `${req.method} ${req.url}`).toBe(404)
      }
    })
  })

  it('refuses a config outside the bounded shape', async () => {
    await withHarness(async (h) => {
      const bad = await add(h, h.dm, {
        name: 'Bad',
        kind: 'custom',
        config: { months: [{ name: 'One', days: 0 }] },
      })
      expect(bad.statusCode).toBe(400)
      const badKind = await add(h, h.dm, { name: 'Bad', kind: 'lunar' })
      expect(badKind.statusCode).toBe(400)
    })
  })

  describe('authorization — world config, not content', () => {
    it('lets a PLAYER read the calendars and the active one', async () => {
      // The requirement, not a leak: a calendar is the frame the world's dates are
      // written in, like the world's name. A player who can see a dated session
      // can already infer everything the calendar would tell them.
      await withHarness(async (h) => {
        const c = (await add(h, h.dm, CUSTOM)).json().calendar as CalendarView
        await activate(h, h.dm, c.id)

        expect(await list(h, h.player)).toHaveLength(1)
        expect((await active(h, h.player))?.id).toBe(c.id)
      })
    })

    it('refuses every calendar WRITE for a player', async () => {
      await withHarness(async (h) => {
        const c = (await add(h, h.dm, CUSTOM)).json().calendar as CalendarView

        expect((await add(h, h.player, { name: 'Sneaky', kind: 'gregorian' })).statusCode).toBe(403)
        expect((await activate(h, h.player, c.id)).statusCode).toBe(403)
        expect(
          (
            await h.app.inject({
              method: 'PATCH',
              url: `/api/worlds/${h.slug}/calendars/${c.id}`,
              headers: { cookie: h.player },
              payload: { name: 'Sneaky' },
            })
          ).statusCode,
        ).toBe(403)
        expect(
          (
            await h.app.inject({
              method: 'DELETE',
              url: `/api/worlds/${h.slug}/calendars/${c.id}`,
              headers: { cookie: h.player },
            })
          ).statusCode,
        ).toBe(403)

        // …and nothing changed behind the refusals.
        expect(await list(h, h.dm)).toHaveLength(1)
        expect((await list(h, h.dm))[0]?.name).toBe('Reckoning')
      })
    })

    it('refuses a non-member entirely, read included', async () => {
      await withHarness(async (h) => {
        const res = await h.app.inject({
          method: 'GET',
          url: `/api/worlds/${h.otherSlug}/calendars`,
          headers: { cookie: h.player },
        })
        expect(res.statusCode).toBe(403)
      })
    })
  })
})
