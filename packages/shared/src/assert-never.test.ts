import { describe, expect, it } from 'vitest'
import { assertNever } from './assert-never'

describe('assertNever', () => {
  it('throws with the offending value in the message', () => {
    // cast through unknown because the whole point is the never-typed param
    expect(() => assertNever('boom' as unknown as never)).toThrow('Unexpected value: boom')
  })
})
