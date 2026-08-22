import type { NameIndex } from '@campaign-settings/shared'
import { useCallback, useMemo } from 'react'
import type { WikiEntry } from '../api'
import { buildWikiCandidates, buildWikiNameIndex } from '../components/entity-description'
import { useApi } from './api-context'
import { useResource } from './use-resource'

/**
 * The world's wiki corpus, in the two shapes the app needs it:
 *
 *   nameIndex  — `name → {kind, id}`, for RESOLVING `[[name]]` when rendering.
 *   candidates — the addressable entities, for OFFERING `[[name]]` when authoring.
 *
 * Both come from ONE fetch and ONE precedence ordering. Two hooks would mean two
 * `listWiki` calls per page; two orderings would mean the picker could offer a
 * row whose name resolves to a different entity than the one displayed.
 *
 * The corpus is whatever `listWiki` returns, which the server has already
 * filtered to what the caller may see — so a player's picker cannot suggest a
 * name they are not entitled to know.
 */
export interface WikiIndex {
  nameIndex: NameIndex
  candidates: WikiEntry[]
}

export function useWikiIndex(worldId: string): WikiIndex {
  const api = useApi()
  const fetcher = useCallback(() => api.listWiki(worldId), [api, worldId])
  const { data } = useResource(fetcher)
  return useMemo(() => {
    const entries = data ?? []
    return { nameIndex: buildWikiNameIndex(entries), candidates: buildWikiCandidates(entries) }
  }, [data])
}

/** The resolution index alone, for surfaces that only render prose. */
export function useNameIndex(worldId: string): NameIndex {
  return useWikiIndex(worldId).nameIndex
}
