import { describe, expect, it } from 'vitest'
import {
  isRelationshipType,
  RELATIONSHIP_TYPE_ENTRIES,
  RELATIONSHIP_TYPES,
  relationshipLabel,
  relationshipType,
} from './relationships'

describe('the relationship vocabulary', () => {
  it('has an entry for every type, and no entry for anything else', () => {
    // Two lists that can drift is exactly the failure a shared vocabulary
    // exists to prevent, so they are pinned against each other.
    expect(RELATIONSHIP_TYPE_ENTRIES.map((e) => e.type).sort()).toEqual(
      [...RELATIONSHIP_TYPES].sort(),
    )
  })

  it('gives every type both a label and an inverse', () => {
    // A missing inverse would render an entity page with a blank relation —
    // "— The Ashen Hand" — which says nothing about how they relate.
    for (const entry of RELATIONSHIP_TYPE_ENTRIES) {
      expect(entry.label.trim().length).toBeGreaterThan(0)
      expect(entry.inverseLabel.trim().length).toBeGreaterThan(0)
    }
  })

  it('keeps a symmetric type reading the same in both directions', () => {
    for (const entry of RELATIONSHIP_TYPE_ENTRIES.filter((e) => e.symmetric)) {
      expect(entry.inverseLabel).toBe(entry.label)
    }
  })

  it('keeps a directional type reading DIFFERENTLY in each direction', () => {
    // A directional type whose two labels coincided would be symmetric in
    // practice while claiming not to be — and the panel would show "Member of"
    // on both pages, which is false on one of them.
    for (const entry of RELATIONSHIP_TYPE_ENTRIES.filter((e) => !e.symmetric)) {
      expect(entry.inverseLabel).not.toBe(entry.label)
    }
  })

  it('has no duplicate types', () => {
    expect(new Set(RELATIONSHIP_TYPES).size).toBe(RELATIONSHIP_TYPES.length)
  })
})

describe('isRelationshipType', () => {
  it('accepts every member of the vocabulary', () => {
    for (const type of RELATIONSHIP_TYPES) expect(isRelationshipType(type)).toBe(true)
  })

  it('rejects anything else, including near-misses', () => {
    for (const value of ['', 'friend_of', 'MEMBER_OF', 'member of', 'toString', '__proto__']) {
      expect(isRelationshipType(value)).toBe(false)
    }
  })
})

describe('relationshipType', () => {
  it('resolves a type to its entry', () => {
    expect(relationshipType('member_of').inverseLabel).toBe('Has member')
  })

  it('throws rather than returning a half-built entry for an unknown type', () => {
    expect(() => relationshipType('nonsense' as never)).toThrow(/No relationship type/)
  })
})

describe('relationshipLabel', () => {
  it('reads one stored row correctly from each end', () => {
    // The whole reason one row suffices: the two pages render the same row
    // through this function and cannot describe the relation differently.
    expect(relationshipLabel('member_of', true)).toBe('Member of')
    expect(relationshipLabel('member_of', false)).toBe('Has member')
    expect(relationshipLabel('located_in', true)).toBe('Located in')
    expect(relationshipLabel('located_in', false)).toBe('Contains')
  })

  it('reads a symmetric type the same from either end', () => {
    expect(relationshipLabel('ally_of', true)).toBe('Ally of')
    expect(relationshipLabel('ally_of', false)).toBe('Ally of')
  })
})
