/**
 * Tiny in-memory fuzzy search. Pure function, no framework deps.
 *
 * Scoring (higher = better):
 *   - exact match            → 1000 + length bonus
 *   - prefix match           → 500
 *   - substring match        → 200–250 (250 at a word boundary)
 *   - subsequence match      → up to 100, with bonuses for runs of
 *                              consecutive characters and word-boundary hits
 *   - no match               → -Infinity (filtered out)
 *
 * Designed for small N (≲1000 items): entity lists, session lists, picker
 * dropdowns. Tokenises the query on whitespace; an item scores only if EVERY
 * token has a hit somewhere in its haystack. Ported from dm-manager.
 */

export interface FuzzyResult<T> {
  item: T
  score: number
}

export interface FuzzyOptions<T> {
  /** Extract the searchable string(s) from an item. */
  text: (item: T) => string | string[]
}

export function fuzzySearch<T>(
  items: readonly T[],
  query: string,
  opts: FuzzyOptions<T>,
): FuzzyResult<T>[] {
  const q = query.trim().toLowerCase()
  if (!q) return items.map((item) => ({ item, score: 0 }))

  const tokens = q.split(/\s+/).filter((t) => t.length > 0)
  const out: FuzzyResult<T>[] = []
  for (const item of items) {
    const fields = opts.text(item)
    const haystacks = (Array.isArray(fields) ? fields : [fields]).map((s) => s.toLowerCase())
    let total = 0
    let allTokensMatched = true
    for (const token of tokens) {
      const best = bestFieldScore(haystacks, token)
      if (best <= -Infinity) {
        allTokensMatched = false
        break
      }
      total += best
    }
    if (allTokensMatched) out.push({ item, score: total })
  }
  out.sort((a, b) => b.score - a.score)
  return out
}

function bestFieldScore(haystacks: string[], token: string): number {
  let best = -Infinity
  for (const h of haystacks) {
    const s = scoreField(h, token)
    if (s > best) best = s
  }
  return best
}

function scoreField(haystack: string, token: string): number {
  if (haystack === token) return 1000 + token.length
  if (haystack.startsWith(token)) return 500
  const idx = haystack.indexOf(token)
  if (idx === 0) return 500
  if (idx > 0) {
    const isBoundary = /\s|[-_/\\.,;:]/.test(haystack[idx - 1] ?? '')
    return isBoundary ? 250 : 200
  }
  // Subsequence (each char of token in order, anywhere in haystack).
  let score = 0
  let h = 0
  let lastMatchPos = -2
  let matched = 0
  for (const ch of token) {
    while (h < haystack.length && haystack[h] !== ch) h++
    if (h >= haystack.length) return -Infinity
    matched++
    if (h === lastMatchPos + 1) score += 5 // run bonus
    if (h === 0 || /\s|[-_/\\.,;:]/.test(haystack[h - 1] ?? '')) score += 8
    lastMatchPos = h
    h++
  }
  return matched === token.length ? Math.min(100, score) : -Infinity
}
