import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import type { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { createScryptAuth } from '../auth/service'
import { createDb } from '../db/kysely'
import { migrateToLatest } from '../db/migrator'
import { withTestDatabase } from '../db/test-database'
import { openFlags } from '../flags/config'
import { buildApp } from './app'

/**
 * Which currencies a settlement or an organization uses.
 *
 * The blocks that matter most are the two visibility ones. An attachment row has
 * a `visibility` of its OWN (so the content seam filters it) AND it NAMES a
 * currency (so the currency's visibility has to be checked separately, and the
 * row dropped whole when it fails). This is the first surface in the codebase
 * needing both at once, and each half is tested failing INDEPENDENTLY of the
 * other — a suite where every hidden case fails both checks would still pass
 * with one of them deleted.
 */

const SECRET = 'test-secret-test-secret-test-secret'
const PW = 'pw-123456'

interface Harness {
  app: FastifyInstance
  slug: string
  dm: string
  player: string
  settlement: string
  organization: string
  npc: string
  /** A public currency, visible to everyone. */
  coin: string
  /** A second public currency, for the primary-swap tests. */
  crown: string
  /** A `dm_only` currency — the endpoint half of the rule. */
  secretCoin: string
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

      const world = await app.inject({
        method: 'POST',
        url: '/api/worlds',
        headers: { cookie: dm },
        payload: { name: 'W' },
      })
      const slug = world.json().world.slug as string
      await app.inject({
        method: 'POST',
        url: `/api/worlds/${slug}/members`,
        headers: { cookie: dm },
        payload: { accountId: playerAccount.id },
      })

      const make = async (kind: string, name: string, visibility: string): Promise<string> => {
        const res = await app.inject({
          method: 'POST',
          url: `/api/worlds/${slug}/entities/${kind}`,
          headers: { cookie: dm },
          payload: { name, visibility },
        })
        return res.json().entity.id as string
      }

      await body({
        app,
        slug,
        dm,
        player: await login(app, 'player'),
        settlement: await make('settlement', 'Blackmoor Hold', 'public'),
        organization: await make('organization', 'The Merchants Guild', 'public'),
        npc: await make('npc', 'The Harbourmaster', 'public'),
        coin: await make('currency', 'Iron Mark', 'public'),
        crown: await make('currency', 'Sunlit Crown', 'public'),
        secretCoin: await make('currency', 'The Drowned Penny', 'dm_only'),
      })
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

interface AttachmentView {
  id: string
  ownerId: string
  isPrimary: boolean
  notes: string
  visibility: string
  currency: { id: string; name: string }
}

interface UserView {
  attachmentId: string
  ownerKind: string
  ownerId: string
  ownerName: string
  isPrimary: boolean
}

const attach = (
  h: Harness,
  cookie: string,
  owner: { kind: string; id: string },
  payload: Record<string, unknown>,
): Promise<LightMyRequestResponse> =>
  h.app.inject({
    method: 'POST',
    url: `/api/worlds/${h.slug}/entities/${owner.kind}/${owner.id}/currencies`,
    headers: { cookie },
    payload,
  })

const listAttachments = async (
  h: Harness,
  cookie: string,
  owner: { kind: string; id: string },
): Promise<AttachmentView[]> => {
  const res = await h.app.inject({
    method: 'GET',
    url: `/api/worlds/${h.slug}/entities/${owner.kind}/${owner.id}/currencies`,
    headers: { cookie },
  })
  expect(res.statusCode).toBe(200)
  return res.json().attachments as AttachmentView[]
}

const patch = (
  h: Harness,
  cookie: string,
  kind: string,
  id: string,
  payload: Record<string, unknown>,
): Promise<LightMyRequestResponse> =>
  h.app.inject({
    method: 'PATCH',
    url: `/api/worlds/${h.slug}/currency-attachments/${kind}/${id}`,
    headers: { cookie },
    payload,
  })

const detach = (
  h: Harness,
  cookie: string,
  kind: string,
  id: string,
): Promise<LightMyRequestResponse> =>
  h.app.inject({
    method: 'DELETE',
    url: `/api/worlds/${h.slug}/currency-attachments/${kind}/${id}`,
    headers: { cookie },
  })

const usersOf = async (h: Harness, cookie: string, currencyId: string): Promise<UserView[]> => {
  const res = await h.app.inject({
    method: 'GET',
    url: `/api/worlds/${h.slug}/currencies/${currencyId}/users`,
    headers: { cookie },
  })
  expect(res.statusCode).toBe(200)
  return res.json().users as UserView[]
}

/** Attach and return the created view, failing loudly if the POST did not 201. */
async function attached(
  h: Harness,
  owner: { kind: string; id: string },
  payload: Record<string, unknown>,
): Promise<AttachmentView> {
  const res = await attach(h, h.dm, owner, payload)
  expect(res.statusCode).toBe(201)
  return res.json().attachment as AttachmentView
}

describe('attach, list and detach', () => {
  it('round-trips an attachment on both owner kinds', async () => {
    await withHarness(async (h) => {
      for (const owner of [
        { kind: 'settlement', id: h.settlement },
        { kind: 'organization', id: h.organization },
      ]) {
        const created = await attached(h, owner, {
          currencyId: h.coin,
          isPrimary: true,
          notes: 'minted at the keep',
        })
        expect(created.currency.name).toBe('Iron Mark')
        expect(created.isPrimary).toBe(true)
        expect(created.notes).toBe('minted at the keep')

        const rows = await listAttachments(h, h.dm, owner)
        expect(rows.map((r) => r.currency.name)).toEqual(['Iron Mark'])
        expect(rows[0]?.ownerId).toBe(owner.id)

        expect((await detach(h, h.dm, owner.kind, created.id)).statusCode).toBe(200)
        expect(await listAttachments(h, h.dm, owner)).toEqual([])
      }
    })
  })

  it('defaults notes to empty, is_primary to false and visibility to public', async () => {
    await withHarness(async (h) => {
      const created = await attached(
        h,
        { kind: 'settlement', id: h.settlement },
        {
          currencyId: h.coin,
        },
      )
      expect(created).toMatchObject({ isPrimary: false, notes: '', visibility: 'public' })
    })
  })

  it('detaching twice reports the second as a 404 rather than a success', async () => {
    await withHarness(async (h) => {
      const created = await attached(
        h,
        { kind: 'settlement', id: h.settlement },
        {
          currencyId: h.coin,
        },
      )
      expect((await detach(h, h.dm, 'settlement', created.id)).statusCode).toBe(200)
      expect((await detach(h, h.dm, 'settlement', created.id)).statusCode).toBe(404)
    })
  })

  it('detach frees the pair, so the same currency can be attached again', async () => {
    // The unique index from 0018 is PARTIAL on `deleted_at is null`, and detach
    // hard-deletes; a total index (or a soft delete) would make this 409 forever
    // with nothing on screen to explain why.
    await withHarness(async (h) => {
      const first = await attached(
        h,
        { kind: 'settlement', id: h.settlement },
        {
          currencyId: h.coin,
        },
      )
      await detach(h, h.dm, 'settlement', first.id)
      expect(
        (
          await attach(
            h,
            h.dm,
            { kind: 'settlement', id: h.settlement },
            {
              currencyId: h.coin,
            },
          )
        ).statusCode,
      ).toBe(201)
    })
  })
})

describe('duplicate attachment', () => {
  it('refuses a second attachment of the same currency to the same owner', async () => {
    await withHarness(async (h) => {
      await attached(h, { kind: 'settlement', id: h.settlement }, { currencyId: h.coin })
      const again = await attach(
        h,
        h.dm,
        { kind: 'settlement', id: h.settlement },
        {
          currencyId: h.coin,
          notes: 'a second opinion',
        },
      )
      expect(again.statusCode).toBe(409)
      expect(again.json().error.code).toBe('duplicate_attachment')
      // Refused rather than a no-op, and the refusal is total: the `notes` the
      // caller sent are not silently applied to the row that already exists.
      const rows = await listAttachments(h, h.dm, { kind: 'settlement', id: h.settlement })
      expect(rows).toHaveLength(1)
      expect(rows[0]?.notes).toBe('')
    })
  })

  it('allows the same currency on a DIFFERENT owner, and on the other owner kind', async () => {
    await withHarness(async (h) => {
      await attached(h, { kind: 'settlement', id: h.settlement }, { currencyId: h.coin })
      expect(
        (
          await attach(
            h,
            h.dm,
            { kind: 'organization', id: h.organization },
            {
              currencyId: h.coin,
            },
          )
        ).statusCode,
      ).toBe(201)
    })
  })
})

describe('at most one primary per owner', () => {
  it('promoting one currency demotes the previous primary of that owner', async () => {
    await withHarness(async (h) => {
      const owner = { kind: 'settlement', id: h.settlement }
      const first = await attached(h, owner, { currencyId: h.coin, isPrimary: true })
      const second = await attached(h, owner, { currencyId: h.crown, isPrimary: true })

      const rows = await listAttachments(h, h.dm, owner)
      expect(rows.filter((r) => r.isPrimary).map((r) => r.id)).toEqual([second.id])
      expect(rows.find((r) => r.id === first.id)?.isPrimary).toBe(false)
    })
  })

  it('promoting via PATCH demotes the other one too', async () => {
    await withHarness(async (h) => {
      const owner = { kind: 'settlement', id: h.settlement }
      const first = await attached(h, owner, { currencyId: h.coin, isPrimary: true })
      const second = await attached(h, owner, { currencyId: h.crown })

      const res = await patch(h, h.dm, 'settlement', second.id, { isPrimary: true })
      expect(res.statusCode).toBe(200)
      const rows = await listAttachments(h, h.dm, owner)
      expect(rows.filter((r) => r.isPrimary).map((r) => r.id)).toEqual([second.id])
      expect(rows.find((r) => r.id === first.id)?.isPrimary).toBe(false)
    })
  })

  it('does NOT clear another settlement’s primary', async () => {
    await withHarness(async (h) => {
      const other = await h.app.inject({
        method: 'POST',
        url: `/api/worlds/${h.slug}/entities/settlement`,
        headers: { cookie: h.dm },
        payload: { name: 'Saltmarsh', visibility: 'public' },
      })
      const otherId = other.json().entity.id as string

      await attached(
        h,
        { kind: 'settlement', id: otherId },
        { currencyId: h.coin, isPrimary: true },
      )
      await attached(
        h,
        { kind: 'settlement', id: h.settlement },
        {
          currencyId: h.crown,
          isPrimary: true,
        },
      )

      const rows = await listAttachments(h, h.dm, { kind: 'settlement', id: otherId })
      expect(rows[0]?.isPrimary).toBe(true)
    })
  })

  it('does NOT cross owner kinds — a settlement’s promotion leaves an organization alone', async () => {
    await withHarness(async (h) => {
      await attached(
        h,
        { kind: 'organization', id: h.organization },
        {
          currencyId: h.coin,
          isPrimary: true,
        },
      )
      await attached(
        h,
        { kind: 'settlement', id: h.settlement },
        {
          currencyId: h.coin,
          isPrimary: true,
        },
      )
      const rows = await listAttachments(h, h.dm, { kind: 'organization', id: h.organization })
      expect(rows[0]?.isPrimary).toBe(true)
    })
  })

  it('does NOT cross worlds', async () => {
    // The `world_id` clause in `clearPrimary` is belt-and-braces today, since an
    // owner id is globally unique and so already implies its world. It is tested
    // because a redundant filter is exactly the kind nobody notices has become
    // load-bearing — the day these tables take an id that is unique per world
    // rather than globally, this test is the one that fails.
    await withHarness(async (h) => {
      const second = await h.app.inject({
        method: 'POST',
        url: '/api/worlds',
        headers: { cookie: h.dm },
        payload: { name: 'Second' },
      })
      const otherSlug = second.json().world.slug as string
      const make = async (kind: string, name: string): Promise<string> => {
        const res = await h.app.inject({
          method: 'POST',
          url: `/api/worlds/${otherSlug}/entities/${kind}`,
          headers: { cookie: h.dm },
          payload: { name, visibility: 'public' },
        })
        return res.json().entity.id as string
      }
      const otherSettlement = await make('settlement', 'Elsewhere')
      const otherCoin = await make('currency', 'Foreign Mark')
      const created = await h.app.inject({
        method: 'POST',
        url: `/api/worlds/${otherSlug}/entities/settlement/${otherSettlement}/currencies`,
        headers: { cookie: h.dm },
        payload: { currencyId: otherCoin, isPrimary: true },
      })
      expect(created.statusCode).toBe(201)

      await attached(
        h,
        { kind: 'settlement', id: h.settlement },
        {
          currencyId: h.coin,
          isPrimary: true,
        },
      )

      const res = await h.app.inject({
        method: 'GET',
        url: `/api/worlds/${otherSlug}/entities/settlement/${otherSettlement}/currencies`,
        headers: { cookie: h.dm },
      })
      expect((res.json().attachments as AttachmentView[])[0]?.isPrimary).toBe(true)
    })
  })
})

describe('the row’s own visibility — half 1, failing on its own', () => {
  it('hides a dm_only attachment of a PUBLIC currency from a player', async () => {
    // Half 2 passes here: the currency is public and resolves fine. Only the
    // seam's per-row filter can drop this row, so deleting half 1 fails this.
    await withHarness(async (h) => {
      const owner = { kind: 'settlement', id: h.settlement }
      await attached(h, owner, { currencyId: h.coin, visibility: 'dm_only' })
      expect(await listAttachments(h, h.player, owner)).toEqual([])
      expect((await listAttachments(h, h.dm, owner)).map((r) => r.currency.name)).toEqual([
        'Iron Mark',
      ])
    })
  })

  it('hides it from the inverse list on the currency page too', async () => {
    await withHarness(async (h) => {
      await attached(
        h,
        { kind: 'settlement', id: h.settlement },
        {
          currencyId: h.coin,
          visibility: 'dm_only',
        },
      )
      expect(await usersOf(h, h.player, h.coin)).toEqual([])
      expect((await usersOf(h, h.dm, h.coin)).map((u) => u.ownerName)).toEqual(['Blackmoor Hold'])
    })
  })

  it('refuses `restricted`, which no ACL could grant', async () => {
    await withHarness(async (h) => {
      const res = await attach(
        h,
        h.dm,
        { kind: 'settlement', id: h.settlement },
        {
          currencyId: h.coin,
          visibility: 'restricted',
        },
      )
      expect(res.statusCode).toBe(400)
    })
  })
})

describe('the currency it names — half 2, failing on its own', () => {
  it('drops a PUBLIC attachment row that names a dm_only currency', async () => {
    // Half 1 passes here: the row itself is public, so the seam returns it. Only
    // the endpoint check can drop it, so deleting half 2 fails this — and the
    // leak it prevents is the currency's NAME appearing on a settlement's page.
    await withHarness(async (h) => {
      const owner = { kind: 'settlement', id: h.settlement }
      await attached(h, owner, { currencyId: h.secretCoin, visibility: 'public' })
      expect(await listAttachments(h, h.player, owner)).toEqual([])
      expect((await listAttachments(h, h.dm, owner)).map((r) => r.currency.name)).toEqual([
        'The Drowned Penny',
      ])
    })
  })

  it('drops the row whole rather than returning it without the name', async () => {
    await withHarness(async (h) => {
      const owner = { kind: 'settlement', id: h.settlement }
      await attached(h, owner, {
        currencyId: h.secretCoin,
        visibility: 'public',
        notes: 'the smugglers take it',
      })
      const rows = await listAttachments(h, h.player, owner)
      // Not a nameless row, not a row with empty notes: nothing. "Uses a
      // currency you cannot see" is still the disclosure, and the NOTES are
      // written independently of the currency's name.
      expect(rows).toEqual([])
    })
  })

  it('hides a dm_only OWNER from the inverse list on a public currency page', async () => {
    // The mirror image: reading a public currency must not report that a hidden
    // settlement uses it.
    await withHarness(async (h) => {
      const hidden = await h.app.inject({
        method: 'POST',
        url: `/api/worlds/${h.slug}/entities/settlement`,
        headers: { cookie: h.dm },
        payload: { name: 'The Sunken Court', visibility: 'dm_only' },
      })
      const hiddenId = hidden.json().entity.id as string
      await attached(
        h,
        { kind: 'settlement', id: hiddenId },
        {
          currencyId: h.coin,
          visibility: 'public',
        },
      )
      await attached(h, { kind: 'organization', id: h.organization }, { currencyId: h.coin })

      expect((await usersOf(h, h.player, h.coin)).map((u) => u.ownerName)).toEqual([
        'The Merchants Guild',
      ])
      expect((await usersOf(h, h.dm, h.coin)).map((u) => u.ownerName).sort()).toEqual([
        'The Merchants Guild',
        'The Sunken Court',
      ])
    })
  })
})

describe('writes are owner-only', () => {
  it('refuses a player every write', async () => {
    await withHarness(async (h) => {
      const owner = { kind: 'settlement', id: h.settlement }
      const created = await attached(h, owner, { currencyId: h.coin })

      expect((await attach(h, h.player, owner, { currencyId: h.crown })).statusCode).toBe(403)
      expect((await patch(h, h.player, 'settlement', created.id, { notes: 'x' })).statusCode).toBe(
        403,
      )
      expect((await detach(h, h.player, 'settlement', created.id)).statusCode).toBe(403)

      // And nothing changed.
      const rows = await listAttachments(h, h.dm, owner)
      expect(rows).toHaveLength(1)
      expect(rows[0]?.notes).toBe('')
    })
  })

  it('lets a player READ what the two visibility rules allow', async () => {
    await withHarness(async (h) => {
      const owner = { kind: 'settlement', id: h.settlement }
      await attached(h, owner, { currencyId: h.coin })
      await attached(h, owner, { currencyId: h.secretCoin })
      await attached(h, owner, { currencyId: h.crown, visibility: 'dm_only' })
      expect((await listAttachments(h, h.player, owner)).map((r) => r.currency.name)).toEqual([
        'Iron Mark',
      ])
    })
  })
})

describe('unknown ids answer 404 rather than succeeding quietly', () => {
  it('404s an unknown owner id', async () => {
    await withHarness(async (h) => {
      const res = await attach(
        h,
        h.dm,
        { kind: 'settlement', id: 'nope' },
        {
          currencyId: h.coin,
        },
      )
      expect(res.statusCode).toBe(404)
    })
  })

  it('404s an unknown currency id', async () => {
    await withHarness(async (h) => {
      const res = await attach(
        h,
        h.dm,
        { kind: 'settlement', id: h.settlement },
        {
          currencyId: 'nope',
        },
      )
      expect(res.statusCode).toBe(404)
    })
  })

  it('404s an owner id of the WRONG kind', async () => {
    // `settlement_id` is foreign-keyed to `entities` since 0005, so the database
    // would accept an NPC's id here quite happily.
    await withHarness(async (h) => {
      const res = await attach(
        h,
        h.dm,
        { kind: 'settlement', id: h.npc },
        {
          currencyId: h.coin,
        },
      )
      expect(res.statusCode).toBe(404)
    })
  })

  it('404s a currency id that names something that is not a currency', async () => {
    await withHarness(async (h) => {
      const res = await attach(
        h,
        h.dm,
        { kind: 'settlement', id: h.settlement },
        {
          currencyId: h.npc,
        },
      )
      expect(res.statusCode).toBe(404)
    })
  })

  it('404s an owner kind that has no attachment table', async () => {
    await withHarness(async (h) => {
      const res = await h.app.inject({
        method: 'GET',
        url: `/api/worlds/${h.slug}/entities/npc/${h.npc}/currencies`,
        headers: { cookie: h.dm },
      })
      expect(res.statusCode).toBe(404)
    })
  })

  it('404s an attachment id from the OTHER owner kind', async () => {
    await withHarness(async (h) => {
      const created = await attached(
        h,
        { kind: 'settlement', id: h.settlement },
        {
          currencyId: h.coin,
        },
      )
      expect((await patch(h, h.dm, 'organization', created.id, { notes: 'x' })).statusCode).toBe(
        404,
      )
      expect((await detach(h, h.dm, 'organization', created.id)).statusCode).toBe(404)
    })
  })

  it('404s an id from another world', async () => {
    await withHarness(async (h) => {
      const created = await attached(
        h,
        { kind: 'settlement', id: h.settlement },
        {
          currencyId: h.coin,
        },
      )
      const second = await h.app.inject({
        method: 'POST',
        url: '/api/worlds',
        headers: { cookie: h.dm },
        payload: { name: 'Second' },
      })
      const otherSlug = second.json().world.slug as string
      const res = await h.app.inject({
        method: 'DELETE',
        url: `/api/worlds/${otherSlug}/currency-attachments/settlement/${created.id}`,
        headers: { cookie: h.dm },
      })
      expect(res.statusCode).toBe(404)
    })
  })

  it('404s the inverse list for an unknown currency', async () => {
    await withHarness(async (h) => {
      const res = await h.app.inject({
        method: 'GET',
        url: `/api/worlds/${h.slug}/currencies/nope/users`,
        headers: { cookie: h.dm },
      })
      expect(res.statusCode).toBe(404)
    })
  })
})

describe('the inverse list', () => {
  it('names both owner kinds and marks which treat it as primary', async () => {
    await withHarness(async (h) => {
      await attached(h, { kind: 'settlement', id: h.settlement }, { currencyId: h.coin })
      await attached(
        h,
        { kind: 'organization', id: h.organization },
        {
          currencyId: h.coin,
          isPrimary: true,
        },
      )
      const users = await usersOf(h, h.dm, h.coin)
      expect(users.map((u) => [u.ownerKind, u.ownerName, u.isPrimary])).toEqual([
        ['organization', 'The Merchants Guild', true],
        ['settlement', 'Blackmoor Hold', false],
      ])
    })
  })

  it('is empty for a currency nobody uses', async () => {
    await withHarness(async (h) => {
      expect(await usersOf(h, h.dm, h.crown)).toEqual([])
    })
  })
})
