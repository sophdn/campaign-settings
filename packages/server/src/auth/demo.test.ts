import { describe, expect, it } from 'vitest'
import { demoRequestAllowed } from './demo'

/**
 * The demo principal's request policy, in isolation. `http-demo.test.ts` drives
 * the same rules through the real routes; these pin the predicate's edges,
 * which a route-level test can only reach by inventing routes to reach them.
 */
describe('demoRequestAllowed', () => {
  it('allows safe methods', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS', 'get', 'head']) {
      expect(demoRequestAllowed(method, '/api/worlds'), method).toBe(true)
    }
  })

  it('refuses every unsafe method', () => {
    for (const method of ['POST', 'PATCH', 'PUT', 'DELETE', 'delete']) {
      expect(demoRequestAllowed(method, '/api/worlds'), method).toBe(false)
    }
  })

  it('allows logging out, so a visitor can leave', () => {
    expect(demoRequestAllowed('POST', '/api/logout')).toBe(true)
    expect(demoRequestAllowed('POST', '/api/logout?next=/')).toBe(true)
  })

  /**
   * Safe is not the same as harmless on a SHARED account: the session list
   * carries the device label of whoever opened the shared session, so a GET is
   * one visitor reading a fact about another.
   */
  it('refuses the account family whatever the method, reads included', () => {
    for (const url of [
      '/api/account',
      '/api/account/sessions',
      '/api/account/status',
      '/api/account/deletion-blockers',
      '/api/account/sessions?since=1',
    ]) {
      expect(demoRequestAllowed('GET', url), url).toBe(false)
      expect(demoRequestAllowed('POST', url), url).toBe(false)
    }
  })

  it('matches the account family by segment, not by string prefix', () => {
    // a different family that merely starts with the same characters
    expect(demoRequestAllowed('GET', '/api/accounts/lookup')).toBe(true)
    expect(demoRequestAllowed('GET', '/api/account-recovery')).toBe(true)
  })
})
