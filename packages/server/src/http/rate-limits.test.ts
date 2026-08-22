import { describe, expect, it } from 'vitest'
import { DEFAULT_RATE_LIMITS, loadRateLimits, parseRateLimit } from './rate-limits'

describe('parseRateLimit', () => {
  const fallback = { max: 10, timeWindow: 600_000 }

  it('uses the default when the environment says nothing', () => {
    expect(parseRateLimit(undefined, undefined, fallback)).toEqual(fallback)
  })

  it('reads each half independently', () => {
    expect(parseRateLimit('3', undefined, fallback)).toEqual({ max: 3, timeWindow: 600_000 })
    expect(parseRateLimit(undefined, '1000', fallback)).toEqual({ max: 10, timeWindow: 1000 })
    expect(parseRateLimit(' 4 ', ' 60000 ', fallback)).toEqual({ max: 4, timeWindow: 60_000 })
  })

  /**
   * Fail-safe in the same direction as parseFlag and parseLimit: a typo must
   * leave the ceiling in place, never remove it. Zero and negatives are the
   * dangerous readings — a `max` of 0 would refuse everyone, and a negative
   * one is meaningless — so both fall back rather than being honoured.
   */
  it('falls back on anything that is not a positive whole number', () => {
    for (const bad of ['0', '-1', '1.5', '', 'lots', 'NaN']) {
      expect(parseRateLimit(bad, bad, fallback), bad).toEqual(fallback)
    }
  })
})

describe('loadRateLimits', () => {
  it('is the documented defaults when the environment is empty', () => {
    expect(loadRateLimits({})).toEqual(DEFAULT_RATE_LIMITS)
  })

  it('reads each ceiling from its own pair of variables', () => {
    expect(
      loadRateLimits({
        AUTH_RATE_LIMIT_MAX: '1',
        MAIL_RATE_LIMIT_MAX: '2',
        TOKEN_RATE_LIMIT_MAX: '3',
        LOOKUP_RATE_LIMIT_MAX: '4',
        AUTH_RATE_LIMIT_WINDOW_MS: '1000',
      }),
    ).toEqual({
      auth: { max: 1, timeWindow: 1000 },
      mail: { max: 2, timeWindow: DEFAULT_RATE_LIMITS.mail.timeWindow },
      token: { max: 3, timeWindow: DEFAULT_RATE_LIMITS.token.timeWindow },
      lookup: { max: 4, timeWindow: DEFAULT_RATE_LIMITS.lookup.timeWindow },
    })
  })

  it('reads process.env when called with no argument', () => {
    expect(typeof loadRateLimits().auth.max).toBe('number')
  })
})
