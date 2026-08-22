import { describe, expect, it } from 'vitest'
import { relativeTime, truncate } from './format'

describe('truncate', () => {
  it('leaves short strings, ellipsizes long ones', () => {
    expect(truncate('short', 10)).toBe('short')
    expect(truncate('a very long string', 6)).toBe('a very…')
    expect(truncate('', 5)).toBe('')
  })
})

describe('relativeTime', () => {
  const now = Date.parse('2026-06-07T12:00:00.000Z')

  it('renders coarse buckets relative to now', () => {
    expect(relativeTime('2026-06-07T11:59:40.000Z', now)).toBe('just now')
    expect(relativeTime('2026-06-07T11:30:00.000Z', now)).toBe('30m ago')
    expect(relativeTime('2026-06-07T09:00:00.000Z', now)).toBe('3h ago')
    expect(relativeTime('2026-06-04T12:00:00.000Z', now)).toBe('3d ago')
    expect(relativeTime('2026-04-07T12:00:00.000Z', now)).toBe('2mo ago')
    expect(relativeTime('2024-06-07T12:00:00.000Z', now)).toBe('2y ago')
  })

  it('returns empty for an unparseable timestamp', () => {
    expect(relativeTime('not a date', now)).toBe('')
  })
})
