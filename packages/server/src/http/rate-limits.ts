/**
 * Ceilings on the routes a caller with no session can reach.
 *
 * Read from the environment for the same reason `tenancy/limits.ts` is: the
 * right number for a portfolio demo, for a household of players behind one NAT,
 * and for a public site are three different numbers, and none of them should
 * need a code change. The defaults are sized for the first.
 *
 * These complement the resource ceilings rather than duplicating them. A rate
 * limit caps how FAST one caller can act; a resource ceiling caps how MUCH one
 * actor accumulates. Neither substitutes for the other.
 */

/** One ceiling, in the shape @fastify/rate-limit's per-route `config` wants. */
export interface RateLimit {
  max: number
  timeWindow: number
}

export interface RateLimits {
  /**
   * Credential attempts: sign-in, registration, and the demo door.
   *
   * A long window rather than a small max. A short window at the same rate lets
   * an attacker sustain that throughput indefinitely by pacing themselves; ten
   * minutes of cooling off after ten wrong guesses costs a real person one cup
   * of tea and costs a script most of its day.
   */
  auth: RateLimit
  /**
   * Routes that SEND MAIL to an address the caller chooses.
   *
   * The per-account throttle already stops one mailbox being flooded. It cannot
   * see a caller walking a list of addresses, because no account repeats.
   */
  mail: RateLimit
  /**
   * Guesses at an opaque token — invitation preview, reset confirm, email
   * verification. The tokens are 256-bit, so guessing is hopeless either way;
   * this stops the endpoints being a free "is this token real?" oracle.
   */
  token: RateLimit
  /**
   * Account lookups. Owner-gated already, and still capped: an exact-match
   * lookup is an enumeration oracle if it can be called without limit. Sized
   * for a human adding players, not a script walking a name list.
   */
  lookup: RateLimit
}

const TEN_MINUTES = 600_000

export const DEFAULT_RATE_LIMITS: RateLimits = {
  auth: { max: 10, timeWindow: TEN_MINUTES },
  mail: { max: 5, timeWindow: TEN_MINUTES },
  token: { max: 30, timeWindow: TEN_MINUTES },
  lookup: { max: 20, timeWindow: 60_000 },
}

/**
 * Read one ceiling from the environment. A missing, unparseable or non-positive
 * value falls back to the default — the same fail-safe direction as `parseFlag`
 * and `parseLimit`, because a typo must not silently remove a ceiling.
 */
export function parseRateLimit(
  max: string | undefined,
  window: string | undefined,
  fallback: RateLimit,
): RateLimit {
  const positive = (raw: string | undefined, fall: number): number => {
    if (raw === undefined) return fall
    const n = Number(raw.trim())
    return Number.isInteger(n) && n > 0 ? n : fall
  }
  return {
    max: positive(max, fallback.max),
    timeWindow: positive(window, fallback.timeWindow),
  }
}

export function loadRateLimits(env: NodeJS.ProcessEnv = process.env): RateLimits {
  return {
    auth: parseRateLimit(
      env.AUTH_RATE_LIMIT_MAX,
      env.AUTH_RATE_LIMIT_WINDOW_MS,
      DEFAULT_RATE_LIMITS.auth,
    ),
    mail: parseRateLimit(
      env.MAIL_RATE_LIMIT_MAX,
      env.MAIL_RATE_LIMIT_WINDOW_MS,
      DEFAULT_RATE_LIMITS.mail,
    ),
    token: parseRateLimit(
      env.TOKEN_RATE_LIMIT_MAX,
      env.TOKEN_RATE_LIMIT_WINDOW_MS,
      DEFAULT_RATE_LIMITS.token,
    ),
    lookup: parseRateLimit(
      env.LOOKUP_RATE_LIMIT_MAX,
      env.LOOKUP_RATE_LIMIT_WINDOW_MS,
      DEFAULT_RATE_LIMITS.lookup,
    ),
  }
}
