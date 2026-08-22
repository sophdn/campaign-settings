/**
 * Settlement demographics coefficient tables — the researched data the
 * parametric model (settlement-demographics.ts) computes over. PURE DATA, no
 * logic. Ported from dm-manager.
 *
 * Source: urban occupation support-ratios from "Medieval Demographics Made
 * Easy" (S. John Ross), derived from a 1292 Paris tax census. A "support ratio"
 * is the number of townsfolk that sustain one of a given trade. Luxury trades
 * are gated behind minimum wealth+population, and a small set of terrain
 * primary-industry roles is added so a settlement reads true to its place.
 */

import type { SettlementAxis } from './settlement-axes'

/** Wealth tiers, weakest → strongest. Used for ordinal `minWealth` gates. */
export const WEALTH_ORDER = ['poor', 'average', 'rich'] as const

/**
 * Representative resident population per size value. The model's starting
 * point; wealth + terrain modifiers scale it.
 */
export const SIZE_BASELINE_POPULATION: Readonly<Record<string, number>> = {
  hamlet: 50,
  village: 400,
  town: 3000,
  city: 12000,
  kingdom: 30000,
}

/** Population multiplier by wealth — prosperity supports more residents. */
export const WEALTH_POP_MODIFIER: Readonly<Record<string, number>> = {
  poor: 0.8,
  average: 1.0,
  rich: 1.25,
}

/**
 * Population multiplier by terrain — rough carrying capacity / trade access.
 * Water and open farmland support more; mountains and desert less.
 */
export const TERRAIN_POP_MODIFIER: Readonly<Record<string, number>> = {
  riverside: 1.15,
  lakeside: 1.1,
  coastal: 1.15,
  plains: 1.1,
  forest: 0.9,
  mountainous: 0.8,
  desert: 0.7,
}

export interface Occupation {
  /** Display label for the role (an occupation, never a personal name). */
  role: string
  /** Townsfolk supporting one of this trade (count = round(pop / perPeople)). */
  perPeople: number
  /** Trade is absent below this population (no inn in a 40-soul hamlet). */
  minPopulation?: number
  /** Trade requires at least this wealth tier (luxury gating). */
  minWealth?: (typeof WEALTH_ORDER)[number]
  /** If set, the trade only appears for these terrain values. */
  terrains?: readonly string[]
}

/**
 * Occupation support-ratios. Universal trades first (MDME ratios), then
 * wealth-gated luxury trades, then terrain primary-industry roles.
 */
export const OCCUPATION_SUPPORT_RATIOS: readonly Occupation[] = [
  // ── Universal urban trades (MDME) ────────────────────────────────────
  { role: 'Shoemaker', perPeople: 150 },
  { role: 'Tailor', perPeople: 250 },
  { role: 'Tavern-keeper', perPeople: 400, minPopulation: 100 },
  { role: 'Barber', perPeople: 350 },
  { role: 'Mason', perPeople: 500 },
  { role: 'Carpenter', perPeople: 550 },
  { role: 'Weaver', perPeople: 600 },
  { role: 'Cooper', perPeople: 700 },
  { role: 'Baker', perPeople: 800, minPopulation: 100 },
  { role: 'Butcher', perPeople: 1200, minPopulation: 200 },
  { role: 'Smith', perPeople: 1500 },
  { role: 'Innkeeper', perPeople: 2000, minPopulation: 200 },
  { role: 'Tanner', perPeople: 2000, minPopulation: 400 },

  // ── Wealth-gated trades (luxury / specialist) ────────────────────────
  { role: 'Scribe', perPeople: 2000, minPopulation: 1000, minWealth: 'average' },
  { role: 'Physician', perPeople: 2300, minPopulation: 1000, minWealth: 'average' },
  { role: 'Furrier', perPeople: 1500, minPopulation: 1000, minWealth: 'average' },
  { role: 'Jeweller', perPeople: 3000, minPopulation: 5000, minWealth: 'rich' },
  { role: 'Bookseller', perPeople: 6300, minPopulation: 8000, minWealth: 'rich' },

  // ── Terrain primary-industry roles (our adaptation) ──────────────────
  { role: 'Fisher', perPeople: 120, terrains: ['riverside', 'lakeside', 'coastal'] },
  { role: 'Miller', perPeople: 1000, terrains: ['riverside'] },
  { role: 'Ferryman', perPeople: 2000, minPopulation: 500, terrains: ['riverside'] },
  { role: 'Shipwright', perPeople: 2500, minPopulation: 2000, terrains: ['coastal'] },
  { role: 'Miner', perPeople: 150, terrains: ['mountainous'] },
  { role: 'Quarrier', perPeople: 800, terrains: ['mountainous'] },
  { role: 'Farmhand', perPeople: 60, terrains: ['plains'] },
  { role: 'Woodcutter', perPeople: 200, terrains: ['forest'] },
  { role: 'Trapper', perPeople: 600, terrains: ['forest'] },
  { role: 'Water-seller', perPeople: 800, terrains: ['desert'] },
  { role: 'Caravaneer', perPeople: 700, minPopulation: 500, terrains: ['desert'] },
]

/** Re-exported for callers that build dims objects keyed by axis. */
export type { SettlementAxis }
