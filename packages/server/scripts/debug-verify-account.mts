/**
 * Operator CLI: mark an account's email verified without the emailed round trip.
 *   tsx scripts/debug-verify-account.mts <username>
 *
 * For local dev, dummy setups, and accounts minted by `create-account.mts` on a
 * host with no outbound mail path — where the real flow cannot complete because
 * there is nothing to send the link with.
 *
 * This is intentionally a SHELL tool and not an HTTP route. Verification exists
 * so that holding an address is proven rather than claimed; an endpoint that
 * skips the proof would make the whole mechanism an honour system. Needing a
 * shell on the host is the trust boundary, the same one create-account.mts
 * already stands on.
 *
 * Env: DATABASE_URL (required — no default, so a mistyped command cannot quietly
 * hit the dev database while you believed you were pointed at something else).
 */
import { Pool } from 'pg'
import { createDb } from '../src/db/kysely'
import { debugVerifyAccount } from '../src/auth/verification'

const username = process.argv[2]
if (!username) {
  console.error('usage: tsx scripts/debug-verify-account.mts <username>')
  process.exit(1)
}

const url = process.env.DATABASE_URL
if (!url) {
  console.error('debug-verify-account: DATABASE_URL is required')
  process.exit(2)
}

const db = createDb(new Pool({ connectionString: url }))
try {
  const result = await debugVerifyAccount(db, username)
  switch (result.status) {
    case 'verified':
      console.log(`verified ${result.username} <${result.email}> at ${result.at.toISOString()}`)
      break
    case 'already-verified':
      console.log(
        `${result.username} <${result.email}> was already verified at ${result.at.toISOString()}; nothing to do`,
      )
      break
    case 'no-email':
      console.log(
        `${result.username} has no email address, so there is nothing to verify. Accounts without an address are not gated.`,
      )
      break
    case 'no-such-account':
      console.error(`no account named "${result.username}"`)
      process.exitCode = 1
      break
  }
} finally {
  await db.destroy()
}
