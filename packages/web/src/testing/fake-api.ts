import { webFlags } from './flags'
import { vi } from 'vitest'
import type { ApiClient } from '../api'

/**
 * A fake ApiClient for component tests. Every method is a vi.fn with a benign
 * default; pass overrides for the calls a test cares about. (Test-only — excluded
 * from coverage.)
 */
export function makeApi(overrides: Partial<ApiClient> = {}): ApiClient {
  const resolve =
    <T>(value: T) =>
    () =>
      Promise.resolve(value)
  const base: ApiClient = {
    login: resolve({ id: 'a', username: 'dm' }),
    register: resolve({ id: 'a', username: 'dm' }),
    logout: resolve(undefined),
    demoLogin: resolve({ id: 'demo', username: 'demo' }),
    previewInvitation: resolve({ world: { name: 'W', slug: 'w' }, targeted: false }),
    acceptInvitation: resolve({ worldName: 'W', worldSlug: 'w' }),
    me: () => Promise.reject(new Error('anon')),
    // Every surface OPEN by default: suites using this fake are testing flows,
    // not the access gate, and a closed default would silently turn each of
    // them into a test of the contact modal. The gate has its own suites, which
    // set the flags they mean.
    getConfig: resolve({
      flags: webFlags(true),
      contactEmail: 'fakeemail@address.com',
    }),
    requestPasswordReset: resolve(undefined),
    confirmPasswordReset: resolve(undefined),
    changePassword: resolve(undefined),
    changeUsername: resolve({ id: 'a', username: 'dm' }),
    listSessions: resolve([]),
    revokeOtherSessions: resolve(undefined),
    accountStatus: resolve({
      emailVerified: true,
      limits: { worldsPerAccount: 5, entitiesPerWorld: 2000, mediaBytesPerWorld: 104857600 },
      usage: { worlds: 0 },
    }),
    resendVerification: resolve(undefined),
    verifyEmail: resolve(undefined),
    deletionBlockers: resolve([]),
    deleteAccount: resolve(undefined),
    listWorlds: resolve([]),
    createWorld: resolve({ id: 'w', name: 'W', slug: 'w', ownerId: 'a', role: 'owner' }),
    getWorld: resolve({ id: 'w', name: 'W', slug: 'w', ownerId: 'a', role: 'owner' }),
    renameWorld: resolve({ id: 'w', name: 'W', slug: 'w', ownerId: 'a', role: 'owner' }),
    deleteWorld: resolve(undefined),
    listMembers: resolve([]),
    grantMember: resolve(undefined),
    revokeMember: resolve(undefined),
    createInvitation: resolve({ id: 'i', token: 'tok' }),
    listInvitations: resolve([]),
    revokeInvitation: resolve(undefined),
    leaveWorld: resolve(undefined),
    getPendingTransfer: resolve(null),
    offerOwnership: resolve(undefined),
    cancelOwnershipOffer: resolve(undefined),
    acceptOwnership: resolve(undefined),
    lookupAccount: resolve(null),
    listEntities: resolve([]),
    createEntity: resolve({ id: 'e' }),
    getEntity: resolve({ id: 'e' }),
    updateEntity: resolve({ id: 'e' }),
    changeEntityKind: resolve({ id: 'e' }),
    deleteEntity: resolve(undefined),
    listTrash: resolve([]),
    restoreTrashed: resolve(undefined),
    purgeTrashed: resolve(undefined),
    listEntityGrants: resolve([]),
    grantEntityAccess: resolve(undefined),
    revokeEntityAccess: resolve(undefined),
    listMapGrants: resolve([]),
    grantMapAccess: resolve(undefined),
    revokeMapAccess: resolve(undefined),
    listPassages: resolve([]),
    createPassage: resolve({ id: 'p' } as never),
    updatePassage: resolve({ id: 'p' } as never),
    deletePassage: resolve(undefined),
    proposePassage: resolve({ id: 'p' } as never),
    acceptPassage: resolve({ id: 'p' } as never),
    rejectPassage: resolve(undefined),
    listPassageGrants: resolve([]),
    grantPassageAccess: resolve(undefined),
    revokePassageAccess: resolve(undefined),
    getDashboard: resolve({ session: null, party: [], myCharacter: null, counts: {} }),
    listWiki: resolve([]),
    getGraph: resolve({ nodes: [], edges: [] }),
    listEntitySessions: resolve([]),
    listEntityMedia: resolve([]),
    uploadEntityMedia: resolve({ id: 'm' } as never),
    deleteMedia: resolve(undefined),
    getPrimaryMedia: resolve(null),
    setPrimaryMedia: resolve(null),
    // Non-empty on purpose: components treat a falsy URL as "there is no image"
    // and take their empty-state branch, so an empty-string default would
    // silently turn every media test into a test of the placeholder.
    mediaRawUrl: (_worldId, id) => `/api/media/${id}/raw`,
    mediaThumbnailUrl: (_worldId, id) => `/api/media/${id}/raw?variant=thumbnail`,
    listMaps: resolve([]),
    getMap: resolve({ map: { id: 'map1', name: 'Map' } as never, image: null }),
    createMap: resolve({ id: 'map1' } as never),
    updateMap: resolve({ id: 'map1' } as never),
    deleteMap: resolve(undefined),
    uploadMapImage: resolve({ sourceWidth: 100, sourceHeight: 100 }),
    listPins: resolve([]),
    createPin: resolve({ id: 'pin1' } as never),
    updatePin: resolve({ id: 'pin1' } as never),
    deletePin: resolve(undefined),
    listEntityMaps: resolve([]),
    listRelationships: resolve([]),
    createRelationship: resolve({ id: 'r1' } as never),
    updateRelationship: resolve({ id: 'r1' } as never),
    deleteRelationship: resolve(undefined),
    listCurrencyAttachments: resolve([]),
    attachCurrency: resolve({ id: 'ca1' } as never),
    updateCurrencyAttachment: resolve({ id: 'ca1' } as never),
    detachCurrency: resolve(undefined),
    listCurrencyUsers: resolve([]),
    listCalendars: resolve([]),
    activeCalendar: resolve(null),
    createCalendar: resolve({ id: 'cal1' } as never),
    updateCalendar: resolve({ id: 'cal1' } as never),
    activateCalendar: resolve([]),
    deleteCalendar: resolve(undefined),
    listTouches: resolve([]),
    createTouch: resolve({ id: 't' } as never),
    deleteTouch: resolve(undefined),
    listNotes: resolve([]),
    createNote: resolve({ id: 'n' } as never),
    updateNote: resolve({ id: 'n' } as never),
    deleteNote: resolve(undefined),
    listSuggestions: resolve([]),
    proposeSuggestion: resolve({ id: 's' } as never),
    acceptSuggestion: resolve({ id: 's' } as never),
    rejectSuggestion: resolve({ id: 's' } as never),
    exportWorld: resolve({ version: 1, tables: {} }),
    importWorld: resolve({ worldId: 'w', slug: 'w', counts: {} }),
  }
  // wrap each in vi.fn so tests can assert calls, then apply overrides
  const spied = Object.fromEntries(
    Object.entries(base).map(([k, fn]) => [k, vi.fn(fn as (...a: unknown[]) => unknown)]),
  ) as unknown as ApiClient
  return { ...spied, ...overrides }
}
