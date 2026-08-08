import { describe, expect, it } from 'vitest'
import {
  type ActiveBracket,
  activeBracketQuery,
  BRACKET_RESOLVER_ORDER,
  buildNameIndex,
  completeBracket,
  type NameIndex,
  parseBrackets,
  resolveBracket,
} from './brackets'

describe('parseBrackets', () => {
  it('returns empty for empty text or text with no brackets', () => {
    expect(parseBrackets('')).toEqual([])
    expect(parseBrackets('The party arrived at Ashenfield.')).toEqual([])
  })

  it('extracts a single bracket with correct span', () => {
    const text = 'They met [[Lord Aldric]] in the square.'
    expect(parseBrackets(text)).toEqual([{ name: 'Lord Aldric', start: 9, end: 24 }])
    expect(text.slice(9, 24)).toBe('[[Lord Aldric]]')
  })

  it('extracts multiple brackets with correct spans', () => {
    const text = '[[Aldric]] and [[Bren]] talked.'
    const out = parseBrackets(text)
    expect(out.map((b) => b.name)).toEqual(['Aldric', 'Bren'])
    expect(text.slice(out[0]!.start, out[0]!.end)).toBe('[[Aldric]]')
    expect(text.slice(out[1]!.start, out[1]!.end)).toBe('[[Bren]]')
  })

  it('normalises internal/surrounding whitespace inside the name', () => {
    expect(parseBrackets('[[Lord  Aldric]]').map((b) => b.name)).toEqual(['Lord Aldric'])
    expect(parseBrackets('[[ Lord Aldric ]]').map((b) => b.name)).toEqual(['Lord Aldric'])
  })

  it('skips empty brackets but keeps surrounding ones', () => {
    expect(parseBrackets('[[]]')).toEqual([])
    expect(parseBrackets('[[  ]]')).toEqual([])
    expect(parseBrackets('[[Real]] then [[]] then [[AlsoReal]]').map((b) => b.name)).toEqual([
      'Real',
      'AlsoReal',
    ])
  })

  it('stops cleanly at an unclosed bracket and preserves prior matches', () => {
    expect(parseBrackets('[[Aldric]] then [[unclosed').map((b) => b.name)).toEqual(['Aldric'])
  })

  it('preserves duplicate occurrences (dedup is the caller’s job)', () => {
    expect(parseBrackets('[[Aldric]] said [[Aldric]] again.').map((b) => b.name)).toEqual([
      'Aldric',
      'Aldric',
    ])
  })
})

describe('buildNameIndex', () => {
  it('returns an empty index for empty input', () => {
    expect(buildNameIndex([]).size).toBe(0)
  })

  it('indexes rows by lowercased name', () => {
    const idx = buildNameIndex([
      {
        kind: 'npc',
        rows: [
          { id: 'n1', name: 'Lord Aldric' },
          { id: 'n2', name: 'Bren' },
        ],
      },
    ])
    expect(idx.get('lord aldric')).toEqual({ kind: 'npc', id: 'n1' })
    expect(idx.get('bren')).toEqual({ kind: 'npc', id: 'n2' })
    expect(idx.size).toBe(2)
  })

  it('first input order wins on a cross-kind name collision', () => {
    expect(
      buildNameIndex([
        { kind: 'npc', rows: [{ id: 'n1', name: 'Ashenfield' }] },
        { kind: 'settlement', rows: [{ id: 's1', name: 'Ashenfield' }] },
      ]).get('ashenfield'),
    ).toEqual({ kind: 'npc', id: 'n1' })
    expect(
      buildNameIndex([
        { kind: 'settlement', rows: [{ id: 's1', name: 'Ashenfield' }] },
        { kind: 'npc', rows: [{ id: 'n1', name: 'Ashenfield' }] },
      ]).get('ashenfield'),
    ).toEqual({ kind: 'settlement', id: 's1' })
  })

  it('first row within a kind wins on intra-kind duplication', () => {
    const idx = buildNameIndex([
      {
        kind: 'npc',
        rows: [
          { id: 'n1', name: 'Twin' },
          { id: 'n2', name: 'Twin' },
        ],
      },
    ])
    expect(idx.get('twin')).toEqual({ kind: 'npc', id: 'n1' })
  })
})

describe('resolveBracket', () => {
  const fixture = (): NameIndex =>
    buildNameIndex([
      {
        kind: 'npc',
        rows: [
          { id: 'n1', name: 'Lord Aldric' },
          { id: 'n2', name: 'Bren' },
        ],
      },
      { kind: 'settlement', rows: [{ id: 's1', name: 'Ashenfield' }] },
    ])

  it('resolves case-insensitively and after whitespace normalisation', () => {
    expect(resolveBracket('Lord Aldric', fixture())).toEqual({ kind: 'npc', id: 'n1' })
    expect(resolveBracket('LORD ALDRIC', fixture())).toEqual({ kind: 'npc', id: 'n1' })
    expect(resolveBracket('  Lord   Aldric  ', fixture())).toEqual({ kind: 'npc', id: 'n1' })
    expect(resolveBracket('ashenfield', fixture())).toEqual({ kind: 'settlement', id: 's1' })
  })

  it('returns null for an absent or empty name', () => {
    expect(resolveBracket('Nonexistent', fixture())).toBeNull()
    expect(resolveBracket('', fixture())).toBeNull()
    expect(resolveBracket('   ', fixture())).toBeNull()
  })
})

describe('BRACKET_RESOLVER_ORDER', () => {
  it('lists the 16 bracketable kinds and excludes map / attachments', () => {
    expect(BRACKET_RESOLVER_ORDER).toHaveLength(16)
    expect(BRACKET_RESOLVER_ORDER[0]).toBe('npc')
    expect(BRACKET_RESOLVER_ORDER).not.toContain('map')
  })
})

describe('activeBracketQuery', () => {
  // The caret is written as `|` in these names; the tests pass its index.
  const at = (withCaret: string): { text: string; caret: number } => ({
    text: withCaret.replace('|', ''),
    caret: withCaret.indexOf('|'),
  })
  const query = (withCaret: string): ActiveBracket | null => {
    const { text, caret } = at(withCaret)
    return activeBracketQuery(text, caret)
  }

  it('matches the moment the brackets are typed, with an empty query', () => {
    // The author who has just typed `[[` is the one who most needs the list.
    expect(query('Met [[|')).toEqual({ query: '', start: 4, end: 6 })
  })

  it('returns the text between the brackets and the caret', () => {
    expect(query('Met [[Sil|')).toEqual({ query: 'Sil', start: 4, end: 9 })
    expect(query('Met [[Silas Cr|')).toEqual({ query: 'Silas Cr', start: 4, end: 14 })
  })

  it('is not active outside a marker', () => {
    expect(query('|')).toBeNull()
    expect(query('plain prose|')).toBeNull()
    expect(query('a single [ bracket|')).toBeNull()
  })

  it('is not active after a marker has closed', () => {
    expect(query('Met [[Mira]] then|')).toBeNull()
    expect(query('Met [[Mira]]|')).toBeNull()
  })

  it('tracks the NEAREST opening when several markers exist', () => {
    const r = query('Met [[Mira]] and [[Sil|')
    expect(r).toEqual({ query: 'Sil', start: 17, end: 22 })
  })

  it('does not run away across a line break', () => {
    // A stray `[[` earlier in a long body must not make every later keystroke
    // look like a query.
    expect(query('Met [[\nlater prose|')).toBeNull()
  })

  it('spans the whole marker when the caret is inside a CLOSED one', () => {
    // Completing here replaces `[[Silas Crow]]` entirely rather than leaving
    // "as Crow]]" stranded after the inserted link.
    const r = query('Met [[Sil|as Crow]] today')
    expect(r).toEqual({ query: 'Sil', start: 4, end: 18 })
  })

  it('stops at the next opening rather than swallowing a later marker', () => {
    const r = query('Met [[Sil| and [[Mira]]')
    expect(r?.end).toBe(9) // the caret, not the far-off `]]`
  })

  it('rejects a caret outside the text', () => {
    expect(activeBracketQuery('Met [[', 99)).toBeNull()
    expect(activeBracketQuery('Met [[', -1)).toBeNull()
  })
})

describe('completeBracket', () => {
  it('replaces an open marker and puts the caret after the link', () => {
    const text = 'Met [[Sil'
    const active = activeBracketQuery(text, text.length)!
    expect(completeBracket(text, active, 'Silas Crow')).toEqual({
      text: 'Met [[Silas Crow]]',
      caret: 18,
    })
  })

  it('replaces a closed marker without stranding its tail', () => {
    const text = 'Met [[Silas Crow]] today'
    const active = activeBracketQuery(text, 9)! // caret after "Sil"
    expect(completeBracket(text, active, 'Mira Vane')).toEqual({
      text: 'Met [[Mira Vane]] today',
      caret: 17,
    })
  })

  it('produces a marker that resolveBracket can resolve', () => {
    // The guarantee that matters: what the picker inserts must round-trip.
    const index = buildNameIndex([{ kind: 'npc', rows: [{ id: 'n1', name: 'Silas Crow' }] }])
    const text = 'Met [[sil'
    const active = activeBracketQuery(text, text.length)!
    const done = completeBracket(text, active, 'Silas Crow')
    const marker = parseBrackets(done.text)[0]!
    expect(resolveBracket(marker.name, index)).toEqual({ kind: 'npc', id: 'n1' })
  })
})
