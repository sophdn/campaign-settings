import { createHash, randomBytes } from 'node:crypto'

/**
 * The shared secret-token primitives. Password reset and world invitations both
 * hand someone an opaque string that must be unguessable, single-use, and
 * unreadable from the database if it leaks — so they share ONE implementation
 * rather than each rolling its own and drifting on entropy or hash choice.
 */

/** A fresh 256-bit secret, URL-safe so it can ride in a link. */
export function newToken(): string {
  return randomBytes(32).toString('base64url')
}

/**
 * SHA-256 hex of a raw token. Only the hash is ever stored: a dump of the
 * database must not yield working tokens. Plain SHA-256 (not a slow KDF) is
 * correct here — the input is 256 bits of machine randomness, so there is no
 * guessable keyspace for a slow hash to protect.
 */
export function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex')
}
