import { webFlags } from '../testing/flags'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApiClient } from './client'
import { ApiClientError } from './errors'

interface MockResponse {
  ok?: boolean
  status?: number
  statusText?: string
  body?: unknown
  jsonThrows?: boolean
}

interface Call {
  url: string
  init: RequestInit
}

function stubFetch(...responses: MockResponse[]): Call[] {
  const calls: Call[] = []
  let i = 0
  const fn = vi.fn((url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    const r = responses[Math.min(i++, responses.length - 1)] ?? {}
    return Promise.resolve({
      ok: r.ok ?? true,
      status: r.status ?? 200,
      statusText: r.statusText ?? '',
      json: () => (r.jsonThrows ? Promise.reject(new Error('not json')) : Promise.resolve(r.body)),
    } as Response)
  })
  vi.stubGlobal('fetch', fn)
  return calls
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('api client', () => {
  it('sends credentials + JSON body and unwraps the response', async () => {
    const calls = stubFetch({ body: { account: { id: 'a1', username: 'dm' } } })
    const api = createApiClient('http://host')
    const account = await api.login('dm', 'pw-123456')

    expect(account).toEqual({ id: 'a1', username: 'dm' })
    expect(calls[0]?.url).toBe('http://host/api/login')
    expect(calls[0]?.init.method).toBe('POST')
    expect(calls[0]?.init.credentials).toBe('include')
    expect(calls[0]?.init.headers).toEqual({ 'content-type': 'application/json' })
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      username: 'dm',
      password: 'pw-123456',
    })
  })

  it('omits the body and content-type on GET', async () => {
    const calls = stubFetch({ body: { account: { id: 'a1', username: 'dm' } } })
    await createApiClient().me()
    expect(calls[0]?.init.body).toBeUndefined()
    expect(calls[0]?.init.headers).toBeUndefined()
  })

  it('throws ApiClientError carrying the server envelope on non-2xx', async () => {
    stubFetch({ ok: false, status: 403, body: { error: { code: 'forbidden', message: 'nope' } } })
    const api = createApiClient()
    await expect(api.listWorlds()).rejects.toBeInstanceOf(ApiClientError)
    stubFetch({ ok: false, status: 403, body: { error: { code: 'forbidden', message: 'nope' } } })
    await expect(api.listWorlds()).rejects.toMatchObject({
      status: 403,
      code: 'forbidden',
      message: 'nope',
    })
  })

  it('falls back to status text when the error body lacks fields or is not JSON', async () => {
    stubFetch({ ok: false, status: 400, statusText: 'Bad Request', body: {} })
    await expect(createApiClient().me()).rejects.toMatchObject({
      code: 'error',
      message: 'Bad Request',
    })
    stubFetch({ ok: false, status: 500, statusText: 'Server Error', jsonThrows: true })
    await expect(createApiClient().me()).rejects.toMatchObject({
      status: 500,
      message: 'Server Error',
    })
  })

  it('builds world-scoped, URL-encoded paths', async () => {
    const calls = stubFetch({ body: { entity: { id: 'e1' } } })
    await createApiClient().getEntity('w 1', 'npc', 'id/2')
    expect(calls[0]?.url).toBe('/api/worlds/w%201/entities/npc/id%2F2')
  })

  it('exposes a typed method for every endpoint', async () => {
    const everything = {
      account: { id: 'a', username: 'u' },
      flags: webFlags(true),
      contactEmail: 'help@example.com',
      worlds: [],
      // carries the accept-invitation shape too, so one stub body serves both
      world: { id: 'w', name: 'W', ownerId: 'a', role: 'owner', worldSlug: 'w' },
      entities: [],
      entity: { id: 'e' },
      passages: [],
      passage: { id: 'p' },
      entries: [],
      graph: { nodes: [], edges: [] },
      sessions: [],
      touches: [],
      touch: { id: 't' },
      notes: [],
      note: { id: 'n' },
      characters: [],
      character: { id: 'c' },
      suggestions: [],
      suggestion: { id: 's' },
      members: [],
      invitations: [],
      accountIds: [],
      pending: null,
      emailVerified: false,
      limits: {},
      usage: {},
      id: 'i',
      token: 'tok',
      ok: true,
      version: 1,
      tables: {},
      worldId: 'w2',
      counts: {},
    }
    stubFetch({ body: everything })
    const api = createApiClient()

    expect((await api.login('u', 'p')).username).toBe('u')
    expect(
      (await api.register({ username: 'u', password: 'p', email: 'u@example.com' })).username,
    ).toBe('u')
    await api.logout()
    expect((await api.demoLogin()).username).toBe('u')
    expect((await api.previewInvitation('tok')).world.name).toBe('W')
    expect((await api.acceptInvitation('tok')).worldSlug).toBe('w')
    expect((await api.me()).id).toBe('a')
    const config = await api.getConfig()
    expect(config.flags.publicSignupEnabled).toBe(true)
    expect(config.contactEmail).toBe('help@example.com')
    await api.requestPasswordReset('dm')
    await api.confirmPasswordReset('tok', 'new-password-1')
    await api.changePassword('old-password-1', 'new-password-2')
    expect((await api.changeUsername('u')).username).toBe('u')
    expect(await api.listSessions()).toEqual([])
    await api.revokeOtherSessions()
    expect((await api.accountStatus()).emailVerified).toBe(false)
    await api.resendVerification()
    await api.verifyEmail('tok')
    expect(await api.deletionBlockers()).toEqual([])
    await api.deleteAccount('pw-123456')
    expect(await api.listWorlds()).toEqual([])
    expect((await api.createWorld('W')).id).toBe('w')
    expect((await api.getWorld('w')).id).toBe('w')
    await api.deleteWorld('w')
    expect(await api.listMembers('w')).toEqual([])
    await api.grantMember('w', 'a')
    await api.revokeMember('w', 'a')
    // Both arms: an open link (no username) and one pinned to an account.
    expect((await api.createInvitation('w')).token).toBe('tok')
    expect((await api.createInvitation('w', 'u')).id).toBe('i')
    expect(await api.listInvitations('w')).toEqual([])
    await api.revokeInvitation('w', 'i')
    await api.leaveWorld('w')
    expect(await api.getPendingTransfer('w')).toBeNull()
    await api.offerOwnership('w', 'a')
    await api.cancelOwnershipOffer('w')
    await api.acceptOwnership('w')
    expect((await api.lookupAccount('w', 'u'))?.username).toBe('u')

    expect(await api.listEntities('w', 'npc')).toEqual([])
    expect((await api.createEntity('w', 'npc', { name: 'x' })).id).toBe('e')
    expect((await api.getEntity('w', 'npc', 'e')).id).toBe('e')
    expect((await api.updateEntity('w', 'npc', 'e', { name: 'y' })).id).toBe('e')
    expect((await api.changeEntityKind('w', 'npc', 'e', 'pc')).id).toBe('e')
    await api.deleteEntity('w', 'npc', 'e')

    expect(await api.listEntityGrants('w', 'npc', 'e')).toEqual([])
    await api.grantEntityAccess('w', 'npc', 'e', 'a')
    await api.revokeEntityAccess('w', 'npc', 'e', 'a')

    expect(await api.listMapGrants('w', 'm')).toEqual([])
    await api.grantMapAccess('w', 'm', 'a')
    await api.revokeMapAccess('w', 'm', 'a')

    expect(await api.listPassages('w', 'npc', 'e')).toEqual([])
    expect((await api.createPassage('w', 'npc', 'e', { body: 'x' })).id).toBe('p')
    expect((await api.updatePassage('w', 'p', { body: 'y' })).id).toBe('p')
    await api.deletePassage('w', 'p')
    expect((await api.proposePassage('w', 'npc', 'e', 'text')).id).toBe('p')
    expect((await api.acceptPassage('w', 'p', 'public')).id).toBe('p')
    await api.rejectPassage('w', 'p')
    expect(await api.listPassageGrants('w', 'p')).toEqual([])
    await api.grantPassageAccess('w', 'p', 'a')
    await api.revokePassageAccess('w', 'p', 'a')

    expect(await api.listWiki('w')).toEqual([])
    expect((await api.getGraph('w')).nodes).toEqual([])
    expect(await api.listEntitySessions('w', 'npc', 'e')).toEqual([])
    expect(await api.listTouches('w', 's')).toEqual([])
    expect((await api.createTouch('w', 's', { entityId: 'e', touchType: 'met' })).id).toBe('t')
    await api.deleteTouch('w', 's', 't')

    expect(await api.listNotes('w')).toEqual([])
    expect((await api.createNote('w', 'b')).id).toBe('n')
    expect((await api.updateNote('w', 'n', 'b2')).id).toBe('n')
    await api.deleteNote('w', 'n')

    expect(await api.listCharacters('w')).toEqual([])
    expect((await api.createCharacter('w', { name: 'c' })).id).toBe('c')
    expect((await api.updateCharacter('w', 'c', { name: 'c2' })).id).toBe('c')
    await api.deleteCharacter('w', 'c')

    expect(await api.listSuggestions('w')).toEqual([])
    expect(
      (await api.proposeSuggestion('w', { targetKind: 'npc', targetId: 'e', proposed: {} })).id,
    ).toBe('s')
    expect((await api.acceptSuggestion('w', 's')).id).toBe('s')
    expect((await api.rejectSuggestion('w', 's')).id).toBe('s')

    expect((await api.exportWorld('w')).version).toBe(1)
    expect((await api.importWorld('W', { version: 1, tables: {} })).worldId).toBe('w2')
  })
})

describe('uploads and binary bodies', () => {
  it('POSTs the file AS the body, with its own type and the name in the query', async () => {
    // No multipart envelope: one file per request, so the body IS the file. The
    // declared type routes the server's parser and is NOT what decides the
    // format — the server reads the header.
    const calls = stubFetch({ body: { media: { id: 'm1' } } })
    const api = createApiClient('http://host')
    const file = new File([new Uint8Array([1, 2, 3])], 'portrait.png', { type: 'image/png' })

    const media = await api.uploadEntityMedia('w1', 'npc', 'e1', file)

    expect(media).toEqual({ id: 'm1' })
    expect(calls[0]?.url).toBe(
      'http://host/api/worlds/w1/entities/npc/e1/media?filename=portrait.png',
    )
    expect(calls[0]?.init.method).toBe('POST')
    expect(calls[0]?.init.credentials).toBe('include')
    expect(calls[0]?.init.headers).toEqual({ 'content-type': 'image/png' })
    expect(calls[0]?.init.body).toBe(file)
  })

  it('falls back to a generic binary type for a file the browser could not type', async () => {
    // The server accepts it for the same reason it ignores the header: gating on
    // a signal already declared to be no evidence would refuse honest uploads.
    const calls = stubFetch({ body: { media: { id: 'm1' } } })
    const api = createApiClient('')
    await api.uploadEntityMedia('w1', 'npc', 'e1', new File([], 'mystery', { type: '' }))
    expect(calls[0]?.init.headers).toEqual({ 'content-type': 'application/octet-stream' })
  })

  it('sends the thumbnail as a SECOND request and returns the updated row', async () => {
    const calls = stubFetch(
      { body: { media: { id: 'm1', thumbnail_path: null } } },
      { body: { media: { id: 'm1', thumbnail_path: 'w/thumb.jpg' } } },
    )
    const api = createApiClient('')
    const thumb = new Blob([new Uint8Array([9])], { type: 'image/jpeg' })

    const media = await api.uploadEntityMedia(
      'w1',
      'npc',
      'e1',
      new File([], 'p.png', { type: 'image/png' }),
      thumb,
    )

    expect(calls).toHaveLength(2)
    expect(calls[1]?.url).toBe('/api/worlds/w1/media/m1/thumbnail')
    expect(media.thumbnail_path).toBe('w/thumb.jpg')
  })

  it('keeps the attachment when the thumbnail request fails', async () => {
    // The whole reason the two are separate requests: a failure here leaves a
    // usable attachment with no preview, which is already a legal state.
    const calls = stubFetch(
      { body: { media: { id: 'm1', thumbnail_path: null } } },
      { ok: false, status: 500, body: { error: { code: 'internal', message: 'boom' } } },
    )
    const api = createApiClient('')
    const media = await api.uploadEntityMedia(
      'w1',
      'npc',
      'e1',
      new File([], 'p.png', { type: 'image/png' }),
      new Blob([new Uint8Array([9])], { type: 'image/jpeg' }),
    )
    expect(calls).toHaveLength(2)
    expect(media).toEqual({ id: 'm1', thumbnail_path: null })
  })

  it('raises the server error when the SOURCE upload itself fails', async () => {
    stubFetch({
      ok: false,
      status: 400,
      body: { error: { code: 'unsupported_image', message: 'not an image' } },
    })
    const api = createApiClient('')
    await expect(
      api.uploadEntityMedia('w1', 'npc', 'e1', new File([], 'x.png', { type: 'image/png' })),
    ).rejects.toBeInstanceOf(ApiClientError)
  })

  it('builds source and thumbnail URLs that differ only by the variant', async () => {
    const api = createApiClient('http://host')
    expect(api.mediaRawUrl('w1', 'm1')).toBe('http://host/api/worlds/w1/media/m1/raw')
    expect(api.mediaThumbnailUrl('w1', 'm1')).toBe(
      'http://host/api/worlds/w1/media/m1/raw?variant=thumbnail',
    )
  })

  it('uploads a map image and reports the dimensions the server read', async () => {
    const calls = stubFetch(
      { body: { media: { id: 'm1' }, sourceWidth: 900, sourceHeight: 600 } },
      { body: { media: { id: 'm1' } } },
    )
    const api = createApiClient('')
    const size = await api.uploadMapImage(
      'w1',
      'map1',
      new File([], 'm.png', { type: 'image/png' }),
      new Blob([new Uint8Array([9])], { type: 'image/jpeg' }),
    )
    expect(size).toEqual({ sourceWidth: 900, sourceHeight: 600 })
    expect(calls[0]?.url).toBe('/api/worlds/w1/maps/map1/image?filename=m.png')
    expect(calls[1]?.url).toBe('/api/worlds/w1/media/m1/thumbnail')
  })

  it('keeps a map image whose thumbnail request fails', async () => {
    // Same tolerance as the entity path: the map is uploaded and its dimensions
    // are recorded; only the preview is missing.
    const calls = stubFetch(
      { body: { media: { id: 'm1' }, sourceWidth: 800, sourceHeight: 400 } },
      { ok: false, status: 500, body: { error: { code: 'internal', message: 'boom' } } },
    )
    const api = createApiClient('')
    const size = await api.uploadMapImage(
      'w1',
      'map1',
      new File([], 'm.png', { type: 'image/png' }),
      new Blob([new Uint8Array([9])], { type: 'image/jpeg' }),
    )
    expect(calls).toHaveLength(2)
    expect(size).toEqual({ sourceWidth: 800, sourceHeight: 400 })
  })

  it('skips the thumbnail request for a map image that has none', async () => {
    const calls = stubFetch({ body: { media: { id: 'm1' }, sourceWidth: 10, sourceHeight: 10 } })
    const api = createApiClient('')
    await api.uploadMapImage('w1', 'map1', new File([], 'm.png', { type: 'image/png' }), null)
    expect(calls).toHaveLength(1)
  })
})

describe('maps, pins and relationships', () => {
  it('routes every map and pin call at the right URL and unwraps it', async () => {
    const calls = stubFetch(
      { body: { maps: [] } },
      { body: { map: { id: 'map1' }, image: null } },
      { body: { map: { id: 'map1' } } },
      { body: { map: { id: 'map1' } } },
      { body: { ok: true } },
      { body: { pins: [] } },
      { body: { pin: { id: 'p1' } } },
      { body: { pin: { id: 'p1' } } },
      { body: { ok: true } },
      { body: { maps: [] } },
    )
    const api = createApiClient('')

    expect(await api.listMaps('w1')).toEqual([])
    expect((await api.getMap('w1', 'map1')).image).toBeNull()
    expect((await api.createMap('w1', { name: 'M' })).id).toBe('map1')
    expect((await api.updateMap('w1', 'map1', { name: 'M2' })).id).toBe('map1')
    await api.deleteMap('w1', 'map1')

    expect(await api.listPins('w1', 'map1')).toEqual([])
    expect(
      (await api.createPin('w1', 'map1', { kind: 'npc', entityId: 'e1', x: 0.5, y: 0.5 })).id,
    ).toBe('p1')
    expect((await api.updatePin('w1', 'map1', 'p1', { x: 0.6 })).id).toBe('p1')
    await api.deletePin('w1', 'map1', 'p1')
    expect(await api.listEntityMaps('w1', 'npc', 'e1')).toEqual([])

    expect(calls.map((c) => c.url)).toEqual([
      '/api/worlds/w1/maps',
      '/api/worlds/w1/maps/map1',
      '/api/worlds/w1/maps',
      '/api/worlds/w1/maps/map1',
      '/api/worlds/w1/maps/map1',
      '/api/worlds/w1/maps/map1/pins',
      '/api/worlds/w1/maps/map1/pins',
      '/api/worlds/w1/maps/map1/pins/p1',
      '/api/worlds/w1/maps/map1/pins/p1',
      '/api/worlds/w1/entities/npc/e1/maps',
    ])
  })

  it('routes the relationship calls, with delete keyed on the row not the entity', async () => {
    // One row, so removing it needs only its own id — and it vanishes from both
    // entities at once.
    const calls = stubFetch(
      { body: { relationships: [] } },
      { body: { relationship: { id: 'r1' } } },
      { body: { ok: true } },
    )
    const api = createApiClient('')

    expect(await api.listRelationships('w1', 'npc', 'e1')).toEqual([])
    expect(
      (await api.createRelationship('w1', 'npc', 'e1', { toId: 'e2', type: 'ally_of' })).id,
    ).toBe('r1')
    await api.deleteRelationship('w1', 'r1')

    expect(calls.map((c) => c.url)).toEqual([
      '/api/worlds/w1/entities/npc/e1/relationships',
      '/api/worlds/w1/entities/npc/e1/relationships',
      '/api/worlds/w1/relationships/r1',
    ])
  })
})
