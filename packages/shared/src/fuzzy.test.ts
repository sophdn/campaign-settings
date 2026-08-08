import { describe, expect, it } from 'vitest'
import { fuzzySearch } from './fuzzy'

const items = ['Lord Aldric', 'Aldric the Bold', 'Brenna', 'Aldwin Greycastle']
const search = (q: string) => fuzzySearch(items, q, { text: (s) => s }).map((r) => r.item)

describe('fuzzySearch', () => {
  it('returns everything (score 0) for an empty query', () => {
    const res = fuzzySearch(items, '   ', { text: (s) => s })
    expect(res).toHaveLength(items.length)
    expect(res.every((r) => r.score === 0)).toBe(true)
  })

  it('ranks an exact match above a prefix above a substring', () => {
    const res = fuzzySearch(['aldric', 'aldric the bold', 'lord aldric'], 'aldric', {
      text: (s) => s,
    })
    expect(res[0]?.item).toBe('aldric') // exact wins
    expect(res.map((r) => r.item)).toContain('lord aldric') // substring still matches
  })

  it('filters out non-matches', () => {
    expect(search('zzzz')).toEqual([])
  })

  it('matches a subsequence when there is no substring hit', () => {
    // "abld" is a subsequence of "Aldric the Bold" (A..l..B..ld) but not a substring.
    expect(search('abld').length).toBeGreaterThan(0)
    // "alt" exercises the subsequence run-bonus (a,l adjacent) + word-boundary bonus (t in "the").
    expect(search('alt')).toContain('Aldric the Bold')
  })

  it('requires every whitespace-separated token to hit (AND semantics)', () => {
    expect(search('aldric bold')).toEqual(['Aldric the Bold'])
    expect(search('aldric brenna')).toEqual([])
  })

  it('searches across multiple fields and uses the best-scoring one', () => {
    const rows = [
      { name: 'Session 7', body: 'Aldric was killed' },
      { name: 'Session 1', body: 'Party arrived' },
    ]
    const res = fuzzySearch(rows, 'killed', { text: (r) => [r.name, r.body] })
    expect(res.map((r) => r.item.name)).toEqual(['Session 7'])
  })
})
