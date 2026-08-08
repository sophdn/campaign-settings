/**
 * Currency exchange-rate invariants — the pure subset of dm-manager's currency
 * validation (the storage walk is replaced by an in-memory map the server
 * supplies). A currency may anchor its exchange rate to another via
 * `base_rate_to`; that anchor must not be itself, must exist, and must not form
 * a cycle.
 */

export interface Denomination {
  name: string
  multiplier: number
}

export class CurrencyValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CurrencyValidationError'
  }
}

/**
 * Validate a proposed `base_rate_to` anchor for currency `selfId` against the
 * world's currencies (id → its own `base_rate_to`, or null). Throws on a
 * self-anchor, a missing target, or a chain that would cycle back to `selfId`.
 * The walk is bounded by the currency count so a pre-existing cycle in the data
 * fails loudly rather than looping forever. Pure.
 */
export function validateBaseRate(
  selfId: string,
  target: string,
  baseRateByCurrency: ReadonlyMap<string, string | null>,
): void {
  if (target === selfId) {
    throw new CurrencyValidationError('currency cannot anchor base_rate_to itself')
  }
  if (!baseRateByCurrency.has(target)) {
    throw new CurrencyValidationError(`base_rate_to target ${target} does not exist`)
  }
  const maxWalk = Math.max(baseRateByCurrency.size, 1)
  let current: string | null = target
  for (let i = 0; i < maxWalk; i++) {
    if (current === null) return
    if (current === selfId) {
      throw new CurrencyValidationError(`base_rate_to chain would cycle through ${selfId}`)
    }
    current = baseRateByCurrency.get(current) ?? null
  }
  throw new CurrencyValidationError(
    'base_rate_to chain exceeds bound — pre-existing cycle in storage',
  )
}
