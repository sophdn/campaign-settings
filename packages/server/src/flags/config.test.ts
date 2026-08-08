import { describe, expect, it } from 'vitest'
import { allFlags, loadFlags, openFlags, parseFlag } from './config'

describe('parseFlag', () => {
  it('returns the fallback when the value is undefined', () => {
    expect(parseFlag(undefined, false)).toBe(false)
    expect(parseFlag(undefined, true)).toBe(true)
  })

  it('honours an explicit true / false (trimmed, case-insensitive)', () => {
    expect(parseFlag('true', false)).toBe(true)
    expect(parseFlag('  TRUE  ', false)).toBe(true)
    expect(parseFlag('false', true)).toBe(false)
    expect(parseFlag('False', true)).toBe(false)
  })

  it('falls back on a malformed value rather than guessing', () => {
    expect(parseFlag('1', false)).toBe(false)
    expect(parseFlag('yes', false)).toBe(false)
    expect(parseFlag('', false)).toBe(false)
    // fail-closed the other way too: garbage never flips a default-true flag off
    expect(parseFlag('nope', true)).toBe(true)
  })
})

describe('loadFlags', () => {
  it('defaults EVERY flag to false (fail-closed) when the environment is empty', () => {
    // Not just the one that happens to be first: an unlisted flag defaulting
    // open is precisely the accident the registry's fail-closed rule prevents.
    expect(loadFlags({})).toEqual(allFlags(false))
  })

  it('enables a flag only on an explicit true, and only that flag', () => {
    expect(loadFlags({ PUBLIC_SIGNUP_ENABLED: 'true' })).toEqual({
      ...allFlags(false),
      publicSignupEnabled: true,
    })
    expect(loadFlags({ PUBLIC_SIGNUP_ENABLED: 'false' })).toEqual(allFlags(false))
    expect(loadFlags({ PUBLIC_SIGNUP_ENABLED: 'garbage' })).toEqual(allFlags(false))
  })

  it('reads each surface from its own variable', () => {
    expect(
      loadFlags({
        LOGIN_ENABLED: 'true',
        PASSWORD_RESET_ENABLED: 'true',
        SUGGESTIONS_ENABLED: 'true',
        ACCOUNT_MANAGEMENT_ENABLED: 'true',
        DEMO_MODE: 'true',
      }),
    ).toEqual({ ...allFlags(true), publicSignupEnabled: false })
  })

  it('openFlags is every surface open', () => {
    expect(openFlags()).toEqual(allFlags(true))
    expect(Object.values(openFlags()).every(Boolean)).toBe(true)
  })

  it('reads process.env when called with no argument', () => {
    // exercises the default parameter without asserting the ambient value
    expect(typeof loadFlags().publicSignupEnabled).toBe('boolean')
  })
})
