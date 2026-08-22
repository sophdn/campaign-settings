/**
 * Operator CLI: create the first (or any) account.
 *   tsx scripts/create-account.mts <username> [email]
 * Password is read from CS_ADMIN_PASSWORD, or prompted on stdin if unset — it is
 * NEVER passed on argv (which is visible in the process table / shell history).
 * Email is optional and NOT secret, so it rides on argv; omit it for an
 * account with no contact channel (the pre-0006 default).
 */
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { Pool } from 'pg'
import { createScryptAuth } from '../src/auth/service'
import { DuplicateUsernameError } from '../src/auth/types'
import { createDb } from '../src/db/kysely'
import { migrateToLatest } from '../src/db/migrator'

const username = process.argv[2]
const email = process.argv[3] ?? null
if (!username) {
  console.error(
    'usage: tsx scripts/create-account.mts <username> [email]  (password via CS_ADMIN_PASSWORD env or prompt)',
  )
  process.exit(1)
}

const url = process.env.DATABASE_URL
if (!url) throw new Error('set DATABASE_URL')

async function readPassword(): Promise<string> {
  const fromEnv = process.env.CS_ADMIN_PASSWORD
  if (fromEnv) return fromEnv
  const rl = createInterface({ input: stdin, output: stdout })
  try {
    return await rl.question(`password for ${username}: `)
  } finally {
    rl.close()
  }
}

const password = await readPassword()
if (!password) throw new Error('empty password')

const pool = new Pool({ connectionString: url })
const db = createDb(pool)
try {
  await migrateToLatest(db)
  const account = await createScryptAuth(db).createAccount(username, password, email)
  console.log(`created account ${account.username} (${account.id})`)
} catch (err) {
  if (err instanceof DuplicateUsernameError) {
    console.error(`error: ${err.message}`)
    process.exitCode = 1
  } else {
    throw err
  }
} finally {
  await db.destroy()
}
