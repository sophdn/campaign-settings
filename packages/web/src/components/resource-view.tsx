import type { ReactNode } from 'react'
import type { Resource } from '../app/use-resource'
import { Loading } from './status'

/**
 * The shared loading → error → empty → content switch over a {@link Resource}.
 * Replaces the hand-rolled `loading ? … : error ? … : empty ? … : content`
 * ternary chain that recurred on nearly every page. `children` is a render
 * function handed the non-null data. `empty`/`emptyLabel` are optional — omit
 * them for resources with no empty state (e.g. a single record).
 */
export function ResourceView<T>({
  resource,
  empty,
  emptyLabel,
  children,
}: {
  resource: Resource<T>
  empty?: (data: T) => boolean
  emptyLabel?: ReactNode
  children: (data: T) => ReactNode
}): React.JSX.Element {
  const { data, loading, error } = resource
  if (loading) return <Loading />
  if (error !== null) return <p role="alert">{error}</p>
  if (data === null) return <Loading />
  if (empty !== undefined && emptyLabel !== undefined && empty(data)) {
    return <>{emptyLabel}</>
  }
  return <>{children(data)}</>
}
