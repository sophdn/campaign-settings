import type { Kysely } from 'kysely'
import type { Database } from '../db/schema'
import { getAccountByUsername } from './accounts'

/**
 * The shared demo principal.
 *
 * The portfolio's entry point lands a visitor already signed in as ONE shared,
 * read-only player. Two properties make that safe, and both live here:
 *
 *  1. **The endpoint takes no input.** It cannot be asked to authenticate as
 *     anybody — there is no username, no id, no token to substitute. The only
 *     identity it can produce is the account named by `DEMO_USERNAME`.
 *  2. **It creates nothing per visit.** Every visitor shares one
 *     `auth_sessions` row, reused until it expires. A thousand visits is one
 *     row, so a flood of traffic costs no storage and there is nothing to reap.
 *
 * The account being SHARED is exactly why `enforce-demo-read-only` exists: one
 * visitor must not be able to change what the next one sees, or change the
 * credentials out from under everybody.
 */

/** Default demo account name; overridable so a deployment can pick its own. */
export const DEFAULT_DEMO_USERNAME = 'demo'

/** Raised when demo mode is on but the demo account has not been provisioned. */
export class DemoAccountMissingError extends Error {
  constructor(username: string) {
    super(`demo mode is enabled but no account named "${username}" exists on this instance`)
    this.name = 'DemoAccountMissingError'
  }
}

/**
 * The demo account's id, or a refusal naming what is missing.
 *
 * A clear refusal rather than a silent 500: "demo mode is on and the account is
 * not there" is a deployment mistake, and the operator should be told which of
 * the two halves they forgot.
 */
export async function demoAccountId(db: Kysely<Database>, username: string): Promise<string> {
  const account = await getAccountByUsername(db, username)
  if (!account) throw new DemoAccountMissingError(username)
  return account.id
}

/**
 * A session id for the demo account: the existing shared one if it is still
 * live, otherwise a freshly-minted one that subsequent visitors reuse.
 *
 * The lookup takes the LATEST unexpired session rather than any of them, so if
 * a stray row ever exists the newest wins and the rest age out. `mintSession`
 * is passed in rather than imported so this stays behind the auth port — the
 * demo path must not become a second place that knows how sessions are made.
 */
export async function sharedDemoSession(
  db: Kysely<Database>,
  accountId: string,
  now: Date,
  mintSession: () => Promise<string>,
): Promise<string> {
  const live = await db
    .selectFrom('auth_sessions')
    .select('id')
    .where('account_id', '=', accountId)
    .where('expires_at', '>', now)
    .orderBy('expires_at', 'desc')
    .executeTakeFirst()
  return live?.id ?? (await mintSession())
}

/**
 * Raised when the shared demo principal attempts any mutation.
 *
 * Read-only is a property OF THE PRINCIPAL, checked once for every unsafe
 * request, rather than a gate bolted onto each mutating route. Enumerating
 * routes would mean the next route added is writable by default — which, on a
 * shared account, means the next feature quietly lets a visitor deface the demo
 * for everyone after them.
 */
export class DemoReadOnlyError extends Error {
  constructor() {
    super('the demo account is read-only')
    this.name = 'DemoReadOnlyError'
  }
}

/** HTTP methods that do not change state, and so are always allowed. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * Whether a request from the demo principal is allowed.
 *
 * Everything unsafe is refused, with ONE exception: logging out. A visitor must
 * be able to leave the demo, and the logout route is careful not to delete the
 * shared session row (see the route) — it only clears that visitor's cookie.
 */
export function demoRequestAllowed(method: string, url: string): boolean {
  if (SAFE_METHODS.has(method.toUpperCase())) return true
  return url.split('?')[0] === '/api/logout'
}
