import {
  BRACKET_RESOLVER_ORDER,
  buildNameIndex,
  type NameIndex,
  parseBrackets,
  resolveBracket,
} from '@campaign-settings/shared'
import { Link } from 'react-router-dom'
import type { WikiEntry } from '../api'

type Chunk = { kind: 'text'; value: string } | { kind: 'bracket'; name: string }

/** Split a body into ordered text spans and `[[name]]` markers (gaps kept). */
export function splitDescription(text: string): Chunk[] {
  const out: Chunk[] = []
  let cursor = 0
  for (const m of parseBrackets(text)) {
    if (m.start > cursor) out.push({ kind: 'text', value: text.slice(cursor, m.start) })
    out.push({ kind: 'bracket', name: m.name })
    cursor = m.end
  }
  if (cursor < text.length) out.push({ kind: 'text', value: text.slice(cursor) })
  return out
}

const RANKED: ReadonlySet<string> = new Set(BRACKET_RESOLVER_ORDER)

/**
 * A `name → {kind, id}` index from the world's wiki entries, ordered by the
 * shared resolver precedence so `[[name]]` collisions resolve the same way the
 * server's graph does (ranked kinds first, any others after).
 */
/**
 * The world's entries in resolver-precedence order: ranked kinds first in
 * {@link BRACKET_RESOLVER_ORDER}, then any unranked kind. Both the resolution
 * index and the authoring picker derive from this ONE ordering, so what the
 * picker offers and what a `[[name]]` resolves to cannot drift apart.
 */
function orderedByPrecedence(
  entries: ReadonlyArray<WikiEntry>,
): { kind: string; rows: WikiEntry[] }[] {
  const byKind = new Map<string, WikiEntry[]>()
  for (const e of entries) {
    const rows = byKind.get(e.kind) ?? []
    rows.push(e)
    byKind.set(e.kind, rows)
  }
  const ranked = BRACKET_RESOLVER_ORDER.filter((k) => byKind.has(k)).map((k) => ({
    kind: k as string,
    rows: byKind.get(k)!,
  }))
  const rest = [...byKind.entries()]
    .filter(([k]) => !RANKED.has(k))
    .map(([kind, rows]) => ({ kind, rows }))
  return [...ranked, ...rest]
}

export function buildWikiNameIndex(entries: ReadonlyArray<WikiEntry>): NameIndex {
  return buildNameIndex(
    orderedByPrecedence(entries).map(({ kind, rows }) => ({
      kind,
      rows: rows.map((r) => ({ id: r.id, name: r.name })),
    })),
  )
}

/**
 * The entries an author can actually address with `[[name]]`, in the order the
 * picker should offer them.
 *
 * Deduplicated by lower-cased name, because `[[name]]` addresses by NAME and
 * nothing else — there is no `[[kind:name]]` syntax. When two entities share a
 * name only the precedence winner is reachable, so offering the shadowed one
 * would be a lie: selecting it would insert text that resolves to the other
 * entity. One row per resolvable name, labelled with the kind it resolves to,
 * is the honest list. An author who wanted the shadowed entity learns that its
 * name is taken, which is the real problem and needs a rename, not a picker.
 */
export function buildWikiCandidates(entries: ReadonlyArray<WikiEntry>): WikiEntry[] {
  const seen = new Set<string>()
  const out: WikiEntry[] = []
  for (const { rows } of orderedByPrecedence(entries)) {
    for (const row of rows) {
      const lower = row.name.toLowerCase()
      if (!row.name.trim() || seen.has(lower)) continue
      seen.add(lower)
      out.push(row)
    }
  }
  return out
}

/**
 * Render an entity body, turning `[[name]]` cross-references into links to the
 * resolved entity (via {@link NameIndex}). Unresolved markers render as a muted
 * "broken link" so the author can see what failed to resolve. Pure — the caller
 * supplies the index (built once per view from the world's entities).
 */
export function EntityDescription({
  text,
  worldId,
  nameIndex,
}: {
  text: string
  worldId: string
  nameIndex: NameIndex
}): React.JSX.Element {
  return (
    <p className="entity-description">
      {splitDescription(text).map((chunk, i) => {
        if (chunk.kind === 'text') return <span key={i}>{chunk.value}</span>
        const ref = resolveBracket(chunk.name, nameIndex)
        if (ref) {
          return (
            <Link key={i} className="entity-link" to={`/worlds/${worldId}/${ref.kind}/${ref.id}`}>
              {chunk.name}
            </Link>
          )
        }
        return (
          <span key={i} className="broken-link" title="Unresolved reference">
            {chunk.name}
          </span>
        )
      })}
    </p>
  )
}
