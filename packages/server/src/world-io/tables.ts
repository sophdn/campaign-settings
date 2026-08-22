/**
 * The world-scoped CONTENT tables, in FK-dependency (creation) order. Export
 * dumps them; import re-inserts them in this order so parents land before
 * children. Since 0005 the 16 per-kind tables are one `entities` base table plus
 * 13 `<kind>_details` tables (each carries `world_id`, so this generic
 * world-scoped loop treats them like any other table).
 *
 * Deliberately excludes tenancy/auth tables (accounts, auth_sessions, worlds,
 * world_members) and the account-coupled player data (player_notes,
 * suggestions) — a world export is the DM's canonical content, not per-account
 * data, and that keeps it free of cross-server account FKs.
 *
 * `pc_details` IS exported — it holds a kind's real content — but since
 * migration 0018 it carries `account_id`, which names an account and therefore
 * must not travel. That ONE COLUMN is stripped on the way out (see
 * `ACCOUNT_COUPLED_COLUMNS` in export.ts), so the same rule holds here as
 * everywhere else in this list: nothing in an archive points at an account.
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
  // currency attachments (FK → entities). The nine per-kind junction tables that
  // used to sit here went into `entity_relationships` in 0017, so they export as
  // relationship rows now and need no entry of their own. These two did NOT move:
  // they carry `visibility` and `deleted_at`, which `entity_relationships` has
  // neither of by design.
  'settlement_currency_attachments',
  'organization_currency_attachments',
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
