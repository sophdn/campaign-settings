import { validateBaseRate } from '@campaign-settings/shared'
import { CONTENT_REPOS } from './content-repos'
import type { WorldContext } from './context'

/**
 * Enforce the exchange-anchor invariants when a currency's `base_rate_to` is
 * set: not itself, the target exists, and the chain does not cycle.
 *
 * The rule itself lives in `shared/currency-rules`, whose docstring says the
 * storage walk is "replaced by an in-memory map the server supplies" — this is
 * the server supplying it. Restating the walk here would be the second copy of
 * a data-integrity rule, which is how two call sites end up disagreeing.
 *
 * Reading the world's currencies through the seam is complete rather than
 * partial BECAUSE the caller is an owner: content writes are owner-gated, and
 * an owner's `visible()` has no visibility clause. A cycle check that saw only
 * some of the graph would be worse than none, so this must not be reached from
 * a player path.
 *
 * A no-op when the patch does not set an anchor. Clearing one (`null`) needs no
 * check — removing an edge cannot create a cycle.
 */
export async function assertValidBaseRate(
  ctx: WorldContext,
  selfId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  if (!('base_rate_to' in patch)) return
  const target = patch.base_rate_to
  if (target === null || target === undefined || target === '') return

  const currencies = await CONTENT_REPOS.currency!.list(ctx)
  const anchors = new Map<string, string | null>(
    currencies.map((c) => {
      const row = c as unknown as Record<string, unknown>
      const anchor = row.base_rate_to
      return [String(row.id), typeof anchor === 'string' ? anchor : null]
    }),
  )
  validateBaseRate(selfId, String(target), anchors)
}
