export interface AuthConfig {
  /** Secret for signing session cookies (HMAC). */
  cookieSecret: string
  sessionTtlMs: number
  /** Whether to set the cookie `Secure` flag (HTTPS-only) — true in production. */
  cookieSecure: boolean
}

/**
 * Load + validate auth config from the environment (defaults to process.env).
 * Pure given its `env` argument so it is fully unit-testable without touching
 * the real process environment.
 */
export function loadAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const cookieSecret = env.SESSION_SECRET
  if (!cookieSecret || cookieSecret.length < 32) {
    throw new Error('SESSION_SECRET must be set to a random string of at least 32 characters')
  }
  const ttlDays = env.SESSION_TTL_DAYS === undefined ? 30 : Number(env.SESSION_TTL_DAYS)
  if (!Number.isFinite(ttlDays) || ttlDays <= 0) {
    throw new Error('SESSION_TTL_DAYS must be a positive number of days')
  }
  return {
    cookieSecret,
    sessionTtlMs: ttlDays * 24 * 60 * 60 * 1000,
    cookieSecure: env.NODE_ENV === 'production',
  }
}
