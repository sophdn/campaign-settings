/**
 * Settlement demographics engine — parametric, non-LLM, sans-IO. The
 * {size, wealth, terrain} permutation is the single input; from it the engine
 * derives a representative population and a denizen-by-role census using the
 * coefficient tables in settlement-demographics-data.ts. Deterministic and pure
 * — no DB, no randomness — so it is exhaustively testable. Ported from
 * dm-manager.
 */

import {
  OCCUPATION_SUPPORT_RATIOS,
  SIZE_BASELINE_POPULATION,
  TERRAIN_POP_MODIFIER,
  WEALTH_ORDER,
  WEALTH_POP_MODIFIER,
} from './settlement-demographics-data'
import type { SettlementAxis } from './settlement-axes'

/** Picked dimension values, keyed by axis. "" / undefined = unset. */
export type SettlementDims = Partial<Record<SettlementAxis, string>>

/** One role and how many of them a settlement of these dims sustains. */
export interface DenizenCount {
  role: string
  count: number
}

/**
 * Representative resident population for a permutation:
 *   round(size baseline × wealth modifier × terrain modifier).
 * Size is the driver — an unset/unknown size yields 0 (no estimate). Unset
 * wealth/terrain contribute a neutral ×1.
 */
export function representativePopulation(dims: SettlementDims): number {
  const base = SIZE_BASELINE_POPULATION[dims.size ?? '']
  if (base === undefined) return 0
  const wealthMod = dims.wealth ? (WEALTH_POP_MODIFIER[dims.wealth] ?? 1) : 1
  const terrainMod = dims.terrain ? (TERRAIN_POP_MODIFIER[dims.terrain] ?? 1) : 1
  return Math.round(base * wealthMod * terrainMod)
}

/** Ordinal rank of a wealth tier, or -1 when unset/unknown. */
function wealthRank(wealth: string): number {
  return (WEALTH_ORDER as readonly string[]).indexOf(wealth)
}

/**
 * The denizen census for a permutation. For each occupation whose terrain,
 * wealth, and population gates pass, count = round(population / perPeople);
 * roles with a count of zero are dropped. Ordered by count (desc) then role
 * name (asc). Returns [] when no population is derivable.
 */
export function denizensByRole(dims: SettlementDims): DenizenCount[] {
  const population = representativePopulation(dims)
  if (population <= 0) return []

  const terrain = dims.terrain ?? ''
  const have = wealthRank(dims.wealth ?? '')

  const out: DenizenCount[] = []
  for (const occ of OCCUPATION_SUPPORT_RATIOS) {
    if (occ.terrains && !occ.terrains.includes(terrain)) continue
    if (occ.minWealth !== undefined && have < wealthRank(occ.minWealth)) continue
    if (occ.minPopulation !== undefined && population < occ.minPopulation) continue
    const count = Math.round(population / occ.perPeople)
    if (count >= 1) out.push({ role: occ.role, count })
  }
  out.sort((a, b) => b.count - a.count || a.role.localeCompare(b.role))
  return out
}
