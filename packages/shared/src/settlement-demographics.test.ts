import { describe, expect, it } from 'vitest'
import { denizensByRole, representativePopulation } from './settlement-demographics'

const roles = (dims: Parameters<typeof denizensByRole>[0]) =>
  denizensByRole(dims).map((d) => d.role)

describe('representativePopulation', () => {
  it('uses the size baseline with neutral modifiers when wealth/terrain unset', () => {
    expect(representativePopulation({ size: 'village' })).toBe(400)
    expect(representativePopulation({ size: 'town' })).toBe(3000)
  })

  it('multiplies by wealth and terrain modifiers', () => {
    expect(representativePopulation({ size: 'village', wealth: 'rich' })).toBe(500) // 400×1.25
    expect(representativePopulation({ size: 'town', terrain: 'mountainous' })).toBe(2400) // 3000×0.8
    expect(representativePopulation({ size: 'city', wealth: 'rich', terrain: 'riverside' })).toBe(
      17250, // round(12000×1.25×1.15)
    )
  })

  it('returns 0 when size is unset or unknown (no estimate without a driver)', () => {
    expect(representativePopulation({})).toBe(0)
    expect(representativePopulation({ wealth: 'rich', terrain: 'coastal' })).toBe(0)
    expect(representativePopulation({ size: 'metropolis' })).toBe(0)
  })
})

describe('denizensByRole', () => {
  it('returns [] when no population is derivable', () => {
    expect(denizensByRole({})).toEqual([])
    expect(denizensByRole({ wealth: 'rich' })).toEqual([])
  })

  it('is deterministic for the same dims', () => {
    const dims = { size: 'town', wealth: 'average', terrain: 'plains' }
    expect(denizensByRole(dims)).toEqual(denizensByRole(dims))
  })

  it('includes universal trades for a populated settlement', () => {
    const r = roles({ size: 'town', wealth: 'average' })
    expect(r).toEqual(expect.arrayContaining(['Shoemaker', 'Baker', 'Smith']))
  })

  it('gates luxury trades behind wealth', () => {
    expect(roles({ size: 'city', wealth: 'rich' })).toContain('Jeweller')
    expect(roles({ size: 'city', wealth: 'poor' })).not.toContain('Jeweller')
    expect(roles({ size: 'city', wealth: 'average' })).toContain('Physician')
    expect(roles({ size: 'city', wealth: 'poor' })).not.toContain('Physician')
  })

  it('gates trades behind a minimum population', () => {
    const hamlet = roles({ size: 'hamlet' })
    expect(hamlet).not.toContain('Innkeeper')
    expect(hamlet).not.toContain('Baker')
  })

  it('adds terrain primary-industry roles only for matching terrain', () => {
    expect(roles({ size: 'town', terrain: 'mountainous' })).toContain('Miner')
    expect(roles({ size: 'town', terrain: 'coastal' })).toContain('Fisher')
    expect(roles({ size: 'town', terrain: 'coastal' })).not.toContain('Miner')
    expect(roles({ size: 'town', terrain: 'plains' })).not.toContain('Fisher')
  })

  it('orders by count descending, then role name', () => {
    const census = denizensByRole({ size: 'city', wealth: 'rich', terrain: 'coastal' })
    for (let i = 1; i < census.length; i++) {
      const prev = census[i - 1]!
      const cur = census[i]!
      expect(prev.count).toBeGreaterThanOrEqual(cur.count)
      if (prev.count === cur.count) {
        expect(prev.role.localeCompare(cur.role)).toBeLessThanOrEqual(0)
      }
    }
    expect(census.every((d) => d.count >= 1)).toBe(true)
  })
})
