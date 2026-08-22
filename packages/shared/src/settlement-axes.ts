/**
 * Settlement dimension taxonomy — the size / wealth / terrain axes a DM picks
 * on a settlement, and their allowed values. Pure data: pickers and detail
 * labels read this, and the demographics model keys its coefficient tables on
 * these same values. Free-form soft taxonomy — the column accepts any string;
 * these are the offered choices. Ported from dm-manager.
 */

/** The three settlement dimensions. */
export type SettlementAxis = 'size' | 'wealth' | 'terrain'

export interface AxisValue {
  /** Stored value — the free-form soft-taxonomy string. Lower-case, stable. */
  value: string
  /** Human label shown in the picker + detail summary. */
  label: string
}

export interface AxisDef {
  axis: SettlementAxis
  /** Human label for the picker group. */
  label: string
  /** Allowed values, in picker order. */
  values: readonly AxisValue[]
}

/** The full axis taxonomy, in display order (size → wealth → terrain). */
export const SETTLEMENT_DETAIL_AXES: readonly AxisDef[] = [
  {
    axis: 'size',
    label: 'Size',
    values: [
      { value: 'hamlet', label: 'Hamlet' },
      { value: 'village', label: 'Village' },
      { value: 'town', label: 'Town' },
      { value: 'city', label: 'City' },
      { value: 'kingdom', label: 'Kingdom / capital' },
    ],
  },
  {
    axis: 'wealth',
    label: 'Wealth',
    values: [
      { value: 'poor', label: 'Poor' },
      { value: 'average', label: 'Average' },
      { value: 'rich', label: 'Rich' },
    ],
  },
  {
    axis: 'terrain',
    label: 'Terrain',
    values: [
      { value: 'riverside', label: 'Riverside' },
      { value: 'lakeside', label: 'Lakeside' },
      { value: 'mountainous', label: 'Mountainous' },
      { value: 'plains', label: 'Plains' },
      { value: 'coastal', label: 'Coastal' },
      { value: 'forest', label: 'Forest' },
      { value: 'desert', label: 'Desert' },
    ],
  },
]
