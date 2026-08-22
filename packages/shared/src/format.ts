/**
 * Small presentation-formatting helpers. Pure, framework-free. Ported from
 * dm-manager.
 */

/** Trim to `n` chars, dropping trailing space and appending an ellipsis. */
export function truncate(s: string, n: number): string {
  if (!s) return ''
  return s.length > n ? `${s.slice(0, n).trimEnd()}…` : s
}

/**
 * Coarse "time ago" for an rfc3339 timestamp (e.g. "3d ago"). `nowMs` is
 * injectable for deterministic tests; defaults to the current time. Returns ""
 * for an unparseable input.
 */
export function relativeTime(iso: string, nowMs: number = Date.now()): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const sec = Math.max(0, Math.round((nowMs - then) / 1000))
  if (sec < 45) return 'just now'
  const min = Math.round(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.round(hr / 24)
  if (day < 30) return `${day}d ago`
  const mo = Math.round(day / 30)
  if (mo < 12) return `${mo}mo ago`
  return `${Math.round(mo / 12)}y ago`
}
