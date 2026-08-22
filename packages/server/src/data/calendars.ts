import type { CalendarConfig, CalendarKind } from '@campaign-settings/shared'
import { assertWorldOwner } from '../authz/content'
import { newId } from '../db/ids'
import type { WorldContext } from './context'

/**
 * Calendars: a world's date scheme, as WORLD CONFIGURATION.
 *
 * ## WHY THIS DOES NOT GO THROUGH THE CONTENT SEAM
 *
 * Read this before "fixing" it. `calendars` carries no `visibility` and no
 * `deleted_at`, so it does not satisfy `ContentTableName` and the authorization
 * seam does not serve it. That is deliberate, decided by Sophi on 2026-08-08:
 * "Calendars don't need to be visible/invisible, it's just part of the world
 * config."
 *
 * A calendar is not content with an audience. It is the frame the world's dates
 * are written in — the same standing as the world's NAME, which every member can
 * read and only the owner can change. There is no coherent campaign in which the
 * GM hides the calendar from a player while showing them a session dated with it:
 * the date on the session already discloses everything the calendar would.
 *
 * So the rule here is simpler than the seam's and is enforced in this module
 * rather than inherited:
 *
 *   - READS are open to every world member. `requireWorld` has already proven
 *     membership by the time a route reaches this code, so there is nothing
 *     further to check.
 *   - WRITES are owner-only, via `assertWorldOwner` — the same single gate the
 *     rest of the codebase uses, not a second copy of the role comparison.
 *
 * A consequence worth stating: because reads are open, nothing here filters by
 * actor, and no call needs the drop-the-row-whole treatment that
 * `data/relationships.ts` and `data/map-pins.ts` apply to rows naming entities.
 * A calendar names no entity.
 *
 * ## Decorative by design
 *
 * Nothing computes off a calendar. It renders a session's `played_at` through
 * `formatDate` in `packages/shared` and that is all — no arithmetic, no
 * scheduling, no derived state. Month lengths are recorded because a GM wants to
 * write them down, not because anything counts with them.
 */

/** A calendar as any world member reads it. */
export interface CalendarView {
  id: string
  name: string
  kind: CalendarKind
  config: CalendarConfig
  /** Exactly one calendar per world is active. See {@link activateCalendar}. */
  isActive: boolean
  /**
   * False for the default calendar dm-manager seeds into every world, true for
   * one the GM wrote. Carried through so the UI can say which is which; it grants
   * no different permissions.
   */
  isUserDefined: boolean
}

/**
 * A config as a REQUEST BODY presents one: every key optionally absent and
 * optionally explicitly `undefined`.
 *
 * Distinct from `CalendarConfig`, which is what a reader gets back, because
 * `exactOptionalPropertyTypes` is on: zod infers `months?: X | undefined` and that
 * does not assign to `months?: X`. Writing the looser shape once here is cheaper
 * than a normaliser whose every key is a branch the coverage gate wants a test for.
 */
export interface CalendarConfigInput {
  months?: Array<{ name: string; days: number }> | undefined
  weekdays?: string[] | undefined
  eras?: string[] | undefined
  leap_year_rule?: string | undefined
}

export interface NewCalendar {
  name: string
  kind: CalendarKind
  config?: CalendarConfigInput
}

export interface CalendarPatch {
  name?: string | undefined
  kind?: CalendarKind | undefined
  config?: CalendarConfigInput | undefined
}

/**
 * A config on its way INTO the jsonb column.
 *
 * The cast is the point: `CalendarConfig` is an interface with named keys and the
 * column's type is an index signature, which TypeScript will not bridge on its
 * own. Spreading also drops nothing — `JSON.stringify` omits `undefined` values,
 * so an explicitly-undefined key from a request body stores as absent rather than
 * as null.
 */
function configColumn(config: CalendarConfigInput): Record<string, unknown> {
  return { ...config } as Record<string, unknown>
}

interface CalendarRow {
  id: string
  name: string
  kind: string
  config: unknown
  is_active: boolean
  is_user_defined: boolean
}

/**
 * A stored `config` back into the typed shape.
 *
 * The column is jsonb and its contents predate this module — the importer copies
 * dm-manager's blob across verbatim — so a row can hold anything that was valid
 * JSON on the way in. Reading it defensively here means one bad legacy row
 * renders as an empty config rather than throwing on somebody's settings page.
 */
function toConfig(raw: unknown): CalendarConfig {
  return typeof raw === 'object' && raw !== null ? (raw as CalendarConfig) : {}
}

function toView(row: CalendarRow): CalendarView {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind as CalendarKind,
    config: toConfig(row.config),
    isActive: row.is_active,
    isUserDefined: row.is_user_defined,
  }
}

const COLUMNS = ['id', 'name', 'kind', 'config', 'is_active', 'is_user_defined'] as const

/** Every calendar in the world, active first then by name. Open to all members. */
export async function listCalendars(ctx: WorldContext): Promise<CalendarView[]> {
  const rows = await ctx.db
    .selectFrom('calendars')
    .select(COLUMNS)
    .where('world_id', '=', ctx.worldId)
    .orderBy('is_active', 'desc')
    .orderBy('name')
    .execute()
  return rows.map(toView)
}

/**
 * The world's active calendar, or null when it has none.
 *
 * Null is a real, supported state rather than an error: a world whose calendar
 * was deleted still has sessions, and they fall back to a free-text date. Callers
 * must handle it — the session date field does.
 */
export async function getActiveCalendar(ctx: WorldContext): Promise<CalendarView | null> {
  const row = await ctx.db
    .selectFrom('calendars')
    .select(COLUMNS)
    .where('world_id', '=', ctx.worldId)
    .where('is_active', '=', true)
    .executeTakeFirst()
  return row ? toView(row) : null
}

/**
 * Add a calendar (owner-only). It is NOT activated by construction — activating
 * is its own deliberate act, because it changes how every existing session's date
 * reads and that should not be a side effect of creating something.
 */
export async function createCalendar(ctx: WorldContext, input: NewCalendar): Promise<CalendarView> {
  assertWorldOwner(ctx, 'calendar create')
  const row = await ctx.db
    .insertInto('calendars')
    .values({
      id: newId(),
      world_id: ctx.worldId,
      name: input.name,
      kind: input.kind,
      config: configColumn(input.config ?? {}),
      is_user_defined: true,
    })
    .returning(COLUMNS)
    .executeTakeFirstOrThrow()
  return toView(row)
}

/** Edit a calendar's name, kind or config (owner-only). */
export async function updateCalendar(
  ctx: WorldContext,
  id: string,
  patch: CalendarPatch,
): Promise<CalendarView | undefined> {
  assertWorldOwner(ctx, 'calendar update')
  const row = await ctx.db
    .updateTable('calendars')
    .set({
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.kind === undefined ? {} : { kind: patch.kind }),
      ...(patch.config === undefined ? {} : { config: configColumn(patch.config) }),
      updated_at: new Date(),
    })
    .where('world_id', '=', ctx.worldId)
    .where('id', '=', id)
    .returning(COLUMNS)
    .executeTakeFirst()
  return row ? toView(row) : undefined
}

/**
 * Make one calendar the world's active one (owner-only).
 *
 * IN A TRANSACTION, and both statements matter. Clearing every other calendar's
 * flag and setting this one's are one atomic change because the invariant is
 * "exactly one active per world": run them apart and a failure between them
 * leaves the world with none active, silently reverting every session date to
 * free text. The clear is scoped by `world_id`, so activating a calendar in one
 * world cannot deactivate another world's.
 *
 * The `<> id` on the clear means re-activating the already-active calendar is a
 * no-op rather than a flap through the zero-active state.
 *
 * Returns false when no such calendar exists in this world, so the route can 404
 * instead of reporting success for an id it never found.
 */
export async function activateCalendar(ctx: WorldContext, id: string): Promise<boolean> {
  assertWorldOwner(ctx, 'calendar activate')
  return ctx.db.transaction().execute(async (trx) => {
    const target = await trx
      .selectFrom('calendars')
      .select('id')
      .where('world_id', '=', ctx.worldId)
      .where('id', '=', id)
      .executeTakeFirst()
    if (!target) return false

    await trx
      .updateTable('calendars')
      .set({ is_active: false, updated_at: new Date() })
      .where('world_id', '=', ctx.worldId)
      .where('id', '<>', id)
      .execute()
    await trx
      .updateTable('calendars')
      .set({ is_active: true, updated_at: new Date() })
      .where('world_id', '=', ctx.worldId)
      .where('id', '=', id)
      .execute()
    return true
  })
}

/**
 * Remove a calendar (owner-only). Returns whether one was actually removed.
 *
 * A hard delete, because the table has no `deleted_at` — it is configuration, not
 * content, so there is no trash for it to sit in. Deleting the ACTIVE calendar is
 * allowed and leaves the world with none, which is a supported state: sessions
 * fall back to the free-text date they had before any calendar existed. Refusing
 * would mean a world could never get back to having no calendar.
 */
export async function deleteCalendar(ctx: WorldContext, id: string): Promise<boolean> {
  assertWorldOwner(ctx, 'calendar delete')
  const res = await ctx.db
    .deleteFrom('calendars')
    .where('world_id', '=', ctx.worldId)
    .where('id', '=', id)
    .executeTakeFirstOrThrow()
  return res.numDeletedRows > 0n
}
