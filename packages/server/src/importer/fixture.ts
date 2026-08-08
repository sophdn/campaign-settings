import { DatabaseSync } from 'node:sqlite'

const TS = '2026-01-01T00:00:00.000Z'

/**
 * Create a synthetic dm-manager SQLite world DB at `path` with one row in every
 * source table — enough to exercise every mapper. `npcs` omits `occupation` and
 * `settlements` omits the v23-25 columns, simulating an older export (schema
 * drift), so the importer falls back to Postgres defaults for them.
 */
export function seedDmManagerFixture(path: string): void {
  const db = new DatabaseSync(path)

  db.exec(`
    create table species (id text, name text, kingdom text, elemental_alignment text, is_corporeal integer, is_sentient integer, description text, dm_only integer, imported_metadata text, created_at text, updated_at text, deleted_at text);
    create table cultures (id text, name text, dominant_values text, historical_period text, aesthetic_notes text, description text, dm_only integer, imported_metadata text, created_at text, updated_at text, deleted_at text);
    create table pantheons (id text, name text, tradition text, historical_period text, description text, dm_only integer, imported_metadata text, created_at text, updated_at text, deleted_at text);
    create table languages (id text, name text, family text, is_trade_language integer, writing_system text, description text, dm_only integer, imported_metadata text, created_at text, updated_at text, deleted_at text);
    create table magic_systems (id text, name text, source_kind text, cost_summary text, alignment text, is_taught integer, requires_materials integer, description text, dm_only integer, imported_metadata text, created_at text, updated_at text, deleted_at text);
    create table currencies (id text, name text, symbol text, denominations text, base_rate_to text, rate real, description text, dm_only integer, imported_metadata text, created_at text, updated_at text, deleted_at text);
    create table deities (id text, name text, domain text, worship_status text, pantheon_id text, description text, dm_only integer, imported_metadata text, created_at text, updated_at text, deleted_at text);
    create table resources (id text, name text, resource_kind text, scarcity text, commercial_value text, description text, dm_only integer, imported_metadata text, created_at text, updated_at text, deleted_at text);
    create table locations (id text, name text, description text, dm_only integer, created_at text, updated_at text, deleted_at text, imported_metadata text);
    create table organizations (id text, name text, description text, dm_only integer, created_at text, updated_at text, deleted_at text, imported_metadata text);
    create table items (id text, name text, description text, dm_only integer, created_at text, updated_at text, deleted_at text, imported_metadata text);
    create table events (id text, name text, description text, occurred_at text, dm_only integer, created_at text, updated_at text, deleted_at text, imported_metadata text);
    create table lore_articles (id text, name text, description text, kind text, dm_only integer, created_at text, updated_at text, deleted_at text, imported_metadata text);
    create table maps (id text, name text, description text, dm_only integer, image_path text, thumbnail_path text, source_width integer, source_height integer, created_at text, updated_at text, deleted_at text, imported_metadata text);
    create table calendars (id text, name text, kind text, config text, is_active integer, is_user_defined integer, created_at text, updated_at text);
    create table sessions (id text, name text, played_at text, captured_text text, dm_only integer, created_at text, updated_at text, deleted_at text, imported_metadata text);
    create table npcs (id text, name text, description text, dm_only integer, created_at text, updated_at text, deleted_at text, imported_metadata text, species_id text, culture_id text);
    create table pcs (id text, name text, description text, created_at text, updated_at text, deleted_at text, imported_metadata text, species_id text);
    create table settlements (id text, name text, description text, dm_only integer, created_at text, updated_at text, deleted_at text, imported_metadata text, culture_id text);
    create table culture_languages (culture_id text, language_id text, role text);
    create table culture_magic_systems (culture_id text, magic_system_id text);
    create table culture_pantheons (culture_id text, pantheon_id text);
    create table npc_languages (npc_id text, language_id text, role text);
    create table npc_magic_systems (npc_id text, magic_system_id text);
    create table pc_languages (pc_id text, language_id text, role text);
    create table pc_magic_systems (pc_id text, magic_system_id text);
    create table settlement_languages (settlement_id text, language_id text, role text);
    create table settlement_currency_attachments (id text, settlement_id text, currency_id text, is_primary integer, notes text, dm_only integer, created_at text, updated_at text, deleted_at text);
    create table organization_currency_attachments (id text, organization_id text, currency_id text, is_primary integer, notes text, dm_only integer, created_at text, updated_at text, deleted_at text);
    create table resource_locations (resource_id text, location_id text, notes text);
    create table map_pins (id text, map_id text, entity_kind text, entity_id text, x real, y real, label text, created_at text, updated_at text, deleted_at text);
    create table entity_touches (id text, session_id text, entity_kind text, entity_id text, touch_type text, narrative_delta text, created_at text, updated_at text, deleted_at text);
    create table media_attachments (id text, owner_kind text, owner_id text, media_kind text, file_path text, thumbnail_path text, original_filename text, mime_type text, byte_size integer, created_at text, updated_at text, deleted_at text);
    create table dm_toolkit_meta (key text, value text);
  `)

  db.exec(`
    insert into species values ('sp1','Vampire','undead',null,1,1,'a kind of undead',0,null,'${TS}','${TS}',null);
    insert into cultures values ('cu1','Camarilla','secrecy','modern','gothic','',0,null,'${TS}','${TS}',null);
    insert into pantheons values ('pan1','Old Gods','animist','ancient','',0,null,'${TS}','${TS}',null);
    insert into languages values ('lg1','Latin','Italic',0,'Latin','',0,null,'${TS}','${TS}',null);
    insert into magic_systems values ('ms1','Blood Magic','blood','vitae','dark',1,1,'',0,null,'${TS}','${TS}',null);
    insert into currencies values ('cur1','Dollar','$','[{"name":"cent"}]',null,1.0,'',0,null,'${TS}','${TS}',null);
    insert into deities values ('dei1','Hecate','magic','active','pan1','',0,null,'${TS}','${TS}',null);
    insert into resources values ('res1','Iron','metal','common','low','',0,null,'${TS}','${TS}',null);
    insert into locations values ('loc1','Chicago','',0,'${TS}','${TS}',null,null);
    insert into organizations values ('org1','Camarilla Inc','',0,'${TS}','${TS}',null,null);
    insert into items values ('it1','Ankh','',0,'${TS}','${TS}',null,null);
    insert into events values ('ev1','The Conclave','',null,0,'${TS}','${TS}',null,null);
    insert into lore_articles values ('lore1','History','','article',0,'${TS}','${TS}','${TS}',null);
    insert into maps values ('map1','City Map','',0,null,null,null,null,'${TS}','${TS}',null,null);
    insert into calendars values ('cal1','Gregorian','gregorian','{}',1,0,'${TS}','${TS}');
    insert into sessions values ('ses1','Session 1',null,'',0,'${TS}','${TS}',null,null);
    insert into npcs values ('npc1','The Prince','',1,'${TS}','${TS}',null,'{"source":"kanka"}','sp1','cu1');
    insert into pcs values ('pc1','Hero','','${TS}','${TS}',null,null,'sp1');
    insert into settlements values ('st1','Chicago','',0,'${TS}','${TS}',null,null,'cu1');
    insert into culture_languages values ('cu1','lg1','liturgical');
    insert into culture_magic_systems values ('cu1','ms1');
    insert into culture_pantheons values ('cu1','pan1');
    insert into npc_languages values ('npc1','lg1','native');
    insert into npc_magic_systems values ('npc1','ms1');
    insert into pc_languages values ('pc1','lg1','native');
    insert into pc_magic_systems values ('pc1','ms1');
    insert into settlement_languages values ('st1','lg1','native');
    insert into settlement_currency_attachments values ('sca1','st1','cur1',1,'',0,'${TS}','${TS}',null);
    insert into organization_currency_attachments values ('oca1','org1','cur1',1,'',0,'${TS}','${TS}',null);
    insert into resource_locations values ('res1','loc1','');
    insert into map_pins values ('mp1','map1','npc','npc1',0.5,0.5,null,'${TS}','${TS}',null);
    insert into entity_touches values ('et1','ses1','npc','npc1','mention','','${TS}','${TS}',null);
    insert into media_attachments values ('ma1','npc','npc1','image','/p.png',null,'p.png','image/png',1024,'${TS}','${TS}',null);
    insert into dm_toolkit_meta values ('world_name','Chicago');
  `)

  db.close()
}
