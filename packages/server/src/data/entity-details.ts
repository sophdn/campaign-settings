import type { RegistryKind } from '@campaign-settings/shared'

/**
 * A kind's detail table: which table holds its extra columns and what those
 * columns are. The single source of truth for the base⋈detail split — consumed
 * by the content seam (read-merge + split writes), the change-kind op, and the
 * importer. Kinds absent here (location, organization, item, and the bespoke
 * session/map) have no detail table: they are pure base rows.
 */
export interface DetailSpec {
  table: string
  columns: readonly string[]
  /** Columns holding JS arrays that must be jsonb-wrapped on write (see db/json). */
  jsonbArrayColumns?: readonly string[]
}

export const DETAIL_SPECS: Partial<Record<RegistryKind, DetailSpec>> = {
  species: {
    table: 'species_details',
    columns: ['kingdom', 'elemental_alignment', 'is_corporeal', 'is_sentient'],
  },
  culture: {
    table: 'culture_details',
    columns: ['dominant_values', 'historical_period', 'aesthetic_notes'],
  },
  pantheon: { table: 'pantheon_details', columns: ['tradition', 'historical_period'] },
  language: {
    table: 'language_details',
    columns: ['family', 'is_trade_language', 'writing_system'],
  },
  magic_system: {
    table: 'magic_system_details',
    columns: ['source_kind', 'cost_summary', 'alignment', 'is_taught', 'requires_materials'],
  },
  currency: {
    table: 'currency_details',
    columns: ['symbol', 'denominations', 'base_rate_to', 'rate'],
    jsonbArrayColumns: ['denominations'],
  },
  deity: { table: 'deity_details', columns: ['domain', 'worship_status', 'pantheon_id'] },
  resource: {
    table: 'resource_details',
    columns: ['resource_kind', 'scarcity', 'commercial_value'],
  },
  event: { table: 'event_details', columns: ['occurred_at'] },
  lore_article: { table: 'lore_article_details', columns: ['article_kind'] },
  npc: { table: 'npc_details', columns: ['species_id', 'culture_id', 'occupation'] },
  pc: { table: 'pc_details', columns: ['species_id', 'account_id'] },
  settlement: {
    table: 'settlement_details',
    columns: ['culture_id', 'size', 'wealth', 'terrain', 'population'],
  },
}

/** The base-table columns a content write may set (everything else is a detail col). */
export const ENTITY_BASE_COLUMNS = [
  'name',
  'description',
  'visibility',
  'imported_metadata',
] as const
