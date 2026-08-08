import { useEffect, useState } from 'react'

export interface Resource<T> {
  data: T | null
  loading: boolean
  error: string | null
  /** Re-run the fetch. */
  reload: () => void
}

/**
 * Load an async resource and track loading/error. `fetcher` must be stable
 * (wrap it in useCallback keyed on its inputs). React 19 discards state updates
 * from a fetch that resolves after unmount, so no manual race guard is needed.
 */
export function useResource<T>(fetcher: () => Promise<T>): Resource<T> {
  const [state, setState] = useState<{ data: T | null; loading: boolean; error: string | null }>({
    data: null,
    loading: true,
    error: null,
  })
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    setState({ data: null, loading: true, error: null })
    void fetcher().then(
      (data) => setState({ data, loading: false, error: null }),
      (e) =>
        setState({
          data: null,
          loading: false,
          error: e instanceof Error ? e.message : 'Request failed',
        }),
    )
  }, [fetcher, nonce])

  return { ...state, reload: () => setNonce((n) => n + 1) }
}
