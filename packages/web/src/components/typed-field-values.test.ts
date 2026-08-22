import type { FieldDef } from '@campaign-settings/shared'
import { describe, expect, it } from 'vitest'
import {
  fieldToInput,
  hasValue,
  initialFieldValues,
  optionLabel,
  toEntityPatch,
} from './typed-field-values'

const text = (nullable: boolean): FieldDef => ({
  key: 'note',
  label: 'Note',
  type: 'text',
  nullable,
})
const num = (nullable: boolean): FieldDef => ({
  key: 'count',
  label: 'Count',
  type: 'number',
  nullable,
})
const bool: FieldDef = { key: 'flag', label: 'Flag', type: 'boolean', nullable: false }
const ref: FieldDef = {
  key: 'species_id',
  label: 'Species',
  type: 'entityRef',
  refKind: 'species',
  nullable: true,
}
const enumField: FieldDef = {
  key: 'size',
  label: 'Size',
  type: 'enum',
  nullable: false,
  options: [
    { value: 'town', label: 'Town' },
    { value: 'city', label: 'City' },
  ],
}

describe('reading an entity into form state', () => {
  it('renders null and undefined as an empty control, not as "null"', () => {
    expect(fieldToInput(text(true), { note: null })).toBe('')
    expect(fieldToInput(text(true), {})).toBe('')
  })

  it('renders booleans as the checkbox strings and numbers as their digits', () => {
    expect(fieldToInput(bool, { flag: true })).toBe('true')
    expect(fieldToInput(bool, { flag: false })).toBe('false')
    expect(fieldToInput(num(false), { count: 0 })).toBe('0')
    expect(fieldToInput(num(false), { count: 1200 })).toBe('1200')
  })

  it('reads a whole field list at once', () => {
    expect(initialFieldValues([text(false), bool], { note: 'hi', flag: false })).toEqual({
      note: 'hi',
      flag: 'false',
    })
  })
})

describe('what an emptied field sends', () => {
  it('sends null for a nullable column and the empty value for a NOT NULL one', () => {
    // This is the whole reason FieldDef carries `nullable`: the same blank
    // input means two different writes depending on the column.
    expect(toEntityPatch([text(true)], { note: '' })).toEqual({ note: null })
    expect(toEntityPatch([text(false)], { note: '' })).toEqual({ note: '' })
    expect(toEntityPatch([num(true)], { count: '' })).toEqual({ count: null })
    expect(toEntityPatch([num(false)], { count: '' })).toEqual({ count: 0 })
    expect(toEntityPatch([ref], { species_id: '' })).toEqual({ species_id: null })
  })

  it('sends a cleared NOT NULL ref as nothing at all rather than a violation', () => {
    const notNullRef: FieldDef = { ...ref, nullable: false }
    expect(toEntityPatch([notNullRef], { species_id: '' })).toEqual({})
  })
})

describe('what a filled field sends', () => {
  it('coerces to the column’s type, not to the string the input held', () => {
    expect(toEntityPatch([num(false)], { count: '1200' })).toEqual({ count: 1200 })
    expect(toEntityPatch([bool], { flag: 'true' })).toEqual({ flag: true })
    expect(toEntityPatch([bool], { flag: 'false' })).toEqual({ flag: false })
    expect(toEntityPatch([text(false)], { note: 'a note' })).toEqual({ note: 'a note' })
    expect(toEntityPatch([ref], { species_id: 'sp1' })).toEqual({ species_id: 'sp1' })
  })

  it('omits a number that will not parse instead of writing a wrong one', () => {
    // Coercing junk to 0 would overwrite a good stored figure with a wrong one;
    // a patch without the key leaves the column exactly as it was.
    expect(toEntityPatch([num(false)], { count: 'lots' })).toEqual({})
    expect(toEntityPatch([num(true)], { count: 'lots' })).toEqual({})
  })

  it('trims a ref id and a number but not prose', () => {
    expect(toEntityPatch([ref], { species_id: '  sp1  ' })).toEqual({ species_id: 'sp1' })
    expect(toEntityPatch([num(false)], { count: ' 7 ' })).toEqual({ count: 7 })
    expect(toEntityPatch([text(false)], { note: '  spaced  ' })).toEqual({ note: '  spaced  ' })
  })

  it('builds the whole patch in one pass, missing keys included', () => {
    expect(toEntityPatch([text(false), bool, num(true)], {})).toEqual({
      note: '',
      flag: false,
      count: null,
    })
  })
})

describe('read-view helpers', () => {
  it('treats null, undefined and empty as unset', () => {
    expect(hasValue(text(true), { note: null })).toBe(false)
    expect(hasValue(text(true), {})).toBe(false)
    expect(hasValue(text(true), { note: '' })).toBe(false)
    expect(hasValue(text(true), { note: 'x' })).toBe(true)
  })

  it('treats a population of 0 as unset, because that is what the field means', () => {
    expect(hasValue(num(false), { count: 0 })).toBe(false)
    expect(hasValue(num(false), { count: 1 })).toBe(true)
  })

  it('shows an enum’s label, and falls back to a value the taxonomy lost', () => {
    // The columns are soft — a value can outlive its place in the offered list.
    expect(optionLabel(enumField, 'town')).toBe('Town')
    expect(optionLabel(enumField, 'metropolis')).toBe('metropolis')
  })
})
