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
