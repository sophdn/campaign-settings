import { describe, expect, it } from 'vitest'
import { loadAuthConfig } from './config'

const SECRET = 'x'.repeat(32)

describe('loadAuthConfig', () => {
  it('rejects a missing or too-short secret', () => {
    expect(() => loadAuthConfig({})).toThrow(/SESSION_SECRET/)
    expect(() => loadAuthConfig({ SESSION_SECRET: 'short' })).toThrow(/SESSION_SECRET/)
  })

  it('defaults the TTL to 30 days and leaves cookies insecure outside production', () => {
    const cfg = loadAuthConfig({ SESSION_SECRET: SECRET })
    expect(cfg.sessionTtlMs).toBe(30 * 24 * 60 * 60 * 1000)
    expect(cfg.cookieSecure).toBe(false)
    expect(cfg.cookieSecret).toBe(SECRET)
  })

  it('honours a custom positive TTL and marks cookies secure in production', () => {
    const cfg = loadAuthConfig({
      SESSION_SECRET: SECRET,
      SESSION_TTL_DAYS: '7',
      NODE_ENV: 'production',
    })
    expect(cfg.sessionTtlMs).toBe(7 * 24 * 60 * 60 * 1000)
    expect(cfg.cookieSecure).toBe(true)
  })

  it('rejects a non-numeric or non-positive TTL', () => {
    expect(() => loadAuthConfig({ SESSION_SECRET: SECRET, SESSION_TTL_DAYS: 'abc' })).toThrow(
      /positive number/,
    )
    expect(() => loadAuthConfig({ SESSION_SECRET: SECRET, SESSION_TTL_DAYS: '0' })).toThrow(
      /positive number/,
    )
  })
})
