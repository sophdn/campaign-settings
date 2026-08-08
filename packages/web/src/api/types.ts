/**
 * DTOs for the HTTP API, mirroring the server's JSON responses. Dates arrive as
 * ISO strings over the wire. Entities are per-kind rows, so the client treats
 * them as open records keyed by id.
 */
import type { MediaKind, Visibility } from '@campaign-settings/shared'

export interface PublicAccount {
  id: string
  username: string
}

/**
 * Runtime client config from `GET /api/config`: the feature flags the SPA
 * reflects. Mirrors the server's evaluated flags.
 */
export interface FeatureFlags {
  /** Public self-serve registration is open. */
  publicSignupEnabled: boolean
  /** The real login flow (off for the portfolio's read-only demo). */
  loginEnabled: boolean
  /** The forgot-password flow. */
  passwordResetEnabled: boolean
  /** Player-to-GM suggestions. */
  suggestionsEnabled: boolean
  /** Self-service account management: credentials, sessions, deletion. */
  accountManagementEnabled: boolean
  /** Demo mode: the shared, read-only auto-login principal. */
  demoModeEnabled: boolean
}

/**
 * The public runtime config from `GET /api/config`: feature flags plus the
 * deploy-configured contact address the SPA's contact modal links to.
 */
export interface PublicConfig {
  flags: FeatureFlags
  /** mailto address for the contact affordance. */
  contactEmail: string
}

/**
 * One live sign-in as `GET /api/account/sessions` returns it. Deliberately
 * carries NO session id — the id is the bearer credential, so the list is safe
 * to render. Timestamps arrive as ISO strings over JSON.
 */
export interface SessionSummary {
  createdAt: string
  lastSeenAt: string
  /** Coarse device label ("Firefox on Linux"), or null if the client sent nothing usable. */
  deviceLabel: string | null
  /** True for the session viewing the page. */
  current: boolean
}

/** What `GET /api/invitations/:token` reveals about a live invitation. */
export interface InvitationPreview {
  world: { name: string; slug: string }
  /** True when the invitation is aimed at one account — it does NOT say which. */
  targeted: boolean
}

export type MemberRole = 'owner' | 'player'

/**
 * One member of a world, as `GET /api/worlds/:worldId/members` returns them —
 * owner first, then players alphabetically. Carries no email by design.
 */
export interface MemberView {
  accountId: string
  username: string
  role: MemberRole
  /** ISO timestamp of when they joined. */
  joinedAt: string
}

/**
 * An outstanding ownership offer for a world: the member it names. An offer,
 * not a transfer — nothing moves until that account accepts it.
 */
export interface PendingTransfer {
  accountId: string
  username: string
}

/** The resource ceilings in force, as `GET /api/account/status` reports them. */
export interface ResourceLimits {
  worldsPerAccount: number
  entitiesPerWorld: number
  mediaBytesPerWorld: number
}

/**
 * Verification state and the limits, so the SPA can show a ceiling BEFORE the
 * user runs into it rather than only when a create is refused.
 */
export interface AccountStatus {
  /** False only when there is an address on the account that has not been proven. */
  emailVerified: boolean
  limits: ResourceLimits
  usage: { worlds: number }
}

/** A world the account owns, blocking account deletion until it is resolved. */
export interface BlockingWorld {
  id: string
  name: string
  slug: string
}

/** The lifecycle of an invitation. `expired` is derived server-side, never stored. */
export type InvitationStatus = 'pending' | 'accepted' | 'revoked' | 'expired'

/**
 * An invitation as the owner sees it in the list. The raw token is absent on
 * purpose — it is returned exactly once at creation and only its hash is kept,
 * so a listing can never re-show a link that was not copied at the time.
 */
export interface InvitationView {
  id: string
  status: InvitationStatus
  /** Username this was aimed at, or null for an open shareable link. */
  invitee: string | null
  createdAt: string
  expiresAt: string
  acceptedAt: string | null
}

/** What creating an invitation returns — the ONLY time the raw token exists. */
export interface CreatedInvitation {
  id: string
  token: string
}

export interface WorldView {
  id: string
  name: string
  /** Unique, human-readable URL key derived from the name — used in routes. */
  slug: string
  ownerId: string
  role: MemberRole
}

export type Entity = { id: string } & Record<string, unknown>

/** A passage is either part of the world, or a player's proposal awaiting review. */
export type PassageStatus = 'published' | 'proposed'

/**
 * A chunk of an entity's prose with its OWN visibility, so a DM can reveal in
 * stages. What a reader sees is the entity's `body` — its base `description`
 * plus the passages they may see, composed by the SERVER. These rows come back
 * already filtered: a player never receives one they cannot read.
 */
export interface Passage {
  id: string
  entity_id: string
  /** Null once the account that wrote it is deleted; the prose outlives them. */
  author_id: string | null
  body: string
  position: number
  status: PassageStatus
  visibility: Visibility
}

export interface GraphNode {
  kind: string
  id: string
  name: string
}

export type GraphEdgeType = 'description' | 'touch' | 'bracket'

export interface GraphEdge {
  from: { kind: string; id: string }
  to: { kind: string; id: string }
  type: GraphEdgeType
}

export type TouchType = 'met' | 'affected' | 'killed' | 'discussed' | 'other'

/** The closed touch-type vocabulary, for the interaction-type picker. */
export const TOUCH_TYPES: readonly TouchType[] = ['met', 'affected', 'killed', 'discussed', 'other']

export interface Touch {
  id: string
  world_id: string
  session_id: string
  entity_id: string
  touch_type: TouchType
  narrative_delta: string
  created_at: string
  updated_at: string
}

/**
 * An image attached to an entity or a map. Bytes served at its raw URL.
 *
 * `media_kind` is the closed `MediaKind` set, not free text: every attachment is
 * a raster image, and the value says what it is FOR. See `MEDIA_KINDS` for why
 * the vocabulary is closed and what reopening it would take.
 */
export interface MediaAttachment {
  id: string
  world_id: string
  owner_kind: string
  owner_id: string
  media_kind: MediaKind
  original_filename: string
  mime_type: string
  byte_size: string
  /** Null until a thumbnail is attached; the raw route falls back to the source. */
  thumbnail_path: string | null
  created_at: string
}

/**
 * A world-level map. `source_width`/`source_height` are the uploaded image's
 * pixel dimensions, read from its header server-side — the viewer needs them to
 * fit the image, and a pin's normalized coordinate has nothing to be normalized
 * against without them. Null until an image is uploaded.
 */
export interface WorldMap {
  id: string
  world_id: string
  name: string
  description: string
  /** All three states since 0016 — maps carry their own grant ACL. */
  visibility: Visibility
  source_width: number | null
  source_height: number | null
  created_at: string
}

/** A map with the image it currently displays, if any. */
export interface MapWithImage {
  map: WorldMap
  image: MediaAttachment | null
}

/**
 * A marker on a map naming an entity. `x`/`y` are fractions of the source image
 * (0..1), so a pin renders correctly at any zoom or scroll offset.
 *
 * A pin only ever arrives with a `target` the viewer is allowed to see — the
 * server drops the pin whole, label included, when they are not.
 */
export interface MapPin {
  id: string
  map_id: string
  entity_id: string
  x: number
  y: number
  label: string | null
  target: { kind: string; id: string; name: string }
}

/**
 * A typed relationship as ONE entity's page reads it.
 *
 * The server stores a single directional row and renders it from whichever end
 * is being viewed: `label` is already inverted when `outgoing` is false, so the
 * two pages cannot describe the same relation differently.
 *
 * `other` is always an entity the viewer may see — a relationship whose far end
 * is hidden is dropped whole server-side, never sent with the name blanked.
 */
export interface EntityRelationship {
  id: string
  type: string
  /** How it reads from the entity being viewed. */
  label: string
  /** True when the viewed entity is the stored row's `from`. */
  outgoing: boolean
  note: string
  other: { kind: string; id: string; name: string }
}

/** A map an entity is pinned on — the entity page's reverse lookup. */
export interface MapReference {
  mapId: string
  mapName: string
  pinId: string
  label: string | null
}

/** One session in an entity's history + how it references the entity. */
export interface EntitySession {
  id: string
  name: string
  played_at: string | null
  link: 'touch' | 'bracket'
}

export interface EntityGraph {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

/** A wiki-index row: an authorized entity reduced to kind + id + name. */
export interface WikiEntry {
  kind: string
  id: string
  name: string
}

export interface PlayerNote {
  id: string
  world_id: string
  author_id: string
  body: string
  created_at: string
  updated_at: string
}

export interface PlayerCharacter {
  id: string
  world_id: string
  owner_id: string
  name: string
  data: Record<string, unknown>
  created_at: string
  updated_at: string
}

export type SuggestionStatus = 'pending' | 'accepted' | 'rejected'

export interface Suggestion {
  id: string
  world_id: string
  author_id: string
  target_entity_kind: string | null
  target_entity_id: string | null
  proposed: Record<string, unknown>
  status: SuggestionStatus
  created_at: string
}

/**
 * A soft-deleted row, as the trash lists it. `kind` is the registry kind for a
 * content entity and the table's own name for the bespoke `session`/`map`, so
 * one list covers all three tables and every row knows how to address itself.
 */
export interface TrashEntry {
  kind: string
  id: string
  name: string
  deleted_at: string
}

export interface WorldExport {
  version: number
  tables: Record<string, Record<string, unknown>[]>
}

export interface ImportResult {
  worldId: string
  /** URL key of the freshly-created world — route here after import. */
  slug: string
  counts: Record<string, number>
}
