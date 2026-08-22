/**
 * How entities relate to each other, beyond the fact that one mentions another.
 *
 * `[[brackets]]` record THAT an entity refers to another; they are untyped and
 * directionless. This is the vocabulary for the other question — HOW they relate
 * — and it lives in `shared` so the server, the SPA, and the wiki graph all read
 * one list rather than three that can drift.
 *
 * ## Why a fixed set
 *
 * Free text is what people reach for at the table, and it was the close call. It
 * loses because nothing is queryable, one campaign spells the same relation six
 * ways, and the graph cannot colour or filter an edge whose type is prose.
 * Adding a twelfth type here is a one-line change; removing one is a migration
 * over real campaign data, so the list is deliberately generous.
 *
 * ## Why one row, not two
 *
 * A relationship is stored ONCE, `from → to`. The other entity's page renders
 * the same row through `inverseLabel`. Two rows would double every write and
 * leave every later operation — delete, export, a visibility change — able to
 * update one and miss the other, producing a half-relationship that shows on one
 * page and not the other. One row cannot be half-deleted.
 *
 * A `symmetric` type reads the same in both directions, so its `inverseLabel`
 * equals its `label`; the field is still populated rather than nullable, because
 * a renderer that has to branch on "is this one symmetric" is a renderer that
 * will eventually branch wrongly.
 */

export const RELATIONSHIP_TYPES = [
  'member_of',
  'leads',
  'located_in',
  'owns',
  'serves',
  'parent_of',
  'created_by',
  'ally_of',
  'enemy_of',
  'rival_of',
  'related_to',
  // Added by migration 0017, which folded in nine dormant junction tables. These
  // say what the types above cannot: not who an NPC allies with, but what they
  // SPEAK. Their rows came from dm-manager via the importer and were reachable
  // from no route and no UI until they became relationships.
  'speaks',
  'practises',
  'venerates',
  'found_at',
] as const

export type RelationshipType = (typeof RELATIONSHIP_TYPES)[number]

/**
 * Which question a type answers, and therefore which group of the picker it sits
 * in. `social` types relate two entities to each other; `attributive` ones state
 * a property of the subject that happens to be another entity — what it speaks,
 * practises, venerates, or where it is found.
 *
 * The split exists because 0017 took the vocabulary from eleven types to fifteen,
 * and a flat fifteen-item dropdown offering "Ally of" beside "Speaks" asks the
 * reader to notice a distinction the list does not draw. It is presentation only:
 * storage, validation and the seam treat every type identically.
 */
export type RelationshipGroup = 'social' | 'attributive'

/** Group headings, here rather than in the SPA so every surface agrees. */
export const RELATIONSHIP_GROUP_LABELS: Readonly<Record<RelationshipGroup, string>> = {
  social: 'Social & structural',
  attributive: 'Attributes',
}

/**
 * The controlled qualifier vocabulary for a language role, carried over by 0017
 * from the four `*_languages` junctions.
 *
 * FOUR values, not three. `culture_languages.role` allowed
 * native/secondary/liturgical and the other three allowed native/secondary/trade;
 * the folded column's vocabulary is the union, so no source row is refused on the
 * way in. `secondary` appeared in all four CHECK constraints and is easy to miss
 * when reading only the culture table.
 */
export const LANGUAGE_ROLES = ['native', 'secondary', 'liturgical', 'trade'] as const

export type LanguageRole = (typeof LANGUAGE_ROLES)[number]

export interface RelationshipTypeEntry {
  type: RelationshipType
  /** Read on the SOURCE entity's page: "<label> — <target>". */
  label: string
  /** Read on the TARGET entity's page for the same stored row. */
  inverseLabel: string
  /**
   * True when the relation reads identically both ways. Kept as data rather than
   * inferred from `label === inverseLabel`, so a future type whose two labels
   * happen to coincide does not silently become symmetric.
   */
  symmetric: boolean
  /** Which picker group the type belongs to. */
  group: RelationshipGroup
  /**
   * The closed set of values this type's `qualifier` may take, when it takes one.
   * Absent means the type carries no qualifier and the column stays null — the
   * route refuses a qualifier on such a type rather than storing an unreadable
   * one. Only `speaks` has one today.
   */
  qualifiers?: readonly string[]
}

export const RELATIONSHIP_TYPE_ENTRIES: readonly RelationshipTypeEntry[] = [
  {
    type: 'member_of',
    label: 'Member of',
    inverseLabel: 'Has member',
    symmetric: false,
    group: 'social',
  },
  { type: 'leads', label: 'Leads', inverseLabel: 'Led by', symmetric: false, group: 'social' },
  {
    type: 'located_in',
    label: 'Located in',
    inverseLabel: 'Contains',
    symmetric: false,
    group: 'social',
  },
  { type: 'owns', label: 'Owns', inverseLabel: 'Owned by', symmetric: false, group: 'social' },
  { type: 'serves', label: 'Serves', inverseLabel: 'Served by', symmetric: false, group: 'social' },
  {
    type: 'parent_of',
    label: 'Parent of',
    inverseLabel: 'Child of',
    symmetric: false,
    group: 'social',
  },
  {
    type: 'created_by',
    label: 'Created by',
    inverseLabel: 'Created',
    symmetric: false,
    group: 'social',
  },
  { type: 'ally_of', label: 'Ally of', inverseLabel: 'Ally of', symmetric: true, group: 'social' },
  {
    type: 'enemy_of',
    label: 'Enemy of',
    inverseLabel: 'Enemy of',
    symmetric: true,
    group: 'social',
  },
  {
    type: 'rival_of',
    label: 'Rival of',
    inverseLabel: 'Rival of',
    symmetric: true,
    group: 'social',
  },
  {
    type: 'related_to',
    label: 'Related to',
    inverseLabel: 'Related to',
    symmetric: true,
    group: 'social',
  },
  // Inverse labels are dm-manager's own cross-reference headings, so a world
  // imported from it reads the way it used to.
  {
    type: 'speaks',
    label: 'Speaks',
    inverseLabel: 'Spoken by',
    symmetric: false,
    group: 'attributive',
    qualifiers: LANGUAGE_ROLES,
  },
  {
    type: 'practises',
    label: 'Practises',
    inverseLabel: 'Practitioners',
    symmetric: false,
    group: 'attributive',
  },
  {
    type: 'venerates',
    label: 'Venerates',
    inverseLabel: 'Venerated by',
    symmetric: false,
    group: 'attributive',
  },
  {
    type: 'found_at',
    label: 'Found at',
    inverseLabel: 'Resources found here',
    symmetric: false,
    group: 'attributive',
  },
]

const BY_TYPE = new Map(RELATIONSHIP_TYPE_ENTRIES.map((e) => [e.type, e]))

/** Whether a string names a type in the vocabulary. The parse boundary. */
export function isRelationshipType(value: string): value is RelationshipType {
  return BY_TYPE.has(value as RelationshipType)
}

/** The registry entry for a type. Throws for anything outside the vocabulary. */
export function relationshipType(type: RelationshipType): RelationshipTypeEntry {
  const entry = BY_TYPE.get(type)
  if (!entry) throw new Error(`No relationship type: ${type}`)
  return entry
}

/**
 * How a relationship reads from one END of it.
 *
 * `outgoing` means the entity being viewed is the row's `from`. This single
 * function is what makes one stored row render correctly on both pages, so
 * neither side can describe the relation differently from the other.
 */
export function relationshipLabel(type: RelationshipType, outgoing: boolean): string {
  const entry = relationshipType(type)
  return outgoing ? entry.label : entry.inverseLabel
}

/**
 * The types in one picker group, in vocabulary order.
 *
 * Derived from `RELATIONSHIP_TYPE_ENTRIES` rather than listed a second time, so
 * adding a type cannot leave it out of its own group.
 */
export function relationshipTypesInGroup(group: RelationshipGroup): RelationshipTypeEntry[] {
  return RELATIONSHIP_TYPE_ENTRIES.filter((e) => e.group === group)
}

/**
 * Whether `qualifier` is acceptable on `type`.
 *
 * `undefined` is always acceptable: the qualifier is optional even on a type that
 * defines a vocabulary, because a DM who records that an NPC speaks a language
 * without saying in what capacity has recorded something true. What is refused is
 * a qualifier on a type with no vocabulary for one, and a value outside the
 * vocabulary of a type that has one — either would store a string no reader can
 * interpret and no filter can group by, which is the whole reason the column is
 * separate from the free-text `note`.
 */
export function isValidQualifier(type: RelationshipType, qualifier: string | undefined): boolean {
  if (qualifier === undefined) return true
  const { qualifiers } = relationshipType(type)
  return qualifiers !== undefined && qualifiers.includes(qualifier)
}
