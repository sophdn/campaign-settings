import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ENTITY_KINDS,
  findKindEntry,
  homeKinds,
  homeKindsByTier,
  kindEntry,
  navKinds,
  navKindsByTier,
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

  it('navKinds excludes map; homeKinds includes it; both sorted by navOrder', () => {
    expect(navKinds().some((k) => k.kind === 'map')).toBe(false)
    expect(homeKinds().some((k) => k.kind === 'map')).toBe(true)
    const orders = navKinds().map((k) => k.navOrder)
    expect(orders).toEqual([...orders].sort((a, b) => a - b))
  })

  it('classifies kinds into home tiers', () => {
    expect(tierOf('pc')).toBe('primary')
    expect(tierOf('currency')).toBe('tertiary')
    expect(tierOf('item')).toBe('secondary')
  })

  it('groups home kinds by tier with every entry placed', () => {
    const groups = homeKindsByTier()
    const total = groups.primary.length + groups.secondary.length + groups.tertiary.length
    expect(total).toBe(homeKinds().length)
    expect(groups.primary.some((k) => k.kind === 'pc')).toBe(true)
  })

  it('groups nav kinds by tier (surfaces.nav-scoped, map excluded, every entry placed)', () => {
    const groups = navKindsByTier()
    const total = groups.primary.length + groups.secondary.length + groups.tertiary.length
    expect(total).toBe(navKinds().length)
    // map is home-only, so it never appears in a nav tier
    const allNavTierKinds = [...groups.primary, ...groups.secondary, ...groups.tertiary]
    expect(allNavTierKinds.some((k) => k.kind === 'map')).toBe(false)
    expect(groups.primary.some((k) => k.kind === 'session')).toBe(true)
    expect(groups.tertiary.some((k) => k.kind === 'deity')).toBe(true)
  })
})
