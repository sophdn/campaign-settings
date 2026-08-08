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
  /** Which surfaces this kind appears on. */
  surfaces: { nav: boolean; home: boolean; wiki: boolean }
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
    surfaces: { nav: true, home: true, wiki: true },
  },
  {
    kind: 'npc',
    label: { singular: 'NPC', plural: 'NPCs' },
    basePath: '/npcs',
    homeCard: { title: 'NPCs', blurb: 'People your campaign meets.' },
    navOrder: 2,
    badgeColor: 'accent',
    bracketResolverRank: 100,
    surfaces: { nav: true, home: true, wiki: true },
  },
  {
    kind: 'settlement',
    label: { singular: 'Settlement', plural: 'Settlements' },
    basePath: '/settlements',
    homeCard: { title: 'Settlements', blurb: 'Towns, cities, and the places people live.' },
    navOrder: 3,
    badgeColor: 'success',
    bracketResolverRank: 300,
    surfaces: { nav: true, home: true, wiki: true },
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
    surfaces: { nav: true, home: true, wiki: true },
  },
  {
    kind: 'item',
    label: { singular: 'Item', plural: 'Items' },
    basePath: '/items',
    homeCard: { title: 'Items', blurb: 'Weapons, relics, and handouts. Track what passes hands.' },
    navOrder: 5,
    badgeColor: 'danger',
    bracketResolverRank: 400,
    surfaces: { nav: true, home: true, wiki: true },
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
    surfaces: { nav: true, home: true, wiki: true },
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
    surfaces: { nav: true, home: true, wiki: true },
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
    surfaces: { nav: true, home: true, wiki: true },
  },
  {
    kind: 'lore_article',
    label: { singular: 'Lore Article', plural: 'Lore Articles' },
    basePath: '/lore',
    homeCard: { title: 'Lore Articles', blurb: 'Myths, legends, traditions, languages, songs.' },
    navOrder: 9,
    badgeColor: 'accent',
    bracketResolverRank: 800,
    surfaces: { nav: true, home: true, wiki: true },
  },
  {
    kind: 'map',
    label: { singular: 'Map', plural: 'Maps' },
    basePath: '/maps',
    homeCard: { title: 'Maps', blurb: 'Campaign maps with pinned entity references.' },
    navOrder: 10,
    badgeColor: 'success',
    bracketResolverRank: null,
    surfaces: { nav: false, home: true, wiki: true },
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
    surfaces: { nav: true, home: true, wiki: true },
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
    surfaces: { nav: true, home: true, wiki: true },
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
    surfaces: { nav: true, home: true, wiki: true },
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
    surfaces: { nav: true, home: true, wiki: true },
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
    surfaces: { nav: true, home: true, wiki: true },
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
    surfaces: { nav: true, home: true, wiki: true },
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
    surfaces: { nav: true, home: true, wiki: true },
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
    surfaces: { nav: true, home: true, wiki: true },
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

/** All kinds with surfaces.home === true, sorted by navOrder. */
export function homeKinds(): EntityKindEntry[] {
  return [...ENTITY_KINDS].filter((k) => k.surfaces.home).sort((a, b) => a.navOrder - b.navOrder)
}

/**
 * Kinds with no dm_only column: they aren't content-authorization tables and
 * aren't suggestable targets. session and map are bespoke kinds. (pc IS a
 * content kind — it has dm_only, so a PC can be hidden from the party.) Mirrors
 * the server's CONTENT_REPOS exclusion list (guarded by a parity test there).
 */
const NON_CONTENT_KINDS = new Set<RegistryKind>(['session', 'map'])

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

/** Home kinds grouped by tier, each group sorted by navOrder. */
export function homeKindsByTier(): Record<EntityTier, EntityKindEntry[]> {
  const groups: Record<EntityTier, EntityKindEntry[]> = {
    primary: [],
    secondary: [],
    tertiary: [],
  }
  for (const entry of homeKinds()) {
    groups[tierOf(entry.kind)].push(entry)
  }
  return groups
}

/**
 * Nav kinds grouped by tier, each group sorted by navOrder. The sidebar's
 * counterpart to homeKindsByTier (which is scoped to surfaces.home) — same tier
 * membership (tierOf), filtered to surfaces.nav so the rail and the home grid
 * never drift apart.
 */
export function navKindsByTier(): Record<EntityTier, EntityKindEntry[]> {
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
