/**
 * The auth seam (port). Everything outside this module — the HTTP routes, the
 * operator CLI, future tenancy code — depends ONLY on `AuthService`, never on
 * scrypt / cookies / sessions directly. The scrypt+cookie implementation lives
 * behind `createScryptAuth` (service.ts); swapping in a different provider
 * (e.g. a vetted library adapter) is a one-file change that re-satisfies this
 * contract, and the suite in service.test.ts pins the full expected behaviour.
 */
import type { BlockingWorld } from './deletion'

/**
 * Account fields safe to expose over the API (never the password hash). Email is
 * DELIBERATELY excluded (decision, task decide-account-identity-model): it is
 * personal contact data, and this shape is returned to OTHER users (member
 * lists, account lookup), so surfacing it here would leak addresses across
 * accounts. A future owner-only "my account" endpoint may return the caller's
 * OWN email; that is a distinct shape, not this one.
 */
export interface PublicAccount {
  id: string
  username: string
}

export interface LoginResult {
  /** Opaque session id to store in the (signed) session cookie. */
  sessionId: string
  account: PublicAccount
}

/**
 * What the caller knows about the device opening a session. `deviceLabel` is
 * already REDUCED to a coarse string ("Firefox on Linux") by the transport
 * layer — the port never sees a raw User-Agent, so no implementation of it can
 * start storing one.
 */
export interface SessionMeta {
  deviceLabel?: string | null
}

/**
 * One live session as the account-settings list shows it. Note there is no
 * session id: the id IS the bearer credential, so listing it would hand every
 * XSS a set of ready-made cookies. Identifying a session for revocation is not
 * needed — the only revoke operation is "all except the one I'm using".
 */
export interface SessionSummary {
  createdAt: Date
  lastSeenAt: Date
  /** Null when the client sent nothing recognisable (API client, curl). */
  deviceLabel: string | null
  /** True for the session making this request. */
  current: boolean
}

export interface AuthService {
  /**
   * How long a session this service issues remains valid, in milliseconds.
   *
   * Part of the contract, not a convenience: the transport has to set a cookie
   * max-age, and a cookie whose lifetime disagrees with the row's `expires_at`
   * is broken in both directions — one leaves the browser presenting a dead
   * credential, the other logs a user out while their session is still live.
   * Only the service knows the answer, so any provider that issues sessions
   * must be able to state it. Previously the HTTP layer took its own copy of
   * this number and the two could silently drift.
   */
  readonly sessionTtlMs: number
  /**
   * Create an account. Throws {@link DuplicateUsernameError} if the username is
   * taken — it never overwrites an existing account. `email` is optional (the
   * operator CLI may omit it); when present it must be case-insensitively unique
   * (the DB partial unique index is the backstop).
   */
  createAccount(username: string, password: string, email?: string | null): Promise<PublicAccount>
  /**
   * Open a session for an account that has just been established by some other
   * means — registration, or accepting an invitation. Distinct from `login`,
   * which exists to VERIFY a credential; re-verifying a password the caller
   * just set would mean hashing it twice for no added assurance.
   */
  startSession(accountId: string, meta?: SessionMeta): Promise<string>
  /**
   * Verify credentials and open a session, or null if they don't match. Also
   * the moment an account's already-expired session rows are reaped: it is the
   * only point where a row is created, so reaping here bounds the table.
   */
  login(username: string, password: string, meta?: SessionMeta): Promise<LoginResult | null>
  /** Resolve the account behind a live (unexpired) session, or null. */
  authenticate(sessionId: string): Promise<PublicAccount | null>
  /** Invalidate a session id (idempotent — unknown ids are a no-op). */
  logout(sessionId: string): Promise<void>
  /**
   * Overwrite an account's password, going through the same hashing path as
   * account creation. Consumed by password reset and (later) password change —
   * one implementation, not two.
   */
  setPassword(accountId: string, newPassword: string): Promise<void>
  /**
   * End every session belonging to an account. Used by password RESET, where
   * there is no trusted caller to spare — whoever asked arrived via an emailed
   * token, not a live session.
   */
  invalidateAllSessions(accountId: string): Promise<void>
  /**
   * End every session EXCEPT the given one. The primitive behind password
   * change and revoke-all: both mean "get everyone else out" and neither should
   * log the user out of the device they are standing at.
   */
  invalidateOtherSessions(accountId: string, exceptSessionId: string): Promise<void>
  /**
   * Check a password against the stored hash for an account, without exposing
   * the hash. This is what lets the password-change route demand the current
   * password while staying ignorant of how credentials are stored.
   */
  verifyAccountPassword(accountId: string, password: string): Promise<boolean>
  /**
   * Change an account's login name, applying the same uniqueness rule as
   * creation. Throws {@link DuplicateUsernameError} if the name is taken.
   */
  setUsername(accountId: string, username: string): Promise<PublicAccount>
  /**
   * Worlds the account owns. Non-empty means deletion is blocked — the caller
   * shows them so the user knows exactly what to resolve.
   */
  worldsBlockingDeletion(accountId: string): Promise<BlockingWorld[]>
  /**
   * HARD-delete the account and everything cascading off it (sessions, tokens,
   * invitations, memberships, notes, characters, entity grants, suggestions).
   * Throws {@link OwnsWorldsError} while it still owns any world.
   */
  deleteAccount(accountId: string): Promise<void>
  /**
   * Issue a fresh session id for an account and retire the current one,
   * returning the new id for the caller to re-cookie.
   *
   * A password change must not leave the old session id valid: anyone who
   * already captured it (shoulder-surfed cookie, shared machine, leaked log)
   * would otherwise keep their access through the very act taken to lock them
   * out. Rotating is what makes "change my password" a real remedy.
   */
  rotateSession(accountId: string, currentSessionId: string, meta?: SessionMeta): Promise<string>
  /**
   * The account's live sessions, newest activity first, with the caller's own
   * marked. Reaps expired rows on the way past. Never returns session ids —
   * see {@link SessionSummary}.
   */
  listSessions(accountId: string, currentSessionId: string): Promise<SessionSummary[]>
}

export class DuplicateUsernameError extends Error {
  constructor(username: string) {
    super(`username already taken: ${username}`)
    this.name = 'DuplicateUsernameError'
  }
}

/**
 * Raised when an email is already registered (case-insensitively). The message
 * deliberately does NOT echo the address back — it is someone else's contact
 * detail, and a reflected value is one templating mistake away from being
 * rendered somewhere it should not be.
 */
export class DuplicateEmailError extends Error {
  constructor() {
    super('email already registered')
    this.name = 'DuplicateEmailError'
  }
}
