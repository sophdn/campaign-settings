import { describe, expect, it } from 'vitest'
import { DEFAULT_LIMITS, loadLimits, parseLimit } from './limits'

describe('parseLimit', () => {
  it('reads a positive integer', () => {
    expect(parseLimit('12', 5)).toBe(12)
    expect(parseLimit('  12  ', 5)).toBe(12)
  })

  it('falls back for anything that is not a usable ceiling', () => {
    // A typo must not silently REMOVE a limit — the same fail-safe reasoning as
    // parseFlag. Zero and negatives are not "no limit", they are a mistake.
    for (const raw of [undefined, '', '  ', 'lots', '0', '-1', '1.5', 'NaN', 'Infinity']) {
      expect(parseLimit(raw, 5), `parseLimit(${String(raw)})`).toBe(5)
    }
  })
})

describe('loadLimits', () => {
  it('defaults every limit when the environment is empty', () => {
    expect(loadLimits({})).toEqual(DEFAULT_LIMITS)
  })

  it('reads each limit from its own variable', () => {
    // Every field is set, so a limit added without an env var of its own — the
    // way a ceiling quietly becomes un-tunable in production — fails here.
    expect(
      loadLimits({
        MAX_WORLDS_PER_ACCOUNT: '3',
        MAX_ENTITIES_PER_WORLD: '40',
        MAX_MEDIA_BYTES_PER_WORLD: '500',
        MAX_IMAGE_BYTES: '600',
        MAX_MAP_IMAGE_BYTES: '700',
        MAX_THUMBNAIL_BYTES: '800',
        MAX_PASSAGES_PER_ENTITY: '9',
        MAX_PASSAGE_BODY_CHARS: '1000',
        MAX_PENDING_PROPOSALS_PER_AUTHOR: '4',
      }),
    ).toEqual({
      worldsPerAccount: 3,
      entitiesPerWorld: 40,
      mediaBytesPerWorld: 500,
      imageBytes: 600,
      mapImageBytes: 700,
      thumbnailBytes: 800,
      passagesPerEntity: 9,
      passageBodyChars: 1000,
      pendingProposalsPerAuthor: 4,
    })
  })

  it('falls back per-variable, not all-or-nothing', () => {
    expect(loadLimits({ MAX_WORLDS_PER_ACCOUNT: 'nope', MAX_ENTITIES_PER_WORLD: '40' })).toEqual({
      ...DEFAULT_LIMITS,
      entitiesPerWorld: 40,
    })
  })
})
