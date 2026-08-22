/**
 * Entity-kind registry — the single source of truth for the kinds a world
 * holds, their labels, nav/home/wiki surfaces, badge colours, home tier, and
 * bracket-resolver precedence. Pure data + pure query functions; shared by the
 * server and the web. Ported from dm-manager.
 */

export type RegistryKind =
  | 'npc'
  | 'pc'
  | 'settlement'
  | 'item'
  | 'organization'
  | 'location'
  | 'event'
  | 'lore_article'
  | 'currency'
  | 'language'
  | 'species'
  | 'culture'
  | 'magic_system'
  | 'resource'
  | 'pantheon'
  | 'deity'
  | 'session'
  | 'map'

export interface EntityKindEntry {
  kind: RegistryKind
  label: { singular: string; plural: string }
  basePath: string
  homeCard: { title: string; blurb: string }
  /** Sort key for nav link order (ascending). */
  navOrder: number
  /** Theme colour-token key for kind badges (resolved to a CSS var by the web). */
  badgeColor: 'accent' | 'danger' | 'success' | 'warning' | 'textSecondary'
  /** Priority for bracket resolution; null = not bracket-resolvable. Lower wins. */
  bracketResolverRank: number | null
  /**
   * Which surfaces this kind appears on.
   *
   * `home` used to sit beside these two and differed from `nav` for exactly one
   * kind — `map`, which the rail linked separately. Chain 470 folded Maps into
   * the rail's Primary group so the world dashboard and the rail could read ONE
   * kinds array, at which point `home` and `nav` agreed on all eighteen entries.
   * Two booleans that must always agree are a drift waiting to happen, so the
   * pair became one.
   */
  surfaces: { nav: boolean; wiki: boolean }
}

export const ENTITY_KINDS: readonly EntityKindEntry[] = [
  {
    kind: 'pc',
    label: { singular: 'PC', plural: 'PCs' },
    basePath: '/pcs',
    homeCard: { title: 'PCs', blurb: 'The party. Player characters who drive the campaign.' },
    navOrder: 1,
    badgeColor: 'success',
    bracketResolverRank: 200,
    surfaces: { nav: true, wiki: true },
  },
  {
    kind: 'npc',
    label: { singular: 'NPC', plural: 'NPCs' },
    basePath: '/npcs',
    homeCard: { title: 'NPCs', blurb: 'People your campaign meets.' },
    navOrder: 2,
    badgeColor: 'accent',
    bracketResolverRank: 100,
    surfaces: { nav: true, wiki: true },
  },
  {
    kind: 'settlement',
    label: { singular: 'Settlement', plural: 'Settlements' },
    basePath: '/settlements',
    homeCard: { title: 'Settlements', blurb: 'Towns, cities, and the places people live.' },
    navOrder: 3,
    badgeColor: 'success',
    bracketResolverRank: 300,
    surfaces: { nav: true, wiki: true },
  },
  {
    kind: 'session',
    label: { singular: 'Session', plural: 'Sessions' },
    basePath: '/sessions',
    homeCard: {
      title: 'Sessions',
      blurb: 'Quick-capture what happened. Auto-derives per-entity history.',
    },
    navOrder: 4,
    badgeColor: 'textSecondary',
    bracketResolverRank: null,
    surfaces: { nav: true, wiki: true },
  },
  {
    kind: 'item',
    label: { singular: 'Item', plural: 'Items' },
    basePath: '/items',
    homeCard: { title: 'Items', blurb: 'Weapons, relics, and handouts. Track what passes hands.' },
    navOrder: 5,
    badgeColor: 'danger',
    bracketResolverRank: 400,
    surfaces: { nav: true, wiki: true },
  },
  {
    kind: 'organization',
    label: { singular: 'Organization', plural: 'Organizations' },
    basePath: '/organizations',
    homeCard: {
      title: 'Organizations',
      blurb: "Factions, guilds, and cabals. Track who's pulling strings.",
    },
    navOrder: 6,
    badgeColor: 'accent',
    bracketResolverRank: 500,
    surfaces: { nav: true, wiki: true },
  },
  {
    kind: 'location',
    label: { singular: 'Location', plural: 'Locations' },
    basePath: '/locations',
    homeCard: {
      title: 'Locations',
      blurb: "Forests, ruins, dungeons, regions — anywhere that isn't a settlement.",
    },
    navOrder: 7,
    badgeColor: 'success',
    bracketResolverRank: 600,
    surfaces: { nav: true, wiki: true },
  },
  {
    kind: 'event',
    label: { singular: 'Event', plural: 'Events' },
    basePath: '/events',
    homeCard: {
      title: 'Events',
      blurb: 'Historical and future in-fiction occurrences. Distinct from sessions.',
    },
    navOrder: 8,
    badgeColor: 'textSecondary',
    bracketResolverRank: 700,
    surfaces: { nav: true, wiki: true },
  },
  {
    kind: 'lore_article',
    label: { singular: 'Lore Article', plural: 'Lore Articles' },
    basePath: '/lore',
    homeCard: { title: 'Lore Articles', blurb: 'Myths, legends, traditions, languages, songs.' },
    navOrder: 9,
    badgeColor: 'accent',
    bracketResolverRank: 800,
    surfaces: { nav: true, wiki: true },
  },
  {
    kind: 'map',
    label: { singular: 'Map', plural: 'Maps' },
    basePath: '/maps',
    homeCard: { title: 'Maps', blurb: 'Campaign maps with pinned entity references.' },
    navOrder: 10,
    badgeColor: 'success',
    bracketResolverRank: null,
    surfaces: { nav: true, wiki: true },
  },
  {
    kind: 'currency',
    label: { singular: 'Currency', plural: 'Currencies' },
    basePath: '/currencies',
    homeCard: {
      title: 'Currencies',
      blurb: 'Coined money, trade goods, regional scrip — anything used as a unit of exchange.',
    },
    navOrder: 11,
    badgeColor: 'warning',
    bracketResolverRank: 900,
    surfaces: { nav: true, wiki: true },
  },
  {
    kind: 'language',
    label: { singular: 'Language', plural: 'Languages' },
    basePath: '/languages',
    homeCard: {
      title: 'Languages',
      blurb: 'Tongues spoken across the world — trade pidgins, liturgical languages, dialects.',
    },
    navOrder: 12,
    badgeColor: 'accent',
    bracketResolverRank: 1000,
    surfaces: { nav: true, wiki: true },
  },
  {
    kind: 'species',
    label: { singular: 'Species', plural: 'Species' },
    basePath: '/species',
    homeCard: {
      title: 'Species',
      blurb: 'The kingdom-level kinds of being a world holds — humans, spirits, demigods.',
    },
    navOrder: 13,
    badgeColor: 'success',
    bracketResolverRank: 1100,
    surfaces: { nav: true, wiki: true },
  },
  {
    kind: 'culture',
    label: { singular: 'Culture', plural: 'Cultures' },
    basePath: '/cultures',
    homeCard: {
      title: 'Cultures',
      blurb: 'Shared identity, values, and practice — distinct from organisations.',
    },
    navOrder: 14,
    badgeColor: 'warning',
    bracketResolverRank: 1200,
    surfaces: { nav: true, wiki: true },
  },
  {
    kind: 'magic_system',
    label: { singular: 'Magic System', plural: 'Magic Systems' },
    basePath: '/magic-systems',
    homeCard: {
      title: 'Magic Systems',
      blurb: 'Traditions and schools of magic — how power is sourced, paid for, and practiced.',
    },
    navOrder: 15,
    badgeColor: 'danger',
    bracketResolverRank: 1300,
    surfaces: { nav: true, wiki: true },
  },
  {
    kind: 'resource',
    label: { singular: 'Resource', plural: 'Resources' },
    basePath: '/resources',
    homeCard: {
      title: 'Resources',
      blurb: 'Deposits, raw materials, and agricultural zones — iron ore, fertile coastline.',
    },
    navOrder: 16,
    badgeColor: 'success',
    bracketResolverRank: 1400,
    surfaces: { nav: true, wiki: true },
  },
  {
    kind: 'pantheon',
    label: { singular: 'Pantheon', plural: 'Pantheons' },
    basePath: '/pantheons',
    homeCard: {
      title: 'Pantheons',
      blurb: 'Religions and groupings of gods — identified-with, not an organisation.',
    },
    navOrder: 17,
    badgeColor: 'accent',
    bracketResolverRank: 1500,
    surfaces: { nav: true, wiki: true },
  },
  {
    kind: 'deity',
    label: { singular: 'Deity', plural: 'Deities' },
    basePath: '/deities',
    homeCard: {
      title: 'Deities',
      blurb: 'Individual gods. May belong to a pantheon, or stand alone.',
    },
    navOrder: 18,
    badgeColor: 'warning',
    bracketResolverRank: 1600,
    surfaces: { nav: true, wiki: true },
  },
]

/** Find a registry entry. Throws if missing. */
export function kindEntry(kind: RegistryKind): EntityKindEntry {
  const entry = ENTITY_KINDS.find((k) => k.kind === kind)
  if (!entry) throw new Error(`No registry entry for kind: ${kind}`)
  return entry
}

const warnedMissingKinds = new Set<string>()

/** Soft lookup; warns once on unknown kinds and returns undefined. */
export function findKindEntry(kind: string): EntityKindEntry | undefined {
  const entry = ENTITY_KINDS.find((k) => k.kind === kind)
  if (!entry && !warnedMissingKinds.has(kind)) {
    warnedMissingKinds.add(kind)
    console.warn(`[entityKinds] no registry entry for kind '${kind}' — rendering as plain text`)
  }
  return entry
}

/** All kinds with surfaces.nav === true, sorted by navOrder. */
export function navKinds(): EntityKindEntry[] {
  return [...ENTITY_KINDS].filter((k) => k.surfaces.nav).sort((a, b) => a.navOrder - b.navOrder)
}

/**
 * Kinds with no dm_only column: they aren't content-authorization tables and
 * aren't suggestable targets. session and map are bespoke kinds. (pc IS a
 * content kind — it has dm_only, so a PC can be hidden from the party.) Mirrors
 * the server's CONTENT_REPOS exclusion list (guarded by a parity test there).
 *
 * Declared as a literal list so the type and the runtime set below are one
 * source: `ContentKind` is what a total per-kind record (ENTITY_FIELDS) keys
 * on, and a set that drifted from it would let such a record miss a kind.
 */
const NON_CONTENT_KIND_LIST = ['session', 'map'] as const

/** The bespoke kinds that do not ride the content-authorization seam. */
export type NonContentKind = (typeof NON_CONTENT_KIND_LIST)[number]

/** The 16 kinds that DO ride the seam — the complement of `NonContentKind`. */
export type ContentKind = Exclude<RegistryKind, NonContentKind>

const NON_CONTENT_KINDS = new Set<RegistryKind>(NON_CONTENT_KIND_LIST)

/**
 * Content kinds: those that flow through the content-authorization seam (have a
 * dm_only column) and are therefore valid suggestion targets. Sorted by
 * navOrder. The single source of truth for the suggestion-target dropdown.
 */
export function contentKinds(): EntityKindEntry[] {
  return [...ENTITY_KINDS]
    .filter((k) => !NON_CONTENT_KINDS.has(k.kind))
    .sort((a, b) => a.navOrder - b.navOrder)
}

/** Home-screen prominence tier. */
export type EntityTier = 'primary' | 'secondary' | 'tertiary'

/** Tier order for rendering home sections. */
export const ENTITY_TIERS: readonly EntityTier[] = ['primary', 'secondary', 'tertiary']

/** Human-facing section titles for each tier. */
export const TIER_TITLES: Record<EntityTier, string> = {
  primary: 'Primary',
  secondary: 'Secondary',
  tertiary: 'Tertiary',
}

const PRIMARY_KINDS = new Set<RegistryKind>([
  'pc',
  'npc',
  'settlement',
  'location',
  'session',
  'organization',
  'event',
  'map',
])
const TERTIARY_KINDS = new Set<RegistryKind>([
  'currency',
  'magic_system',
  'resource',
  'pantheon',
  'deity',
])

/** Which home tier a kind belongs to. */
export function tierOf(kind: RegistryKind): EntityTier {
  if (PRIMARY_KINDS.has(kind)) return 'primary'
  if (TERTIARY_KINDS.has(kind)) return 'tertiary'
  return 'secondary'
}

/**
 * Nav kinds grouped by tier, each group sorted by navOrder.
 *
 * THE one grouping. It replaced a near-duplicate pair — `homeKindsByTier` and
 * `navKindsByTier` — that differed only in which `surfaces` flag they filtered
 * on, and therefore only in whether `map` was in the result. Chain 470 gave the
 * rail and the world dashboard one source for the Primary group, which made the
 * two functions the same function; see the note on `EntityKindEntry.surfaces`.
 */
export function kindsByTier(): Record<EntityTier, EntityKindEntry[]> {
  const groups: Record<EntityTier, EntityKindEntry[]> = {
    primary: [],
    secondary: [],
    tertiary: [],
  }
  for (const entry of navKinds()) {
    groups[tierOf(entry.kind)].push(entry)
  }
  return groups
}

/**
 * The world-relative path segment for a kind's index screen.
 *
 * Every kind but one is just `<kind>`, served by the route tree's `:kind`
 * catch-all. `map` is the exception: maps are a world-level surface with their
 * own index route (`maps`), declared before the catch-all so it is not read as
 * an entity kind. Nothing needed to ask until chain 470 folded Maps out of its
 * hardcoded rail link and into the Primary group, at which point the rail and
 * the dashboard both had to know. They ask here, so they cannot disagree.
 */
export function kindIndexPath(kind: RegistryKind): string {
  return kind === 'map' ? 'maps' : kind
}

/**
 * The Primary tier alone — the shared array the rail's Primary section and the
 * dashboard's quick links both read, so a kind cannot be prominent in one place
 * and missing from the other.
 */
export function primaryKinds(): EntityKindEntry[] {
  return kindsByTier().primary
}
