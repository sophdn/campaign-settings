import {
  isMediaKind,
  LANGUAGE_ROLES,
  type MediaKind,
  type RelationshipType,
  visibilityFromDmOnly,
} from '@campaign-settings/shared'
import type { Insertable, Kysely, RawBuilder } from 'kysely'
import { newId } from '../db/ids'
import { jsonb } from '../db/json'
import type {
  CalendarKind,
  CalendarsTable,
  CultureDetailsTable,
  Database,
  DeityDetailsTable,
  DmToolkitMetaTable,
  EntitiesTable,
  EntityRelationshipsTable,
  EntityTouchesTable,
  EventDetailsTable,
  LanguageDetailsTable,
  LoreArticleDetailsTable,
  MagicSystemDetailsTable,
  MapPinsTable,
  MapsTable,
  MediaAttachmentsTable,
  NpcDetailsTable,
  OrganizationCurrencyAttachmentsTable,
  PantheonDetailsTable,
  PcDetailsTable,
  ResourceDetailsTable,
  SessionsTable,
  SettlementCurrencyAttachmentsTable,
  SettlementDetailsTable,
  SpeciesDetailsTable,
} from '../db/schema'
import { bool, dateOpt, dateReq, field, num, numOpt, type Row, text, textOpt } from './converters'
import type { TableReader } from './sqlite-reader'

// jsonb-from-TEXT helpers. node-pg auto-serializes plain objects to jsonb, so
// object columns pass the parsed value directly; only arrays (denominations)
// get mistaken for Postgres array literals and need the jsonb() wrapper.
const jArr = (v: unknown): RawBuilder<unknown[]> => jsonb(JSON.parse(String(v)) as unknown[])
const jObj = (v: unknown): Record<string, unknown> =>
  JSON.parse(String(v)) as Record<string, unknown>
const jObjOpt = (v: unknown): Record<string, unknown> | null =>
  v == null ? null : (JSON.parse(String(v)) as Record<string, unknown>)

// ── the entity base + per-kind detail mappers ───────────────────────────────
// Since 0005 every content kind maps to a shared `entities` base row plus a slim
// `<kind>_details` row (keyed by entity_id). The base carries the columns every
// kind shares; the detail carries the kind-specific ones.

/** Shared base row for any content kind (the discriminator is `kind`). */
export function mapEntityBase(row: Row, worldId: string, kind: string): Insertable<EntitiesTable> {
  return {
    id: text(row.id),
    world_id: worldId,
    kind,
    name: text(row.name),
    description: field(row, 'description', text),
    visibility: visibilityFromDmOnly(field(row, 'dm_only', bool)),
    imported_metadata: field(row, 'imported_metadata', jObjOpt),
    created_at: dateReq(row.created_at),
    updated_at: dateReq(row.updated_at),
    deleted_at: field(row, 'deleted_at', dateOpt),
  }
}

export function mapSpeciesDetail(row: Row, worldId: string): Insertable<SpeciesDetailsTable> {
  return {
    entity_id: text(row.id),
    world_id: worldId,
    kingdom: field(row, 'kingdom', text),
    elemental_alignment: field(row, 'elemental_alignment', textOpt),
    is_corporeal: field(row, 'is_corporeal', bool),
    is_sentient: field(row, 'is_sentient', bool),
  }
}

export function mapCultureDetail(row: Row, worldId: string): Insertable<CultureDetailsTable> {
  return {
    entity_id: text(row.id),
    world_id: worldId,
    dominant_values: field(row, 'dominant_values', text),
    historical_period: field(row, 'historical_period', text),
    aesthetic_notes: field(row, 'aesthetic_notes', text),
  }
}

export function mapPantheonDetail(row: Row, worldId: string): Insertable<PantheonDetailsTable> {
  return {
    entity_id: text(row.id),
    world_id: worldId,
    tradition: field(row, 'tradition', text),
    historical_period: field(row, 'historical_period', text),
  }
}

export function mapLanguageDetail(row: Row, worldId: string): Insertable<LanguageDetailsTable> {
  return {
    entity_id: text(row.id),
    world_id: worldId,
    family: field(row, 'family', text),
    is_trade_language: field(row, 'is_trade_language', bool),
    writing_system: field(row, 'writing_system', text),
  }
}

export function mapMagicSystemDetail(
  row: Row,
  worldId: string,
): Insertable<MagicSystemDetailsTable> {
  return {
    entity_id: text(row.id),
    world_id: worldId,
    source_kind: field(row, 'source_kind', text),
    cost_summary: field(row, 'cost_summary', text),
    alignment: field(row, 'alignment', text),
    is_taught: field(row, 'is_taught', bool),
    requires_materials: field(row, 'requires_materials', bool),
  }
}

// Return type inferred (not annotated Insertable): denominations is a jsonb
// array passed as a RawBuilder, which the insert's ValueExpression accepts but
// the plain Insertable type does not.
export function mapCurrencyDetail(row: Row, worldId: string) {
  return {
    entity_id: text(row.id),
    world_id: worldId,
    symbol: field(row, 'symbol', text),
    denominations: field(row, 'denominations', jArr),
    base_rate_to: textOpt(row.base_rate_to),
    rate: numOpt(row.rate),
  }
}

export function mapDeityDetail(row: Row, worldId: string): Insertable<DeityDetailsTable> {
  return {
    entity_id: text(row.id),
    world_id: worldId,
    domain: field(row, 'domain', text),
    worship_status: field(row, 'worship_status', text),
    pantheon_id: textOpt(row.pantheon_id),
  }
}

export function mapResourceDetail(row: Row, worldId: string): Insertable<ResourceDetailsTable> {
  return {
    entity_id: text(row.id),
    world_id: worldId,
    resource_kind: field(row, 'resource_kind', text),
    scarcity: field(row, 'scarcity', text),
    commercial_value: field(row, 'commercial_value', text),
  }
}

export function mapEventDetail(row: Row, worldId: string): Insertable<EventDetailsTable> {
  return {
    entity_id: text(row.id),
    world_id: worldId,
    occurred_at: field(row, 'occurred_at', textOpt),
  }
}

export function mapLoreArticleDetail(
  row: Row,
  worldId: string,
): Insertable<LoreArticleDetailsTable> {
  // The source column is `kind`; it becomes `article_kind` to avoid colliding
  // with the entities.kind discriminator.
  return {
    entity_id: text(row.id),
    world_id: worldId,
    article_kind: field(row, 'kind', textOpt),
  }
}

export function mapNpcDetail(row: Row, worldId: string): Insertable<NpcDetailsTable> {
  return {
    entity_id: text(row.id),
    world_id: worldId,
    species_id: textOpt(row.species_id),
    culture_id: textOpt(row.culture_id),
    occupation: field(row, 'occupation', text),
  }
}

export function mapPcDetail(row: Row, worldId: string): Insertable<PcDetailsTable> {
  return {
    entity_id: text(row.id),
    world_id: worldId,
    species_id: textOpt(row.species_id),
  }
}

export function mapSettlementDetail(row: Row, worldId: string): Insertable<SettlementDetailsTable> {
  return {
    entity_id: text(row.id),
    world_id: worldId,
    culture_id: textOpt(row.culture_id),
    size: field(row, 'size', text),
    wealth: field(row, 'wealth', text),
    terrain: field(row, 'terrain', text),
    population: field(row, 'population', num),
  }
}

// ── bespoke (non-entity) mappers ────────────────────────────────────────────

export function mapMap(row: Row, worldId: string): Insertable<MapsTable> {
  return {
    id: text(row.id),
    world_id: worldId,
    name: text(row.name),
    description: field(row, 'description', text),
    visibility: visibilityFromDmOnly(field(row, 'dm_only', bool)),
    image_path: field(row, 'image_path', textOpt),
    thumbnail_path: field(row, 'thumbnail_path', textOpt),
    source_width: numOpt(row.source_width),
    source_height: numOpt(row.source_height),
    imported_metadata: field(row, 'imported_metadata', jObjOpt),
    created_at: dateReq(row.created_at),
    updated_at: dateReq(row.updated_at),
    deleted_at: field(row, 'deleted_at', dateOpt),
  }
}

export function mapCalendar(row: Row, worldId: string): Insertable<CalendarsTable> {
  return {
    // dm-manager seeds every world with a default calendar under the fixed
    // literal id `cal-gregorian-default`, so preserving the source id (as every
    // other table does) collides on the global `calendars` PK the moment a
    // SECOND world is imported. Calendars carry no inbound FK, so world-scoping
    // the id here is safe and keeps each world's calendar row distinct.
    id: `${worldId}:${text(row.id)}`,
    world_id: worldId,
    name: text(row.name),
    kind: row.kind as CalendarKind,
    config: field(row, 'config', jObj),
    is_active: field(row, 'is_active', bool),
    is_user_defined: field(row, 'is_user_defined', bool),
    created_at: dateReq(row.created_at),
    updated_at: dateReq(row.updated_at),
  }
}

export function mapSession(row: Row, worldId: string): Insertable<SessionsTable> {
  return {
    id: text(row.id),
    world_id: worldId,
    name: text(row.name),
    played_at: field(row, 'played_at', textOpt),
    captured_text: field(row, 'captured_text', text),
    visibility: visibilityFromDmOnly(field(row, 'dm_only', bool)),
    imported_metadata: field(row, 'imported_metadata', jObjOpt),
    created_at: dateReq(row.created_at),
    updated_at: dateReq(row.updated_at),
    deleted_at: field(row, 'deleted_at', dateOpt),
  }
}

// ── the folded junctions → entity_relationships ─────────────────────────────
//
// Nine dm-manager junction tables have no Postgres table of their own since
// migration 0017; each row becomes one typed relationship. The SOURCE schema is
// untouched — dm-manager still exports `npc_languages` — so what changes here is
// only the destination, which is why `TableImport` grew an `into` (below).
//
// This is the whole reason task 4 could not just delete the junction types from
// `schema.ts`: without a translation layer the nine source tables would still be
// read and then written nowhere, and an import would report success having
// silently discarded every relation in them.

/** How one source junction table becomes relationship rows. */
interface JunctionFold {
  /** Source column holding the subject id. */
  from: string
  /** Source column holding the object id. */
  to: string
  type: RelationshipType
  /** Source column carrying a controlled role, if any. */
  role?: string
  /** Source column carrying free text, if any. */
  note?: string
}

/**
 * Salvage a source `role` into the `(qualifier, note)` pair.
 *
 * A value in `LANGUAGE_ROLES` becomes the qualifier, which is the point of the
 * column. Anything else — the source is SQLite from a tool whose CHECK
 * constraints we do not control, and worlds get hand-edited — is NOT dropped and
 * NOT written to `qualifier` either: it goes to the free-text `note`, where it
 * survives without pretending to be a member of a vocabulary that filters and
 * groups. Silently nulling it would lose a fact the source recorded, and silently
 * storing it would corrupt the only column claiming to be controlled.
 */
function foldRole(raw: unknown, note: string): { qualifier: string | null; note: string } {
  const role = raw == null ? '' : String(raw).trim()
  if (role === '') return { qualifier: null, note }
  if ((LANGUAGE_ROLES as readonly string[]).includes(role)) return { qualifier: role, note }
  const salvaged = `imported role: ${role}`
  return { qualifier: null, note: note === '' ? salvaged : `${note} (${salvaged})` }
}

/**
 * Build the mapper for one folded junction table.
 *
 * A factory rather than nine near-identical functions: the nine differ only in
 * their column names and target type, which is exactly the table that migration
 * 0017's `FOLDS` constant already spells out. Two copies of that list, one here
 * and one there, would be two places to forget `venerates`.
 *
 * The id is generated: a junction row has none to preserve, unlike every other
 * table the importer touches.
 */
export function foldedRelationshipMapper(
  fold: JunctionFold,
): (row: Row, worldId: string) => Insertable<EntityRelationshipsTable> {
  return (row, worldId) => {
    const base = fold.note === undefined ? '' : text(row[fold.note] ?? '')
    const { qualifier, note } =
      fold.role === undefined ? { qualifier: null, note: base } : foldRole(row[fold.role], base)
    return {
      id: newId(),
      world_id: worldId,
      from_id: text(row[fold.from]),
      to_id: text(row[fold.to]),
      type: fold.type,
      note,
      qualifier,
    }
  }
}

export const mapCultureLanguage = foldedRelationshipMapper({
  from: 'culture_id',
  to: 'language_id',
  type: 'speaks',
  role: 'role',
})

export const mapNpcLanguage = foldedRelationshipMapper({
  from: 'npc_id',
  to: 'language_id',
  type: 'speaks',
  role: 'role',
})

export const mapPcLanguage = foldedRelationshipMapper({
  from: 'pc_id',
  to: 'language_id',
  type: 'speaks',
  role: 'role',
})

export const mapSettlementLanguage = foldedRelationshipMapper({
  from: 'settlement_id',
  to: 'language_id',
  type: 'speaks',
  role: 'role',
})

export const mapCultureMagicSystem = foldedRelationshipMapper({
  from: 'culture_id',
  to: 'magic_system_id',
  type: 'practises',
})

export const mapNpcMagicSystem = foldedRelationshipMapper({
  from: 'npc_id',
  to: 'magic_system_id',
  type: 'practises',
})

export const mapPcMagicSystem = foldedRelationshipMapper({
  from: 'pc_id',
  to: 'magic_system_id',
  type: 'practises',
})

export const mapCulturePantheon = foldedRelationshipMapper({
  from: 'culture_id',
  to: 'pantheon_id',
  type: 'venerates',
})

export const mapResourceLocation = foldedRelationshipMapper({
  from: 'resource_id',
  to: 'location_id',
  type: 'found_at',
  note: 'notes',
})

// ── attachment mappers (NOT folded — see 0017) ──────────────────────────────

export function mapSettlementCurrencyAttachment(
  row: Row,
  worldId: string,
): Insertable<SettlementCurrencyAttachmentsTable> {
  return {
    id: text(row.id),
    world_id: worldId,
    settlement_id: text(row.settlement_id),
    currency_id: text(row.currency_id),
    is_primary: field(row, 'is_primary', bool),
    notes: field(row, 'notes', text),
    visibility: visibilityFromDmOnly(field(row, 'dm_only', bool)),
    created_at: dateReq(row.created_at),
    updated_at: dateReq(row.updated_at),
    deleted_at: field(row, 'deleted_at', dateOpt),
  }
}

export function mapOrganizationCurrencyAttachment(
  row: Row,
  worldId: string,
): Insertable<OrganizationCurrencyAttachmentsTable> {
  return {
    id: text(row.id),
    world_id: worldId,
    organization_id: text(row.organization_id),
    currency_id: text(row.currency_id),
    is_primary: field(row, 'is_primary', bool),
    notes: field(row, 'notes', text),
    visibility: visibilityFromDmOnly(field(row, 'dm_only', bool)),
    created_at: dateReq(row.created_at),
    updated_at: dateReq(row.updated_at),
    deleted_at: field(row, 'deleted_at', dateOpt),
  }
}

// ── polymorphic + meta mappers ──────────────────────────────────────────────

export function mapMapPin(row: Row, worldId: string): Insertable<MapPinsTable> {
  return {
    id: text(row.id),
    world_id: worldId,
    map_id: text(row.map_id),
    entity_id: text(row.entity_id),
    x: num(row.x),
    y: num(row.y),
    label: field(row, 'label', textOpt),
    created_at: dateReq(row.created_at),
    updated_at: dateReq(row.updated_at),
    deleted_at: field(row, 'deleted_at', dateOpt),
  }
}

export function mapEntityTouch(row: Row, worldId: string): Insertable<EntityTouchesTable> {
  return {
    id: text(row.id),
    world_id: worldId,
    session_id: text(row.session_id),
    entity_id: text(row.entity_id),
    touch_type: text(row.touch_type),
    narrative_delta: field(row, 'narrative_delta', text),
    created_at: dateReq(row.created_at),
    updated_at: dateReq(row.updated_at),
    deleted_at: field(row, 'deleted_at', dateOpt),
  }
}

/**
 * Narrow an imported `media_kind` into the closed set (`image` | `map`).
 *
 * dm-manager's column was free text and its exports carry whatever it wrote —
 * `portrait`, `handout`, and anything else a user typed. Those files are all
 * raster images attached to an entity, so `image` is not a guess: it is what
 * every one of them is, once the vocabulary stops trying to describe the
 * subject. `map` is the only value that means something structural (it is how
 * `getMapImage` finds the image pins are positioned against), so it survives.
 *
 * Narrowing on the way IN rather than tolerating the old values on the way out
 * is what makes the closed set true of the whole table. A vocabulary enforced
 * only for new rows is not enforced.
 */
function importedMediaKind(value: unknown): MediaKind {
  const raw = text(value)
  return isMediaKind(raw) ? raw : 'image'
}

export function mapMediaAttachment(row: Row, worldId: string): Insertable<MediaAttachmentsTable> {
  return {
    id: text(row.id),
    world_id: worldId,
    owner_kind: text(row.owner_kind),
    owner_id: text(row.owner_id),
    media_kind: importedMediaKind(row.media_kind),
    file_path: text(row.file_path),
    thumbnail_path: field(row, 'thumbnail_path', textOpt),
    original_filename: text(row.original_filename),
    mime_type: text(row.mime_type),
    byte_size: num(row.byte_size),
    created_at: dateReq(row.created_at),
    updated_at: dateReq(row.updated_at),
    deleted_at: field(row, 'deleted_at', dateOpt),
  }
}

export function mapDmToolkitMeta(row: Row, worldId: string): Insertable<DmToolkitMetaTable> {
  return {
    world_id: worldId,
    key: text(row.key),
    value: text(row.value),
  }
}

/**
 * One content kind's import wiring: which source table it reads, the `kind`
 * discriminator to stamp on the base row, and the detail table + mapper (absent
 * for location/organization/item, which have no extra columns). Ordered so every
 * cross-entity FK target (species/cultures/pantheons/currencies) is imported
 * before the kinds that reference it.
 */
interface ContentImport {
  source: string
  kind: string
  detailTable?: keyof Database
  mapDetail?: (row: Row, worldId: string) => Record<string, unknown>
}

const CONTENT_IMPORTS: ReadonlyArray<ContentImport> = [
  {
    source: 'species',
    kind: 'species',
    detailTable: 'species_details',
    mapDetail: mapSpeciesDetail,
  },
  {
    source: 'cultures',
    kind: 'culture',
    detailTable: 'culture_details',
    mapDetail: mapCultureDetail,
  },
  {
    source: 'pantheons',
    kind: 'pantheon',
    detailTable: 'pantheon_details',
    mapDetail: mapPantheonDetail,
  },
  {
    source: 'languages',
    kind: 'language',
    detailTable: 'language_details',
    mapDetail: mapLanguageDetail,
  },
  {
    source: 'magic_systems',
    kind: 'magic_system',
    detailTable: 'magic_system_details',
    mapDetail: mapMagicSystemDetail,
  },
  {
    source: 'currencies',
    kind: 'currency',
    detailTable: 'currency_details',
    mapDetail: mapCurrencyDetail,
  },
  { source: 'deities', kind: 'deity', detailTable: 'deity_details', mapDetail: mapDeityDetail },
  {
    source: 'resources',
    kind: 'resource',
    detailTable: 'resource_details',
    mapDetail: mapResourceDetail,
  },
  { source: 'locations', kind: 'location' },
  { source: 'organizations', kind: 'organization' },
  { source: 'items', kind: 'item' },
  { source: 'events', kind: 'event', detailTable: 'event_details', mapDetail: mapEventDetail },
  {
    source: 'lore_articles',
    kind: 'lore_article',
    detailTable: 'lore_article_details',
    mapDetail: mapLoreArticleDetail,
  },
  { source: 'npcs', kind: 'npc', detailTable: 'npc_details', mapDetail: mapNpcDetail },
  { source: 'pcs', kind: 'pc', detailTable: 'pc_details', mapDetail: mapPcDetail },
  {
    source: 'settlements',
    kind: 'settlement',
    detailTable: 'settlement_details',
    mapDetail: mapSettlementDetail,
  },
]

/**
 * A non-content table's import wiring.
 *
 * `name` is the dm-manager SQLite table read from, and it is also the `counts`
 * key — both of which must stay stable, because the source schema is fixed and
 * callers assert on `counts.npc_languages`.
 *
 * `into` is the Postgres table written to. It exists because those two used to be
 * ONE field, which was true only while every source table had a destination of the
 * same name. Migration 0017 broke that: nine source tables now land in
 * `entity_relationships`. Without the split, dropping the nine junction types from
 * `schema.ts` would have made `insertInto(imp.name)` fail to typecheck at best,
 * and at worst — had the name still resolved — read nine tables and write them
 * nowhere, reporting a clean import that had dropped every relation.
 *
 * The union is what keeps the safety the single field gave for free: an entry
 * either names a real `Database` table in `name`, or supplies one in `into`, so a
 * typo in a destination is still a type error.
 */
type TableImport =
  | {
      name: keyof Database
      into?: never
      map: (row: Row, worldId: string) => Record<string, unknown>
    }
  | {
      name: string
      into: 'entity_relationships'
      map: (row: Row, worldId: string) => Insertable<EntityRelationshipsTable>
    }

// Imported after the entities (FK order): bespoke tables, the folded junctions,
// the two attachment tables, then the polymorphic + meta tables. Everything from
// `culture_languages` down references entities.id, so it must follow the
// CONTENT_IMPORTS loop.
const OTHER_IMPORTS: ReadonlyArray<TableImport> = [
  { name: 'maps', map: mapMap },
  { name: 'calendars', map: mapCalendar },
  { name: 'sessions', map: mapSession },
  { name: 'culture_languages', into: 'entity_relationships', map: mapCultureLanguage },
  { name: 'culture_magic_systems', into: 'entity_relationships', map: mapCultureMagicSystem },
  { name: 'culture_pantheons', into: 'entity_relationships', map: mapCulturePantheon },
  { name: 'npc_languages', into: 'entity_relationships', map: mapNpcLanguage },
  { name: 'npc_magic_systems', into: 'entity_relationships', map: mapNpcMagicSystem },
  { name: 'pc_languages', into: 'entity_relationships', map: mapPcLanguage },
  { name: 'pc_magic_systems', into: 'entity_relationships', map: mapPcMagicSystem },
  { name: 'settlement_languages', into: 'entity_relationships', map: mapSettlementLanguage },
  { name: 'settlement_currency_attachments', map: mapSettlementCurrencyAttachment },
  { name: 'organization_currency_attachments', map: mapOrganizationCurrencyAttachment },
  { name: 'resource_locations', into: 'entity_relationships', map: mapResourceLocation },
  { name: 'map_pins', map: mapMapPin },
  { name: 'entity_touches', map: mapEntityTouch },
  { name: 'media_attachments', map: mapMediaAttachment },
  { name: 'dm_toolkit_meta', map: mapDmToolkitMeta },
]

/**
 * The suffix marking a skipped-row count in the returned `counts`.
 *
 * A key like `npc_languages_skipped` appears ONLY when a folded junction table
 * held rows that could not become relationships (see `unusableEndpoints`). It is
 * absent, not zero, in the ordinary case — so the existing invariant that the
 * source-table values sum to the number of source rows is untouched, and a caller
 * summing everything sees a discrepancy exactly when there is one to see.
 *
 * The alternative was to drop the rows silently, which is the failure this whole
 * translation layer exists to prevent.
 */
export const SKIPPED_SUFFIX = '_skipped'

/**
 * Why a mapped relationship row cannot be inserted, or null when it can.
 *
 * Both checks are load-bearing HERE in a way they are not in migration 0017. That
 * migration moves Postgres rows whose endpoint columns are already foreign-keyed
 * to `entities(id)`; this reads SQLite, which enforces nothing, so a world can
 * genuinely name a deleted entity or relate something to itself. Either one would
 * abort the entire import on an FK or CHECK violation — one malformed row costing
 * the user every other row in the file.
 *
 * Endpoints are checked against the ids imported by THIS run rather than against
 * `entities`, which is stricter than the FK: the FK is global, so an id belonging
 * to somebody else's world would satisfy it and quietly relate this world to
 * theirs.
 */
function unusableEndpoints(
  row: Insertable<EntityRelationshipsTable>,
  imported: ReadonlySet<string>,
): string | null {
  if (row.from_id === row.to_id) return 'self-relation'
  if (!imported.has(String(row.from_id))) return 'unknown from-endpoint'
  if (!imported.has(String(row.to_id))) return 'unknown to-endpoint'
  return null
}

/**
 * The nine legacy junction tables and the mapper that folds each one, keyed by the
 * table's own name.
 *
 * Two doors read this, not one. The dm-manager SQLite importer is the obvious one.
 * The other is `world-io/import.ts`: a world ARCHIVE exported before 0017 carries
 * these tables as top-level keys, and since they are no longer in
 * `WORLD_CONTENT_TABLES` the archive importer would walk straight past them. That
 * is the same silent drop the SQLite path guards against, on a file the user
 * believes is a complete backup — so both doors fold rather than one.
 *
 * The column names are identical on both sides (dm-manager's names survived into
 * Postgres), which is why one set of mappers serves both.
 */
export const LEGACY_JUNCTION_FOLDS: Readonly<
  Record<string, (row: Row, worldId: string) => Insertable<EntityRelationshipsTable>>
> = {
  culture_languages: mapCultureLanguage,
  culture_magic_systems: mapCultureMagicSystem,
  culture_pantheons: mapCulturePantheon,
  npc_languages: mapNpcLanguage,
  npc_magic_systems: mapNpcMagicSystem,
  pc_languages: mapPcLanguage,
  pc_magic_systems: mapPcMagicSystem,
  settlement_languages: mapSettlementLanguage,
  resource_locations: mapResourceLocation,
}

/**
 * Insert mapped relationship rows, dropping the ones that cannot be relationships.
 * Returns how many were dropped, for the caller to report.
 *
 * ON CONFLICT DO NOTHING rather than a pre-pass dedupe, because two SOURCE TABLES
 * can fold to the same type — an id present in both `npc_languages` and
 * `pc_languages` yields `speaks` twice for one pair — so the collision is not
 * visible from inside a single table's rows.
 */
export async function insertFoldedRelationships(
  db: Kysely<Database>,
  mapped: ReadonlyArray<Insertable<EntityRelationshipsTable>>,
  importedIds: ReadonlySet<string>,
): Promise<number> {
  const usable = mapped.filter((r) => unusableEndpoints(r, importedIds) === null)
  if (usable.length) {
    await db
      .insertInto('entity_relationships')
      .values(usable)
      .onConflict((oc) => oc.doNothing())
      .execute()
  }
  return mapped.length - usable.length
}

/**
 * Import every dm-manager source table into Postgres under `worldId`, in
 * FK-dependency order. Returns a per-table row count (0 for empty tables), keyed
 * by the SOURCE table name (so `counts.npcs` and `counts.npc_languages` stay
 * stable across both the 0005 class-table split and the 0017 junction fold). The
 * source SQLite schema is unchanged; only the Postgres write targets moved.
 *
 * A folded junction table may additionally report a `<source>_skipped` count — see
 * `SKIPPED_SUFFIX`.
 */
export async function importWorldRows(
  db: Kysely<Database>,
  worldId: string,
  reader: TableReader,
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {}
  // Detail-table inserts use a runtime table name; the seam uses the same cast.
  const loose = db as unknown as Kysely<Record<string, Record<string, unknown>>>
  // Every entity id this run created, for the folded-junction endpoint guard.
  const importedIds = new Set<string>()

  for (const imp of CONTENT_IMPORTS) {
    const rows = reader.all(imp.source)
    if (rows.length) {
      const bases = rows.map((r) => mapEntityBase(r, worldId, imp.kind))
      await db.insertInto('entities').values(bases).execute()
      for (const base of bases) importedIds.add(base.id as string)
      if (imp.detailTable && imp.mapDetail) {
        const map = imp.mapDetail
        await loose
          .insertInto(imp.detailTable)
          .values(rows.map((r) => map(r, worldId)))
          .execute()
      }
    }
    counts[imp.source] = rows.length
  }

  for (const imp of OTHER_IMPORTS) {
    const rows = reader.all(imp.name)
    counts[imp.name] = rows.length
    if (rows.length === 0) continue

    if (imp.into === undefined) {
      await loose
        .insertInto(imp.name)
        .values(rows.map((r) => imp.map(r, worldId)))
        .execute()
      continue
    }

    const skipped = await insertFoldedRelationships(
      db,
      rows.map((r) => imp.map(r, worldId)),
      importedIds,
    )
    if (skipped > 0) counts[`${imp.name}${SKIPPED_SUFFIX}`] = skipped
  }

  return counts
}
