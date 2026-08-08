/** Shared sans-IO surface: the exhaustiveness guard + the ported domain rules. */
export { assertNever } from './assert-never'

export { type FuzzyOptions, type FuzzyResult, fuzzySearch } from './fuzzy'
export { relativeTime, truncate } from './format'

export {
  type AxisDef,
  type AxisValue,
  SETTLEMENT_DETAIL_AXES,
  type SettlementAxis,
} from './settlement-axes'
export {
  type Occupation,
  OCCUPATION_SUPPORT_RATIOS,
  SIZE_BASELINE_POPULATION,
  TERRAIN_POP_MODIFIER,
  WEALTH_ORDER,
  WEALTH_POP_MODIFIER,
} from './settlement-demographics-data'
export {
  type DenizenCount,
  denizensByRole,
  representativePopulation,
  type SettlementDims,
} from './settlement-demographics'

export {
  type ActiveBracket,
  activeBracketQuery,
  BRACKET_RESOLVER_ORDER,
  type BracketableKind,
  type BracketMarker,
  buildNameIndex,
  completeBracket,
  type EntityRef,
  type NameIndex,
  type NameIndexInput,
  parseBrackets,
  resolveBracket,
} from './brackets'

export {
  contentKinds,
  ENTITY_KINDS,
  ENTITY_TIERS,
  type EntityKindEntry,
  type EntityTier,
  findKindEntry,
  homeKinds,
  homeKindsByTier,
  kindEntry,
  navKinds,
  navKindsByTier,
  type RegistryKind,
  TIER_TITLES,
  tierOf,
} from './entity-kinds'

export {
  detectImageMime,
  extensionForImageMime,
  IMAGE_MIME_TYPES,
  type ImageDimensions,
  type ImageMimeType,
  isMediaKind,
  MEDIA_KINDS,
  type MediaKind,
  readImageDimensions,
} from './image-bytes'

export {
  isRelationshipType,
  RELATIONSHIP_TYPE_ENTRIES,
  RELATIONSHIP_TYPES,
  relationshipLabel,
  relationshipType,
  type RelationshipType,
  type RelationshipTypeEntry,
} from './relationships'

export { type CalendarConfig, type CalendarKind, type CalendarShape, formatDate } from './calendar'
export { CurrencyValidationError, type Denomination, validateBaseRate } from './currency-rules'
export { nextAvailableSlug, slugify } from './slug'
export { type Visibility, VISIBILITIES, visibilityFromDmOnly } from './visibility'
