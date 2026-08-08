import { isMediaKind, type MediaKind, visibilityFromDmOnly } from '@campaign-settings/shared'
import type { Insertable, Kysely, RawBuilder } from 'kysely'
import { jsonb } from '../db/json'
import type {
  CalendarKind,
  CalendarsTable,
  CultureDetailsTable,
  CultureLanguageRole,
  CultureLanguagesTable,
  CultureMagicSystemsTable,
  CulturePantheonsTable,
  Database,
  DeityDetailsTable,
  DmToolkitMetaTable,
  EntitiesTable,
  EntityLanguageRole,
  EntityTouchesTable,
  EventDetailsTable,
  LanguageDetailsTable,
  LoreArticleDetailsTable,
  MagicSystemDetailsTable,
  MapPinsTable,
  MapsTable,
  MediaAttachmentsTable,
  NpcDetailsTable,
  NpcLanguagesTable,
  NpcMagicSystemsTable,
  OrganizationCurrencyAttachmentsTable,
  PantheonDetailsTable,
  PcDetailsTable,
  PcLanguagesTable,
  PcMagicSystemsTable,
  ResourceDetailsTable,
  ResourceLocationsTable,
  SessionsTable,
  SettlementCurrencyAttachmentsTable,
  SettlementDetailsTable,
  SettlementLanguagesTable,
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

// ── junction mappers ────────────────────────────────────────────────────────

export function mapCultureLanguage(row: Row, worldId: string): Insertable<CultureLanguagesTable> {
  return {
    world_id: worldId,
    culture_id: text(row.culture_id),
    language_id: text(row.language_id),
    role: row.role as CultureLanguageRole,
  }
}

export function mapCultureMagicSystem(
  row: Row,
  worldId: string,
): Insertable<CultureMagicSystemsTable> {
  return {
    world_id: worldId,
    culture_id: text(row.culture_id),
    magic_system_id: text(row.magic_system_id),
  }
}

export function mapCulturePantheon(row: Row, worldId: string): Insertable<CulturePantheonsTable> {
  return {
    world_id: worldId,
    culture_id: text(row.culture_id),
    pantheon_id: text(row.pantheon_id),
  }
}

export function mapNpcLanguage(row: Row, worldId: string): Insertable<NpcLanguagesTable> {
  return {
    world_id: worldId,
    npc_id: text(row.npc_id),
    language_id: text(row.language_id),
    role: row.role as EntityLanguageRole,
  }
}

export function mapNpcMagicSystem(row: Row, worldId: string): Insertable<NpcMagicSystemsTable> {
  return {
    world_id: worldId,
    npc_id: text(row.npc_id),
    magic_system_id: text(row.magic_system_id),
  }
}

export function mapPcLanguage(row: Row, worldId: string): Insertable<PcLanguagesTable> {
  return {
    world_id: worldId,
    pc_id: text(row.pc_id),
    language_id: text(row.language_id),
    role: row.role as EntityLanguageRole,
  }
}

export function mapPcMagicSystem(row: Row, worldId: string): Insertable<PcMagicSystemsTable> {
  return {
    world_id: worldId,
    pc_id: text(row.pc_id),
    magic_system_id: text(row.magic_system_id),
  }
}

export function mapSettlementLanguage(
  row: Row,
  worldId: string,
): Insertable<SettlementLanguagesTable> {
  return {
    world_id: worldId,
    settlement_id: text(row.settlement_id),
    language_id: text(row.language_id),
    role: row.role as EntityLanguageRole,
  }
}

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

export function mapResourceLocation(row: Row, worldId: string): Insertable<ResourceLocationsTable> {
  return {
    world_id: worldId,
    resource_id: text(row.resource_id),
    location_id: text(row.location_id),
    notes: field(row, 'notes', text),
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

/** A non-content table's import wiring: source name + its row mapper. */
interface TableImport {
  name: keyof Database
  map: (row: Row, worldId: string) => Record<string, unknown>
}

// Imported after the entities (FK order): bespoke tables, junctions, then the
// polymorphic + meta tables. Junctions and map_pins/entity_touches reference
// entities.id, so they must follow the CONTENT_IMPORTS loop.
const OTHER_IMPORTS: ReadonlyArray<TableImport> = [
  { name: 'maps', map: mapMap },
  { name: 'calendars', map: mapCalendar },
  { name: 'sessions', map: mapSession },
  { name: 'culture_languages', map: mapCultureLanguage },
  { name: 'culture_magic_systems', map: mapCultureMagicSystem },
  { name: 'culture_pantheons', map: mapCulturePantheon },
  { name: 'npc_languages', map: mapNpcLanguage },
  { name: 'npc_magic_systems', map: mapNpcMagicSystem },
  { name: 'pc_languages', map: mapPcLanguage },
  { name: 'pc_magic_systems', map: mapPcMagicSystem },
  { name: 'settlement_languages', map: mapSettlementLanguage },
  { name: 'settlement_currency_attachments', map: mapSettlementCurrencyAttachment },
  { name: 'organization_currency_attachments', map: mapOrganizationCurrencyAttachment },
  { name: 'resource_locations', map: mapResourceLocation },
  { name: 'map_pins', map: mapMapPin },
  { name: 'entity_touches', map: mapEntityTouch },
  { name: 'media_attachments', map: mapMediaAttachment },
  { name: 'dm_toolkit_meta', map: mapDmToolkitMeta },
]

/**
 * Import every dm-manager source table into Postgres under `worldId`, in
 * FK-dependency order. Returns a per-table row count (0 for empty tables), keyed
 * by the SOURCE table name (so `counts.npcs` etc. stay stable across the 0005
 * class-table split). The source SQLite schema is unchanged; only the Postgres
 * write targets moved (per-kind → entities + detail).
 */
export async function importWorldRows(
  db: Kysely<Database>,
  worldId: string,
  reader: TableReader,
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {}
  // Detail-table inserts use a runtime table name; the seam uses the same cast.
  const loose = db as unknown as Kysely<Record<string, Record<string, unknown>>>

  for (const imp of CONTENT_IMPORTS) {
    const rows = reader.all(imp.source)
    if (rows.length) {
      await db
        .insertInto('entities')
        .values(rows.map((r) => mapEntityBase(r, worldId, imp.kind)))
        .execute()
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
    if (rows.length) {
      await loose
        .insertInto(imp.name)
        .values(rows.map((r) => imp.map(r, worldId)))
        .execute()
    }
    counts[imp.name] = rows.length
  }

  return counts
}
