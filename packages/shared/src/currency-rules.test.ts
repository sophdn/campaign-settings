import { describe, expect, it } from 'vitest'
import { CurrencyValidationError, validateBaseRate } from './currency-rules'

describe('validateBaseRate', () => {
  it('accepts an anchor whose chain terminates at a null base_rate_to', () => {
    const map = new Map<string, string | null>([
      ['s', null],
      ['a', null],
    ])
    expect(() => validateBaseRate('s', 'a', map)).not.toThrow()
  })

  it('rejects anchoring a currency to itself', () => {
    expect(() => validateBaseRate('s', 's', new Map([['s', null]]))).toThrow(
      CurrencyValidationError,
    )
  })

  it('rejects a target that does not exist', () => {
    expect(() => validateBaseRate('s', 'ghost', new Map([['s', null]]))).toThrow(/does not exist/)
  })

  it('rejects a chain that would cycle back to the currency', () => {
    // s → a → s would cycle
    const map = new Map<string, string | null>([
      ['s', null],
      ['a', 's'],
    ])
    expect(() => validateBaseRate('s', 'a', map)).toThrow(/would cycle/)
  })

  it('rejects when the data already holds a cycle the walk cannot escape', () => {
    // x ↔ y is a pre-existing cycle; anchoring a new currency z to x exceeds the bound
    const map = new Map<string, string | null>([
      ['x', 'y'],
      ['y', 'x'],
    ])
    expect(() => validateBaseRate('z', 'x', map)).toThrow(/exceeds bound/)
  })
})

describe('the walk bound', () => {
  it('accepts an anchor on the only stored currency', () => {
    // The regression: with one currency the bound was 1, which spent its only
    // step on the target and never reached the terminating null — so a valid
    // anchor was reported as a cycle. Reachable when `selfId` is not in the map
    // at all, which is exactly the row-being-created case.
    const one = new Map<string, string | null>([['a', null]])
    expect(() => validateBaseRate('brand-new', 'a', one)).not.toThrow()
  })

  it('accepts a chain that runs through every stored currency', () => {
    // d -> c -> b -> a -> null, anchored from a row not yet in the map.
    const chain = new Map<string, string | null>([
      ['a', null],
      ['b', 'a'],
      ['c', 'b'],
      ['d', 'c'],
    ])
    expect(() => validateBaseRate('brand-new', 'd', chain)).not.toThrow()
  })

  it('still refuses a pre-existing cycle the walk can never leave', () => {
    // The extra step cannot let a cycle through: it never terminates.
    const cyclic = new Map<string, string | null>([
      ['a', 'b'],
      ['b', 'a'],
      ['self', null],
    ])
    expect(() => validateBaseRate('self', 'a', cyclic)).toThrow(CurrencyValidationError)
  })
})
