import type { Visibility } from '@campaign-settings/shared'
import { ApiClientError } from './errors'
import type {
  AccountStatus,
  BlockingWorld,
  CreatedInvitation,
  Entity,
  EntityGraph,
  EntityRelationship,
  EntitySession,
  ImportResult,
  InvitationPreview,
  InvitationView,
  MapPin,
  MapReference,
  MapWithImage,
  MediaAttachment,
  MemberView,
  Passage,
  PendingTransfer,
  PlayerCharacter,
  PlayerNote,
  PublicAccount,
  PublicConfig,
  SessionSummary,
  Suggestion,
  Touch,
  TouchType,
  TrashEntry,
  WikiEntry,
  WorldExport,
  WorldMap,
  WorldView,
} from './types'

/**
 * Typed client over the HTTP API using native fetch. The session cookie rides
 * along via `credentials: 'include'`; non-2xx responses become
 * {@link ApiClientError} carrying the server's `{error:{code,message}}`.
 * Handlers stay thin — the client only shapes requests and unwraps responses.
 */
export interface ApiClient {
  login(username: string, password: string): Promise<PublicAccount>
  /**
   * Create an account and sign in. Rejects with `signup_closed` when public
   * registration is switched off — the flag is enforced server-side, so the
   * SPA hiding the form is a courtesy, not the gate.
   */
  register(input: {
    username: string
    password: string
    email: string
    /** Authorises registration on its own when public signup is closed. */
    inviteToken?: string
  }): Promise<PublicAccount>
  logout(): Promise<void>
  /**
   * Sign in as the shared, read-only demo player. Takes no arguments by
   * design — the endpoint cannot be asked to authenticate as anybody else.
   * Rejects with `surface_disabled` when demo mode is off.
   */
  demoLogin(): Promise<PublicAccount>

  /** What world a token points at. Rejects with `invalid_invitation` if it is dead. */
  previewInvitation(token: string): Promise<InvitationPreview>
  /** Redeem a token as the signed-in account, joining the world. */
  acceptInvitation(token: string): Promise<{ worldName: string; worldSlug: string }>
  me(): Promise<PublicAccount>
  /** Public runtime config the SPA reflects — flags + contact email (unauthenticated). */
  getConfig(): Promise<PublicConfig>
  /** Request a password-reset email. Always resolves — no account-existence oracle. */
  requestPasswordReset(identifier: string): Promise<void>
  /** Set a new password from a reset token; rejects on an invalid/expired token. */
  confirmPasswordReset(token: string, newPassword: string): Promise<void>

  /**
   * Change your own password. Ends every other session and silently re-issues
   * this one, so the caller stays signed in on a fresh cookie.
   */
  changePassword(currentPassword: string, newPassword: string): Promise<void>
  /** Change your own login name; rejects with `username_taken` if it is held. */
  changeUsername(username: string): Promise<PublicAccount>
  /** Your live sessions, newest activity first, with this one marked. */
  listSessions(): Promise<SessionSummary[]>
  /** End every session except this one. */
  revokeOtherSessions(): Promise<void>
  /**
   * Verification state, the resource ceilings in force, and current usage —
   * everything the SPA needs to warn BEFORE a create is refused.
   */
  accountStatus(): Promise<AccountStatus>
  /** Re-send the verification link. Throttled server-side; always resolves. */
  resendVerification(): Promise<void>
  /** Prove an address from an emailed token. Public — the link may open logged out. */
  verifyEmail(token: string): Promise<void>
  /**
   * Worlds you own, which block account deletion until each is transferred or
   * deleted. Empty means deletion will go through.
   */
  deletionBlockers(): Promise<BlockingWorld[]>
  /**
   * HARD-delete your account and everything hanging off it. Requires the
   * current password. Rejects with `owns_worlds` while you still own a world.
   * There is no undo and nothing is retained.
   */
  deleteAccount(password: string): Promise<void>

  listWorlds(): Promise<WorldView[]>
  createWorld(name: string): Promise<WorldView>
  getWorld(worldId: string): Promise<WorldView>
  /**
   * Rename a world. Owner only, and the returned view carries the world's NEW
   * slug — the URL follows the name, so the address just used to make this call
   * has stopped resolving and the caller has to go to the one it hands back.
   */
  renameWorld(worldId: string, name: string): Promise<WorldView>
  deleteWorld(worldId: string): Promise<void>
  /** Everyone in the world, owner first. Readable by any member. */
  listMembers(worldId: string): Promise<MemberView[]>
  grantMember(worldId: string, accountId: string): Promise<void>
  revokeMember(worldId: string, accountId: string): Promise<void>

  /**
   * Mint an invitation. Omit `username` for an open shareable link; supply it
   * to pin the invitation to one account (an unknown name rejects rather than
   * silently widening to an open link).
   *
   * The returned `token` is the ONLY time the raw value exists — only its hash
   * is stored, so it cannot be recovered from {@link listInvitations} later.
   * Show it to the owner immediately or it is lost.
   */
  createInvitation(worldId: string, username?: string): Promise<CreatedInvitation>
  /** Every invitation for the world, newest first. Owner-only. */
  listInvitations(worldId: string): Promise<InvitationView[]>
  /** Revoke a PENDING invitation. An accepted one rejects — removing a member is `revokeMember`. */
  revokeInvitation(worldId: string, invitationId: string): Promise<void>
  /**
   * Leave a world of your own accord. Rejects with `owner_cannot_leave` for the
   * owner — a world may never be ownerless, so their exits are transfer-then-
   * leave, or delete.
   *
   * Leaving DELETES your notes, characters, and entity grants for that world.
   * Offer the export first.
   */
  leaveWorld(worldId: string): Promise<void>
  /** The outstanding ownership offer for a world, or null. Any member may read it. */
  getPendingTransfer(worldId: string): Promise<PendingTransfer | null>
  /** Offer the world to an existing member. Owner-only; rejects `not_a_member`. */
  offerOwnership(worldId: string, accountId: string): Promise<void>
  /** Withdraw an outstanding offer. Owner-only. */
  cancelOwnershipOffer(worldId: string): Promise<void>
  /** Accept the offer naming you. Rejects unless you are the named account. */
  acceptOwnership(worldId: string): Promise<void>

  /**
   * Resolve an EXACT username to the account reference `grantMember` and the
   * entity-grant calls take. Owner-only and rate-limited server-side; resolves
   * to null when no account has that exact name. Not a search — there is
   * deliberately no prefix or fuzzy matching to browse.
   */
  lookupAccount(worldId: string, username: string): Promise<PublicAccount | null>

  listEntities(worldId: string, kind: string): Promise<Entity[]>
  createEntity(worldId: string, kind: string, input: Record<string, unknown>): Promise<Entity>
  getEntity(worldId: string, kind: string, id: string): Promise<Entity>
  updateEntity(
    worldId: string,
    kind: string,
    id: string,
    patch: Record<string, unknown>,
  ): Promise<Entity>
  /** Reclassify an entity to a different content kind; returns the moved entity. */
  changeEntityKind(worldId: string, kind: string, id: string, toKind: string): Promise<Entity>
  deleteEntity(worldId: string, kind: string, id: string): Promise<void>

  /**
   * The world's soft-deleted content. Owner-only server-side — a player's call
   * is refused rather than answered with an empty list.
   */
  listTrash(worldId: string): Promise<TrashEntry[]>
  /** Clear a trashed row's `deleted_at`, putting it back with its own visibility. */
  restoreTrashed(worldId: string, kind: string, id: string): Promise<void>
  /** Destroy a trashed row for good, with its dependents and its uploaded bytes. */
  purgeTrashed(worldId: string, kind: string, id: string): Promise<void>

  /**
   * The account ids currently granted access to a `restricted` entity.
   * Owner-only server-side. The list is meaningful only while the entity IS
   * restricted — the authorization seam consults grants for nothing else.
   */
  listEntityGrants(worldId: string, kind: string, id: string): Promise<string[]>
  /** Grant one account access to a restricted entity. Owner-only; idempotent. */
  grantEntityAccess(worldId: string, kind: string, id: string, accountId: string): Promise<void>
  /** Revoke one account's access to a restricted entity. Owner-only; idempotent. */
  revokeEntityAccess(worldId: string, kind: string, id: string, accountId: string): Promise<void>

  /**
   * The passages of one entity that THIS viewer may see — the same list that
   * composed their `body`. A sub-resource, like media and relationships, so the
   * panel managing them refreshes on its own rather than reloading the entity.
   */
  listPassages(worldId: string, kind: string, id: string): Promise<Passage[]>
  createPassage(
    worldId: string,
    kind: string,
    id: string,
    input: { body: string; position?: number; visibility?: Visibility },
  ): Promise<Passage>
  /** Edit a passage. Owner-only; the passage id is unique within the world. */
  updatePassage(
    worldId: string,
    passageId: string,
    patch: { body?: string; position?: number; visibility?: Visibility },
  ): Promise<Passage>
  deletePassage(worldId: string, passageId: string): Promise<void>
  /**
   * Propose a passage as a PLAYER. The only content write a player has: the
   * server forces its status, author, visibility and position, so this takes
   * the text and nothing else.
   */
  proposePassage(worldId: string, kind: string, id: string, body: string): Promise<Passage>
  /** Publish a proposal at a visibility the OWNER chooses. Owner-only. */
  acceptPassage(worldId: string, passageId: string, visibility: Visibility): Promise<Passage>
  /** Decline a proposal (a soft delete). Owner-only. */
  rejectPassage(worldId: string, passageId: string): Promise<void>
  listPassageGrants(worldId: string, passageId: string): Promise<string[]>
  grantPassageAccess(worldId: string, passageId: string, accountId: string): Promise<void>
  revokePassageAccess(worldId: string, passageId: string, accountId: string): Promise<void>

  listWiki(worldId: string): Promise<WikiEntry[]>
  getGraph(worldId: string): Promise<EntityGraph>
  listEntitySessions(worldId: string, kind: string, id: string): Promise<EntitySession[]>

  listEntityMedia(worldId: string, kind: string, id: string): Promise<MediaAttachment[]>
  /**
   * Attach an image to an entity. The file IS the request body — one file per
   * request, so there is no multipart envelope and no parser to go with it.
   *
   * `thumbnail`, when given, is sent as a follow-up request; if that second call
   * fails the attachment still stands and simply has no preview, which is what
   * `thumbnail_path` being nullable has always meant.
   */
  uploadEntityMedia(
    worldId: string,
    kind: string,
    id: string,
    file: File,
    thumbnail?: Blob | null,
  ): Promise<MediaAttachment>
  deleteMedia(worldId: string, id: string): Promise<void>
  /** Same-origin URL for a media row's raw bytes (use as an <img> src). */
  mediaRawUrl(worldId: string, id: string): string
  /** Preview bytes for a gallery. Falls back to the source when there is no thumbnail. */
  mediaThumbnailUrl(worldId: string, id: string): string

  listMaps(worldId: string): Promise<WorldMap[]>
  /** A map plus its image — both, because the viewer cannot draw without either. */
  getMap(worldId: string, id: string): Promise<MapWithImage>
  createMap(
    worldId: string,
    input: { name: string; description?: string; visibility?: Visibility },
  ): Promise<WorldMap>
  updateMap(
    worldId: string,
    id: string,
    patch: { name?: string; description?: string; visibility?: Visibility },
  ): Promise<WorldMap>
  deleteMap(worldId: string, id: string): Promise<void>
  /** Which players may see a `restricted` map. Owner-only. */
  listMapGrants(worldId: string, mapId: string): Promise<string[]>
  grantMapAccess(worldId: string, mapId: string, accountId: string): Promise<void>
  revokeMapAccess(worldId: string, mapId: string, accountId: string): Promise<void>
  /** Upload the map's image; the server reads its dimensions from the header. */
  uploadMapImage(
    worldId: string,
    id: string,
    file: File,
    thumbnail?: Blob | null,
  ): Promise<{ sourceWidth: number; sourceHeight: number }>

  /** Pins on a map — only those whose target the caller may see. */
  listPins(worldId: string, mapId: string): Promise<MapPin[]>
  createPin(
    worldId: string,
    mapId: string,
    input: { kind: string; entityId: string; x: number; y: number; label?: string | null },
  ): Promise<MapPin>
  updatePin(
    worldId: string,
    mapId: string,
    id: string,
    patch: { x?: number; y?: number; label?: string | null },
  ): Promise<MapPin>
  deletePin(worldId: string, mapId: string, id: string): Promise<void>
  /** The maps an entity is pinned on, filtered to maps the caller may see. */
  listEntityMaps(worldId: string, kind: string, id: string): Promise<MapReference[]>

  /**
   * Typed relationships touching an entity, in both directions. Only those whose
   * FAR end the caller may see — a relationship naming a hidden entity is
   * dropped server-side, so nothing here needs to filter.
   */
  listRelationships(worldId: string, kind: string, id: string): Promise<EntityRelationship[]>
  /** Assert a relationship FROM this entity. Owner-only server-side. */
  createRelationship(
    worldId: string,
    kind: string,
    id: string,
    input: { toId: string; type: string; note?: string },
  ): Promise<EntityRelationship>
  /** Remove a relationship. It vanishes from both entities, being one row. */
  deleteRelationship(worldId: string, id: string): Promise<void>

  listTouches(worldId: string, sessionId: string): Promise<Touch[]>
  createTouch(
    worldId: string,
    sessionId: string,
    input: { entityId: string; touchType: TouchType; narrativeDelta?: string },
  ): Promise<Touch>
  deleteTouch(worldId: string, sessionId: string, id: string): Promise<void>

  listNotes(worldId: string): Promise<PlayerNote[]>
  createNote(worldId: string, body: string): Promise<PlayerNote>
  updateNote(worldId: string, id: string, body: string): Promise<PlayerNote>
  deleteNote(worldId: string, id: string): Promise<void>

  listCharacters(worldId: string): Promise<PlayerCharacter[]>
  createCharacter(
    worldId: string,
    input: { name: string; data?: Record<string, unknown> },
  ): Promise<PlayerCharacter>
  updateCharacter(
    worldId: string,
    id: string,
    patch: { name?: string; data?: Record<string, unknown> },
  ): Promise<PlayerCharacter>
  deleteCharacter(worldId: string, id: string): Promise<void>

  listSuggestions(worldId: string): Promise<Suggestion[]>
  proposeSuggestion(
    worldId: string,
    input: { targetKind: string; targetId: string; proposed: Record<string, unknown> },
  ): Promise<Suggestion>
  acceptSuggestion(worldId: string, id: string): Promise<Suggestion>
  rejectSuggestion(worldId: string, id: string): Promise<Suggestion>

  exportWorld(worldId: string): Promise<WorldExport>
  importWorld(name: string, data: WorldExport): Promise<ImportResult>
}

const seg = (s: string): string => encodeURIComponent(s)

async function toError(res: Response): Promise<ApiClientError> {
  let code = 'error'
  let message = res.statusText || 'request failed'
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string } }
    if (body.error?.code) code = body.error.code
    if (body.error?.message) message = body.error.message
  } catch {
    // non-JSON error body — keep the status text
  }
  return new ApiClientError(res.status, code, message)
}

export function createApiClient(baseUrl = ''): ApiClient {
  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const init: RequestInit = { method, credentials: 'include' }
    if (body !== undefined) {
      init.headers = { 'content-type': 'application/json' }
      init.body = JSON.stringify(body)
    }
    const res = await fetch(`${baseUrl}${path}`, init)
    if (!res.ok) throw await toError(res)
    return (await res.json()) as T
  }

  /**
   * Same as {@link request} but for routes that answer 204 — there is no body,
   * and asking `res.json()` for one throws on the empty response.
   */
  async function requestNoContent(method: string, path: string, body?: unknown): Promise<void> {
    const init: RequestInit = { method, credentials: 'include' }
    if (body !== undefined) {
      init.headers = { 'content-type': 'application/json' }
      init.body = JSON.stringify(body)
    }
    const res = await fetch(`${baseUrl}${path}`, init)
    if (!res.ok) throw await toError(res)
  }

  /**
   * POST raw bytes. The blob's own type becomes the Content-Type, which is what
   * routes the request to the server's binary parser — it is NOT what decides
   * the format, since the server reads the header and ignores this entirely.
   */
  async function sendBytes<T>(path: string, bytes: Blob): Promise<T> {
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': bytes.type || 'application/octet-stream' },
      body: bytes,
    })
    if (!res.ok) throw await toError(res)
    return (await res.json()) as T
  }

  const world = (worldId: string): string => `/api/worlds/${seg(worldId)}`

  return {
    async login(username, password) {
      return (
        await request<{ account: PublicAccount }>('POST', '/api/login', { username, password })
      ).account
    },
    async register(input) {
      return (await request<{ account: PublicAccount }>('POST', '/api/register', input)).account
    },
    async logout() {
      await request('POST', '/api/logout')
    },
    async demoLogin() {
      return (await request<{ account: PublicAccount }>('POST', '/api/demo-login')).account
    },
    async previewInvitation(token) {
      return request<InvitationPreview>('GET', `/api/invitations/${seg(token)}`)
    },
    async acceptInvitation(token) {
      return (
        await request<{ world: { worldName: string; worldSlug: string } }>(
          'POST',
          `/api/invitations/${seg(token)}/accept`,
        )
      ).world
    },
    async me() {
      return (await request<{ account: PublicAccount }>('GET', '/api/me')).account
    },
    async getConfig() {
      return request<PublicConfig>('GET', '/api/config')
    },
    async requestPasswordReset(identifier) {
      await request('POST', '/api/password-reset/request', { identifier })
    },
    async confirmPasswordReset(token, newPassword) {
      await request('POST', '/api/password-reset/confirm', { token, newPassword })
    },

    async changePassword(currentPassword, newPassword) {
      await request('POST', '/api/account/password', { currentPassword, newPassword })
    },
    async changeUsername(username) {
      return (
        await request<{ account: PublicAccount }>('POST', '/api/account/username', { username })
      ).account
    },
    async listSessions() {
      return (await request<{ sessions: SessionSummary[] }>('GET', '/api/account/sessions'))
        .sessions
    },
    async revokeOtherSessions() {
      await request('POST', '/api/account/sessions/revoke-all')
    },
    async accountStatus() {
      return request<AccountStatus>('GET', '/api/account/status')
    },
    async resendVerification() {
      await request('POST', '/api/account/verification/resend')
    },
    async verifyEmail(token) {
      await request('POST', '/api/verify-email', { token })
    },
    async deletionBlockers() {
      return (await request<{ worlds: BlockingWorld[] }>('GET', '/api/account/deletion-blockers'))
        .worlds
    },
    async deleteAccount(password) {
      await request('DELETE', '/api/account', { password })
    },

    async listWorlds() {
      return (await request<{ worlds: WorldView[] }>('GET', '/api/worlds')).worlds
    },
    async createWorld(name) {
      return (await request<{ world: WorldView }>('POST', '/api/worlds', { name })).world
    },
    async getWorld(worldId) {
      return (await request<{ world: WorldView }>('GET', world(worldId))).world
    },
    async renameWorld(worldId, name) {
      return (await request<{ world: WorldView }>('PATCH', world(worldId), { name })).world
    },
    async deleteWorld(worldId) {
      await request('DELETE', world(worldId))
    },
    async listMembers(worldId) {
      return (await request<{ members: MemberView[] }>('GET', `${world(worldId)}/members`)).members
    },
    async grantMember(worldId, accountId) {
      await request('POST', `${world(worldId)}/members`, { accountId })
    },
    async revokeMember(worldId, accountId) {
      await request('DELETE', `${world(worldId)}/members/${seg(accountId)}`)
    },
    async createInvitation(worldId, username) {
      // Conditional spread, not `{ username }` — exactOptionalPropertyTypes is
      // on, and an explicit `username: undefined` would serialise as a key the
      // server's optional-string schema would then have to tolerate.
      return request<CreatedInvitation>('POST', `${world(worldId)}/invitations`, {
        ...(username ? { username } : {}),
      })
    },
    async listInvitations(worldId) {
      return (
        await request<{ invitations: InvitationView[] }>('GET', `${world(worldId)}/invitations`)
      ).invitations
    },
    async revokeInvitation(worldId, invitationId) {
      await request('DELETE', `${world(worldId)}/invitations/${seg(invitationId)}`)
    },
    async leaveWorld(worldId) {
      await request('POST', `${world(worldId)}/leave`)
    },
    async getPendingTransfer(worldId) {
      return (
        await request<{ pending: PendingTransfer | null }>('GET', `${world(worldId)}/transfer`)
      ).pending
    },
    async offerOwnership(worldId, accountId) {
      await request('POST', `${world(worldId)}/transfer`, { accountId })
    },
    async cancelOwnershipOffer(worldId) {
      await request('DELETE', `${world(worldId)}/transfer`)
    },
    async acceptOwnership(worldId) {
      await request('POST', `${world(worldId)}/transfer/accept`)
    },
    async lookupAccount(worldId, username) {
      return (
        await request<{ account: PublicAccount | null }>(
          'GET',
          `${world(worldId)}/account-lookup?username=${seg(username)}`,
        )
      ).account
    },

    async listEntities(worldId, kind) {
      return (
        await request<{ entities: Entity[] }>('GET', `${world(worldId)}/entities/${seg(kind)}`)
      ).entities
    },
    async createEntity(worldId, kind, input) {
      return (
        await request<{ entity: Entity }>('POST', `${world(worldId)}/entities/${seg(kind)}`, input)
      ).entity
    },
    async getEntity(worldId, kind, id) {
      return (
        await request<{ entity: Entity }>(
          'GET',
          `${world(worldId)}/entities/${seg(kind)}/${seg(id)}`,
        )
      ).entity
    },
    async updateEntity(worldId, kind, id, patch) {
      return (
        await request<{ entity: Entity }>(
          'PATCH',
          `${world(worldId)}/entities/${seg(kind)}/${seg(id)}`,
          patch,
        )
      ).entity
    },
    async changeEntityKind(worldId, kind, id, toKind) {
      return (
        await request<{ entity: Entity }>(
          'POST',
          `${world(worldId)}/entities/${seg(kind)}/${seg(id)}/change-kind`,
          { toKind },
        )
      ).entity
    },
    async deleteEntity(worldId, kind, id) {
      await request('DELETE', `${world(worldId)}/entities/${seg(kind)}/${seg(id)}`)
    },

    async listTrash(worldId) {
      return (await request<{ entries: TrashEntry[] }>('GET', `${world(worldId)}/trash`)).entries
    },
    async restoreTrashed(worldId, kind, id) {
      await request('POST', `${world(worldId)}/trash/${seg(kind)}/${seg(id)}/restore`)
    },
    async purgeTrashed(worldId, kind, id) {
      await request('DELETE', `${world(worldId)}/trash/${seg(kind)}/${seg(id)}`)
    },

    async listEntityGrants(worldId, kind, id) {
      return (
        await request<{ accountIds: string[] }>(
          'GET',
          `${world(worldId)}/entities/${seg(kind)}/${seg(id)}/grants`,
        )
      ).accountIds
    },
    async grantEntityAccess(worldId, kind, id, accountId) {
      // 204, so there is no body to unwrap — `request` would choke on the parse.
      await requestNoContent('POST', `${world(worldId)}/entities/${seg(kind)}/${seg(id)}/grants`, {
        accountId,
      })
    },
    async revokeEntityAccess(worldId, kind, id, accountId) {
      await requestNoContent(
        'DELETE',
        `${world(worldId)}/entities/${seg(kind)}/${seg(id)}/grants/${seg(accountId)}`,
      )
    },

    async listPassages(worldId, kind, id) {
      return (
        await request<{ passages: Passage[] }>(
          'GET',
          `${world(worldId)}/entities/${seg(kind)}/${seg(id)}/passages`,
        )
      ).passages
    },
    async createPassage(worldId, kind, id, input) {
      return (
        await request<{ passage: Passage }>(
          'POST',
          `${world(worldId)}/entities/${seg(kind)}/${seg(id)}/passages`,
          input,
        )
      ).passage
    },
    async updatePassage(worldId, passageId, patch) {
      return (
        await request<{ passage: Passage }>(
          'PATCH',
          `${world(worldId)}/passages/${seg(passageId)}`,
          patch,
        )
      ).passage
    },
    async deletePassage(worldId, passageId) {
      await request<{ ok: true }>('DELETE', `${world(worldId)}/passages/${seg(passageId)}`)
    },
    async proposePassage(worldId, kind, id, body) {
      return (
        await request<{ passage: Passage }>(
          'POST',
          `${world(worldId)}/entities/${seg(kind)}/${seg(id)}/propose`,
          { body },
        )
      ).passage
    },
    async acceptPassage(worldId, passageId, visibility) {
      return (
        await request<{ passage: Passage }>(
          'POST',
          `${world(worldId)}/passages/${seg(passageId)}/accept`,
          { visibility },
        )
      ).passage
    },
    async rejectPassage(worldId, passageId) {
      await request<{ ok: true }>('POST', `${world(worldId)}/passages/${seg(passageId)}/reject`)
    },
    async listPassageGrants(worldId, passageId) {
      return (
        await request<{ accountIds: string[] }>(
          'GET',
          `${world(worldId)}/passages/${seg(passageId)}/grants`,
        )
      ).accountIds
    },
    async grantPassageAccess(worldId, passageId, accountId) {
      await requestNoContent('POST', `${world(worldId)}/passages/${seg(passageId)}/grants`, {
        accountId,
      })
    },
    async revokePassageAccess(worldId, passageId, accountId) {
      await requestNoContent(
        'DELETE',
        `${world(worldId)}/passages/${seg(passageId)}/grants/${seg(accountId)}`,
      )
    },

    async listWiki(worldId) {
      return (await request<{ entries: WikiEntry[] }>('GET', `${world(worldId)}/wiki`)).entries
    },
    async getGraph(worldId) {
      return (await request<{ graph: EntityGraph }>('GET', `${world(worldId)}/graph`)).graph
    },
    async listEntitySessions(worldId, kind, id) {
      return (
        await request<{ sessions: EntitySession[] }>(
          'GET',
          `${world(worldId)}/entities/${seg(kind)}/${seg(id)}/sessions`,
        )
      ).sessions
    },
    async listEntityMedia(worldId, kind, id) {
      return (
        await request<{ media: MediaAttachment[] }>(
          'GET',
          `${world(worldId)}/entities/${seg(kind)}/${seg(id)}/media`,
        )
      ).media
    },
    async uploadEntityMedia(worldId, kind, id, file, thumbnail) {
      const media = await sendBytes<{ media: MediaAttachment }>(
        `${world(worldId)}/entities/${seg(kind)}/${seg(id)}/media?filename=${seg(file.name)}`,
        file,
      )
      if (!thumbnail) return media.media
      // A second call, deliberately: packing two files into one body means
      // hand-rolling framing. If it fails, the attachment is already real and
      // simply has no preview — so the failure is swallowed rather than losing
      // the upload the user actually asked for.
      const withThumb = await sendBytes<{ media: MediaAttachment }>(
        `${world(worldId)}/media/${seg(media.media.id)}/thumbnail`,
        thumbnail,
      ).catch(() => null)
      // The thumbnail call returns the UPDATED row, so prefer it; a null means
      // it failed and the attachment stands without a preview.
      return withThumb ? withThumb.media : media.media
    },
    async deleteMedia(worldId, id) {
      await request('DELETE', `${world(worldId)}/media/${seg(id)}`)
    },
    mediaRawUrl(worldId, id) {
      return `${baseUrl}${world(worldId)}/media/${seg(id)}/raw`
    },
    mediaThumbnailUrl(worldId, id) {
      return `${baseUrl}${world(worldId)}/media/${seg(id)}/raw?variant=thumbnail`
    },

    async listMaps(worldId) {
      return (await request<{ maps: WorldMap[] }>('GET', `${world(worldId)}/maps`)).maps
    },
    async getMap(worldId, id) {
      return await request<MapWithImage>('GET', `${world(worldId)}/maps/${seg(id)}`)
    },
    async createMap(worldId, input) {
      return (await request<{ map: WorldMap }>('POST', `${world(worldId)}/maps`, input)).map
    },
    async updateMap(worldId, id, patch) {
      return (await request<{ map: WorldMap }>('PATCH', `${world(worldId)}/maps/${seg(id)}`, patch))
        .map
    },
    async listMapGrants(worldId, mapId) {
      return (
        await request<{ accountIds: string[] }>(
          'GET',
          `${world(worldId)}/maps/${seg(mapId)}/grants`,
        )
      ).accountIds
    },
    async grantMapAccess(worldId, mapId, accountId) {
      await requestNoContent('POST', `${world(worldId)}/maps/${seg(mapId)}/grants`, { accountId })
    },
    async revokeMapAccess(worldId, mapId, accountId) {
      await requestNoContent(
        'DELETE',
        `${world(worldId)}/maps/${seg(mapId)}/grants/${seg(accountId)}`,
      )
    },
    async deleteMap(worldId, id) {
      await request('DELETE', `${world(worldId)}/maps/${seg(id)}`)
    },
    async uploadMapImage(worldId, id, file, thumbnail) {
      const res = await sendBytes<{
        media: MediaAttachment
        sourceWidth: number
        sourceHeight: number
      }>(`${world(worldId)}/maps/${seg(id)}/image?filename=${seg(file.name)}`, file)
      if (thumbnail) {
        await sendBytes(`${world(worldId)}/media/${seg(res.media.id)}/thumbnail`, thumbnail).catch(
          () => null,
        )
      }
      return { sourceWidth: res.sourceWidth, sourceHeight: res.sourceHeight }
    },

    async listPins(worldId, mapId) {
      return (await request<{ pins: MapPin[] }>('GET', `${world(worldId)}/maps/${seg(mapId)}/pins`))
        .pins
    },
    async createPin(worldId, mapId, input) {
      return (
        await request<{ pin: MapPin }>('POST', `${world(worldId)}/maps/${seg(mapId)}/pins`, input)
      ).pin
    },
    async updatePin(worldId, mapId, id, patch) {
      return (
        await request<{ pin: MapPin }>(
          'PATCH',
          `${world(worldId)}/maps/${seg(mapId)}/pins/${seg(id)}`,
          patch,
        )
      ).pin
    },
    async deletePin(worldId, mapId, id) {
      await request('DELETE', `${world(worldId)}/maps/${seg(mapId)}/pins/${seg(id)}`)
    },
    async listRelationships(worldId, kind, id) {
      return (
        await request<{ relationships: EntityRelationship[] }>(
          'GET',
          `${world(worldId)}/entities/${seg(kind)}/${seg(id)}/relationships`,
        )
      ).relationships
    },
    async createRelationship(worldId, kind, id, input) {
      return (
        await request<{ relationship: EntityRelationship }>(
          'POST',
          `${world(worldId)}/entities/${seg(kind)}/${seg(id)}/relationships`,
          input,
        )
      ).relationship
    },
    async deleteRelationship(worldId, id) {
      await request('DELETE', `${world(worldId)}/relationships/${seg(id)}`)
    },
    async listEntityMaps(worldId, kind, id) {
      return (
        await request<{ maps: MapReference[] }>(
          'GET',
          `${world(worldId)}/entities/${seg(kind)}/${seg(id)}/maps`,
        )
      ).maps
    },
    async listTouches(worldId, sessionId) {
      return (
        await request<{ touches: Touch[] }>(
          'GET',
          `${world(worldId)}/sessions/${seg(sessionId)}/touches`,
        )
      ).touches
    },
    async createTouch(worldId, sessionId, input) {
      return (
        await request<{ touch: Touch }>(
          'POST',
          `${world(worldId)}/sessions/${seg(sessionId)}/touches`,
          input,
        )
      ).touch
    },
    async deleteTouch(worldId, sessionId, id) {
      await request('DELETE', `${world(worldId)}/sessions/${seg(sessionId)}/touches/${seg(id)}`)
    },

    async listNotes(worldId) {
      return (await request<{ notes: PlayerNote[] }>('GET', `${world(worldId)}/notes`)).notes
    },
    async createNote(worldId, body) {
      return (await request<{ note: PlayerNote }>('POST', `${world(worldId)}/notes`, { body })).note
    },
    async updateNote(worldId, id, body) {
      return (
        await request<{ note: PlayerNote }>('PATCH', `${world(worldId)}/notes/${seg(id)}`, { body })
      ).note
    },
    async deleteNote(worldId, id) {
      await request('DELETE', `${world(worldId)}/notes/${seg(id)}`)
    },

    async listCharacters(worldId) {
      return (
        await request<{ characters: PlayerCharacter[] }>('GET', `${world(worldId)}/characters`)
      ).characters
    },
    async createCharacter(worldId, input) {
      return (
        await request<{ character: PlayerCharacter }>('POST', `${world(worldId)}/characters`, input)
      ).character
    },
    async updateCharacter(worldId, id, patch) {
      return (
        await request<{ character: PlayerCharacter }>(
          'PATCH',
          `${world(worldId)}/characters/${seg(id)}`,
          patch,
        )
      ).character
    },
    async deleteCharacter(worldId, id) {
      await request('DELETE', `${world(worldId)}/characters/${seg(id)}`)
    },

    async listSuggestions(worldId) {
      return (await request<{ suggestions: Suggestion[] }>('GET', `${world(worldId)}/suggestions`))
        .suggestions
    },
    async proposeSuggestion(worldId, input) {
      return (
        await request<{ suggestion: Suggestion }>('POST', `${world(worldId)}/suggestions`, input)
      ).suggestion
    },
    async acceptSuggestion(worldId, id) {
      return (
        await request<{ suggestion: Suggestion }>(
          'POST',
          `${world(worldId)}/suggestions/${seg(id)}/accept`,
        )
      ).suggestion
    },
    async rejectSuggestion(worldId, id) {
      return (
        await request<{ suggestion: Suggestion }>(
          'POST',
          `${world(worldId)}/suggestions/${seg(id)}/reject`,
        )
      ).suggestion
    },

    async exportWorld(worldId) {
      return request<WorldExport>('GET', `${world(worldId)}/export`)
    },
    async importWorld(name, data) {
      return request<ImportResult>('POST', '/api/worlds/import', { name, data })
    },
  }
}
