import { describe, expect, it } from 'vitest'
import { errorMessage } from './error-message'

describe('errorMessage', () => {
  it('returns an Error’s message', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom')
  })

  it('uses the fallback for non-Error values', () => {
    expect(errorMessage('nope', 'Failed')).toBe('Failed')
  })

  it('has a default fallback', () => {
    expect(errorMessage(null)).toBe('Something went wrong')
  })
})
