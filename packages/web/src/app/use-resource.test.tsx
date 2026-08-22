import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useResource } from './use-resource'

function Probe({ fetcher }: { fetcher: () => Promise<string> }): React.JSX.Element {
  const { data, loading, error, reload } = useResource(fetcher)
  const text = loading ? 'loading' : error ? `error:${error}` : `data:${data}`
  return (
    <div>
      <span>state:{text}</span>
      <button type="button" onClick={reload}>
        reload
      </button>
    </div>
  )
}

describe('useResource', () => {
  it('starts loading then exposes the data', async () => {
    render(<Probe fetcher={() => Promise.resolve('hi')} />)
    expect(screen.getByText('state:loading')).toBeTruthy()
    await waitFor(() => expect(screen.getByText('state:data:hi')).toBeTruthy())
  })

  it('surfaces Error messages, with a generic fallback for non-Errors', async () => {
    const { unmount } = render(<Probe fetcher={() => Promise.reject(new Error('boom'))} />)
    await waitFor(() => expect(screen.getByText('state:error:boom')).toBeTruthy())
    unmount()
    render(<Probe fetcher={() => Promise.reject('nope')} />)
    await waitFor(() => expect(screen.getByText('state:error:Request failed')).toBeTruthy())
  })

  it('re-runs the fetch on reload', async () => {
    let n = 0
    render(<Probe fetcher={() => Promise.resolve(`v${n++}`)} />)
    await waitFor(() => expect(screen.getByText('state:data:v0')).toBeTruthy())
    fireEvent.click(screen.getByText('reload'))
    await waitFor(() => expect(screen.getByText('state:data:v1')).toBeTruthy())
  })
})
