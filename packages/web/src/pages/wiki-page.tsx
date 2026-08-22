import { fuzzySearch } from '@campaign-settings/shared'
import { useCallback, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import type { WikiEntry } from '../api'
import { useApi } from '../app/api-context'
import { useResource } from '../app/use-resource'
import { Badge } from '../components/badge'
import { CardLink } from '../components/card-link'
import { PageHeader } from '../components/page-header'
import { ResourceView } from '../components/resource-view'
import { SegmentedToggle } from '../components/segmented-toggle'
import { EmptyState } from '../components/status'
import { kindColor, kindLabel } from './kind-color'
import { WikiGraph } from './wiki-graph'

type ViewMode = 'list' | 'graph'
type SortKey = 'name' | 'kind'

/** Search + kind-filter + sort over the world's wiki entries. */
function WikiList({
  worldId,
  entries,
}: {
  worldId: string
  entries: WikiEntry[]
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState('')
  const [sort, setSort] = useState<SortKey>('name')

  const kinds = useMemo(() => Array.from(new Set(entries.map((e) => e.kind))).sort(), [entries])

  const results = useMemo(() => {
    const scoped = kind ? entries.filter((e) => e.kind === kind) : entries
    const matched = fuzzySearch(scoped, query, { text: (e) => e.name }).map((r) => r.item)
    return [...matched].sort((a, b) =>
      sort === 'kind'
        ? kindLabel(a.kind).localeCompare(kindLabel(b.kind)) || a.name.localeCompare(b.name)
        : a.name.localeCompare(b.name),
    )
  }, [entries, query, kind, sort])

  return (
    <>
      <div className="wiki-controls">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search…"
          aria-label="Search wiki"
        />
        <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Filter by kind">
          <option value="">All kinds</option>
          {kinds.map((k) => (
            <option key={k} value={k}>
              {kindLabel(k)}
            </option>
          ))}
        </select>
        <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} aria-label="Sort">
          <option value="name">Name</option>
          <option value="kind">Kind</option>
        </select>
      </div>
      {results.length === 0 ? (
        <EmptyState>No entities yet.</EmptyState>
      ) : (
        <ul className="card-grid">
          {results.map((e) => (
            <CardLink
              key={`${e.kind}:${e.id}`}
              to={`/worlds/${worldId}/${e.kind}/${e.id}`}
              title={e.name || e.id}
              meta={
                <Badge className="wiki-kind" color={kindColor(e.kind)}>
                  {kindLabel(e.kind)}
                </Badge>
              }
            />
          ))}
        </ul>
      )}
    </>
  )
}

/**
 * The world index: a searchable/filterable/sortable browse of every wiki-surface
 * entity (authorization-correct — the server's listWikiEntities already drops
 * dm_only rows for players), with a toggle into the interactive entity graph.
 * Replaces the old placeholder Overview landing screen.
 */
export function WikiPage(): React.JSX.Element {
  const api = useApi()
  const { worldId = '' } = useParams()
  const fetcher = useCallback(() => api.listWiki(worldId), [api, worldId])
  const entriesRes = useResource(fetcher)
  const [view, setView] = useState<ViewMode>('list')

  return (
    <section className="wiki">
      <PageHeader
        title="Wiki"
        actions={
          <SegmentedToggle
            label="View mode"
            value={view}
            onChange={setView}
            options={[
              { value: 'list', label: 'List' },
              { value: 'graph', label: 'Graph' },
            ]}
          />
        }
      />
      {view === 'graph' ? (
        <WikiGraph />
      ) : (
        <ResourceView resource={entriesRes}>
          {(entries) => <WikiList worldId={worldId} entries={entries} />}
        </ResourceView>
      )}
    </section>
  )
}
