import {
  type BinaryLike,
  randomBytes,
  type ScryptOptions,
  scrypt as scryptCb,
  timingSafeEqual,
} from 'node:crypto'
import { promisify } from 'node:util'

// promisify infers scrypt's no-options overload, so type the result explicitly
// to keep the (password, salt, keylen, options) form.
const scrypt = promisify(scryptCb) as (
  password: BinaryLike,
  salt: BinaryLike,
  keylen: number,
  options: ScryptOptions,
) => Promise<Buffer>

// scrypt cost parameters. N must be a power of two; these are a reasonable
// interactive-login cost. They are encoded into every hash so the cost can be
// raised later without invalidating already-stored hashes.
const N = 16384
const R = 8
const P = 1
const KEYLEN = 64

/** Minimum password length, shared by registration and password reset. */
export const MIN_PASSWORD_LENGTH = 8

/** Hash a password into a self-describing `scrypt$N$r$p$salt$hash` string. */
export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(16)
  const derived = await scrypt(plain, salt, KEYLEN, { N, r: R, p: P })
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64url')}$${derived.toString('base64url')}`
}

/**
 * Constant-time verify against a stored hash. Returns false — never throws — on
 * any malformed input, so callers can treat every failure mode uniformly.
 */
export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  const parts = stored.split('$')
  if (parts.length !== 6) return false
  const [scheme, nS, rS, pS, saltB64, hashB64] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
  ]
  if (scheme !== 'scrypt') return false
  const n = Number(nS)
  const r = Number(rS)
  const p = Number(pS)
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false
  const salt = Buffer.from(saltB64, 'base64url')
  const expected = Buffer.from(hashB64, 'base64url')
  if (expected.length === 0) return false
  let derived: Buffer
  try {
    derived = await scrypt(plain, salt, expected.length, { N: n, r, p })
  } catch {
    // bad params (e.g. N not a power of two) or memory limit — treat as no match
    return false
  }
  return timingSafeEqual(derived, expected)
}
