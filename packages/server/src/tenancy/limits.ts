import type { Kysely } from 'kysely'
import type { Database } from '../db/schema'

/**
 * Per-account and per-world resource ceilings.
 *
 * These complement task 3551's request-rate limiting rather than duplicating
 * it. Rate limiting caps how FAST one caller can act; it does nothing about how
 * MUCH one persistent actor accumulates. A script kept politely under the rate
 * limit can still fill a small VPS's disk over a weekend. This is the other
 * half: a ceiling on the total.
 *
 * Every limit is read from the environment, because the right number for a
 * portfolio demo and for a real user base are different and neither should
 * require a code change. The defaults are sized for the former.
 */

export interface ResourceLimits {
  /** Worlds one account may own. */
  worldsPerAccount: number
  /** Content rows one world may hold. */
  entitiesPerWorld: number
  /** Total bytes of media attachments one world may hold. */
  mediaBytesPerWorld: number
  /** Bytes one image attached to an entity may weigh. */
  imageBytes: number
  /** Bytes one map image may weigh — larger, because a city map is not a portrait. */
  mapImageBytes: number
  /** Bytes one browser-generated thumbnail may weigh. */
  thumbnailBytes: number
  /** Staged-reveal passages one entity may hold, live proposals included. */
  passagesPerEntity: number
  /** Characters one passage's body may run to. */
  passageBodyChars: number
  /** Proposals one player may have awaiting review in one world. */
  pendingProposalsPerAuthor: number
}

const MB = 1024 * 1024

export const DEFAULT_LIMITS: ResourceLimits = {
  worldsPerAccount: 5,
  entitiesPerWorld: 2_000,
  mediaBytesPerWorld: 100 * MB,
  imageBytes: 5 * MB,
  mapImageBytes: 25 * MB,
  thumbnailBytes: 512 * 1024,
  passagesPerEntity: 100,
  passageBodyChars: 20_000,
  pendingProposalsPerAuthor: 20,
}

/**
 * Read one limit from the environment. A missing, unparseable, or non-positive
 * value falls back to the default — a typo in an env var must not silently
 * remove a ceiling, the same fail-safe reasoning as `parseFlag`.
 */
export function parseLimit(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback
  const n = Number(raw.trim())
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return fallback
  return n
}

export function loadLimits(env: NodeJS.ProcessEnv = process.env): ResourceLimits {
  return {
    worldsPerAccount: parseLimit(env.MAX_WORLDS_PER_ACCOUNT, DEFAULT_LIMITS.worldsPerAccount),
    entitiesPerWorld: parseLimit(env.MAX_ENTITIES_PER_WORLD, DEFAULT_LIMITS.entitiesPerWorld),
    mediaBytesPerWorld: parseLimit(
      env.MAX_MEDIA_BYTES_PER_WORLD,
      DEFAULT_LIMITS.mediaBytesPerWorld,
    ),
    imageBytes: parseLimit(env.MAX_IMAGE_BYTES, DEFAULT_LIMITS.imageBytes),
    mapImageBytes: parseLimit(env.MAX_MAP_IMAGE_BYTES, DEFAULT_LIMITS.mapImageBytes),
    thumbnailBytes: parseLimit(env.MAX_THUMBNAIL_BYTES, DEFAULT_LIMITS.thumbnailBytes),
    passagesPerEntity: parseLimit(env.MAX_PASSAGES_PER_ENTITY, DEFAULT_LIMITS.passagesPerEntity),
    passageBodyChars: parseLimit(env.MAX_PASSAGE_BODY_CHARS, DEFAULT_LIMITS.passageBodyChars),
    pendingProposalsPerAuthor: parseLimit(
      env.MAX_PENDING_PROPOSALS_PER_AUTHOR,
      DEFAULT_LIMITS.pendingProposalsPerAuthor,
    ),
  }
}

/**
 * The largest single request body any upload route accepts, used as fastify's
 * `bodyLimit` so an oversized upload is refused at the socket rather than
 * buffered in full and then rejected. Deliberately the MAXIMUM across the
 * per-file limits: the route still applies its own, tighter one, and a limit
 * that varied per route would mean the frame parser had to know which route it
 * was serving before it had parsed anything.
 *
 * Only the BYTE limits belong here. `passagesPerEntity` and `passageBodyChars`
 * count rows and characters, not upload bytes, and folding either into the
 * socket-level ceiling would silently raise it.
 */
export function maxUploadBytes(limits: ResourceLimits): number {
  return Math.max(limits.imageBytes, limits.mapImageBytes, limits.thumbnailBytes)
}

/**
 * Raised when a resource ceiling is reached. Carries the limit and what it
 * counts, so the refusal tells the user what to do instead of just "no".
 */
export class LimitReachedError extends Error {
  constructor(
    readonly limit: keyof ResourceLimits,
    readonly max: number,
    message: string,
  ) {
    super(message)
    this.name = 'LimitReachedError'
  }
}

/** Worlds this account currently owns. */
export async function countOwnedWorlds(db: Kysely<Database>, accountId: string): Promise<number> {
  const row = await db
    .selectFrom('worlds')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('owner_id', '=', accountId)
    .executeTakeFirstOrThrow()
  return Number(row.n)
}

/** Live (not soft-deleted) content rows in a world. */
export async function countEntities(db: Kysely<Database>, worldId: string): Promise<number> {
  const row = await db
    .selectFrom('entities')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('world_id', '=', worldId)
    .where('deleted_at', 'is', null)
    .executeTakeFirstOrThrow()
  return Number(row.n)
}

/**
 * Total media bytes in a world. Two doors create media rows — world import and,
 * since chain 451, upload — and both read this one count, so neither can drift
 * into a ceiling of its own.
 */
export async function countMediaBytes(db: Kysely<Database>, worldId: string): Promise<number> {
  const row = await db
    .selectFrom('media_attachments')
    .select((eb) => eb.fn.sum<string | null>('byte_size').as('n'))
    .where('world_id', '=', worldId)
    .where('deleted_at', 'is', null)
    .executeTakeFirstOrThrow()
  return Number(row.n ?? 0)
}

/** Refuse if the account already owns its allowance of worlds. */
export async function assertCanCreateWorld(
  db: Kysely<Database>,
  accountId: string,
  limits: ResourceLimits,
): Promise<void> {
  if ((await countOwnedWorlds(db, accountId)) >= limits.worldsPerAccount) {
    throw new LimitReachedError(
      'worldsPerAccount',
      limits.worldsPerAccount,
      `you already own the maximum of ${limits.worldsPerAccount} worlds — delete or transfer one first`,
    )
  }
}

/** Refuse if the world is already at its content ceiling. */
export async function assertCanCreateEntity(
  db: Kysely<Database>,
  worldId: string,
  limits: ResourceLimits,
): Promise<void> {
  if ((await countEntities(db, worldId)) >= limits.entitiesPerWorld) {
    throw new LimitReachedError(
      'entitiesPerWorld',
      limits.entitiesPerWorld,
      `this world has reached its maximum of ${limits.entitiesPerWorld} pages — delete some before adding more`,
    )
  }
}

/**
 * Refuse if one file is over its own ceiling. Checked BEFORE the world total,
 * because "that image is too big" is a more useful thing to be told than "this
 * world is full" when the truth is both.
 */
export function assertFileWithinLimit(
  byteSize: number,
  max: number,
  limit: keyof ResourceLimits,
  what: string,
): void {
  if (byteSize > max) {
    throw new LimitReachedError(
      limit,
      max,
      `that ${what} is ${Math.round(byteSize / MB)} MB — the maximum is ${Math.round(max / MB)} MB`,
    )
  }
}

/**
 * Refuse if adding `pendingBytes` would put the world over its media allowance.
 *
 * Checked BEFORE any bytes are written, unlike the post-hoc import check below:
 * an upload knows its size up front, so there is no reason to write first and
 * ask afterwards. Bytes already on disk for soft-deleted ENTITIES still count,
 * which is correct — they are still occupying the disk, and the entity is
 * restorable.
 */
export async function assertMediaUploadAllowed(
  db: Kysely<Database>,
  worldId: string,
  pendingBytes: number,
  limits: ResourceLimits,
): Promise<void> {
  const current = await countMediaBytes(db, worldId)
  if (current + pendingBytes > limits.mediaBytesPerWorld) {
    const mb = (n: number): number => Math.round(n / MB)
    throw new LimitReachedError(
      'mediaBytesPerWorld',
      limits.mediaBytesPerWorld,
      `this world holds ${mb(current)} MB of its ${mb(limits.mediaBytesPerWorld)} MB media allowance — delete something before uploading more`,
    )
  }
}

/** Live passages on one entity — proposals included, since they occupy the page too. */
export async function countPassages(
  db: Kysely<Database>,
  worldId: string,
  entityId: string,
): Promise<number> {
  const row = await db
    .selectFrom('entity_passages')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('world_id', '=', worldId)
    .where('entity_id', '=', entityId)
    .where('deleted_at', 'is', null)
    .executeTakeFirstOrThrow()
  return Number(row.n)
}

/**
 * Refuse if this entity is already at its passage ceiling.
 *
 * Counts proposals as well as published passages, so a player cannot exhaust an
 * entity's budget by proposing — the propose route shares this ceiling rather
 * than getting one of its own.
 */
export async function assertCanCreatePassage(
  db: Kysely<Database>,
  worldId: string,
  entityId: string,
  limits: ResourceLimits,
): Promise<void> {
  if ((await countPassages(db, worldId, entityId)) >= limits.passagesPerEntity) {
    throw new LimitReachedError(
      'passagesPerEntity',
      limits.passagesPerEntity,
      `this entry already has the maximum of ${limits.passagesPerEntity} passages — merge or delete some before adding more`,
    )
  }
}

/**
 * Refuse if this player already has their allowance of proposals awaiting
 * review. Separate from the per-entity ceiling: that one stops a page filling
 * up, this one stops ONE player filling the DM's review queue across a world.
 */
export function assertCanProposePassage(pending: number, limits: ResourceLimits): void {
  if (pending >= limits.pendingProposalsPerAuthor) {
    throw new LimitReachedError(
      'pendingProposalsPerAuthor',
      limits.pendingProposalsPerAuthor,
      `you already have ${limits.pendingProposalsPerAuthor} suggestions awaiting review — wait for the GM to look at those first`,
    )
  }
}

/** Refuse a passage body over its character ceiling. */
export function assertPassageBodyWithinLimit(body: string, limits: ResourceLimits): void {
  if (body.length > limits.passageBodyChars) {
    throw new LimitReachedError(
      'passageBodyChars',
      limits.passageBodyChars,
      `that passage is ${body.length} characters — the maximum is ${limits.passageBodyChars}`,
    )
  }
}

/** Refuse if a world has exceeded its media allowance. Checked after import. */
export async function assertMediaWithinLimit(
  db: Kysely<Database>,
  worldId: string,
  limits: ResourceLimits,
): Promise<void> {
  if ((await countMediaBytes(db, worldId)) > limits.mediaBytesPerWorld) {
    throw new LimitReachedError(
      'mediaBytesPerWorld',
      limits.mediaBytesPerWorld,
      `this import exceeds the ${Math.round(limits.mediaBytesPerWorld / (1024 * 1024))} MB media allowance for one world`,
    )
  }
}
