import { describe, expect, it } from 'vitest'
import { parseTrustProxy } from './trust-proxy'

describe('parseTrustProxy', () => {
  it('trusts nothing when the deployment says nothing', () => {
    expect(parseTrustProxy(undefined)).toBe(false)
    expect(parseTrustProxy('')).toBe(false)
    expect(parseTrustProxy('   ')).toBe(false)
    expect(parseTrustProxy('false')).toBe(false)
  })

  it('reads a whole number as a hop count', () => {
    expect(parseTrustProxy('1')).toBe(1)
    expect(parseTrustProxy(' 2 ')).toBe(2)
    // zero hops is "no proxy", spelled the other way
    expect(parseTrustProxy('0')).toBe(false)
  })

  it('accepts an explicit true for a chain that is unreachable except through the proxy', () => {
    expect(parseTrustProxy('true')).toBe(true)
  })

  it('passes an address or CIDR through for fastify to match', () => {
    expect(parseTrustProxy('192.0.2.0/24')).toBe('192.0.2.0/24')
    expect(parseTrustProxy('127.0.0.1')).toBe('127.0.0.1')
  })

  /**
   * A typo lands in the address case, and that fails safe on its own: fastify
   * matches the string against the peer address, and a value that is not an
   * address matches nothing, so nothing is trusted. Worth pinning, because the
   * tempting "helpful" reading of `yes` is the one that would start believing a
   * header the caller controls.
   */
  it('does not read a near-miss word as a yes', () => {
    expect(parseTrustProxy('yes')).not.toBe(true)
    expect(parseTrustProxy('1.5')).not.toBe(true)
    expect(parseTrustProxy('TRUE')).not.toBe(true)
  })
})
