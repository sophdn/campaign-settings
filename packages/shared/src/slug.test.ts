import { describe, expect, it } from 'vitest'
import { nextAvailableSlug, slugify } from './slug'

describe('slugify', () => {
  it('lowercases and dash-joins words', () => {
    expect(slugify('Shadowrun Chicago')).toBe('shadowrun-chicago')
  })

  it('collapses punctuation and repeated separators into single dashes', () => {
    expect(slugify('  The Prince’s   Court!! ')).toBe('the-prince-s-court')
    expect(slugify('A — B / C')).toBe('a-b-c')
  })

  it('folds accented characters to their ascii base', () => {
    expect(slugify('Café Düsseldorf')).toBe('cafe-dusseldorf')
  })

  it('falls back to "world" when nothing usable remains', () => {
    expect(slugify('！！！')).toBe('world')
    expect(slugify('')).toBe('world')
  })
})

describe('nextAvailableSlug', () => {
  it('returns the base untouched when it is free', () => {
    expect(nextAvailableSlug('chicago', new Set())).toBe('chicago')
  })

  it('appends the first free numeric suffix on collision', () => {
    expect(nextAvailableSlug('chicago', new Set(['chicago']))).toBe('chicago-2')
    expect(nextAvailableSlug('chicago', new Set(['chicago', 'chicago-2']))).toBe('chicago-3')
  })

  it('skips gaps to the next free suffix', () => {
    expect(nextAvailableSlug('chicago', new Set(['chicago', 'chicago-3']))).toBe('chicago-2')
  })
})
