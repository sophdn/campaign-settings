import { describe, expect, it } from 'vitest'
import { foldedRelationshipMapper, mapCalendar, mapMediaAttachment } from './mappers'
import type { Row } from './converters'

const calendarRow: Row = {
  id: 'cal-gregorian-default',
  name: 'Gregorian',
  kind: 'gregorian',
  config: '{}',
  is_active: 1,
  is_user_defined: 0,
  created_at: '1970-01-01T00:00:00Z',
  updated_at: '1970-01-01T00:00:00Z',
}

describe('mapCalendar', () => {
  it('world-scopes the calendar id so a shared default id does not collide across worlds', () => {
    // dm-manager seeds every world with a default calendar under the fixed id
    // `cal-gregorian-default`. Preserving it (as every other table does) would
    // collide on the global `calendars` PK on the SECOND world import. The two
    // mappings below stand in for two worlds importing that same seeded row.
    const a = mapCalendar(calendarRow, 'world-a')
    const b = mapCalendar(calendarRow, 'world-b')

    expect(a.id).not.toBe(b.id)
    expect(a.id).toBe('world-a:cal-gregorian-default')
    expect(a.world_id).toBe('world-a')
  })
})

const mediaRow: Row = {
  id: 'media-1',
  owner_kind: 'npc',
  owner_id: 'npc-1',
  media_kind: 'portrait',
  file_path: 'w/npc/npc-1/a.png',
  thumbnail_path: null,
  original_filename: 'a.png',
  mime_type: 'image/png',
  byte_size: 100,
  created_at: '1970-01-01T00:00:00Z',
  updated_at: '1970-01-01T00:00:00Z',
}

describe('mapMediaAttachment', () => {
  it('narrows dm-manager’s free-text media_kind into the closed set', () => {
    // dm-manager's column was free text and its exports carry whatever a user
    // typed. Every one of those rows is a raster image attached to an entity,
    // so `image` is not a guess about the file — it is what the file is, once
    // the vocabulary stops trying to describe the subject.
    for (const legacy of ['portrait', 'handout', 'reference', '', 'AUDIO']) {
      expect(mapMediaAttachment({ ...mediaRow, media_kind: legacy }, 'w').media_kind).toBe('image')
    }
  })

  it('keeps `map`, which is the one value that means something structural', () => {
    // `getMapImage` finds a map's image by this value; narrowing it to `image`
    // would leave every imported map displaying nothing.
    const mapped = mapMediaAttachment({ ...mediaRow, owner_kind: 'map', media_kind: 'map' }, 'w')
    expect(mapped.media_kind).toBe('map')
  })

  it('keeps `image` as it found it', () => {
    expect(mapMediaAttachment({ ...mediaRow, media_kind: 'image' }, 'w').media_kind).toBe('image')
  })
})

describe('foldedRelationshipMapper', () => {
  const speaks = foldedRelationshipMapper({
    from: 'npc_id',
    to: 'language_id',
    type: 'speaks',
    role: 'role',
  })

  it('maps a junction pair onto a relationship row with a generated id', () => {
    const row = speaks({ npc_id: 'npc1', language_id: 'lg1', role: 'native' }, 'w1')

    expect(row).toMatchObject({
      world_id: 'w1',
      from_id: 'npc1',
      to_id: 'lg1',
      type: 'speaks',
      note: '',
      qualifier: 'native',
    })
    // A junction row has no id to preserve, unlike every other table the importer
    // touches — so this is the one place the importer generates one.
    expect(row.id).toEqual(expect.any(String))
    expect(speaks({ npc_id: 'npc1', language_id: 'lg1', role: 'native' }, 'w1').id).not.toBe(row.id)
  })

  it.each([
    ['native', 'native'],
    ['secondary', 'secondary'],
    ['liturgical', 'liturgical'],
    ['trade', 'trade'],
  ])('accepts %s as a qualifier — the vocabulary is the union of all four tables', (role, want) => {
    expect(speaks({ npc_id: 'a', language_id: 'b', role }, 'w1').qualifier).toBe(want)
  })

  it.each([[null], [undefined], [''], ['   ']])(
    'leaves the qualifier null for an absent role (%s)',
    (role) => {
      const row = speaks({ npc_id: 'a', language_id: 'b', role }, 'w1')
      expect(row.qualifier).toBeNull()
      expect(row.note).toBe('')
    },
  )

  it('salvages an unrecognized role into the note instead of dropping or storing it', () => {
    // The source is SQLite from a tool whose CHECK constraints we do not control,
    // and worlds get hand-edited. Nulling this would lose a fact the source
    // recorded; putting it in `qualifier` would corrupt the only column claiming
    // to be a controlled vocabulary.
    const row = speaks({ npc_id: 'a', language_id: 'b', role: 'ancestral' }, 'w1')

    expect(row.qualifier).toBeNull()
    expect(row.note).toBe('imported role: ancestral')
  })

  it('appends a salvaged role to an existing note rather than replacing it', () => {
    const foundAt = foldedRelationshipMapper({
      from: 'resource_id',
      to: 'location_id',
      type: 'found_at',
      role: 'role',
      note: 'notes',
    })

    const row = foundAt(
      { resource_id: 'r', location_id: 'l', notes: 'deep seam', role: 'odd' },
      'w1',
    )

    expect(row.note).toBe('deep seam (imported role: odd)')
  })

  it('maps a note column onto `note` and carries no qualifier when the table has no role', () => {
    const foundAt = foldedRelationshipMapper({
      from: 'resource_id',
      to: 'location_id',
      type: 'found_at',
      note: 'notes',
    })

    expect(foundAt({ resource_id: 'r', location_id: 'l', notes: 'rich seam' }, 'w1')).toMatchObject(
      {
        type: 'found_at',
        note: 'rich seam',
        qualifier: null,
      },
    )
    // A source predating the column (schema drift) gets the empty default, not
    // the string "undefined".
    expect(foundAt({ resource_id: 'r', location_id: 'l' }, 'w1').note).toBe('')
  })
})
