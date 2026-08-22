import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ENTITY_KINDS,
  findKindEntry,
  kindEntry,
  kindsByTier,
  navKinds,
  primaryKinds,
  type RegistryKind,
  tierOf,
} from './entity-kinds'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('entity-kind registry', () => {
  it('has 18 kinds with unique nav orders', () => {
    expect(ENTITY_KINDS).toHaveLength(18)
    const orders = ENTITY_KINDS.map((k) => k.navOrder)
    expect(new Set(orders).size).toBe(orders.length)
  })

  it('kindEntry returns the entry or throws for an unknown kind', () => {
    expect(kindEntry('npc').label.singular).toBe('NPC')
    expect(() => kindEntry('bogus' as RegistryKind)).toThrow(/No registry entry/)
  })

  it('findKindEntry returns undefined and warns once for unknown kinds', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(findKindEntry('npc')?.kind).toBe('npc')
    expect(findKindEntry('totally-unknown')).toBeUndefined()
    expect(findKindEntry('totally-unknown')).toBeUndefined() // second call: no second warn
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('navKinds carries every kind including map, sorted by navOrder', () => {
    // map used to be the ONE kind nav excluded and home included. Chain 470
    // folded it into the rail's Primary group, which is what let the two
    // groupings collapse into `kindsByTier`.
    expect(navKinds().some((k) => k.kind === 'map')).toBe(true)
    expect(navKinds()).toHaveLength(ENTITY_KINDS.length)
    const orders = navKinds().map((k) => k.navOrder)
    expect(orders).toEqual([...orders].sort((a, b) => a - b))
  })

  it('classifies kinds into home tiers', () => {
    expect(tierOf('pc')).toBe('primary')
    expect(tierOf('currency')).toBe('tertiary')
    expect(tierOf('item')).toBe('secondary')
  })

  it('groups every nav kind by tier, placing all of them', () => {
    const groups = kindsByTier()
    const total = groups.primary.length + groups.secondary.length + groups.tertiary.length
    expect(total).toBe(navKinds().length)
    expect(groups.primary.some((k) => k.kind === 'pc')).toBe(true)
    expect(groups.primary.some((k) => k.kind === 'session')).toBe(true)
    expect(groups.tertiary.some((k) => k.kind === 'deity')).toBe(true)
  })

  it('primaryKinds is the Primary tier, carries map, and is sorted by navOrder', () => {
    const primary = primaryKinds()
    expect(primary).toEqual(kindsByTier().primary)
    // The rail's separately hardcoded Maps link folded into this array; if map
    // ever falls out of it, the rail loses Maps entirely rather than degrading.
    expect(primary.some((k) => k.kind === 'map')).toBe(true)
    const orders = primary.map((k) => k.navOrder)
    expect(orders).toEqual([...orders].sort((a, b) => a - b))
  })
})
