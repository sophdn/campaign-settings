import { describe, expect, it } from 'vitest'
import { ENTITY_FIELDS, type FieldDef, fieldsForKind, fieldsForKindName } from './entity-fields'
import { contentKinds, type ContentKind, ENTITY_KINDS } from './entity-kinds'
import { SETTLEMENT_DETAIL_AXES } from './settlement-axes'

const ALL_FIELDS: ReadonlyArray<{ kind: ContentKind; field: FieldDef }> = Object.entries(
  ENTITY_FIELDS,
).flatMap(([kind, fields]) => fields.map((field) => ({ kind: kind as ContentKind, field })))

describe('ENTITY_FIELDS coverage', () => {
  it('is total over the content kinds — every one present, nothing else', () => {
    expect(Object.keys(ENTITY_FIELDS).sort()).toEqual(
      contentKinds()
        .map((k) => k.kind)
        .sort(),
    )
  })

  it('covers all 16 content kinds, so the bespoke session/map are excluded', () => {
    expect(Object.keys(ENTITY_FIELDS)).toHaveLength(16)
    expect(ENTITY_FIELDS).not.toHaveProperty('session')
    expect(ENTITY_FIELDS).not.toHaveProperty('map')
  })

  it('gives the three kinds with no detail table an empty list, not a missing entry', () => {
    // A caller iterating kinds must never have to handle `undefined`.
    for (const kind of ['item', 'organization', 'location'] as const) {
      expect(ENTITY_FIELDS[kind]).toEqual([])
      expect(fieldsForKind(kind)).toEqual([])
    }
  })
})

describe('field descriptors are well-formed', () => {
  it('every field has a non-empty key and label, and no kind repeats a key', () => {
    for (const [kind, fields] of Object.entries(ENTITY_FIELDS)) {
      const keys = fields.map((f) => f.key)
      expect(keys, `${kind} repeats a key`).toEqual([...new Set(keys)])
      for (const f of fields) {
        expect(f.key, `${kind} field has an empty key`).not.toBe('')
        expect(f.label, `${kind}.${f.key} has an empty label`).not.toBe('')
      }
    }
  })

  it('an enum field carries options and nothing else does', () => {
    for (const { kind, field } of ALL_FIELDS) {
      if (field.type === 'enum') {
        expect(field.options, `${kind}.${field.key} is an enum with no options`).toBeDefined()
        expect(field.options?.length, `${kind}.${field.key} has empty options`).toBeGreaterThan(0)
      } else {
        expect(field.options, `${kind}.${field.key} is not an enum but has options`).toBeUndefined()
      }
    }
  })

  it('an entityRef points at a real kind, and nothing else carries a refKind', () => {
    const known = new Set(ENTITY_KINDS.map((k) => k.kind))
    for (const { kind, field } of ALL_FIELDS) {
      if (field.type === 'entityRef') {
        expect(field.refKind, `${kind}.${field.key} is a ref with no refKind`).toBeDefined()
        expect(known.has(field.refKind!), `${kind}.${field.key} -> unknown kind`).toBe(true)
      } else {
        expect(field.refKind, `${kind}.${field.key} is not a ref but has a refKind`).toBeUndefined()
      }
    }
  })

  it('never models the base columns — those are not per-kind fields', () => {
    // `name`/`description` belong to every kind and the editor renders them
    // itself; `visibility` is the entity-level 3-state column with its own
    // owner-only control. A field here would give each a second, conflicting UI.
    for (const { kind, field } of ALL_FIELDS) {
      expect(['name', 'description', 'visibility'], `${kind} models ${field.key}`).not.toContain(
        field.key,
      )
    }
  })

  it('excludes the complex fields a scalar input cannot edit', () => {
    expect(ENTITY_FIELDS.currency.map((f) => f.key)).not.toContain('denominations')
  })
})

describe('settlement axes are sourced, not copied', () => {
  it('size, wealth, and terrain offer exactly the shared taxonomy, in picker order', () => {
    for (const axis of SETTLEMENT_DETAIL_AXES) {
      const field = ENTITY_FIELDS.settlement.find((f) => f.key === axis.axis)
      expect(field, `settlement has no ${axis.axis} field`).toBeDefined()
      expect(field?.type).toBe('enum')
      expect(field?.options).toEqual(axis.values.map((v) => ({ value: v.value, label: v.label })))
    }
  })

  it('is the only kind with closed enums — the rest are soft taxonomies', () => {
    // The other vocabularies (resource scarcity, deity worship status, …) are
    // free-form columns whose offered values live in the hint, so the DM can
    // write one the app never heard of.
    const enumKinds = ALL_FIELDS.filter(({ field }) => field.type === 'enum').map(
      ({ kind }) => kind,
    )
    expect([...new Set(enumKinds)]).toEqual(['settlement'])
  })

  it('states the soft vocabulary in a hint wherever it offers one', () => {
    const softTaxonomy = ALL_FIELDS.filter(({ field }) =>
      ['resource_kind', 'scarcity', 'worship_status', 'kingdom', 'source_kind'].includes(field.key),
    )
    expect(softTaxonomy.length).toBeGreaterThan(0)
    for (const { kind, field } of softTaxonomy) {
      expect(field.type, `${kind}.${field.key} should stay free-form`).toBe('text')
      expect(field.hint, `${kind}.${field.key} offers no vocabulary`).toMatch(/soft taxonomy/)
    }
  })
})

describe('lookup helpers', () => {
  it('fieldsForKind returns the kind’s own list', () => {
    expect(fieldsForKind('deity')).toBe(ENTITY_FIELDS.deity)
    expect(fieldsForKind('npc').map((f) => f.key)).toEqual([
      'occupation',
      'species_id',
      'culture_id',
    ])
  })

  it('fieldsForKindName falls back to empty for a non-content or unknown kind', () => {
    // A URL segment or an API payload can carry anything; rendering name +
    // description is a better answer than throwing.
    expect(fieldsForKindName('npc')).toBe(ENTITY_FIELDS.npc)
    expect(fieldsForKindName('session')).toEqual([])
    expect(fieldsForKindName('not-a-kind')).toEqual([])
    expect(fieldsForKindName('')).toEqual([])
  })
})
