/**
 * Reduce a raw User-Agent header to a coarse, human-recognisable device label
 * ("Firefox on Linux"). This is the ONLY thing that is ever stored — see
 * migration 0008: a full UA string is a fingerprinting surface, and all the
 * session list needs is enough for someone to tell their phone from their
 * laptop. Deliberately lossy, and deliberately not a UA-parsing dependency.
 */

/** Browser families, most-specific first — Edge and Opera also claim "Chrome". */
const BROWSERS: readonly (readonly [RegExp, string])[] = [
  [/\bEdg[A-Z]?\//, 'Edge'],
  [/\bOPR\/|\bOpera\b/, 'Opera'],
  [/\bFirefox\/|\bFxiOS\//, 'Firefox'],
  [/\bChrome\/|\bCriOS\//, 'Chrome'],
  [/\bSafari\//, 'Safari'],
]

/** Platform families, most-specific first — iOS UAs also contain "Mac OS X". */
const PLATFORMS: readonly (readonly [RegExp, string])[] = [
  [/\biPhone\b|\biPad\b|\biOS\b/, 'iOS'],
  [/\bAndroid\b/, 'Android'],
  [/\bWindows\b/, 'Windows'],
  [/\bMac OS X\b|\bMacintosh\b/, 'macOS'],
  [/\bLinux\b|\bX11\b/, 'Linux'],
]

const firstMatch = (raw: string, table: readonly (readonly [RegExp, string])[]): string | null =>
  table.find(([pattern]) => pattern.test(raw))?.[1] ?? null

/**
 * A coarse label for a User-Agent header, or null when nothing recognisable is
 * present (a missing header, an API client, curl). Null is a normal outcome,
 * not an error — the session list renders it as an unknown device.
 */
export function describeUserAgent(raw: string | undefined): string | null {
  if (!raw) return null
  const browser = firstMatch(raw, BROWSERS)
  const platform = firstMatch(raw, PLATFORMS)
  if (browser && platform) return `${browser} on ${platform}`
  return browser ?? platform
}
