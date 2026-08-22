/**
 * Per-kind field registry — the declarative description of the typed fields
 * each content kind carries beyond `name` and `description`, ordered for
 * rendering. Pure data; the detail page and the entity editor read this instead
 * of hard-coding a block per kind, which is what dm-manager did (one
 * `showXFields` branch per kind in `components/ui/EntityForm.tsx` plus a
 * matching read-only block in `components/entity-pages.tsx` — two lists, in two
 * files, that had to be edited together).
 *
 * The keys are the FLAT shape the API returns, not a per-table shape: since
 * migration 0005 a kind's columns live in `<kind>_details` and the content seam
 * merges them onto the `entities` base row before the API sees them.
 *
 * NOT in here, on purpose:
 *   - `name` / `description`, which every kind has and the editor renders itself
 *   - `visibility`, which is not a per-kind field — it is the 3-state entity
 *     column from migration 0004, and it already has its own owner-only control
 *     (the web's `entity-visibility-panel`)
 *   - the complex fields: currency `denominations` (a JSON array of coin
 *     denominations) and calendar config. A single scalar input cannot edit
 *     either, and they are owned by the bespoke-domain-panels task.
 *
 * A server-side parity test asserts every key here is a real column for its
 * kind, so this file cannot drift from the schema in silence.
 */

import type { ContentKind, RegistryKind } from './entity-kinds'
import { SETTLEMENT_DETAIL_AXES } from './settlement-axes'

/**
 * How a field is edited and displayed.
 *
 * `text` vs `enum` is a real distinction here rather than a cosmetic one: most
 * of this app's taxonomies are SOFT — the column accepts any string and the
 * offered values are suggestions, so the vocabulary belongs in the `hint` and
 * the input stays free-form. Only settlement size/wealth/terrain have a closed
 * offered set (`SETTLEMENT_DETAIL_AXES`), because the demographics model keys
 * its coefficient tables on those exact values.
 */
export type FieldType =
  | 'text'
  | 'textarea'
  | 'number'
  | 'boolean'
  | 'enum'
  | 'entityRef'
  | 'accountRef'

/** One offered choice on an `enum` field: the stored value plus its label. */
export interface FieldOption {
  value: string
  label: string
}

export interface FieldDef {
  /** Column name in the flat merged entity — the key the API reads and writes. */
  key: string
  /** Human label for the input and the detail row. */
  label: string
  type: FieldType
  /**
   * Whether the underlying column accepts NULL. Required rather than optional,
   * because it decides what CLEARING the input means and a forgotten flag would
   * pick the wrong answer silently: a nullable field emptied becomes `null`, and
   * a NOT NULL one becomes `''` or `0` — sending `null` to the latter is a
   * constraint violation, and sending `''` to the former makes "unset" and
   * "empty" two different stored states for one user action.
   *
   * The parity test checks every flag against `information_schema.is_nullable`,
   * so this cannot quietly disagree with the database.
   */
  nullable: boolean
  /** The offered values. `enum` only. */
  options?: readonly FieldOption[]
  /** Which kind this field points at. `entityRef` only. */
  refKind?: RegistryKind
  /** Helper text under the label — carries the soft-taxonomy vocabulary. */
  hint?: string
  /** Input placeholder. */
  placeholder?: string
}

/**
 * Settlement's three axis fields, DERIVED from the shared taxonomy rather than
 * looked up in it by name. The axis definition already carries the key, the
 * label, the offered values and the display order, so deriving means there is
 * no name to mistype, no lookup that can miss, and adding a fourth axis to
 * `SETTLEMENT_DETAIL_AXES` puts it on the settlement editor by itself.
 *
 * All three columns are NOT NULL with a default, so an unset one is `''`.
 */
const SETTLEMENT_AXIS_FIELDS: readonly FieldDef[] = SETTLEMENT_DETAIL_AXES.map((axis) => ({
  key: axis.axis,
  label: axis.label,
  type: 'enum',
  nullable: false,
  options: axis.values.map((v) => ({ value: v.value, label: v.label })),
}))

/**
 * Every content kind's fields, in render order. Total over the 16 content kinds
 * — a kind with no typed fields of its own maps to `[]` rather than being
 * absent, so a caller iterating kinds never has to handle `undefined`.
 *
 * Order follows dm-manager's form, not the column order in the schema, because
 * the order is a display decision and that is where the display decision was
 * made.
 */
export const ENTITY_FIELDS: Record<ContentKind, readonly FieldDef[]> = {
  npc: [
    {
      key: 'occupation',
      label: 'Occupation',
      type: 'text',
      nullable: false,
      hint: 'Free-form role (e.g. Baker, Guard). Optional.',
      placeholder: 'e.g. Baker',
    },
    {
      key: 'species_id',
      label: 'Species',
      type: 'entityRef',
      nullable: true,
      refKind: 'species',
      hint: 'Optional. The kingdom-level kind of being.',
    },
    {
      key: 'culture_id',
      label: 'Culture',
      type: 'entityRef',
      nullable: true,
      refKind: 'culture',
      hint: 'Optional. The shared identity this belongs to.',
    },
  ],

  pc: [
    {
      key: 'species_id',
      label: 'Species',
      type: 'entityRef',
      nullable: true,
      refKind: 'species',
      hint: 'Optional. The kingdom-level kind of being.',
    },
    {
      key: 'account_id',
      label: 'Played by',
      // Not an `entityRef`: an account is not an entity and has no page. The
      // options come from the world's members rather than the wiki corpus,
      // which is the whole reason this is its own type — see `accountRef` on
      // FieldType.
      type: 'accountRef',
      nullable: true,
      hint: 'Optional. The player whose character this is. Only the GM can set it.',
    },
  ],

  settlement: [
    ...SETTLEMENT_AXIS_FIELDS,
    {
      key: 'population',
      label: 'Population',
      type: 'number',
      nullable: false,
      hint: 'Leave at 0 to use the figure the size/wealth/terrain model estimates.',
    },
    {
      key: 'culture_id',
      label: 'Culture',
      type: 'entityRef',
      nullable: true,
      refKind: 'culture',
      hint: 'Optional. The shared identity this belongs to.',
    },
  ],

  species: [
    {
      key: 'kingdom',
      label: 'Kingdom',
      type: 'text',
      nullable: false,
      hint: 'Free-form, soft taxonomy: humanoid, beast, spirit, construct, other.',
      placeholder: 'e.g. humanoid',
    },
    {
      key: 'elemental_alignment',
      label: 'Elemental alignment',
      type: 'text',
      nullable: true,
      hint: 'Free-form. Optional.',
      placeholder: 'e.g. fire',
    },
    { key: 'is_corporeal', label: 'Corporeal', type: 'boolean', nullable: false },
    { key: 'is_sentient', label: 'Sentient', type: 'boolean', nullable: false },
  ],

  culture: [
    {
      key: 'dominant_values',
      label: 'Dominant values',
      type: 'textarea',
      nullable: false,
      hint: 'Free-form. What this culture prizes.',
    },
    {
      key: 'historical_period',
      label: 'Historical period',
      type: 'text',
      nullable: false,
      hint: 'Free-form (e.g. "Late Verdant Ascendancy").',
    },
    {
      key: 'aesthetic_notes',
      label: 'Aesthetic notes',
      type: 'textarea',
      nullable: false,
      hint: 'Free-form. Dress, art, architecture, motifs.',
    },
  ],

  language: [
    {
      key: 'family',
      label: 'Family',
      type: 'text',
      nullable: false,
      hint: 'Free-form. The language group this belongs to.',
      placeholder: 'e.g. Old Coastal',
    },
    {
      key: 'is_trade_language',
      label: 'Trade language',
      type: 'boolean',
      nullable: false,
      hint: 'A common tongue for cross-culture exchange.',
    },
    {
      key: 'writing_system',
      label: 'Writing system',
      type: 'text',
      nullable: false,
      hint: 'Free-form. Optional.',
      placeholder: 'e.g. runic',
    },
  ],

  magic_system: [
    {
      key: 'source_kind',
      label: 'Source',
      type: 'text',
      nullable: false,
      hint: 'Free-form, soft taxonomy: divine, arcane, natural, innate, other.',
      placeholder: 'e.g. divine',
    },
    {
      key: 'cost_summary',
      label: 'Cost',
      type: 'textarea',
      nullable: false,
      hint: 'Free-form. What the practitioner pays.',
    },
    {
      key: 'alignment',
      label: 'Alignment',
      type: 'text',
      nullable: false,
      hint: 'Free-form. How this tradition is regarded.',
    },
    {
      key: 'is_taught',
      label: 'Taught',
      type: 'boolean',
      nullable: false,
      hint: 'Otherwise: born into.',
    },
    { key: 'requires_materials', label: 'Requires materials', type: 'boolean', nullable: false },
  ],

  // `base_rate_to` and `rate` are NOT here: they are one coupled control, not
  // two independent fields. A rate means nothing without an anchor, and an
  // anchor's validity depends on every OTHER currency in the world (it may not
  // be itself and the chain may not cycle) — which no per-field descriptor can
  // express and no generic picker can check. The currency panel owns the pair,
  // and they are listed in the parity test's DELIBERATELY_UNRENDERED with that
  // reason. `denominations` is out for the same reason it always was: a JSON
  // array no scalar input can edit.
  currency: [
    {
      key: 'symbol',
      label: 'Symbol',
      type: 'text',
      nullable: false,
      hint: 'Short label, e.g. "gp", "tb", "✦".',
    },
  ],

  resource: [
    {
      key: 'resource_kind',
      label: 'Kind',
      type: 'text',
      nullable: false,
      hint: 'Free-form, soft taxonomy: mineral, agricultural, aquatic, forestry, magical, other.',
      placeholder: 'e.g. mineral',
    },
    {
      key: 'scarcity',
      label: 'Scarcity',
      type: 'text',
      nullable: false,
      hint: 'Free-form, soft taxonomy: abundant, common, scarce, depleted, untapped.',
      placeholder: 'e.g. scarce',
    },
    {
      key: 'commercial_value',
      label: 'Commercial value',
      type: 'text',
      nullable: false,
      hint: 'Free-form, relative. Not linked to currency.',
    },
  ],

  pantheon: [
    {
      key: 'tradition',
      label: 'Tradition',
      type: 'text',
      nullable: false,
      hint: 'Free-form. The religious tradition this pantheon belongs to.',
    },
    {
      key: 'historical_period',
      label: 'Historical period',
      type: 'text',
      nullable: false,
      hint: 'Free-form (e.g. "the Age of the Demigods").',
    },
  ],

  deity: [
    {
      key: 'domain',
      label: 'Domain',
      type: 'text',
      nullable: false,
      hint: 'Free-form (e.g. storm, harvest, mercy).',
      placeholder: 'e.g. harvest',
    },
    {
      key: 'worship_status',
      label: 'Worship status',
      type: 'text',
      nullable: false,
      hint: 'Free-form, soft taxonomy: active, dormant, forgotten.',
      placeholder: 'e.g. dormant',
    },
    {
      key: 'pantheon_id',
      label: 'Pantheon',
      type: 'entityRef',
      nullable: true,
      refKind: 'pantheon',
      hint: 'Optional. The pantheon this deity belongs to.',
    },
  ],

  event: [
    {
      key: 'occurred_at',
      label: 'When',
      type: 'text',
      nullable: true,
      hint: 'Free-form in-world date — this is prose, not a timestamp.',
      placeholder: 'e.g. two winters ago',
    },
  ],

  lore_article: [
    {
      key: 'article_kind',
      label: 'Kind',
      type: 'text',
      nullable: true,
      hint: 'Free-form, soft taxonomy: myth, legend, tradition, song, history, other.',
      placeholder: 'e.g. myth',
    },
  ],

  // No detail table of their own — a name, a description, and their
  // relationships are the whole of them.
  item: [],
  organization: [],
  location: [],
}

/** This kind's fields in render order; `[]` for a kind with none. */
export function fieldsForKind(kind: ContentKind): readonly FieldDef[] {
  return ENTITY_FIELDS[kind]
}

/**
 * Soft lookup for a kind that arrived as a plain string (a URL segment, an API
 * payload). Returns `[]` for anything that is not a content kind, so a caller
 * rendering an unknown kind falls back to name + description rather than
 * throwing.
 */
export function fieldsForKindName(kind: string): readonly FieldDef[] {
  return ENTITY_FIELDS[kind as ContentKind] ?? []
}
