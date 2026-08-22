/**
 * How the `TRUST_PROXY` environment variable becomes fastify's `trustProxy`.
 *
 * Pure and unit-tested rather than inlined into main.ts, for the reason main.ts
 * states about itself: it is the untested IO shell, and a five-branch parse is
 * not something to put somewhere nothing checks. The parse decides whether
 * `X-Forwarded-For` is believed, and believing it wrongly lets a caller choose
 * their own rate-limit key.
 */

/**
 * Parse `TRUST_PROXY`.
 *
 * - unset, empty, or `false` → trust nothing. The default, and the right answer
 *   for a process reached directly: an untrusted `X-Forwarded-For` is worse
 *   than no header at all, because a caller could then pick their own identity.
 * - a whole number → that many proxy hops (`1` behind a single Caddy).
 * - `true` → trust the whole forwarded chain. Only safe where the process is
 *   unreachable except through the proxy.
 * - anything else → passed through as an address or CIDR for fastify to match.
 *
 * That last case is also where a typo lands, and it fails SAFE without needing
 * a validation branch: fastify matches the string against the peer address, and
 * a value that is not an address matches nothing, so nothing is trusted. The
 * fail-safe direction is the same as `parseFlag` and `parseLimit` — a mistake
 * must never silently start believing a header the caller controls.
 */
export function parseTrustProxy(raw: string | undefined): boolean | number | string {
  const value = raw?.trim()
  if (!value || value === 'false') return false
  if (value === 'true') return true
  if (/^\d+$/.test(value)) {
    const hops = Number(value)
    // Zero hops means "no proxy", which is `false` — fastify reads 0 as a hop
    // count and would treat it as trusting nothing anyway, but saying so here
    // keeps the two spellings of the same intent from diverging.
    return hops === 0 ? false : hops
  }
  return value
}
