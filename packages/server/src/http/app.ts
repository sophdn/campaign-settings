import { readFile } from 'node:fs/promises'
import { extname, join, relative, isAbsolute } from 'node:path'
import cookie from '@fastify/cookie'
import rateLimit from '@fastify/rate-limit'
import fastifyStatic from '@fastify/static'
import { IMAGE_MIME_TYPES, type MediaKind, RELATIONSHIP_TYPES } from '@campaign-settings/shared'
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import type { Kysely } from 'kysely'
import { ZodError, z } from 'zod'
import { assertWorldOwner } from '../authz/content'
import { resolveWorldContext } from '../authz/context'
import { getAccountByEmail, getAccountById, getAccountByUsername } from '../auth/accounts'
import { OwnsWorldsError } from '../auth/deletion'
import {
  DEFAULT_DEMO_USERNAME,
  demoAccountId,
  demoRequestAllowed,
  DemoReadOnlyError,
  sharedDemoSession,
} from '../auth/demo'
import {
  EmailNotVerifiedError,
  consumeVerificationToken,
  createVerificationToken,
  isVerificationOutstanding,
} from '../auth/verification'
import { type Mailer, createLoggingMailer } from '../auth/mailer'
import { MIN_PASSWORD_LENGTH } from '../auth/password'
import { consumeResetToken, createResetToken } from '../auth/reset-tokens'
import type { AuthService, PublicAccount, SessionMeta } from '../auth/types'
import { describeUserAgent } from '../auth/user-agent'
import {
  activateCalendar,
  createCalendar,
  deleteCalendar,
  getActiveCalendar,
  listCalendars,
  updateCalendar,
} from '../data/calendars'
import { changeEntityKind } from '../data/change-kind'
import { buildWorldDashboard } from '../data/dashboard'
import { reconcileBrackets } from '../data/relationship-reconcile'
import { CONTENT_REPOS, ENTITY_REPOS, type ContentRepoLike } from '../data/content-repos'
import {
  ATTACHMENT_VISIBILITIES,
  type AttachmentOwnerKind,
  attachCurrency,
  detachCurrency,
  isAttachmentOwnerKind,
  listAttachmentsForOwner,
  listOwnersOfCurrency,
  updateAttachment,
} from '../data/currency-attachments'
import { assertValidBaseRate } from '../data/currency-anchor'
import { assertLinkableAccount } from '../data/pc-account'
import type { WorldContext } from '../data/context'
import {
  createPin,
  deletePin,
  listMapsForEntity,
  listPinsForMap,
  updatePin,
} from '../data/map-pins'
import {
  getMapImage,
  grantMapVisibility,
  listMapGrants,
  MAP_MEDIA_KIND,
  revokeMapVisibility,
  setMapSourceDimensions,
} from '../data/maps'
import {
  createRelationship,
  deleteRelationship,
  listRelationshipsForEntity,
  updateRelationship,
} from '../data/relationships'
import {
  type ComposableEntity,
  acceptPassage,
  countPendingProposals,
  createPassage,
  deletePassage,
  getPassage,
  grantPassageVisibility,
  listPassageGrants,
  listPassagesForEntity,
  proposePassage,
  rejectPassage,
  revokePassageVisibility,
  updatePassage,
  withComposedBodies,
} from '../data/passages'
import {
  grantEntityVisibility,
  listEntityGrants,
  revokeEntityVisibility,
} from '../data/entity-visibility'
import { listTrash, purgeTrashed, restoreTrashed } from '../data/trash'
import {
  attachThumbnail,
  createMediaAttachment,
  deleteMediaAttachment,
  findPrimaryMedia,
  getMediaById,
  identifyImage,
  listMediaForOwner,
  type MediaAttachment,
  mediaFilePath,
  removeWorldMedia,
  resolveUploadsDir,
  setPrimaryMedia,
  UnsupportedImageError,
  writeMediaFile,
} from '../data/media'
import {
  createTouch,
  deleteTouch,
  listTouchesForSession,
  TOUCH_TYPES,
  type TouchType,
} from '../data/touches'
import { newId } from '../db/ids'
import type { Database } from '../db/schema'
import { loadFlags } from '../flags/config'
import { loadRateLimits, type RateLimits } from './rate-limits'
import type { FeatureFlags } from '../flags/registry'
import { createNote, deleteNote, listNotes, updateNote } from '../player-data'
import {
  acceptSuggestion,
  listSuggestions,
  proposeSuggestion,
  rejectSuggestion,
} from '../suggestions'
import { createTenancy } from '../tenancy'
import {
  countOwnedWorlds,
  type ResourceLimits,
  assertCanCreateEntity,
  assertCanCreatePassage,
  assertCanCreateWorld,
  assertCanProposePassage,
  assertFileWithinLimit,
  assertMediaUploadAllowed,
  assertMediaWithinLimit,
  assertPassageBodyWithinLimit,
  loadLimits,
  maxUploadBytes,
} from '../tenancy/limits'
import {
  acceptInvitation,
  createInvitation,
  listInvitations,
  resolveInvitation,
  revokeInvitation,
} from '../tenancy/invitations'
import { buildEntityGraph, listSessionsForEntity, listWikiEntities } from '../wiki'
import { exportWorld, importWorldExport } from '../world-io'
import {
  ApiError,
  forbidden,
  invalidCredentials,
  invalidInvitation,
  invalidResetToken,
  invalidVerificationToken,
  notFound,
  rateLimited,
  signupClosed,
  surfaceDisabled,
  unauthenticated,
} from './errors'
import { clearSessionCookie, sessionIdFromCookie, setSessionCookie } from './session'

declare module 'fastify' {
  interface FastifyRequest {
    account: PublicAccount | null
    /** The verified session id behind `account` — set by the requireAccount gate. */
    sessionId: string | null
    /** True when `account` IS the shared demo principal. Set by requireAccount. */
    isDemo: boolean
    worldContext: WorldContext | null
  }
  interface FastifyInstance {
    /** Every registered route and the preHandler names guarding it. */
    routeGuards: RouteGuards[]
  }
}

/** One route's guard chain, by name. See the `onRoute` hook in buildApp. */
export interface RouteGuards {
  method: string
  url: string
  guards: string[]
}

/** Fallback contact address when CONTACT_EMAIL is unset (dev/test/dummy). */
export const DEFAULT_CONTACT_EMAIL = 'fakeemail@address.com'

/** Reset-token lifetime — long enough to act on the email, short enough to limit exposure. */
const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000 // 1 hour
/** Minimum interval between reset emails per account (mail-bomb guard). */
const PASSWORD_RESET_THROTTLE_MS = 60 * 1000 // 60 seconds

/** Verification-link lifetime. Longer than a reset: it is not a live credential. */
const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours
/** Minimum interval between verification emails per account (mail-bomb guard). */
const EMAIL_VERIFICATION_THROTTLE_MS = 60 * 1000 // 60 seconds

/**
 * Invitation lifetime. Long enough that a link sent on a Friday still works
 * when someone gets to it the following weekend; short enough that a link
 * forwarded on or left in a chat log stops being a way in.
 */
const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

export interface AppDeps {
  db: Kysely<Database>
  auth: AuthService
  cookieSecret: string
  cookieSecure: boolean
  /**
   * Evaluated feature flags, exposed to the SPA via `GET /api/config`. Optional
   * so tests and callers that don't set it get the fail-closed defaults.
   */
  flags?: FeatureFlags
  /**
   * Public contact address the SPA's contact modal links to (mailto only).
   * Optional; defaults to {@link DEFAULT_CONTACT_EMAIL} so dev/test still renders
   * a valid link.
   */
  contactEmail?: string
  /** Outbound mail port (password reset). Defaults to a logging no-op mailer. */
  mailer?: Mailer
  /** Clock seam for time-sensitive flows (reset-token expiry/throttle). */
  now?: () => Date
  /**
   * Ceilings on the anonymous-reachable routes, per caller. Optional; defaults
   * to the environment-configured values. Tests lower them so a ceiling is
   * reachable without firing the production quota's worth of requests.
   */
  rateLimits?: RateLimits
  /**
   * How many reverse proxies sit in front of this process, or a trusted address
   * / CIDR. Passed straight to fastify's `trustProxy`.
   *
   * WITHOUT IT, EVERY IP-KEYED RATE LIMIT IS ONE SHARED BUCKET. Behind Caddy the
   * socket's peer address is Caddy's, identical for every visitor on earth, so a
   * per-IP ceiling stops being a ceiling on one caller and becomes a ceiling on
   * the whole internet — one abuser locks out everybody.
   *
   * Defaults to `false`, which is right for dev and tests and for any deployment
   * reached directly. Trusting the header when nothing sets it would let a
   * caller pick their own rate-limit key by sending `X-Forwarded-For`, which is
   * worse than no limit because it looks like one.
   */
  trustProxy?: boolean | number | string
  /**
   * Per-account/per-world resource ceilings. Optional; defaults to the
   * environment-configured values. Tests lower them so a ceiling is reachable
   * without creating thousands of rows.
   */
  limits?: ResourceLimits
  /**
   * Username of the shared demo account. Optional; defaults to
   * {@link DEFAULT_DEMO_USERNAME}. Only consulted when demo mode is on.
   */
  demoUsername?: string
  /**
   * Absolute path to the built web SPA (packages/web/dist). When set, the app
   * serves those static assets and falls back to index.html for client-side
   * routes — one origin, one process. When unset (tests, dev), the app is
   * API-only and unknown routes get the default 404.
   */
  webDistDir?: string
  /**
   * Root directory media file bytes live under (media_attachments.file_path is
   * relative to it). Defaults to `packages/server/.uploads` / $UPLOADS_DIR.
   */
  uploadsDir?: string
}

// ── error envelope ───────────────────────────────────────────────────────────

/** Fastify tags its own errors with a `code`; the Error type does not carry one. */
const hasCode = (error: Error, code: string): boolean =>
  (error as Error & { code?: string }).code === code

function errorHandler(error: Error, _req: FastifyRequest, reply: FastifyReply): void {
  if (error instanceof ApiError) {
    void reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } })
    return
  }
  if (error instanceof ZodError) {
    void reply.code(400).send({
      error: { code: 'invalid_request', message: 'validation failed', details: error.issues },
    })
    return
  }
  // Domain errors are matched by name to avoid importing every error class.
  const byName: Record<string, { status: number; code: string }> = {
    ForbiddenError: { status: 403, code: 'forbidden' },
    // Distinct from a bare `forbidden` on purpose: the owner has two real ways
    // out (transfer, or delete the world) and the code says which refusal it is
    // so the SPA can offer them instead of a dead end.
    OwnerCannotLeaveError: { status: 409, code: 'owner_cannot_leave' },
    NotAMemberError: { status: 400, code: 'not_a_member' },
    // Deletion refused because the account still owns worlds. The handler
    // re-sends this one with the world list attached, so the UI can name them.
    OwnsWorldsError: { status: 409, code: 'owns_worlds' },
    // The SPA maps this to the contact modal, whose copy already says exactly
    // this: read-only demo, email to get your own world.
    DemoReadOnlyError: { status: 403, code: 'demo_read_only' },
    // A deployment mistake, not a user error: demo mode on, demo account absent.
    DemoAccountMissingError: { status: 503, code: 'demo_unavailable' },
    // 403, not 401: the caller IS authenticated, they simply have not proven
    // the address yet. A 401 would send the SPA to the login page, which is
    // exactly the wrong remedy.
    EmailNotVerifiedError: { status: 403, code: 'email_not_verified' },
    // 409, not 429: nothing here is about rate. The request is well-formed and
    // permanently refused until the user frees something up.
    LimitReachedError: { status: 409, code: 'limit_reached' },
    DuplicateUsernameError: { status: 409, code: 'username_taken' },
    DuplicateEmailError: { status: 409, code: 'email_taken' },
    // 400, not 415: the content type was accepted (that is how the request got
    // this far) and the BYTES are the problem. Saying "unsupported media type"
    // would send the uploader to change a header that was never consulted.
    UnsupportedImageError: { status: 400, code: 'unsupported_image' },
    // Unreachable from HTTP today — the route's zod schema bounds x and y first
    // — but the data layer guards independently for callers that are not routes
    // (the seeder, a future importer). Mapped so that if such a caller ever does
    // sit behind a route, it answers 400 rather than 500.
    PinOutOfBoundsError: { status: 400, code: 'pin_out_of_bounds' },
    PinTargetNotFoundError: { status: 404, code: 'not_found' },
    SelfRelationshipError: { status: 400, code: 'self_relationship' },
    InvalidQualifierError: { status: 400, code: 'invalid_qualifier' },
    // 409, not 400: the request is well-formed and the relationship simply
    // already exists, which is almost always a double-click rather than an error
    // the caller needs to correct.
    DuplicateRelationshipError: { status: 409, code: 'duplicate_relationship' },
    EndpointNotFoundError: { status: 404, code: 'not_found' },
    // Same shape as the relationship pair above, for the same reasons: an
    // endpoint the actor cannot see is indistinguishable from one that is not
    // there, and a second attach of the same currency is a double-click.
    AttachmentEndpointNotFoundError: { status: 404, code: 'not_found' },
    DuplicateAttachmentError: { status: 409, code: 'duplicate_attachment' },
    CurrencyValidationError: { status: 400, code: 'invalid_currency' },
    PcAccountLinkError: { status: 400, code: 'invalid_pc_account' },
    KindChangeError: { status: 400, code: 'invalid_kind_change' },
    EmptySuggestionError: { status: 400, code: 'empty_suggestion' },
  }
  const mapped = byName[error.name]
  if (mapped) {
    void reply.code(mapped.status).send({ error: { code: mapped.code, message: error.message } })
    return
  }
  // Fastify's own body-limit refusal, raised before any handler runs. Without
  // this an over-sized upload — the most likely way a real user meets this
  // error — reports "internal error", which blames the server for the user's
  // 40 MB photo and gives them nothing to act on.
  if (hasCode(error, 'FST_ERR_CTP_BODY_TOO_LARGE')) {
    void reply.code(413).send({
      error: { code: 'upload_too_large', message: 'that file is larger than this server accepts' },
    })
    return
  }
  void reply.code(500).send({ error: { code: 'internal', message: 'internal error' } })
}

// ── helpers ──────────────────────────────────────────────────────────────────

function accountOf(req: FastifyRequest): PublicAccount {
  if (!req.account) throw unauthenticated()
  return req.account
}

function sessionOf(req: FastifyRequest): string {
  if (!req.sessionId) throw unauthenticated()
  return req.sessionId
}

function ctxOf(req: FastifyRequest): WorldContext {
  if (!req.worldContext) throw unauthenticated()
  return req.worldContext
}

/**
 * What we record about the calling device, already reduced to a coarse label.
 * Deriving it HERE means the raw User-Agent never crosses the auth port.
 */
const sessionMetaOf = (req: FastifyRequest): SessionMeta => ({
  deviceLabel: describeUserAgent(req.headers['user-agent']),
})

function repoOf(kind: string): ContentRepoLike {
  const repo = ENTITY_REPOS[kind]
  if (!repo) throw notFound(`unknown entity kind: ${kind}`)
  return repo
}

const param = (req: FastifyRequest, key: string): string =>
  (req.params as Record<string, string>)[key] ?? ''

// ── schemas ──────────────────────────────────────────────────────────────────

const LoginBody = z.object({ username: z.string().min(1), password: z.string().min(1) })
/**
 * Email is REQUIRED here even though the column is nullable, per the recorded
 * identity decision: recovery, verification, and invitation all need a contact
 * channel, but the operator CLI must still be able to mint an account without
 * one (that is how the live owner account exists).
 */
const RegisterBody = z.object({
  username: z.string().min(1),
  password: z.string().min(MIN_PASSWORD_LENGTH),
  email: z.email(),
  /**
   * An invitation token authorises registration on its own. Public signup ships
   * flag-gated OFF, so without this an invited stranger could not create the
   * account their invitation is for.
   */
  inviteToken: z.string().min(1).optional(),
})
/** No role field, deliberately — see the migration: the bound is not negotiable from a payload. */
const InviteBody = z.object({ username: z.string().min(1).optional() })
const ResetRequestBody = z.object({ identifier: z.string().min(1) })
const ResetConfirmBody = z.object({
  token: z.string().min(1),
  newPassword: z.string().min(MIN_PASSWORD_LENGTH),
})
const AccountPasswordBody = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(MIN_PASSWORD_LENGTH),
})
const AccountUsernameBody = z.object({ username: z.string().min(1) })
const AccountDeleteBody = z.object({ password: z.string().min(1) })
const VerifyEmailBody = z.object({ token: z.string().min(1) })
const LookupQuery = z.object({ username: z.string().min(1) })
/**
 * The uploaded filename, recorded for display only. Never used to build a path —
 * `mediaFilePath` composes every segment server-side — so it is bounded rather
 * than sanitised: whatever it contains, it only ever renders as an `alt`.
 */
/**
 * A staged-reveal passage.
 *
 * `visibility` accepts all three states, unlike a map's — a passage's grants
 * live in `passage_visibility`, so a `restricted` one is genuinely grantable.
 *
 * `status` and `author_id` are deliberately absent: a client that could set
 * either could publish its own proposal or write in someone else's name. The
 * server decides both.
 */
const PassageCreateBody = z.object({
  body: z.string(),
  position: z.number().int().min(0).optional(),
  visibility: z.enum(['public', 'dm_only', 'restricted']).optional(),
})
/**
 * A player's proposal. ONE field, and that is the point: status, author,
 * visibility and position are all decided by the server, so there is nothing
 * here for a client to send that would change who sees the result.
 */
const PassageProposeBody = z.object({ body: z.string().min(1) })
/** Accepting a proposal is the owner CHOOSING its visibility, so it is required. */
const PassageAcceptBody = z.object({
  visibility: z.enum(['public', 'dm_only', 'restricted']),
})
const PassagePatchBody = z.object({
  body: z.string().optional(),
  position: z.number().int().min(0).optional(),
  visibility: z.enum(['public', 'dm_only', 'restricted']).optional(),
})

const UploadQuery = z.object({ filename: z.string().min(1).max(255).optional() })
const MediaVariantQuery = z.object({ variant: z.enum(['source', 'thumbnail']).optional() })
// `null` clears the owner's primary without deleting the file — an owner who
// decides no image should lead the page has to be able to say so.
const PrimaryMediaBody = z.object({ mediaId: z.string().min(1).nullable() })
/**
 * Map metadata. `image_path`, `thumbnail_path` and the source dimensions are
 * deliberately absent: they describe bytes on disk, and a client that could set
 * them could make every pin on that map land somewhere else.
 */
const MapCreateBody = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  /**
   * All three states, since 0016. `restricted` was refused until maps got their
   * own grant ACL (`map_visibility`) — a grant naming a map could not be stored
   * in `entity_visibility`, whose `entity_id` is foreign-keyed to `entities`,
   * so offering the value would have sold the DM something shareable that
   * behaved exactly like `dm_only`.
   *
   * The per-PIN filter is unaffected and still applies on top: a player granted
   * a map still does not see pins whose target entity they cannot see.
   */
  visibility: z.enum(['public', 'dm_only', 'restricted']).optional(),
})
const MapPatchBody = MapCreateBody.partial()
/**
 * A pin's position, as fractions of the source image. Bounded here so an
 * out-of-range value is a 400 naming the field rather than a raw CHECK
 * violation, which the schema would otherwise report as an opaque 500.
 */
const UNIT = z.number().min(0).max(1)
const PinCreateBody = z.object({
  kind: z.string().min(1),
  entityId: z.string().min(1),
  x: UNIT,
  y: UNIT,
  label: z.string().max(200).nullable().optional(),
})
/**
 * A relationship's far end and its type. `fromId` is the URL's entity, never the
 * payload's — so a caller cannot assert a relationship on behalf of an entity
 * they never resolved through the seam.
 */
const RelationshipBody = z.object({
  toId: z.string().min(1),
  type: z.enum(RELATIONSHIP_TYPES),
  note: z.string().max(500).optional(),
  // Not `z.enum(LANGUAGE_ROLES)`: which values are legal depends on the `type`,
  // and that pairing lives in `shared`'s registry. Validated in
  // `createRelationship` via `isValidQualifier`, so the rule has one home rather
  // than a loose enum here and the real check there.
  qualifier: z.string().min(1).max(40).optional(),
})
/**
 * A patch onto an existing relationship. Every field optional — a GM changing
 * only the type should not have to resend the note.
 *
 * `qualifier` is NULLABLE here where the create body is merely optional:
 * clearing a role is a thing to say, and `undefined` already means "leave it".
 *
 * `origin` and `source_passage_id` are absent on purpose. Provenance is
 * reconciliation's record of where a row came from, not a field a user edits —
 * and letting the form move a row off its source passage would publish a secret.
 */
const RelationshipPatchBody = z.object({
  type: z.enum(RELATIONSHIP_TYPES).optional(),
  note: z.string().max(500).optional(),
  qualifier: z.string().min(1).max(40).nullable().optional(),
})
/**
 * A calendar's structured config. Bounded on every axis — a config is written by
 * hand into a jsonb column, so the limits are what stop a mistyped paste becoming
 * a row every later reader has to cope with. `leap_year_rule` is free prose
 * because nothing computes with it (see `data/calendars.ts` on being decorative).
 */
const CalendarConfigBody = z.object({
  months: z
    .array(z.object({ name: z.string().min(1).max(60), days: z.number().int().min(1).max(1000) }))
    .max(60)
    .optional(),
  weekdays: z.array(z.string().min(1).max(60)).max(30).optional(),
  eras: z.array(z.string().min(1).max(60)).max(20).optional(),
  leap_year_rule: z.string().max(300).optional(),
})
const CalendarBody = z.object({
  name: z.string().min(1).max(120),
  kind: z.enum(['gregorian', 'custom']),
  config: CalendarConfigBody.optional(),
})
const CalendarPatchBody = z.object({
  name: z.string().min(1).max(120).optional(),
  kind: z.enum(['gregorian', 'custom']).optional(),
  config: CalendarConfigBody.optional(),
})
/**
 * Attaching a currency to a settlement or an organization.
 *
 * `visibility` is bounded to public/dm_only rather than the full `VISIBILITIES`.
 * An attachment row cannot be `restricted` — no ACL table is foreign-keyable to
 * it, so the level would behave exactly like `dm_only` — and the argument is in
 * `data/currency-attachments.ts`. Refused here rather than silently downgraded,
 * so a caller asking for something the model cannot do is told so.
 */
const AttachmentBody = z.object({
  currencyId: z.string().min(1),
  isPrimary: z.boolean().optional(),
  notes: z.string().max(500).optional(),
  visibility: z.enum(ATTACHMENT_VISIBILITIES).optional(),
})
const AttachmentPatchBody = z.object({
  isPrimary: z.boolean().optional(),
  notes: z.string().max(500).optional(),
  visibility: z.enum(ATTACHMENT_VISIBILITIES).optional(),
})
const PinPatchBody = z.object({
  x: UNIT.optional(),
  y: UNIT.optional(),
  label: z.string().max(200).nullable().optional(),
})
/**
 * A world's name, at BOTH doors that set one — create and rename.
 *
 * Trimmed before it is judged, so a name of spaces is refused as the empty name
 * it is rather than stored and then slugified to the meaningless `world`. The
 * ceiling matches the other free-text fields here; a name is a label, and one
 * that does not fit in a heading is not one.
 */
const WorldName = z.string().trim().min(1).max(200)
const NameBody = z.object({ name: WorldName })
const GrantBody = z.object({ accountId: z.string().min(1) })
const EntityCreateBody = z.object({ name: z.string().min(1) }).passthrough()
const PatchBody = z.record(z.string(), z.unknown())
const ChangeKindBody = z.object({ toKind: z.string().min(1) })
const NoteBody = z.object({ body: z.string() })
const TouchBody = z.object({
  entityId: z.string().min(1),
  touchType: z.enum(TOUCH_TYPES),
  narrativeDelta: z.string().optional(),
})
const ProposeBody = z.object({
  targetKind: z.string().min(1),
  targetId: z.string().min(1),
  proposed: z.record(z.string(), z.unknown()),
})
const ImportBody = z.object({
  name: z.string().min(1),
  data: z.object({
    version: z.number(),
    tables: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))),
  }),
})

// ── app ──────────────────────────────────────────────────────────────────────

export function buildApp(deps: AppDeps): FastifyInstance {
  const uploadLimits = deps.limits ?? loadLimits({})
  const rateLimits = deps.rateLimits ?? loadRateLimits({})
  const app = Fastify({
    logger: false,
    // Sized to the largest single file any upload route accepts, so an oversized
    // body is refused at the socket instead of being buffered whole and then
    // rejected. Each route still applies its own, tighter ceiling — this is the
    // outer bound, not the policy.
    bodyLimit: maxUploadBytes(uploadLimits),
    // See AppDeps.trustProxy: without this, req.ip behind a proxy is the
    // proxy's address for every visitor and every IP-keyed limit below is a
    // single shared bucket.
    trustProxy: deps.trustProxy ?? false,
  })
  /**
   * Uploads arrive as the raw request body: one file per request, so multipart's
   * multi-part machinery would be unused and a body parser is a poor thing to
   * add to an upload surface for no gain. The declared content type routes the
   * request HERE; it does not decide what the bytes are — `identifyImage` reads
   * the header, and a JPEG announced as `image/webp` is stored as a JPEG.
   *
   * `application/octet-stream` is accepted for the same reason: a file the
   * browser could not type still has to reach the one thing that CAN type it.
   * Gate-keeping on a header we have already declared to be no evidence would
   * refuse honest uploads while stopping no dishonest one.
   */
  for (const contentType of [...IMAGE_MIME_TYPES, 'application/octet-stream']) {
    app.addContentTypeParser(
      contentType,
      { parseAs: 'buffer' },
      (_req, body, done): void => void done(null, body),
    )
  }
  void app.register(cookie, { secret: deps.cookieSecret })
  // `global: false` — no route is limited unless it opts in via `config.rateLimit`.
  // Rate-limiting the rest of the surface is task 3551's call, and it should
  // make it deliberately rather than inherit a blanket limit from this task.
  void app.register(rateLimit, {
    global: false,
    // The plugin runs at onRequest, before the auth preHandler, so the account
    // is not resolved yet. The signed session cookie is the closest stable
    // identity available that early; unauthenticated callers fall back to IP
    // (they cannot reach this owner-gated route anyway, but the key must exist).
    keyGenerator: (req) => sessionIdFromCookie(req) ?? req.ip,
    errorResponseBuilder: () => rateLimited(),
  })
  /**
   * Every route, with the names of the preHandlers guarding it.
   *
   * Recorded so the guard policy can be asserted STRUCTURALLY rather than by
   * probing a sample of routes and hoping the sample was representative. The
   * invariant that matters — every `/api/worlds/:worldId/*` route re-checks
   * membership instead of trusting the path parameter — is a property of the
   * whole family, and a new route added without `inWorld` is exactly the case a
   * spot-check misses. `http-route-guards.test.ts` reads this.
   *
   * Populated by an `onRoute` hook, so it is complete only after `app.ready()`.
   */
  const routeGuards: RouteGuards[] = []
  app.addHook('onRoute', (route) => {
    const handlers = route.preHandler
    routeGuards.push({
      method: Array.isArray(route.method) ? route.method.join(',') : route.method,
      url: route.url,
      guards: (Array.isArray(handlers) ? handlers : handlers ? [handlers] : []).map(
        (h) => h.name || '(anonymous)',
      ),
    })
  })
  app.decorate('routeGuards', routeGuards)
  app.decorateRequest('account', null)
  app.decorateRequest('sessionId', null)
  app.decorateRequest('worldContext', null)
  app.decorateRequest('isDemo', false)
  app.setErrorHandler(errorHandler)

  // Liveness probe for systemd / the Tailscale edge — no auth, no DB.
  app.get('/api/health', () => ({ status: 'ok' }))

  // Public runtime config for the SPA — the feature flags it reflects. Like the
  // health probe: no auth, no DB. Fail-closed defaults when deps omit flags, so
  // a caller that forgets to pass them still can't accidentally open a gate.
  const flags = deps.flags ?? loadFlags({})
  const contactEmail = deps.contactEmail ?? DEFAULT_CONTACT_EMAIL
  app.get('/api/config', () => ({ flags, contactEmail }))

  const mailer = deps.mailer ?? createLoggingMailer()
  const clock = deps.now ?? ((): Date => new Date())
  const limits = uploadLimits
  /** Root the uploaded bytes live under; `file_path` is relative to it. */
  const uploadsDir = resolveUploadsDir(deps.uploadsDir)
  const demoUsername = deps.demoUsername ?? DEFAULT_DEMO_USERNAME

  /**
   * Refuse a surface the deployment has switched off. The SPA routes this code
   * to the contact modal; the refusal here is what makes the flag real, because
   * a script does not read the SPA.
   */
  function requireSurface(enabled: boolean, surface: string): void {
    if (!enabled) throw surfaceDisabled(surface)
  }

  /**
   * Gate an action behind a proven email address. NOT applied to login or to
   * reading anything — the recorded identity decision is that verification
   * gates world creation and invitation only, so a visitor who signs up to look
   * around gets in immediately and the CLI-minted operator account (which has
   * no email and never can be verified) keeps working.
   */
  async function requireVerified(accountId: string, action: string): Promise<void> {
    if (await isVerificationOutstanding(deps.db, accountId)) {
      throw new EmailNotVerifiedError(action)
    }
  }

  const tenancy = createTenancy(deps.db)
  // Derived from the auth service, never taken as a separate input: the cookie
  // must expire when the session does, and one value with two independent sinks
  // is a divergence waiting to happen (it already cost a debugging cycle — see
  // bug 1205). Configure the TTL where sessions are actually made.
  const cookieOpts = {
    secure: deps.cookieSecure,
    maxAgeSeconds: Math.floor(deps.auth.sessionTtlMs / 1000),
  }

  const requireAccount = async (req: FastifyRequest): Promise<void> => {
    const sid = sessionIdFromCookie(req)
    const account = sid ? await deps.auth.authenticate(sid) : null
    if (!account) throw unauthenticated()
    req.account = account
    req.sessionId = sid
    // Read-only is a property OF THE PRINCIPAL, applied once here rather than
    // route by route. Enumerating mutating routes would make the NEXT route
    // added writable by default — and on a shared account that means the next
    // feature quietly lets one visitor deface the demo for everyone after them.
    req.isDemo = flags.demoModeEnabled && account.username === demoUsername
    if (req.isDemo && !demoRequestAllowed(req.method, req.url)) throw new DemoReadOnlyError()
  }

  const requireWorld = async (req: FastifyRequest): Promise<void> => {
    const account = accountOf(req)
    const ctx = await resolveWorldContext(deps.db, account.id, param(req, 'worldId'))
    if (!ctx) throw forbidden('not a member of this world')
    req.worldContext = ctx
  }

  const authed = { preHandler: requireAccount }
  const inWorld = { preHandler: [requireAccount, requireWorld] }
  /**
   * Signed in AND account management switched on. Applied as a preHandler to the
   * WHOLE `/api/account/*` family rather than checked inside each handler: the
   * hazard this closes is one route being forgotten, and a per-handler check is
   * exactly the shape that gets forgotten. Adding a route to the family means
   * using this instead of `authed`.
   */
  // Explicitly async: fastify decides callback-vs-promise style from the hook's
  // shape, and a plain sync arrow here silently never completes. Named rather
  // than inline so it is legible in `routeGuards`, which is how the guard policy
  // is asserted — an anonymous hook there reads as "(anonymous)" and tells a
  // reviewer nothing.
  const requireAccountManagement = async (): Promise<void> => {
    requireSurface(flags.accountManagementEnabled, 'account management')
  }
  const accountManaged = { preHandler: [requireAccount, requireAccountManagement] }

  // ── auth ──
  /**
   * The ceilings on the anonymous-reachable surface, resolved once so every
   * route below reads the same object and a test can lower all of them together.
   *
   * These are the only routes a stranger can reach at all. Everything else in
   * this file is behind `authed`, `inWorld` or `accountManaged`, where the
   * resource ceilings in tenancy/limits.ts are the relevant guard — a limit on
   * REQUEST RATE and a limit on TOTAL ACCUMULATION are different defences, and
   * an authenticated caller needs the second one more than the first.
   */
  const authLimit = { rateLimit: rateLimits.auth }
  const mailLimit = { rateLimit: rateLimits.mail }
  const tokenLimit = { rateLimit: rateLimits.token }

  /**
   * REGISTERED INSIDE `after()`, and that is load-bearing.
   *
   * @fastify/rate-limit applies a route's `config.rateLimit` through an
   * `onRoute` hook, and `onRoute` only fires for routes registered AFTER the
   * plugin has finished loading. `app.register` defers loading to `ready()`, so
   * a route declared in the normal flow above carries its limit config and NO
   * LIMIT — it works perfectly and is simply not rate-limited, which is the
   * worst shape a missing guard can take. `after()` runs once the preceding
   * registrations have loaded, which is what makes the ceiling real.
   *
   * Verified by http-rate-limits.test.ts, which fires one request past every
   * ceiling and asserts the 429. Those tests failed against the same routes
   * declared outside `after()`.
   */
  app.after(() => {
    app.post('/api/login', { config: authLimit }, async (req, reply) => {
      requireSurface(flags.loginEnabled, 'signing in')
      const { username, password } = LoginBody.parse(req.body)
      const result = await deps.auth.login(username, password, sessionMetaOf(req))
      if (!result) throw invalidCredentials()
      setSessionCookie(reply, result.sessionId, cookieOpts)
      return { account: result.account }
    })
    /**
     * Self-serve registration. Gated on the feature flag SERVER-side, not merely
     * hidden in the SPA — a closed signup that only stops the button from
     * rendering is not closed. The flag fails closed, so a deployment that never
     * sets PUBLIC_SIGNUP_ENABLED does not accidentally accept strangers.
     *
     * Rate-limited on the same ceiling as login. Registration is the more
     * expensive of the two — it writes rows and hashes a password with scrypt —
     * so an unlimited one is a cheap way to spend a small box's CPU even when
     * every account it creates is junk that nothing else will ever read.
     */
    app.post('/api/register', { config: authLimit }, async (req, reply) => {
      const { username, password, email, inviteToken } = RegisterBody.parse(req.body)
      // Two independent authorisations for one door: signup is open to everyone,
      // OR this particular person holds a live invitation. The token is resolved
      // (not merely present) before it counts, so a junk value cannot prise open
      // a closed instance.
      const invitation = inviteToken ? await resolveInvitation(deps.db, inviteToken, clock()) : null
      if (!flags.publicSignupEnabled && !invitation) throw signupClosed()

      const account = await deps.auth.createAccount(username, password, email)
      // Redeem AFTER the account exists — a duplicate-username rejection must not
      // burn the invitation, or a typo would cost someone their only way in.
      if (inviteToken) await acceptInvitation(deps.db, account.id, inviteToken, clock())
      // Registration signs you in. The password was just set by this request, so
      // re-verifying it through `login` would hash it a second time to learn
      // nothing.
      const sessionId = await deps.auth.startSession(account.id, sessionMetaOf(req))
      setSessionCookie(reply, sessionId, cookieOpts)
      // Send the verification link now rather than making the user ask for it.
      // Failing to send must NOT fail the registration — the account exists and
      // the resend endpoint is right there; losing the account because a mail
      // provider was down would be the worse outcome by a wide margin.
      const raw = await createVerificationToken(
        deps.db,
        account.id,
        clock(),
        EMAIL_VERIFICATION_TTL_MS,
        EMAIL_VERIFICATION_THROTTLE_MS,
      )
      if (raw) await mailer.sendEmailVerification({ to: email, token: raw })
      return reply.code(201).send({ account })
    })
    app.post('/api/logout', async (req, reply) => {
      const sid = sessionIdFromCookie(req)
      // A demo visitor leaving must not sign out every other visitor: the demo
      // session row is SHARED, so their cookie is cleared and the row is left
      // alone. Everyone else's logout destroys their own session as normal.
      if (sid) {
        const account = await deps.auth.authenticate(sid)
        const isDemo = flags.demoModeEnabled && account?.username === demoUsername
        if (!isDemo) await deps.auth.logout(sid)
      }
      clearSessionCookie(reply)
      return { ok: true }
    })

    /**
     * The portfolio's front door: land a visitor signed in as the shared,
     * read-only demo player.
     *
     * It takes NO input, which is what makes "can only ever produce the demo
     * principal" true by construction rather than by validation — there is no
     * username, id, or token here to substitute. And it reuses one shared session
     * row rather than inserting per visit, so a flood of traffic costs no storage.
     */
    app.post('/api/demo-login', { config: authLimit }, async (req, reply) => {
      requireSurface(flags.demoModeEnabled, 'the demo')
      const accountId = await demoAccountId(deps.db, demoUsername)
      const sessionId = await sharedDemoSession(deps.db, accountId, clock(), () =>
        deps.auth.startSession(accountId, sessionMetaOf(req)),
      )
      setSessionCookie(reply, sessionId, cookieOpts)
      // isDemo is true by construction here: this route has exactly one identity
      // it can produce, and the SPA adopts this account without re-probing /api/me.
      return { account: { id: accountId, username: demoUsername, isDemo: true } }
    })
    // `isDemo` travels with the account so the SPA can stop OFFERING surfaces this
    // principal will be refused — the header's account link, chiefly. It is a
    // courtesy, exactly like a hidden form: `requireAccount` is the gate.
    app.get('/api/me', authed, async (req) => ({
      account: { ...accountOf(req), isDemo: req.isDemo === true },
    }))

    // ── password reset (unauthenticated) ──
    app.post('/api/password-reset/request', { config: mailLimit }, async (req) => {
      requireSurface(flags.passwordResetEnabled, 'password reset')
      const { identifier } = ResetRequestBody.parse(req.body)
      const account =
        (await getAccountByUsername(deps.db, identifier)) ??
        (await getAccountByEmail(deps.db, identifier))
      // Anti-enumeration: the response is identical whether or not the account
      // exists (or has an email) — no oracle via body or status.
      if (account?.email) {
        const token = await createResetToken(
          deps.db,
          account.id,
          clock(),
          PASSWORD_RESET_TTL_MS,
          PASSWORD_RESET_THROTTLE_MS,
        )
        if (token) await mailer.sendPasswordReset({ to: account.email, token })
      }
      return { ok: true }
    })
    app.post('/api/password-reset/confirm', { config: tokenLimit }, async (req) => {
      requireSurface(flags.passwordResetEnabled, 'password reset')
      const { token, newPassword } = ResetConfirmBody.parse(req.body)
      const accountId = await consumeResetToken(deps.db, token, clock())
      if (!accountId) throw invalidResetToken()
      await deps.auth.setPassword(accountId, newPassword)
      await deps.auth.invalidateAllSessions(accountId)
      return { ok: true }
    })
  })

  // ── account self-service (authenticated) ──
  app.post('/api/account/password', accountManaged, async (req, reply) => {
    const { currentPassword, newPassword } = AccountPasswordBody.parse(req.body)
    const account = accountOf(req)
    const sid = sessionOf(req)
    // Knowing the current password is what makes this a change rather than a
    // takeover: a hijacked session must not be able to lock the owner out.
    if (!(await deps.auth.verifyAccountPassword(account.id, currentPassword))) {
      throw invalidCredentials()
    }
    await deps.auth.setPassword(account.id, newPassword)
    // Everyone else out, then re-issue our own id so the pre-change cookie is
    // dead too — otherwise the one session an attacker actually holds is the
    // one the change spares.
    await deps.auth.invalidateOtherSessions(account.id, sid)
    const rotated = await deps.auth.rotateSession(account.id, sid, sessionMetaOf(req))
    setSessionCookie(reply, rotated, cookieOpts)
    return { ok: true }
  })
  app.post('/api/account/username', accountManaged, async (req) => ({
    account: await deps.auth.setUsername(
      accountOf(req).id,
      AccountUsernameBody.parse(req.body).username,
    ),
  }))
  app.get('/api/account/sessions', accountManaged, async (req) => ({
    sessions: await deps.auth.listSessions(accountOf(req).id, sessionOf(req)),
  }))
  // Deletion demands the current password: it is irreversible, and a session
  // left open on a shared machine should not be enough to end the account.
  // What the SPA needs to show the verification banner and the limits BEFORE
  // the user runs into one. Read-only, own-account only.
  app.get('/api/account/status', accountManaged, async (req) => ({
    // False only when there is genuinely something outstanding — an account
    // with no address to prove is not asked to prove one.
    emailVerified: !(await isVerificationOutstanding(deps.db, accountOf(req).id)),
    limits,
    usage: { worlds: await countOwnedWorlds(deps.db, accountOf(req).id) },
  }))
  app.post('/api/account/verification/resend', accountManaged, async (req) => {
    const account = accountOf(req)
    const email = (await getAccountById(deps.db, account.id))?.email
    // No address to prove — CLI-minted accounts. Answer the same either way:
    // whether an account has an email is not this endpoint's news to break.
    if (email) {
      const raw = await createVerificationToken(
        deps.db,
        account.id,
        clock(),
        EMAIL_VERIFICATION_TTL_MS,
        EMAIL_VERIFICATION_THROTTLE_MS,
      )
      // null means throttled — deliberately indistinguishable from a send.
      if (raw) await mailer.sendEmailVerification({ to: email, token: raw })
    }
    return { ok: true }
  })
  // Public: the link may well be opened in a browser with no session, and
  // demanding a login first is how a verification link becomes a dead end.
  /**
   * REGISTERED INSIDE `after()`, and that is load-bearing.
   *
   * @fastify/rate-limit applies a route's `config.rateLimit` through an
   * `onRoute` hook, and `onRoute` only fires for routes registered AFTER the
   * plugin has finished loading. `app.register` defers loading to `ready()`, so
   * a route declared in the normal flow above carries its limit config and NO
   * LIMIT — it works perfectly and is simply not rate-limited, which is the
   * worst shape a missing guard can take. `after()` runs once the preceding
   * registrations have loaded, which is what makes the ceiling real.
   *
   * Verified by http-rate-limits.test.ts, which fires one request past every
   * ceiling and asserts the 429. Those tests failed against the same routes
   * declared outside `after()`.
   */
  app.after(() => {
    app.post('/api/verify-email', { config: tokenLimit }, async (req) => {
      const { token } = VerifyEmailBody.parse(req.body)
      if (!(await consumeVerificationToken(deps.db, token, clock())))
        throw invalidVerificationToken()
      return { ok: true }
    })
  })
  app.get('/api/account/deletion-blockers', accountManaged, async (req) => ({
    worlds: await deps.auth.worldsBlockingDeletion(accountOf(req).id),
  }))
  app.delete('/api/account', accountManaged, async (req, reply) => {
    const { password } = AccountDeleteBody.parse(req.body)
    const account = accountOf(req)
    if (!(await deps.auth.verifyAccountPassword(account.id, password))) throw invalidCredentials()
    try {
      await deps.auth.deleteAccount(account.id)
    } catch (err) {
      // Re-thrown with the blocking worlds attached — a bare code would leave
      // the user guessing which of their worlds to deal with.
      if (err instanceof OwnsWorldsError) {
        return reply
          .code(409)
          .send({ error: { code: 'owns_worlds', message: err.message, worlds: err.worlds } })
      }
      throw err
    }
    // The sessions are already gone with the account; clear the cookie so the
    // browser is not left presenting a credential for a row that no longer exists.
    clearSessionCookie(reply)
    return { ok: true }
  })

  app.post('/api/account/sessions/revoke-all', accountManaged, async (req) => {
    await deps.auth.invalidateOtherSessions(accountOf(req).id, sessionOf(req))
    return { ok: true }
  })

  // ── invitations (redeemed by the invitee; no world membership yet) ──
  /**
   * Preview a token so the SPA can say WHICH world someone was invited to
   * before asking them to sign in or register. Every refusal — unknown,
   * revoked, expired, already used — is the same 400 carrying no world detail,
   * so a dead link cannot be used to probe for worlds.
   */
  /**
   * REGISTERED INSIDE `after()`, and that is load-bearing.
   *
   * @fastify/rate-limit applies a route's `config.rateLimit` through an
   * `onRoute` hook, and `onRoute` only fires for routes registered AFTER the
   * plugin has finished loading. `app.register` defers loading to `ready()`, so
   * a route declared in the normal flow above carries its limit config and NO
   * LIMIT — it works perfectly and is simply not rate-limited, which is the
   * worst shape a missing guard can take. `after()` runs once the preceding
   * registrations have loaded, which is what makes the ceiling real.
   *
   * Verified by http-rate-limits.test.ts, which fires one request past every
   * ceiling and asserts the 429. Those tests failed against the same routes
   * declared outside `after()`.
   */
  app.after(() => {
    app.get('/api/invitations/:token', { config: tokenLimit }, async (req) => {
      const found = await resolveInvitation(deps.db, param(req, 'token'), clock())
      if (!found) throw invalidInvitation()
      return {
        world: { name: found.worldName, slug: found.worldSlug },
        // Tells the SPA whether to offer "accept" or a registration form; it says
        // nothing about WHO the invitation is for.
        targeted: found.inviteeAccountId !== null,
      }
    })
  })
  app.post('/api/invitations/:token/accept', authed, async (req) => {
    const joined = await acceptInvitation(deps.db, accountOf(req).id, param(req, 'token'), clock())
    if (!joined) throw invalidInvitation()
    return { world: joined }
  })

  // ── worlds + members ──
  app.get('/api/worlds', authed, async (req) => ({
    worlds: await tenancy.listWorlds(accountOf(req).id),
  }))
  app.post('/api/worlds', authed, async (req, reply) => {
    await requireVerified(accountOf(req).id, 'create a world')
    await assertCanCreateWorld(deps.db, accountOf(req).id, limits)
    const { name } = NameBody.parse(req.body)
    const world = await tenancy.createWorld(accountOf(req).id, name)
    return reply.code(201).send({ world })
  })
  // The `:worldId` path segment is the world's slug (the URL key); the
  // membership gate has already resolved it to the real id in the context, so
  // these tenancy calls use `ctxOf(req).worldId` rather than the raw segment.
  app.get('/api/worlds/:worldId', inWorld, async (req) => {
    const world = await tenancy.getWorld(accountOf(req).id, ctxOf(req).worldId)
    if (!world) throw notFound('world')
    return { world }
  })
  // Owner-gated inside the service, exactly as delete is. The slug follows the
  // name, so the response carries the world's NEW slug: it is the caller's only
  // way to know where the world now lives, the address it was asked for having
  // just stopped resolving.
  app.patch('/api/worlds/:worldId', inWorld, async (req) => {
    const { name } = NameBody.parse(req.body)
    return { world: await tenancy.renameWorld(accountOf(req).id, ctxOf(req).worldId, name) }
  })
  app.delete('/api/worlds/:worldId', inWorld, async (req) => {
    const worldId = ctxOf(req).worldId
    await tenancy.deleteWorld(accountOf(req).id, worldId)
    // The rows cascade off the world; the BYTES do not, and nothing else will
    // ever reference them. World-scoping the upload path is what makes this one
    // subtree removal rather than a sweep.
    await removeWorldMedia(uploadsDir, worldId)
    return { ok: true }
  })
  /**
   * Resolve an exact username to the minimal public account reference that the
   * member and grant routes take as `accountId`. Without this a DM cannot add
   * anyone without reading a UUID out of the database.
   *
   * EXACT match only, and case-sensitive, because usernames are stored
   * case-sensitively — a case-insensitive lookup could match two distinct
   * accounts. No prefix or fuzzy matching: a public instance must not ship a
   * browsable directory of everyone who has registered.
   *
   * Semantics on the two failure paths, per the task's requirement to justify
   * them: a non-owner gets 403 for EVERY username, including ones that exist,
   * and an owner gets a truthful answer for every username. The axes never
   * mix — you cannot learn your permission from the username, nor a username
   * from your permission. For an owner a truthful found/not-found is
   * unavoidable: a lookup that lies about existence cannot be used to invite
   * anyone, which is the whole point. `{account: null}` rather than a 404
   * because 404 is ambiguous with route-not-found, and the SPA has to tell
   * "no such person" apart from "this endpoint is gone".
   */
  //
  // Registered inside `after()` on purpose. @fastify/rate-limit applies a
  // route's `config.rateLimit` through an onRoute hook, and onRoute only fires
  // for routes declared AFTER the hook exists. `app.register` is deferred to
  // boot, so a route declared inline here would be created before the plugin
  // loads and would silently carry NO limit — the failure mode is a route that
  // works perfectly and is simply not rate-limited. `after()` runs once the
  // preceding registrations have loaded, which is what makes the limit real.
  app.after(() => {
    app.get(
      '/api/worlds/:worldId/account-lookup',
      { ...inWorld, config: { rateLimit: rateLimits.lookup } },
      async (req) => {
        assertWorldOwner(ctxOf(req), 'account lookup')
        const { username } = LookupQuery.parse(req.query)
        const found = await getAccountByUsername(deps.db, username)
        return { account: found ? { id: found.id, username: found.username } : null }
      },
    )
  })
  // ── invitations (owner side) ──
  app.post('/api/worlds/:worldId/invitations', inWorld, async (req, reply) => {
    const ctx = ctxOf(req)
    assertWorldOwner(ctx, 'invite')
    await requireVerified(accountOf(req).id, 'invite someone')
    const { username } = InviteBody.parse(req.body)
    // A named invitee is pinned to their account id, so only they can redeem
    // it. Omitting the name makes an open link the owner can hand to anyone.
    // An unknown name is a 404 rather than an open link — silently widening a
    // targeted invitation because of a typo is the wrong way to fail.
    const invitee = username ? await getAccountByUsername(deps.db, username) : null
    if (username && !invitee) throw notFound('account')
    const created = await createInvitation(deps.db, {
      worldId: ctx.worldId,
      invitedBy: accountOf(req).id,
      inviteeAccountId: invitee?.id ?? null,
      now: clock(),
      ttlMs: INVITATION_TTL_MS,
    })
    // The raw token is returned exactly once, here. It is not recoverable from
    // the listing later — that is the point of storing only the hash.
    return reply.code(201).send({ id: created.id, token: created.token })
  })
  app.get('/api/worlds/:worldId/invitations', inWorld, async (req) => {
    assertWorldOwner(ctxOf(req), 'list invitations')
    return { invitations: await listInvitations(deps.db, ctxOf(req).worldId, clock()) }
  })
  app.delete('/api/worlds/:worldId/invitations/:id', inWorld, async (req) => {
    assertWorldOwner(ctxOf(req), 'revoke invitation')
    if (!(await revokeInvitation(deps.db, ctxOf(req).worldId, param(req, 'id')))) {
      throw notFound('invitation')
    }
    return { ok: true }
  })

  // Readable by any member (`inWorld` is the gate) — a player is entitled to
  // know who else is in the campaign. Mutating the list stays owner-only below.
  app.get('/api/worlds/:worldId/members', inWorld, async (req) => ({
    members: await tenancy.listMembers(ctxOf(req).worldId),
  }))
  app.post('/api/worlds/:worldId/members', inWorld, async (req) => {
    const { accountId } = GrantBody.parse(req.body)
    await tenancy.grantMember(accountOf(req).id, ctxOf(req).worldId, accountId)
    return { ok: true }
  })
  app.delete('/api/worlds/:worldId/members/:accountId', inWorld, async (req) => {
    await tenancy.revokeMember(accountOf(req).id, ctxOf(req).worldId, param(req, 'accountId'))
    return { ok: true }
  })

  // ── leaving, and handing a world over ──
  // Leaving is the one membership change a NON-owner may make, so it is gated on
  // membership (`inWorld`) rather than ownership. The owner is refused inside
  // the service with `owner_cannot_leave`, not here — a world may never be
  // ownerless, and the refusal names the two real alternatives.
  app.post('/api/worlds/:worldId/leave', inWorld, async (req) => {
    await tenancy.leaveWorld(accountOf(req).id, ctxOf(req).worldId)
    return { ok: true }
  })
  app.get('/api/worlds/:worldId/transfer', inWorld, async (req) => ({
    pending: await tenancy.pendingTransfer(ctxOf(req).worldId),
  }))
  app.post('/api/worlds/:worldId/transfer', inWorld, async (req) => {
    const { accountId } = GrantBody.parse(req.body)
    await tenancy.offerOwnership(accountOf(req).id, ctxOf(req).worldId, accountId)
    return { ok: true }
  })
  app.delete('/api/worlds/:worldId/transfer', inWorld, async (req) => {
    await tenancy.cancelOwnershipOffer(accountOf(req).id, ctxOf(req).worldId)
    return { ok: true }
  })
  // Gated on the offer naming you, checked inside the transaction — being a
  // member is not enough to become the owner.
  app.post('/api/worlds/:worldId/transfer/accept', inWorld, async (req) => {
    await tenancy.acceptOwnership(accountOf(req).id, ctxOf(req).worldId)
    return { ok: true }
  })

  // ── entities (content by kind) ──
  /**
   * Every entity read carries BOTH `description` and `body`:
   *
   * - `description` is the raw base column, and it is what the owner's editor
   *   round-trips. It must stay raw, or saving would fold every passage the
   *   owner can see back into the base field.
   * - `body` is the viewer-COMPOSED prose (base + the passages this actor may
   *   see), and it is what every reader renders.
   *
   * Composition happens HERE and in wiki/graph.ts, both through the one
   * composer in data/passages.ts. The web package never composes.
   */
  async function withBodies(
    req: FastifyRequest,
    kind: string,
    entities: ReadonlyArray<{ id: string }>,
  ): Promise<Array<Record<string, unknown>>> {
    // This route dispatches over ENTITY_REPOS, which is a SUPERSET of the
    // content kinds — it also reaches `session` and `map`, bespoke tables that
    // ride the seam. Neither has prose to compose: sessions carry
    // `captured_text` and no `description` at all, and `entity_passages.
    // entity_id` is foreign-keyed to `entities`, so neither can ever own a
    // passage. Composing them would be a wasted query at best, and reading a
    // `description` that does not exist at worst.
    if (!CONTENT_REPOS[kind]) return [...entities] as Array<Record<string, unknown>>
    return (await withComposedBodies(
      ctxOf(req),
      entities as unknown as ComposableEntity[],
    )) as unknown as Array<Record<string, unknown>>
  }

  app.get('/api/worlds/:worldId/entities/:kind', inWorld, async (req) => {
    const kind = param(req, 'kind')
    return { entities: await withBodies(req, kind, await repoOf(kind).list(ctxOf(req))) }
  })
  app.post('/api/worlds/:worldId/entities/:kind', inWorld, async (req, reply) => {
    await assertCanCreateEntity(deps.db, ctxOf(req).worldId, limits)
    const kind = param(req, 'kind')
    const body = EntityCreateBody.parse(req.body)
    // The id is minted here rather than inside the repo so the anchor check has
    // something to reason about: "does this chain cycle back to me" needs a
    // "me". A fresh id is absent from every existing anchor, so on create only
    // the target-exists clause can actually fail — which is the point, since
    // `EntityCreateBody` passes arbitrary keys through and a caller that is not
    // the UI can set an anchor at creation.
    const id = newId()
    if (kind === 'currency') await assertValidBaseRate(ctxOf(req), id, body)
    // A PC's `account_id` is the other field the generic repo cannot vet, and
    // like the anchor it needs the id: the checks are "is this account a member"
    // and "does anyone ELSE already play for them", and the second needs a "me".
    if (kind === 'pc') await assertLinkableAccount(ctxOf(req), id, body)
    const entity = await repoOf(kind).create(ctxOf(req), body, id)
    // A create may already carry prose with `[[links]]` in it — the importer's
    // route through the UI does exactly that.
    await reconcileBrackets(ctxOf(req), id)
    return reply.code(201).send({ entity })
  })
  app.get('/api/worlds/:worldId/entities/:kind/:id', inWorld, async (req) => {
    const kind = param(req, 'kind')
    const entity = await repoOf(kind).get(ctxOf(req), param(req, 'id'))
    if (!entity) throw notFound('entity')
    // The passages themselves are a sub-resource with its own route, like media
    // and relationships — the panel that manages them fetches and refreshes on
    // its own rather than forcing a whole-entity reload after every edit.
    return { entity: (await withBodies(req, kind, [entity]))[0] }
  })
  app.patch('/api/worlds/:worldId/entities/:kind/:id', inWorld, async (req) => {
    const kind = param(req, 'kind')
    const id = param(req, 'id')
    const patch = PatchBody.parse(req.body)
    // Currency's exchange anchor is the one field on any kind whose validity
    // depends on the OTHER rows, so the generic repo cannot check it.
    if (kind === 'currency') await assertValidBaseRate(ctxOf(req), id, patch)
    if (kind === 'pc') await assertLinkableAccount(ctxOf(req), id, patch)
    const entity = await repoOf(kind).update(ctxOf(req), id, patch)
    if (!entity) throw notFound('entity')
    // The prose may have gained or lost a `[[link]]`, and a link IS a
    // relationship now. Reconciled after the write rather than inside the repo:
    // the seam serves eighteen kinds and knows nothing about brackets, and this
    // is the one route through which an entity's text changes.
    await reconcileBrackets(ctxOf(req), id)
    return { entity }
  })
  app.delete('/api/worlds/:worldId/entities/:kind/:id', inWorld, async (req) => {
    const ok = await repoOf(param(req, 'kind')).softDelete(ctxOf(req), param(req, 'id'))
    if (!ok) throw notFound('entity')
    return { ok: true }
  })
  // Reclassify an entity to a different content kind (owner-only). The `:kind`
  // path segment is the current kind; the body carries the target kind.
  app.post('/api/worlds/:worldId/entities/:kind/:id/change-kind', inWorld, async (req) => {
    const { toKind } = ChangeKindBody.parse(req.body)
    const entity = await changeEntityKind(ctxOf(req), param(req, 'id'), toKind)
    if (!entity) throw notFound('entity')
    return { entity }
  })

  // ── trash (soft-deleted content: what came back, and what goes for good) ──
  /**
   * Owner-only, and gated by `assertWorldOwner` inside `data/trash.ts` rather
   * than here — the same place every other content rule lives, so a second
   * route added later cannot forget it.
   *
   * Both mutations answer 404 for an id that is not in this world's trash. That
   * covers "already restored", "already purged", "wrong kind", and "another
   * world's row" with one answer, which is also the answer that declines to say
   * which of those it was.
   */
  app.get('/api/worlds/:worldId/trash', inWorld, async (req) => ({
    entries: await listTrash(ctxOf(req)),
  }))
  app.post('/api/worlds/:worldId/trash/:kind/:id/restore', inWorld, async (req) => {
    if (!(await restoreTrashed(ctxOf(req), param(req, 'kind'), param(req, 'id')))) {
      throw notFound('trashed row')
    }
    return { ok: true }
  })
  /**
   * Permanent deletion. A DELETE on a resource under `/trash`, so the URL says
   * what it destroys — this removes the row FROM the trash rather than putting
   * something into it, which is what `DELETE /entities/:kind/:id` does.
   */
  app.delete('/api/worlds/:worldId/trash/:kind/:id', inWorld, async (req) => {
    if (!(await purgeTrashed(ctxOf(req), uploadsDir, param(req, 'kind'), param(req, 'id')))) {
      throw notFound('trashed row')
    }
    return { ok: true }
  })

  // ── per-entity visibility grants (which players may see a `restricted` page) ──
  // Setting the visibility LEVEL is a normal owner entity PATCH (visibility is a
  // column); these routes manage the per-player grant list for restricted pages.
  app.get('/api/worlds/:worldId/entities/:kind/:id/grants', inWorld, async (req) => ({
    accountIds: await listEntityGrants(ctxOf(req), param(req, 'id')),
  }))
  app.post('/api/worlds/:worldId/entities/:kind/:id/grants', inWorld, async (req, reply) => {
    const { accountId } = GrantBody.parse(req.body)
    await grantEntityVisibility(ctxOf(req), param(req, 'id'), accountId)
    return reply.code(204).send()
  })
  app.delete(
    '/api/worlds/:worldId/entities/:kind/:id/grants/:accountId',
    inWorld,
    async (req, reply) => {
      await revokeEntityVisibility(ctxOf(req), param(req, 'id'), param(req, 'accountId'))
      return reply.code(204).send()
    },
  )

  // ── passages (staged reveal: an entity's prose, in independently-visible parts) ──
  /**
   * Reads are seam-filtered, so a player gets only the passages they may see —
   * the same list that composed their `body`. Writes are owner-only, enforced in
   * data/passages.ts by the seam's `assertContentWrite`, not by this route.
   *
   * Every passage route hangs off its parent entity or names a passage id that
   * the seam then world-scopes; there is deliberately no "list every passage in
   * this world" door. That absence is what holds the invariant that a passage
   * can never be reached without its parent — see data/passages.ts.
   */
  app.get('/api/worlds/:worldId/entities/:kind/:id/passages', inWorld, async (req) => {
    const kind = param(req, 'kind')
    if (!(await repoOf(kind).get(ctxOf(req), param(req, 'id')))) throw notFound('entity')
    return { passages: await listPassagesForEntity(ctxOf(req), param(req, 'id')) }
  })
  app.post('/api/worlds/:worldId/entities/:kind/:id/passages', inWorld, async (req, reply) => {
    const kind = param(req, 'kind')
    const entityId = param(req, 'id')
    // Resolve the parent through the seam first: an owner cannot attach a
    // passage to something that is not theirs, and this is also what makes a
    // bad id a 404 rather than a foreign-key error.
    if (!(await repoOf(kind).get(ctxOf(req), entityId))) throw notFound('entity')
    const body = PassageCreateBody.parse(req.body)
    assertPassageBodyWithinLimit(body.body, limits)
    await assertCanCreatePassage(deps.db, ctxOf(req).worldId, entityId, limits)
    const passage = await createPassage(
      ctxOf(req),
      { entityId, body: body.body, position: body.position, visibility: body.visibility },
      accountOf(req).id,
    )
    await reconcileBrackets(ctxOf(req), entityId)
    return reply.code(201).send({ passage })
  })
  /**
   * A PLAYER proposes a passage. The one route in the app that does not go
   * through `assertContentWrite`.
   *
   * It is member-gated, not owner-gated, and everything a player could abuse is
   * forced server-side in `proposePassage` — status, author, visibility, the
   * self-grant and the position. The request body carries a body string and
   * nothing else that survives; `PassageProposeBody` accepts no other field.
   *
   * Gated by the SAME flag as suggestions, on the propose side only. Accept and
   * reject are GM actions on proposals that already exist, and gating those
   * would strand whatever is already in the queue — the reasoning the
   * suggestions routes already use.
   */
  app.post('/api/worlds/:worldId/entities/:kind/:id/propose', inWorld, async (req, reply) => {
    requireSurface(flags.suggestionsEnabled, 'sending suggestions')
    const kind = param(req, 'kind')
    const entityId = param(req, 'id')
    // Resolved through the seam, so a player cannot propose against an entity
    // they cannot see: they get the same 404 as if it did not exist.
    if (!(await repoOf(kind).get(ctxOf(req), entityId))) throw notFound('entity')
    const { body } = PassageProposeBody.parse(req.body)
    assertPassageBodyWithinLimit(body, limits)
    await assertCanCreatePassage(deps.db, ctxOf(req).worldId, entityId, limits)
    assertCanProposePassage(await countPendingProposals(ctxOf(req), accountOf(req).id), limits)
    const passage = await proposePassage(ctxOf(req), { entityId, body }, accountOf(req).id)
    return reply.code(201).send({ passage })
  })
  app.post('/api/worlds/:worldId/passages/:id/accept', inWorld, async (req) => {
    const { visibility } = PassageAcceptBody.parse(req.body)
    const passage = await acceptPassage(ctxOf(req), param(req, 'id'), visibility)
    if (!passage) throw notFound('passage')
    // An accepted proposal becomes part of the entity's prose, so its brackets
    // become relationships. A REJECTED one never does, which is why reject has
    // no matching call.
    await reconcileBrackets(ctxOf(req), passage.entity_id)
    return { passage }
  })
  app.post('/api/worlds/:worldId/passages/:id/reject', inWorld, async (req) => {
    if (!(await rejectPassage(ctxOf(req), param(req, 'id')))) throw notFound('passage')
    return { ok: true }
  })
  app.patch('/api/worlds/:worldId/passages/:id', inWorld, async (req) => {
    const patch = PassagePatchBody.parse(req.body)
    if (patch.body !== undefined) assertPassageBodyWithinLimit(patch.body, limits)
    const passage = await updatePassage(ctxOf(req), param(req, 'id'), patch)
    if (!passage) throw notFound('passage')
    // Both halves of a passage edit matter here: changing its BODY changes which
    // links it makes, and changing its VISIBILITY changes whether it is still
    // the most visible source for a pair it shares with the description.
    await reconcileBrackets(ctxOf(req), passage.entity_id)
    return { passage }
  })
  app.delete('/api/worlds/:worldId/passages/:id', inWorld, async (req) => {
    // Read BEFORE the delete: a soft-deleted passage still exists, but this is
    // the last moment its parent is reachable through the seam by id alone.
    const doomed = await getPassage(ctxOf(req), param(req, 'id'))
    if (!(await deletePassage(ctxOf(req), param(req, 'id')))) throw notFound('passage')
    // Passages are SOFT-deleted, so the 0021 foreign key's cascade never fires.
    // Reconciliation is what retires the relationships this passage sourced:
    // its text has left the source set, so each row falls back to another
    // source or goes with it.
    if (doomed) await reconcileBrackets(ctxOf(req), doomed.entity_id)
    return { ok: true }
  })
  app.get('/api/worlds/:worldId/passages/:id/grants', inWorld, async (req) => ({
    accountIds: await listPassageGrants(ctxOf(req), param(req, 'id')),
  }))
  app.post('/api/worlds/:worldId/passages/:id/grants', inWorld, async (req, reply) => {
    const { accountId } = GrantBody.parse(req.body)
    if (!(await getPassage(ctxOf(req), param(req, 'id')))) throw notFound('passage')
    await grantPassageVisibility(ctxOf(req), param(req, 'id'), accountId)
    return reply.code(204).send()
  })
  app.delete('/api/worlds/:worldId/passages/:id/grants/:accountId', inWorld, async (req, reply) => {
    await revokePassageVisibility(ctxOf(req), param(req, 'id'), param(req, 'accountId'))
    return reply.code(204).send()
  })

  // ── world dashboard (the world root: role-aware arrival screen) ──
  // Composed entirely from seam reads — see the docstring on buildWorldDashboard.
  app.get('/api/worlds/:worldId/dashboard', inWorld, async (req) => ({
    dashboard: await buildWorldDashboard(ctxOf(req)),
  }))

  // ── wiki (browse index + link graph) ──
  app.get('/api/worlds/:worldId/wiki', inWorld, async (req) => ({
    entries: await listWikiEntities(ctxOf(req)),
  }))
  app.get('/api/worlds/:worldId/graph', inWorld, async (req) => ({
    graph: await buildEntityGraph(ctxOf(req)),
  }))

  // ── per-entity session history (which sessions touch/bracket this entity) ──
  app.get('/api/worlds/:worldId/entities/:kind/:id/sessions', inWorld, async (req) => ({
    sessions: await listSessionsForEntity(ctxOf(req), param(req, 'kind'), param(req, 'id')),
  }))

  // ── media attachments (images hung off an entity) ──
  // Media visibility IS its owner entity's: both routes first resolve the owner
  // through the content seam (repoOf(...).get), which returns undefined when the
  // actor may not see it — so a player can neither list nor fetch the bytes of
  // media on a dm_only/restricted entity they lack a grant for.

  /**
   * The raw bytes of an upload. The content-type parser hands us a Buffer for
   * the image types it accepts; anything else reaches here as a parsed JSON body
   * or nothing at all, and is refused rather than coerced.
   */
  function uploadBody(req: FastifyRequest): Buffer {
    if (!Buffer.isBuffer(req.body)) {
      throw new UnsupportedImageError(
        'send the image as the request body with a JPEG, PNG, or WebP content type',
      )
    }
    return req.body
  }

  /**
   * The shared upload path: identify the bytes, check both ceilings, write the
   * file, then insert the row.
   *
   * Order is load-bearing. Identification comes first because an unrecognised
   * file should be refused before anything is measured against a quota. Both
   * limits are checked BEFORE any byte is written, so a refused upload costs no
   * disk. The row lands LAST, so a crash leaves an unreferenced file — inert —
   * rather than a row pointing at bytes that are not there.
   */
  async function storeUpload(
    req: FastifyRequest,
    opts: {
      ownerKind: string
      ownerId: string
      /** Closed vocabulary — every attachment is an image; this says what for. */
      mediaKind: MediaKind
      maxBytes: number
      limitName: keyof ResourceLimits
      what: string
    },
  ): Promise<{ media: MediaAttachment; width: number; height: number }> {
    const bytes = uploadBody(req)
    const { mime, width, height } = identifyImage(bytes)
    assertFileWithinLimit(bytes.length, opts.maxBytes, opts.limitName, opts.what)
    const ctx = ctxOf(req)
    await assertMediaUploadAllowed(deps.db, ctx.worldId, bytes.length, limits)

    const id = newId()
    const filePath = mediaFilePath(ctx.worldId, opts.ownerKind, opts.ownerId, id, mime)
    await writeMediaFile(uploadsDir, filePath, bytes)
    const media = await createMediaAttachment(
      ctx,
      {
        owner_kind: opts.ownerKind,
        owner_id: opts.ownerId,
        media_kind: opts.mediaKind,
        file_path: filePath,
        original_filename: UploadQuery.parse(req.query).filename ?? `upload${extname(filePath)}`,
        mime_type: mime,
        byte_size: bytes.length,
      },
      id,
    )
    // Dimensions ride back rather than into the row: `media_attachments` has no
    // columns for them, but `maps` does, and the map upload needs them.
    return { media, width, height }
  }
  app.get('/api/worlds/:worldId/entities/:kind/:id/media', inWorld, async (req) => {
    const kind = param(req, 'kind')
    const id = param(req, 'id')
    if (!(await repoOf(kind).get(ctxOf(req), id))) throw notFound('entity')
    return { media: await listMediaForOwner(ctxOf(req), kind, id) }
  })
  app.get('/api/worlds/:worldId/media/:id/raw', inWorld, async (req, reply) => {
    const media = await getMediaById(ctxOf(req), param(req, 'id'))
    if (!media) throw notFound('media')
    if (!(await repoOf(media.owner_kind).get(ctxOf(req), media.owner_id))) throw notFound('media')
    // `?variant=thumbnail` serves the browser-generated preview; anything else
    // serves the source. A row with no thumbnail falls back rather than 404ing,
    // because "no thumbnail yet" is a legal state (the importer makes such rows,
    // and so does a source upload whose thumbnail request never arrived).
    const wantsThumb = MediaVariantQuery.parse(req.query).variant === 'thumbnail'
    const path = (wantsThumb ? media.thumbnail_path : null) ?? media.file_path
    // Contain the DB-supplied path within the uploads root (defense in depth).
    const abs = join(uploadsDir, path)
    const rel = relative(uploadsDir, abs)
    if (rel.startsWith('..') || isAbsolute(rel)) throw notFound('media')
    const bytes = await readFile(abs).catch(() => null)
    if (!bytes) throw notFound('media')
    // A thumbnail is always a JPEG the browser made; only the source is
    // guaranteed to be the mime the row records.
    return reply.type(path === media.file_path ? media.mime_type : 'image/jpeg').send(bytes)
  })

  /**
   * Upload an image to an entity. The body IS the file; the filename rides in a
   * query parameter and is recorded for display only — it never reaches a path.
   *
   * Owner-gated by `createMediaAttachment`, which goes through the same
   * `assertContentWrite` every content mutation does. The owner entity is
   * resolved through the seam first, so uploading to an entity you cannot see is
   * a 404 for the same reason reading it is.
   */
  app.post('/api/worlds/:worldId/entities/:kind/:id/media', inWorld, async (req, reply) => {
    const kind = param(req, 'kind')
    const ownerId = param(req, 'id')
    if (!(await repoOf(kind).get(ctxOf(req), ownerId))) throw notFound('entity')
    const { media } = await storeUpload(req, {
      ownerKind: kind,
      ownerId,
      mediaKind: 'image',
      maxBytes: limits.imageBytes,
      limitName: 'imageBytes',
      what: 'image',
    })
    return reply.code(201).send({ media })
  })

  /**
   * Set (or clear) THE image for an entity — the one its page leads with.
   *
   * Owner-gated by `setPrimaryMedia`, through the same `assertContentWrite`
   * every content mutation goes through. Hiding the control from a player is
   * presentation; this is the refusal.
   */
  app.get('/api/worlds/:worldId/entities/:kind/:id/media/primary', inWorld, async (req) => {
    const kind = param(req, 'kind')
    const ownerId = param(req, 'id')
    if (!(await repoOf(kind).get(ctxOf(req), ownerId))) throw notFound('entity')
    // One row or none. The page draws the avatar before anything else and does
    // not otherwise need the gallery, so it never pays for twenty photographs
    // to render one.
    return { media: (await findPrimaryMedia(ctxOf(req), kind, ownerId)) ?? null }
  })

  app.put('/api/worlds/:worldId/entities/:kind/:id/media/primary', inWorld, async (req) => {
    const kind = param(req, 'kind')
    const ownerId = param(req, 'id')
    if (!(await repoOf(kind).get(ctxOf(req), ownerId))) throw notFound('entity')
    const { mediaId } = PrimaryMediaBody.parse(req.body)
    if (!(await setPrimaryMedia(ctxOf(req), kind, ownerId, mediaId))) throw notFound('media')
    return { media: await findPrimaryMedia(ctxOf(req), kind, ownerId) }
  })

  /**
   * Attach the browser-generated thumbnail to a media row created moments ago.
   * A separate request from the source upload — see `attachThumbnail` for why —
   * so this failing leaves a usable attachment with no preview rather than no
   * attachment at all.
   */
  app.post('/api/worlds/:worldId/media/:id/thumbnail', inWorld, async (req) => {
    const bytes = uploadBody(req)
    assertFileWithinLimit(bytes.length, limits.thumbnailBytes, 'thumbnailBytes', 'thumbnail')
    await assertMediaUploadAllowed(deps.db, ctxOf(req).worldId, bytes.length, limits)
    const media = await attachThumbnail(ctxOf(req), uploadsDir, param(req, 'id'), bytes)
    if (!media) throw notFound('media')
    return { media }
  })

  /** Delete an attachment — row and bytes together, so the cap cannot drift. */
  app.delete('/api/worlds/:worldId/media/:id', inWorld, async (req) => {
    if (!(await deleteMediaAttachment(ctxOf(req), uploadsDir, param(req, 'id')))) {
      throw notFound('media')
    }
    return { ok: true }
  })

  // ── maps (world-level images, with pins onto entities) ──
  // A map rides the SAME content seam as an entity — `repoOf('map')` is an
  // instance of it over the `maps` table — so `maps.visibility` behaves exactly
  // like an entity's and no per-route visibility logic exists here to disagree
  // with it. Every route below is a thin wrapper over that seam.
  const mapRepo = repoOf('map')

  app.get('/api/worlds/:worldId/maps', inWorld, async (req) => ({
    maps: await mapRepo.list(ctxOf(req)),
  }))
  app.post('/api/worlds/:worldId/maps', inWorld, async (req, reply) => {
    const map = await mapRepo.create(ctxOf(req), MapCreateBody.parse(req.body))
    return reply.code(201).send({ map })
  })
  app.get('/api/worlds/:worldId/maps/:id', inWorld, async (req) => {
    const map = await mapRepo.get(ctxOf(req), param(req, 'id'))
    if (!map) throw notFound('map')
    // The image travels with the map so the viewer has everything it needs to
    // draw in one request — it cannot render without both the bytes' URL and
    // the source dimensions the pin transform is built on.
    return { map, image: await getMapImage(ctxOf(req), param(req, 'id')) }
  })
  app.patch('/api/worlds/:worldId/maps/:id', inWorld, async (req) => {
    const map = await mapRepo.update(ctxOf(req), param(req, 'id'), MapPatchBody.parse(req.body))
    if (!map) throw notFound('map')
    return { map }
  })
  app.delete('/api/worlds/:worldId/maps/:id', inWorld, async (req) => {
    if (!(await mapRepo.softDelete(ctxOf(req), param(req, 'id')))) throw notFound('map')
    return { ok: true }
  })

  /**
   * Upload (or replace) the image a map displays.
   *
   * Same pipeline as an entity image, with a larger per-file ceiling — a city
   * map is not a portrait — and one extra step: the source dimensions are
   * recorded on the map row. They are read from the header here rather than
   * accepted from the client, because a client that could set them could put
   * every pin on that map in the wrong place.
   */
  app.post('/api/worlds/:worldId/maps/:id/image', inWorld, async (req, reply) => {
    const mapId = param(req, 'id')
    if (!(await mapRepo.get(ctxOf(req), mapId))) throw notFound('map')
    const { media, width, height } = await storeUpload(req, {
      ownerKind: 'map',
      ownerId: mapId,
      mediaKind: MAP_MEDIA_KIND,
      maxBytes: limits.mapImageBytes,
      limitName: 'mapImageBytes',
      what: 'map image',
    })
    await setMapSourceDimensions(ctxOf(req), mapId, width, height)
    return reply.code(201).send({ media, sourceWidth: width, sourceHeight: height })
  })

  // ── map pins (markers on a map that name an entity) ──
  // Two visibility axes meet here and BOTH are enforced: the map is resolved
  // through the seam (so a hidden map's pins are unreachable), and each pin's
  // TARGET is resolved through it too inside `listPinsForMap` — because the map
  // being visible says nothing about the entity a pin names, and the pin's own
  // free-text label can spell out a secret the entity's name never would.
  app.get('/api/worlds/:worldId/maps/:id/pins', inWorld, async (req) => {
    const mapId = param(req, 'id')
    if (!(await mapRepo.get(ctxOf(req), mapId))) throw notFound('map')
    return { pins: await listPinsForMap(ctxOf(req), mapId) }
  })
  app.post('/api/worlds/:worldId/maps/:id/pins', inWorld, async (req, reply) => {
    const mapId = param(req, 'id')
    if (!(await mapRepo.get(ctxOf(req), mapId))) throw notFound('map')
    const b = PinCreateBody.parse(req.body)
    // The target is resolved through the seam before the insert so a pin can
    // never be created against something the actor cannot see.
    if (!(await repoOf(b.kind).get(ctxOf(req), b.entityId))) throw notFound('entity')
    const pin = await createPin(ctxOf(req), {
      map_id: mapId,
      entity_id: b.entityId,
      x: b.x,
      y: b.y,
      ...(b.label === undefined ? {} : { label: b.label }),
    })
    return reply.code(201).send({ pin })
  })
  app.patch('/api/worlds/:worldId/maps/:mapId/pins/:id', inWorld, async (req) => {
    if (!(await mapRepo.get(ctxOf(req), param(req, 'mapId')))) throw notFound('map')
    const pin = await updatePin(ctxOf(req), param(req, 'id'), PinPatchBody.parse(req.body))
    if (!pin) throw notFound('pin')
    return { pin }
  })
  app.delete('/api/worlds/:worldId/maps/:mapId/pins/:id', inWorld, async (req) => {
    if (!(await mapRepo.get(ctxOf(req), param(req, 'mapId')))) throw notFound('map')
    if (!(await deletePin(ctxOf(req), param(req, 'id')))) throw notFound('pin')
    return { ok: true }
  })

  // ── typed relationships (HOW two entities relate, beyond a bracket mention) ──
  // A relationship names TWO entities, so it is readable only when both are
  // visible — a rule the content seam cannot apply on a row's own behalf, and
  // which `data/relationships.ts` applies explicitly on every read.
  // ── per-map visibility grants (which players may see a `restricted` map) ──
  // Setting the LEVEL is a normal owner map PATCH; these manage the grant list.
  // Maps read their grants from `map_visibility`, not `entity_visibility` — see
  // migration 0016 for why a map needs an ACL of its own.
  app.get('/api/worlds/:worldId/maps/:id/grants', inWorld, async (req) => ({
    accountIds: await listMapGrants(ctxOf(req), param(req, 'id')),
  }))
  app.post('/api/worlds/:worldId/maps/:id/grants', inWorld, async (req, reply) => {
    const { accountId } = GrantBody.parse(req.body)
    if (!(await repoOf('map').get(ctxOf(req), param(req, 'id')))) throw notFound('map')
    await grantMapVisibility(ctxOf(req), param(req, 'id'), accountId)
    return reply.code(204).send()
  })
  app.delete('/api/worlds/:worldId/maps/:id/grants/:accountId', inWorld, async (req, reply) => {
    await revokeMapVisibility(ctxOf(req), param(req, 'id'), param(req, 'accountId'))
    return reply.code(204).send()
  })

  app.get('/api/worlds/:worldId/entities/:kind/:id/relationships', inWorld, async (req) => {
    const id = param(req, 'id')
    if (!(await repoOf(param(req, 'kind')).get(ctxOf(req), id))) throw notFound('entity')
    return { relationships: await listRelationshipsForEntity(ctxOf(req), id) }
  })
  app.post('/api/worlds/:worldId/entities/:kind/:id/relationships', inWorld, async (req, reply) => {
    const fromId = param(req, 'id')
    if (!(await repoOf(param(req, 'kind')).get(ctxOf(req), fromId))) throw notFound('entity')
    const b = RelationshipBody.parse(req.body)
    const relationship = await createRelationship(ctxOf(req), {
      fromId,
      toId: b.toId,
      type: b.type,
      ...(b.note === undefined ? {} : { note: b.note }),
      ...(b.qualifier === undefined ? {} : { qualifier: b.qualifier }),
    })
    return reply.code(201).send({ relationship })
  })
  /**
   * Specify a relationship further: change its type, add a qualifier or a note.
   *
   * The reason this route exists is the bracket-derived row. A `[[link]]`
   * creates one at `related_to`, and a GM saying what the link actually IS must
   * not have to delete it and type a new one — deleting would lose the
   * `source_passage_id` that governs who may see it, publishing a secret the
   * moment they typed it more precisely.
   */
  app.patch('/api/worlds/:worldId/relationships/:id', inWorld, async (req) => {
    const patch = RelationshipPatchBody.parse(req.body)
    const relationship = await updateRelationship(ctxOf(req), param(req, 'id'), patch)
    if (!relationship) throw notFound('relationship')
    return { relationship }
  })
  app.delete('/api/worlds/:worldId/relationships/:id', inWorld, async (req) => {
    if (!(await deleteRelationship(ctxOf(req), param(req, 'id')))) throw notFound('relationship')
    return { ok: true }
  })

  /*
    ── currency attachments: which currencies a settlement or organization uses ──

    Two visibility rules apply to every read here and each alone is a leak — the
    row's own `visibility` (the content seam, since these ARE content tables) and
    the CURRENCY it names (resolved through the seam and the row dropped whole).
    `data/currency-attachments.ts` carries the argument; this is the first module
    in the codebase needing both at once.

    The owner kind is a path segment rather than a body field so the two owner
    kinds share one route shape, matching the one panel that renders them. It is
    validated against the two kinds that HAVE an attachment table, not against
    the entity registry: `/entities/npc/<id>/currencies` names a real kind with no
    such table, and a 404 is the honest answer.
  */
  const attachmentOwnerKind = (req: FastifyRequest): AttachmentOwnerKind => {
    const kind = param(req, 'kind')
    if (!isAttachmentOwnerKind(kind)) throw notFound(`no currencies on kind: ${kind}`)
    return kind
  }

  app.get('/api/worlds/:worldId/entities/:kind/:id/currencies', inWorld, async (req) => ({
    attachments: await listAttachmentsForOwner(
      ctxOf(req),
      attachmentOwnerKind(req),
      param(req, 'id'),
    ),
  }))
  app.post('/api/worlds/:worldId/entities/:kind/:id/currencies', inWorld, async (req, reply) => {
    const b = AttachmentBody.parse(req.body)
    const attachment = await attachCurrency(
      ctxOf(req),
      attachmentOwnerKind(req),
      param(req, 'id'),
      {
        currencyId: b.currencyId,
        ...(b.isPrimary === undefined ? {} : { isPrimary: b.isPrimary }),
        ...(b.notes === undefined ? {} : { notes: b.notes }),
        ...(b.visibility === undefined ? {} : { visibility: b.visibility }),
      },
    )
    return reply.code(201).send({ attachment })
  })
  /*
    Editing and detaching key off the ATTACHMENT's id, so they sit on their own
    flat path rather than under the owner — the shape `/relationships/:id`
    already uses for the same reason. Nesting them would put a static segment
    beside `:id` at the same level (`/entities/:kind/:id/currencies` against
    `/entities/:kind/currencies/:id`), where an entity whose id is literally
    "currencies" routes to the wrong handler.

    `:kind` stays in the path because it names which of the two TABLES the id
    lives in. It is not redundant with the id: the two tables mint ids from the
    same generator, so without it a settlement attachment's id would have to be
    looked for in both.
  */
  app.patch('/api/worlds/:worldId/currency-attachments/:kind/:id', inWorld, async (req) => {
    const b = AttachmentPatchBody.parse(req.body)
    const attachment = await updateAttachment(
      ctxOf(req),
      attachmentOwnerKind(req),
      param(req, 'id'),
      {
        ...(b.isPrimary === undefined ? {} : { isPrimary: b.isPrimary }),
        ...(b.notes === undefined ? {} : { notes: b.notes }),
        ...(b.visibility === undefined ? {} : { visibility: b.visibility }),
      },
    )
    if (!attachment) throw notFound('attachment')
    return { attachment }
  })
  app.delete('/api/worlds/:worldId/currency-attachments/:kind/:id', inWorld, async (req) => {
    if (!(await detachCurrency(ctxOf(req), attachmentOwnerKind(req), param(req, 'id')))) {
      throw notFound('attachment')
    }
    return { ok: true }
  })

  /**
   * The settlements and organizations that use a currency — the inverse read,
   * and the cross-reference section on a currency's own page. Owner-filtered as
   * well as row-filtered: a player must not learn that a `dm_only` settlement
   * uses the coin they are looking at.
   */
  app.get('/api/worlds/:worldId/currencies/:id/users', inWorld, async (req) => {
    const id = param(req, 'id')
    if (!(await repoOf('currency').get(ctxOf(req), id))) throw notFound('currency')
    return { users: await listOwnersOfCurrency(ctxOf(req), id) }
  })

  /** The maps an entity is pinned on — the reverse lookup, map-visibility filtered. */
  app.get('/api/worlds/:worldId/entities/:kind/:id/maps', inWorld, async (req) => {
    const id = param(req, 'id')
    if (!(await repoOf(param(req, 'kind')).get(ctxOf(req), id))) throw notFound('entity')
    return { maps: await listMapsForEntity(ctxOf(req), id) }
  })

  /*
    ── calendars: WORLD CONFIG, DELIBERATELY OFF THE CONTENT SEAM ──

    Reads are open to every world member and writes are owner-only, which is the
    world's NAME's authorization shape rather than an entity's. `calendars` has no
    `visibility` and no `deleted_at`, so it is not a `ContentTableName` and there
    is no seam repo to route through — that is the decision, not an oversight, and
    `data/calendars.ts` carries the full argument. `inWorld` has already proven
    membership here; the owner gate lives in the data module so it cannot be
    forgotten by a second caller.
  */
  app.get('/api/worlds/:worldId/calendars', inWorld, async (req) => ({
    calendars: await listCalendars(ctxOf(req)),
  }))
  /** The one calendar dates render through, or null. Its own route because the
      session date field needs exactly this and nothing else. */
  app.get('/api/worlds/:worldId/calendars/active', inWorld, async (req) => ({
    calendar: await getActiveCalendar(ctxOf(req)),
  }))
  app.post('/api/worlds/:worldId/calendars', inWorld, async (req, reply) => {
    const b = CalendarBody.parse(req.body)
    const calendar = await createCalendar(ctxOf(req), {
      name: b.name,
      kind: b.kind,
      ...(b.config === undefined ? {} : { config: b.config }),
    })
    return reply.code(201).send({ calendar })
  })
  app.patch('/api/worlds/:worldId/calendars/:id', inWorld, async (req) => {
    const b = CalendarPatchBody.parse(req.body)
    const calendar = await updateCalendar(ctxOf(req), param(req, 'id'), {
      ...(b.name === undefined ? {} : { name: b.name }),
      ...(b.kind === undefined ? {} : { kind: b.kind }),
      ...(b.config === undefined ? {} : { config: b.config }),
    })
    if (!calendar) throw notFound('calendar')
    return { calendar }
  })
  app.post('/api/worlds/:worldId/calendars/:id/activate', inWorld, async (req) => {
    if (!(await activateCalendar(ctxOf(req), param(req, 'id')))) throw notFound('calendar')
    return { calendars: await listCalendars(ctxOf(req)) }
  })
  app.delete('/api/worlds/:worldId/calendars/:id', inWorld, async (req) => {
    if (!(await deleteCalendar(ctxOf(req), param(req, 'id')))) throw notFound('calendar')
    return { ok: true }
  })

  // ── session touches (the structured interaction records) ──
  app.get('/api/worlds/:worldId/sessions/:sessionId/touches', inWorld, async (req) => ({
    touches: await listTouchesForSession(ctxOf(req), param(req, 'sessionId')),
  }))
  app.post('/api/worlds/:worldId/sessions/:sessionId/touches', inWorld, async (req, reply) => {
    const b = TouchBody.parse(req.body)
    const input: {
      session_id: string
      entity_id: string
      touch_type: TouchType
      narrative_delta?: string
    } = {
      session_id: param(req, 'sessionId'),
      entity_id: b.entityId,
      touch_type: b.touchType,
    }
    if (b.narrativeDelta !== undefined) input.narrative_delta = b.narrativeDelta
    const touch = await createTouch(ctxOf(req), input)
    return reply.code(201).send({ touch })
  })
  app.delete('/api/worlds/:worldId/sessions/:sessionId/touches/:id', inWorld, async (req) => {
    if (!(await deleteTouch(ctxOf(req), param(req, 'id')))) throw notFound('touch')
    return { ok: true }
  })

  // ── player data ──
  app.get('/api/worlds/:worldId/notes', inWorld, async (req) => ({
    notes: await listNotes(ctxOf(req)),
  }))
  app.post('/api/worlds/:worldId/notes', inWorld, async (req, reply) => {
    const note = await createNote(ctxOf(req), NoteBody.parse(req.body))
    return reply.code(201).send({ note })
  })
  app.patch('/api/worlds/:worldId/notes/:id', inWorld, async (req) => {
    const note = await updateNote(ctxOf(req), param(req, 'id'), NoteBody.parse(req.body))
    if (!note) throw notFound('note')
    return { note }
  })
  app.delete('/api/worlds/:worldId/notes/:id', inWorld, async (req) => {
    if (!(await deleteNote(ctxOf(req), param(req, 'id')))) throw notFound('note')
    return { ok: true }
  })
  // ── suggestions ──
  app.get('/api/worlds/:worldId/suggestions', inWorld, async (req) => ({
    suggestions: await listSuggestions(ctxOf(req)),
  }))
  app.post('/api/worlds/:worldId/suggestions', inWorld, async (req, reply) => {
    // The PROPOSE side only. Accept/reject are GM actions on suggestions that
    // already exist; gating them would strand anything already in the queue.
    requireSurface(flags.suggestionsEnabled, 'sending suggestions')
    const suggestion = await proposeSuggestion(ctxOf(req), ProposeBody.parse(req.body))
    return reply.code(201).send({ suggestion })
  })
  app.post('/api/worlds/:worldId/suggestions/:id/accept', inWorld, async (req) => {
    const suggestion = await acceptSuggestion(ctxOf(req), param(req, 'id'))
    if (!suggestion) throw notFound('suggestion')
    return { suggestion }
  })
  app.post('/api/worlds/:worldId/suggestions/:id/reject', inWorld, async (req) => {
    const suggestion = await rejectSuggestion(ctxOf(req), param(req, 'id'))
    if (!suggestion) throw notFound('suggestion')
    return { suggestion }
  })

  // ── import / export ──
  app.get('/api/worlds/:worldId/export', inWorld, async (req) => await exportWorld(ctxOf(req)))
  app.post('/api/worlds/import', authed, async (req, reply) => {
    await requireVerified(accountOf(req).id, 'import a world')
    await assertCanCreateWorld(deps.db, accountOf(req).id, limits)
    const { name, data } = ImportBody.parse(req.body)
    const world = await tenancy.createWorld(accountOf(req).id, name)
    const counts = await importWorldExport(deps.db, world.id, data)
    // Checked AFTER the rows land, because the payload's media size is only
    // knowable once parsed. The whole route runs inside no transaction today,
    // so a world over the line is deleted rather than left half-imported.
    try {
      await assertMediaWithinLimit(deps.db, world.id, limits)
    } catch (err) {
      await tenancy.deleteWorld(accountOf(req).id, world.id)
      throw err
    }
    return reply.code(201).send({ worldId: world.id, slug: world.slug, counts })
  })

  // ── static web SPA (single origin) ──
  if (deps.webDistDir) {
    void app.register(fastifyStatic, { root: deps.webDistDir, wildcard: false })
    // Unknown GETs that aren't API calls are client-side routes → serve the SPA
    // shell so deep links / refreshes work; everything else stays a JSON 404.
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api')) {
        return reply.sendFile('index.html')
      }
      return reply.code(404).send({ error: { code: 'not_found', message: 'not found' } })
    })
  }

  return app
}
