import { describe, expect, it } from 'vitest'
import { hashPassword, verifyPassword } from './password'

describe('password hashing', () => {
  it('hashes to a self-describing scrypt string that is not the plaintext', async () => {
    const hash = await hashPassword('correct horse')
    expect(hash.startsWith('scrypt$16384$8$1$')).toBe(true)
    expect(hash).not.toContain('correct horse')
    expect(hash.split('$')).toHaveLength(6)
  })

  it('uses a random salt so equal passwords hash differently', async () => {
    expect(await hashPassword('same')).not.toBe(await hashPassword('same'))
  })

  it('verifies the correct password and rejects a wrong one', async () => {
    const hash = await hashPassword('s3cret')
    expect(await verifyPassword('s3cret', hash)).toBe(true)
    expect(await verifyPassword('s3cret!', hash)).toBe(false)
  })

  it('returns false (never throws) on every malformed stored hash', async () => {
    expect(await verifyPassword('x', 'not-a-hash')).toBe(false) // wrong part count
    expect(await verifyPassword('x', 'bcrypt$16384$8$1$YWJj$YWJj')).toBe(false) // wrong scheme
    expect(await verifyPassword('x', 'scrypt$NaN$8$1$YWJj$YWJj')).toBe(false) // non-integer param
    expect(await verifyPassword('x', 'scrypt$16384$8$1$YWJj$')).toBe(false) // empty hash
    expect(await verifyPassword('x', 'scrypt$3$8$1$YWJj$YWJj')).toBe(false) // invalid scrypt N
  })
})
