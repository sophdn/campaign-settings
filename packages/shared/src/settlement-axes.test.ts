import { describe, expect, it } from 'vitest'
import { SETTLEMENT_DETAIL_AXES } from './settlement-axes'

describe('settlement axis taxonomy', () => {
  it('defines size, wealth, and terrain axes, each with labelled values', () => {
    expect(SETTLEMENT_DETAIL_AXES.map((a) => a.axis)).toEqual(['size', 'wealth', 'terrain'])
    for (const axis of SETTLEMENT_DETAIL_AXES) {
      expect(axis.label.length).toBeGreaterThan(0)
      expect(axis.values.length).toBeGreaterThan(0)
      for (const v of axis.values) {
        expect(v.value.length).toBeGreaterThan(0)
        expect(v.label.length).toBeGreaterThan(0)
      }
    }
  })
})
