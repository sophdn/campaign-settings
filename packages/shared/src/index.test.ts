import { describe, expect, it } from 'vitest'
import * as shared from './index'

describe('shared barrel', () => {
  it('re-exports the exhaustiveness guard and the ported domain rules', () => {
    expect(typeof shared.assertNever).toBe('function')
    expect(typeof shared.fuzzySearch).toBe('function')
    expect(typeof shared.relativeTime).toBe('function')
    expect(typeof shared.representativePopulation).toBe('function')
    expect(typeof shared.parseBrackets).toBe('function')
    expect(typeof shared.formatDate).toBe('function')
    expect(typeof shared.validateBaseRate).toBe('function')
    expect(shared.SETTLEMENT_DETAIL_AXES.length).toBeGreaterThan(0)
    expect(shared.ENTITY_KINDS).toHaveLength(18)
    expect(shared.BRACKET_RESOLVER_ORDER).toContain('npc')
  })
})
