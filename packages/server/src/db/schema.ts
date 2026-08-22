import type { MediaKind, Visibility } from '@campaign-settings/shared'
import type { ColumnType, Generated } from 'kysely'

/**
 * Typed mirror of the Postgres schema (the migrations are the source of truth;
 * this interface must track them). Since migration 0005 the 16 content "kinds"
 * share ONE base table `entities` (carrying a `kind` discriminator + the columns
 * every kind shares) with a slim `<kind>_details` table per kind that has extra
 * columns (keyed 1:1 by `entity_id`; `location`/`organization`/`item` have none).
 * `sessions` and `maps` stay bespoke tables. The net-new tables (accounts,
 * auth_sessions, worlds, world_members, entity_visibility + player_notes/
 * characters/suggestions) support hosted auth and the web player surface.
 */

/** jsonb object defaulting to `{}` — optional on insert. */
type JsonObject = ColumnType<
  Record<string, unknown>,
  Record<string, unknown> | undefined,
  Record<string, unknown>
>

/** jsonb array defaulting to `[]` — optional on insert. */
type JsonArray = ColumnType<unknown[], unknown[] | undefined, unknown[]>

/** nullable jsonb (imported_metadata) — optional on insert. */
type NullableJson = ColumnType<
  Record<string, unknown> | null,
  Record<string, unknown> | null | undefined,
  Record<string, unknown> | null
>

/** nullable text — optional on insert. */
type NullableText = ColumnType<string | null, string | null | undefined, string | null>

/** required non-defaulted timestamptz — accepts Date or ISO string on insert. */
type Timestamp = ColumnType<Date, Date | string, Date | string>

/** nullable timestamptz — optional on insert. */
type NullableTimestamp = ColumnType<
  Date | null,
  Date | string | null | undefined,
  Date | string | null
>

/** bigint — pg returns int8 as string; accepts number or string on insert. */
type BigIntColumn = ColumnType<string, string | number, string | number>

// ── enums (mirror the SQL CHECK constraints) ───────────────────────────────
export type MemberRole = 'owner' | 'player'
export type SuggestionStatus = 'pending' | 'accepted' | 'rejected'
/** A passage is either part of the world, or a player's proposal awaiting review. */
export type PassageStatus = 'published' | 'proposed'
export type CalendarKind = 'gregorian' | 'custom'
// `CultureLanguageRole` / `EntityLanguageRole` lived here until 0017 folded the
// four `*_languages` junctions into `entity_relationships`. Their union is now
// `LANGUAGE_ROLES` in `packages/shared`, which is where a vocabulary the SPA also
// renders belongs — and `entity_relationships.qualifier` has no CHECK for the
// same reason `type` has none (see 0014), so there is no SQL constraint here to
// mirror any more.

// ── net-new auth / tenancy ─────────────────────────────────────────────────
export interface AccountsTable {
  id: string
  username: string
  password_hash: string
  /** Optional contact channel (0006) — nullable so pre-0006 CLI accounts stay valid. */
  email: NullableText
  /**
   * When the address on this account was proven (0013). NULL = unverified,
   * which includes every CLI-minted account that has no email at all. Gates
   * world creation and invitation, never login.
   */
  email_verified_at: Timestamp | null
  created_at: Generated<Date>
}

export interface AuthSessionsTable {
  id: string
  account_id: string
  expires_at: Timestamp
  created_at: Generated<Date>
  /** Refreshed (throttled) on authenticated requests so the session list can show recency (0008). */
  last_seen_at: Generated<Date>
  /** Coarse DERIVED device string ("Firefox on Linux"), never the raw User-Agent (0008). */
  device_label: NullableText
}

/** Stored invitation states (0010). `expired` is DERIVED from expires_at, never stored. */
export type InvitationStatus = 'pending' | 'accepted' | 'revoked'

/**
 * World invitations (0010). Only the token HASH is stored. A null
 * `invitee_account_id` means an open shareable link; a set one means only that
 * account may accept. `role` is CHECK-pinned to 'player'.
 */
/** Single-use, expiring, hash-at-rest email-verification tokens (0013). */
export interface EmailVerificationTokensTable {
  id: string
  account_id: string
  token_hash: string
  expires_at: Timestamp
  consumed_at: Timestamp | null
  created_at: Generated<Date>
}

export interface WorldInvitationsTable {
  id: string
  world_id: string
  invited_by: string
  invitee_account_id: NullableText
  token_hash: string
  role: MemberRole
  status: InvitationStatus
  expires_at: Timestamp
  accepted_at: NullableTimestamp
  created_at: Generated<Date>
}

/**
 * One-time password-reset tokens (0007). Only the SHA-256 hash of the token is
 * stored; `consumed_at` marks single-use; expiry is checked against the request
 * clock by the consumer.
 */
export interface PasswordResetTokensTable {
  id: string
  account_id: string
  token_hash: string
  expires_at: Timestamp
  consumed_at: NullableTimestamp
  created_at: Generated<Date>
}

export interface WorldsTable {
  id: string
  owner_id: string
  name: string
  /** URL key — unique, derived from name on creation (see 0003_world_slug). */
  slug: string
  /**
   * The member the current owner has OFFERED the world to (0011). An offer, not
   * a transfer: nothing moves until that account accepts. Null means no offer
   * outstanding, which is every world's normal state.
   */
  pending_owner_id: NullableText
  created_at: Generated<Date>
}

export interface WorldMembersTable {
  world_id: string
  account_id: string
  role: MemberRole
  created_at: Generated<Date>
}

/**
 * Per-player grants for `restricted` content rows: a player sees a restricted
 * entity only if they hold a matching grant. Keyed by (world, entity id,
 * account) — the entity id alone identifies the entity since 0005 (its kind
 * lives on `entities.kind`). Owner-managed; consulted by the authorization seam.
 */
export interface EntityVisibilityTable {
  world_id: string
  entity_id: string
  account_id: string
  created_at: Generated<Date>
}

/**
 * A chunk of an entity's prose with its OWN visibility, so a DM can reveal in
 * stages (0015). What a viewer reads is the entity's base `description` plus
 * the passages they may see — `description` is unchanged and still the
 * always-visible layer.
 *
 * Carries id/world_id/visibility/deleted_at, which is exactly what
 * `ContentTableName` tests for, so the authorization seam covers it with no
 * per-table code. Its grants live in `passage_visibility`, not
 * `entity_visibility`, which is why the seam takes the ACL as a parameter.
 */
export interface EntityPassagesTable {
  id: string
  world_id: string
  entity_id: string
  /** Who wrote it. Null once that account is deleted — the prose outlives them. */
  author_id: NullableText
  body: Generated<string>
  /** Render order within the entity; ties break on created_at. */
  position: Generated<number>
  status: Generated<PassageStatus>
  /** Defaults to `dm_only` — a passage exists to withhold something. */
  visibility: Generated<Visibility>
  created_at: Generated<Date>
  updated_at: Generated<Date>
  deleted_at: NullableTimestamp
}

/**
 * Per-player grants for `restricted` MAPS (0016) — the map-side twin of
 * `entity_visibility`, read by the same seam through its `grantTable` option.
 * A map lives in its own table, so a grant naming one cannot live in
 * `entity_visibility`, whose `entity_id` is foreign-keyed to `entities`.
 */
export interface MapVisibilityTable {
  world_id: string
  map_id: string
  account_id: string
  created_at: Generated<Date>
}

/**
 * Per-player grants for `restricted` passages — the passage-side twin of
 * `entity_visibility`, consulted by the same seam via its `grantTable` option.
 * A player-proposed passage uses exactly one of these rows to scope itself to
 * its author, which is why proposals need no exception in `visible()`.
 */
export interface PassageVisibilityTable {
  world_id: string
  passage_id: string
  account_id: string
  created_at: Generated<Date>
}

// ── the entity base table + per-kind detail tables (0005) ───────────────────
/**
 * The shared base for all 16 content kinds. `kind` is the discriminator; the
 * kind-specific columns live in the matching `<kind>_details` table.
 */
export interface EntitiesTable {
  id: string
  world_id: string
  kind: string
  name: string
  description: Generated<string>
  visibility: Generated<Visibility>
  imported_metadata: NullableJson
  created_at: Generated<Date>
  updated_at: Generated<Date>
  deleted_at: NullableTimestamp
}

/** Common columns on every detail table: 1:1 with entities + denormalized world_id. */
interface DetailBase {
  entity_id: string
  world_id: string
}

export interface SpeciesDetailsTable extends DetailBase {
  kingdom: Generated<string>
  elemental_alignment: NullableText
  is_corporeal: Generated<boolean>
  is_sentient: Generated<boolean>
}

export interface CultureDetailsTable extends DetailBase {
  dominant_values: Generated<string>
  historical_period: Generated<string>
  aesthetic_notes: Generated<string>
}

export interface PantheonDetailsTable extends DetailBase {
  tradition: Generated<string>
  historical_period: Generated<string>
}

export interface LanguageDetailsTable extends DetailBase {
  family: Generated<string>
  is_trade_language: Generated<boolean>
  writing_system: Generated<string>
}

export interface MagicSystemDetailsTable extends DetailBase {
  source_kind: Generated<string>
  cost_summary: Generated<string>
  alignment: Generated<string>
  is_taught: Generated<boolean>
  requires_materials: Generated<boolean>
}

export interface CurrencyDetailsTable extends DetailBase {
  symbol: Generated<string>
  denominations: JsonArray
  base_rate_to: string | null
  rate: number | null
}

export interface DeityDetailsTable extends DetailBase {
  domain: Generated<string>
  worship_status: Generated<string>
  pantheon_id: string | null
}

export interface ResourceDetailsTable extends DetailBase {
  resource_kind: Generated<string>
  scarcity: Generated<string>
  commercial_value: Generated<string>
}

export interface EventDetailsTable extends DetailBase {
  occurred_at: NullableText // freeform in-world date ('years ago'), not a timestamp
}

export interface LoreArticleDetailsTable extends DetailBase {
  /** The lore article sub-type (renamed from `kind` in 0005 to dodge `entities.kind`). */
  article_kind: NullableText
}

export interface NpcDetailsTable extends DetailBase {
  species_id: string | null
  culture_id: string | null
  occupation: Generated<string>
}

export interface PcDetailsTable extends DetailBase {
  species_id: string | null
  /**
   * The account that PLAYS this character, set by the world owner. Nullable —
   * an unplayed PC page is ordinary, and ON DELETE SET NULL means a departing
   * account leaves the DM's write-up standing rather than taking it along. The
   * "must be a member of this world" half of the rule cannot live on the column
   * (see migration 0018); it is enforced on the write path.
   */
  account_id: string | null
}

export interface SettlementDetailsTable extends DetailBase {
  culture_id: string | null
  size: Generated<string>
  wealth: Generated<string>
  terrain: Generated<string>
  population: Generated<number>
}

// ── bespoke entity-shaped tables (not folded into `entities`) ───────────────
export interface MapsTable {
  id: string
  world_id: string
  name: string
  description: Generated<string>
  visibility: Generated<Visibility>
  image_path: NullableText
  thumbnail_path: NullableText
  source_width: number | null
  source_height: number | null
  imported_metadata: NullableJson
  created_at: Generated<Date>
  updated_at: Generated<Date>
  deleted_at: NullableTimestamp
}

export interface CalendarsTable {
  id: string
  world_id: string
  name: string
  kind: CalendarKind
  config: JsonObject
  is_active: Generated<boolean>
  is_user_defined: Generated<boolean>
  created_at: Generated<Date>
  updated_at: Generated<Date>
}

export interface SessionsTable {
  id: string
  world_id: string
  name: string
  played_at: NullableText // user-entered date text, stored freeform like dm-manager
  captured_text: Generated<string>
  visibility: Generated<Visibility>
  imported_metadata: NullableJson
  created_at: Generated<Date>
  updated_at: Generated<Date>
  deleted_at: NullableTimestamp
}

// ── currency attachments ───────────────────────────────────────────────────
// The nine per-kind junction tables that used to sit here were folded into
// `entity_relationships` by migration 0017 — see its docstring. The two
// currency-attachment tables below did NOT move: they carry `visibility` and
// `deleted_at`, so they are content rows on the seam rather than junctions, and
// folding them into a table with neither would have destroyed both.

export interface SettlementCurrencyAttachmentsTable {
  id: string
  world_id: string
  settlement_id: string
  currency_id: string
  is_primary: Generated<boolean>
  notes: Generated<string>
  visibility: Generated<Visibility>
  created_at: Generated<Date>
  updated_at: Generated<Date>
  deleted_at: NullableTimestamp
}

export interface OrganizationCurrencyAttachmentsTable {
  id: string
  world_id: string
  organization_id: string
  currency_id: string
  is_primary: Generated<boolean>
  notes: Generated<string>
  visibility: Generated<Visibility>
  created_at: Generated<Date>
  updated_at: Generated<Date>
  deleted_at: NullableTimestamp
}

// ── polymorphic (key off an entity id; since 0005 the kind is not stored here
//    for entity/touch/pin/suggestion — it lives on entities.kind) ────────────
export interface MapPinsTable {
  id: string
  world_id: string
  map_id: string
  entity_id: string
  x: number
  y: number
  label: NullableText
  created_at: Generated<Date>
  updated_at: Generated<Date>
  deleted_at: NullableTimestamp
}

/**
 * A typed, directional relationship between two entities — HOW they relate, as
 * opposed to the bracket mentions that only record THAT one refers to another.
 *
 * Deliberately NOT shaped like a content table: it carries no `visibility` and
 * no `deleted_at`, so it is not a `ContentTableName` and the seam does not serve
 * it directly. Its visibility is derived — a relationship is readable exactly
 * when BOTH endpoints are, which is a rule the seam cannot apply on a row's own
 * behalf and which `data/relationships.ts` applies explicitly.
 */
export interface EntityRelationshipsTable {
  id: string
  world_id: string
  from_id: string
  to_id: string
  /** A `RelationshipType` from `shared`; validated at the route, not by a CHECK. */
  type: string
  note: Generated<string>
  /**
   * A small controlled qualifier on the relation itself — today only a language
   * `role` (native / liturgical / trade), carried over by migration 0017 from
   * the junction tables it folded in. Distinct from `note`, which is prose: this
   * is meant to stay filterable.
   */
  qualifier: NullableText
  /**
   * Whether reconciliation owns this row (0021). `'authored'` — a GM typed it
   * through the relationship form, and no rewording of the prose may retire it.
   * `'bracket'` — a `[[link]]` in the entity's text produced it.
   */
  origin: Generated<string>
  /**
   * The passage whose text produced this row, or null for the base description
   * (0021). The row's audience is DERIVED from this passage at read time; the
   * passage's visibility is deliberately never copied here, so revealing a
   * reveal reveals its relationships with no second write.
   */
  source_passage_id: NullableText
  created_at: Generated<Date>
  updated_at: Generated<Date>
}

export interface EntityTouchesTable {
  id: string
  world_id: string
  session_id: string
  entity_id: string
  touch_type: string
  narrative_delta: Generated<string>
  created_at: Generated<Date>
  updated_at: Generated<Date>
  deleted_at: NullableTimestamp
}

/**
 * Media owners span entities ∪ sessions, so this table KEEPS its own
 * `owner_kind` discriminator (a single FK can't target two tables). owner_id is
 * still globally unique.
 */
export interface MediaAttachmentsTable {
  id: string
  world_id: string
  owner_kind: string
  owner_id: string
  media_kind: MediaKind
  file_path: string
  thumbnail_path: NullableText
  original_filename: string
  mime_type: string
  byte_size: BigIntColumn
  /**
   * THE image for this owner — the one the page renders as an avatar (0020).
   * At most one per `(world_id, owner_kind, owner_id)`, held by a partial
   * unique index rather than by the write path, so it binds the importer too.
   */
  is_primary: Generated<boolean>
  created_at: Generated<Date>
  updated_at: Generated<Date>
  deleted_at: NullableTimestamp
}

export interface DmToolkitMetaTable {
  world_id: string
  key: string
  value: string
}

// ── net-new player surface ─────────────────────────────────────────────────
export interface PlayerNotesTable {
  id: string
  world_id: string
  author_id: string
  body: string
  created_at: Generated<Date>
  updated_at: Generated<Date>
}

export interface SuggestionsTable {
  id: string
  world_id: string
  author_id: string
  target_entity_id: string | null
  proposed: Record<string, unknown>
  status: Generated<SuggestionStatus>
  created_at: Generated<Date>
}

export interface Database {
  accounts: AccountsTable
  auth_sessions: AuthSessionsTable
  password_reset_tokens: PasswordResetTokensTable
  email_verification_tokens: EmailVerificationTokensTable
  world_invitations: WorldInvitationsTable
  worlds: WorldsTable
  world_members: WorldMembersTable
  entity_visibility: EntityVisibilityTable
  entities: EntitiesTable
  species_details: SpeciesDetailsTable
  culture_details: CultureDetailsTable
  pantheon_details: PantheonDetailsTable
  language_details: LanguageDetailsTable
  magic_system_details: MagicSystemDetailsTable
  currency_details: CurrencyDetailsTable
  deity_details: DeityDetailsTable
  resource_details: ResourceDetailsTable
  event_details: EventDetailsTable
  lore_article_details: LoreArticleDetailsTable
  npc_details: NpcDetailsTable
  pc_details: PcDetailsTable
  settlement_details: SettlementDetailsTable
  maps: MapsTable
  calendars: CalendarsTable
  sessions: SessionsTable
  settlement_currency_attachments: SettlementCurrencyAttachmentsTable
  organization_currency_attachments: OrganizationCurrencyAttachmentsTable
  map_pins: MapPinsTable
  entity_passages: EntityPassagesTable
  passage_visibility: PassageVisibilityTable
  map_visibility: MapVisibilityTable
  entity_relationships: EntityRelationshipsTable
  entity_touches: EntityTouchesTable
  media_attachments: MediaAttachmentsTable
  dm_toolkit_meta: DmToolkitMetaTable
  player_notes: PlayerNotesTable
  suggestions: SuggestionsTable
}
