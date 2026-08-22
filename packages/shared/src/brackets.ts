/**
 * `[[name]]` wikilink parsing + name resolution — the pure subset of
 * dm-manager's bracket-resolver (the SQL-backed reverse lookup lives in the
 * server). Parse / build-index / resolve are ported byte-for-byte so the
 * existing fixture corpus still passes.
 */

/**
 * Entity kinds for bracket-name precedence on collisions; lower index = higher
 * precedence. Map and the currency-attachment kinds are not bracket-resolvable.
 */
export const BRACKET_RESOLVER_ORDER = [
  'npc',
  'pc',
  'settlement',
  'item',
  'organization',
  'location',
  'event',
  'lore_article',
  'currency',
  'language',
  'species',
  'culture',
  'magic_system',
  'resource',
  'pantheon',
  'deity',
] as const

/** A kind that is bracket-resolvable. */
export type BracketableKind = (typeof BRACKET_RESOLVER_ORDER)[number]

export interface EntityRef {
  /** snake_case entity-kind value. */
  kind: string
  id: string
}

/** Lower-cased name → resolved ref. Built once per render by callers. */
export type NameIndex = Map<string, EntityRef>

/**
 * A `[[name]]` marker located within text. `start` is the index of the opening
 * `[[`; `end` is just past the closing `]]`, so `text.slice(start, end)` is the
 * full marker.
 */
export interface BracketMarker {
  name: string
  start: number
  end: number
}

export interface NameIndexInput {
  /** The entity kind for these rows. */
  kind: string
  /** The entity rows. Soft-delete filtering is the caller's job. */
  rows: ReadonlyArray<{ id: string; name: string }>
}

/**
 * Parse `[[name]]` markers out of text, returning each marker's normalised name
 * + character span. Whitespace inside brackets is collapsed; empty/unclosed
 * brackets are skipped. Duplicate occurrences are preserved.
 */
export function parseBrackets(text: string): BracketMarker[] {
  const out: BracketMarker[] = []
  let i = 0
  while (i + 3 < text.length) {
    if (text[i] === '[' && text[i + 1] === '[') {
      const close = text.indexOf(']]', i + 2)
      if (close === -1) break
      const name = text
        .slice(i + 2, close)
        .split(/\s+/)
        .filter((s) => s.length > 0)
        .join(' ')
      if (name.length > 0) {
        out.push({ name, start: i, end: close + 2 })
      }
      i = close + 2
    } else {
      i++
    }
  }
  return out
}

/**
 * The `[[` marker the caret currently sits inside, if any. `start` is the index
 * of the opening `[[`; `end` is just past the region a completion should
 * replace, which is the caret while the marker is still open and the closing
 * `]]` when the caret is inside an already-closed one.
 */
export interface ActiveBracket {
  /** Raw text between `[[` and the caret — what to search on. */
  query: string
  start: number
  end: number
}

/**
 * Locate the `[[` marker the caret is inside, for authoring-time completion.
 *
 * Distinct from {@link parseBrackets}, which finds only CLOSED markers and
 * stops at the first unclosed one. The interesting case here is the opposite:
 * a marker the author is still typing, which by definition has no `]]` yet.
 *
 * Returns null when the caret is not inside a marker, including the two cases
 * that would otherwise produce a runaway match — a marker that already closed
 * before the caret, and a `[[` on an earlier line. The line-break guard is what
 * stops a stray `[[` at the top of a long body from making every subsequent
 * keystroke look like a query.
 *
 * An empty query (the caret immediately after `[[`) is a MATCH, not null: the
 * author who has just typed the brackets is exactly the one who most needs to
 * be shown what exists.
 */
export function activeBracketQuery(text: string, caret: number): ActiveBracket | null {
  if (caret < 2 || caret > text.length) return null

  const start = text.lastIndexOf('[[', caret - 2)
  if (start === -1) return null

  const inner = text.slice(start + 2, caret)
  // Closed before the caret, or spanning a line: the caret is not inside it.
  if (inner.includes(']]') || /[\r\n]/.test(inner)) return null

  // If this marker is already closed AFTER the caret, a completion replaces the
  // whole marker — otherwise selecting "Silas Crow" while the caret sits mid-way
  // through an existing `[[Silas Crow]]` would strand its tail as loose text.
  const close = text.indexOf(']]', caret)
  const nextOpen = text.indexOf('[[', caret)
  const closesThisMarker =
    close !== -1 &&
    (nextOpen === -1 || close < nextOpen) &&
    !/[\r\n]/.test(text.slice(caret, close))

  return { query: inner, start, end: closesThisMarker ? close + 2 : caret }
}

/**
 * Replace the marker `active` spans with a completed `[[name]]`, returning the
 * new text and where the caret belongs afterwards (just past the `]]`, so typing
 * continues after the link rather than inside it).
 */
export function completeBracket(
  text: string,
  active: ActiveBracket,
  name: string,
): { text: string; caret: number } {
  const before = text.slice(0, active.start)
  const marker = `[[${name}]]`
  return {
    text: before + marker + text.slice(active.end),
    caret: before.length + marker.length,
  }
}

/**
 * Build a case-insensitive `name → {kind, id}` index. Iterates input in
 * caller-provided order; the first occurrence of each lower-cased name wins, so
 * the caller controls precedence by ordering input.
 */
export function buildNameIndex(input: ReadonlyArray<NameIndexInput>): NameIndex {
  const idx: NameIndex = new Map()
  for (const { kind, rows } of input) {
    for (const row of rows) {
      const lower = row.name.toLowerCase()
      if (!idx.has(lower)) {
        idx.set(lower, { kind, id: row.id })
      }
    }
  }
  return idx
}

/**
 * Resolve a single bracket name against an index. Whitespace is collapsed
 * (matching parseBrackets) and the lookup is case-insensitive. Returns null for
 * empty / whitespace-only / unmatched names.
 */
export function resolveBracket(name: string, index: NameIndex): EntityRef | null {
  const normalised = name
    .split(/\s+/)
    .filter((s) => s.length > 0)
    .join(' ')
  if (normalised.length === 0) return null
  return index.get(normalised.toLowerCase()) ?? null
}
