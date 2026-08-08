import { describe, expect, it } from 'vitest'
import { mapCalendar, mapMediaAttachment } from './mappers'
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
