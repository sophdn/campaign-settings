import { describe, expect, it } from 'vitest'
import {
  isRelationshipType,
  isValidQualifier,
  LANGUAGE_ROLES,
  RELATIONSHIP_GROUP_LABELS,
  RELATIONSHIP_TYPE_ENTRIES,
  RELATIONSHIP_TYPES,
  relationshipLabel,
  relationshipType,
  relationshipTypesInGroup,
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

describe('the attributive types added by migration 0017', () => {
  it("reads each one from both ends with dm-manager's own headings", () => {
    // These inverse labels are the cross-reference headings dm-manager used, so a
    // world imported from it reads the way it used to.
    expect(relationshipLabel('speaks', true)).toBe('Speaks')
    expect(relationshipLabel('speaks', false)).toBe('Spoken by')
    expect(relationshipLabel('practises', false)).toBe('Practitioners')
    expect(relationshipLabel('venerates', false)).toBe('Venerated by')
    expect(relationshipLabel('found_at', false)).toBe('Resources found here')
  })

  it('groups every type, and the two groups partition the vocabulary', () => {
    const social = relationshipTypesInGroup('social')
    const attributive = relationshipTypesInGroup('attributive')

    expect(attributive.map((e) => e.type)).toEqual(['speaks', 'practises', 'venerates', 'found_at'])
    // A partition, not a filter: every type lands in exactly one group, so a new
    // type cannot go missing from the picker by having no group.
    expect(social.length + attributive.length).toBe(RELATIONSHIP_TYPES.length)
    expect(Object.keys(RELATIONSHIP_GROUP_LABELS).sort()).toEqual(['attributive', 'social'])
  })
})

describe('isValidQualifier', () => {
  it('accepts an absent qualifier on any type', () => {
    // Optional even where a vocabulary exists: recording that an NPC speaks a
    // language without saying in what capacity records something true.
    expect(isValidQualifier('speaks', undefined)).toBe(true)
    expect(isValidQualifier('member_of', undefined)).toBe(true)
  })

  it("accepts every value in the type's own vocabulary", () => {
    for (const role of LANGUAGE_ROLES) expect(isValidQualifier('speaks', role)).toBe(true)
  })

  it('refuses a value outside the vocabulary', () => {
    expect(isValidQualifier('speaks', 'ancestral')).toBe(false)
    expect(isValidQualifier('speaks', '')).toBe(false)
  })

  it('refuses any qualifier on a type that defines none', () => {
    // Storing one would put a string in the column no reader can interpret and no
    // filter can group by — the reason it is separate from the free-text note.
    expect(isValidQualifier('member_of', 'native')).toBe(false)
    expect(isValidQualifier('practises', 'native')).toBe(false)
  })
})

describe('LANGUAGE_ROLES', () => {
  it('is the UNION of the four junction CHECK vocabularies, not one of them', () => {
    // culture_languages allowed native/secondary/liturgical; the npc/pc/settlement
    // tables allowed native/secondary/trade. Reading only the culture table gives
    // three values and silently refuses every imported `trade` row.
    expect([...LANGUAGE_ROLES]).toEqual(['native', 'secondary', 'liturgical', 'trade'])
  })
})
