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
] as const

export type RelationshipType = (typeof RELATIONSHIP_TYPES)[number]

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
}

export const RELATIONSHIP_TYPE_ENTRIES: readonly RelationshipTypeEntry[] = [
  { type: 'member_of', label: 'Member of', inverseLabel: 'Has member', symmetric: false },
  { type: 'leads', label: 'Leads', inverseLabel: 'Led by', symmetric: false },
  { type: 'located_in', label: 'Located in', inverseLabel: 'Contains', symmetric: false },
  { type: 'owns', label: 'Owns', inverseLabel: 'Owned by', symmetric: false },
  { type: 'serves', label: 'Serves', inverseLabel: 'Served by', symmetric: false },
  { type: 'parent_of', label: 'Parent of', inverseLabel: 'Child of', symmetric: false },
  { type: 'created_by', label: 'Created by', inverseLabel: 'Created', symmetric: false },
  { type: 'ally_of', label: 'Ally of', inverseLabel: 'Ally of', symmetric: true },
  { type: 'enemy_of', label: 'Enemy of', inverseLabel: 'Enemy of', symmetric: true },
  { type: 'rival_of', label: 'Rival of', inverseLabel: 'Rival of', symmetric: true },
  { type: 'related_to', label: 'Related to', inverseLabel: 'Related to', symmetric: true },
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
