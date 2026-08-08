/**
 * The world-scoped CONTENT tables, in FK-dependency (creation) order. Export
 * dumps them; import re-inserts them in this order so parents land before
 * children. Since 0005 the 16 per-kind tables are one `entities` base table plus
 * 13 `<kind>_details` tables (each carries `world_id`, so this generic
 * world-scoped loop treats them like any other table).
 *
 * Deliberately excludes tenancy/auth tables (accounts, auth_sessions, worlds,
 * world_members) and the account-coupled player data (player_notes,
 * player_characters, suggestions) — a world export is the DM's canonical content,
 * not per-account data, and that keeps it free of cross-server account FKs.
 */
export const WORLD_CONTENT_TABLES = [
  // base first — every detail/junction/pin/touch references entities.id
  'entities',
  // per-kind detail tables (FK entity_id → entities)
  'species_details',
  'culture_details',
  'pantheon_details',
  'language_details',
  'magic_system_details',
  'currency_details',
  'deity_details',
  'resource_details',
  'event_details',
  'lore_article_details',
  'npc_details',
  'pc_details',
  'settlement_details',
  // bespoke entity-shaped tables
  'maps',
  'calendars',
  'sessions',
  // junctions (FK → entities)
  'culture_languages',
  'culture_magic_systems',
  'culture_pantheons',
  'npc_languages',
  'npc_magic_systems',
  'pc_languages',
  'pc_magic_systems',
  'settlement_languages',
  'settlement_currency_attachments',
  'organization_currency_attachments',
  'resource_locations',
  // typed relationships — after `entities`, since both endpoints FK to it
  'entity_relationships',
  // Staged-reveal prose (0015). DM content, so it exports — a world whose
  // reveals were dropped on the way out would import back as a world the DM
  // had never written. Its ACL `passage_visibility` is deliberately NOT here:
  // it is account-coupled, exactly like `entity_visibility`, which this list
  // already excludes. Grants do not survive an export, and a restricted
  // passage lands on the far side visible to the owner alone.
  'entity_passages',
  // polymorphic + meta
  'map_pins',
  'entity_touches',
  'media_attachments',
  'dm_toolkit_meta',
] as const
