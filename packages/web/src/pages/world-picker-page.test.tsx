import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { type ApiClient, ApiClientError, type WorldView } from '../api'
import { ApiProvider } from '../app/api-context'
import { makeApi } from '../testing/fake-api'
import { WorldPickerPage } from './world-picker-page'

function Landing(): React.JSX.Element {
  const { worldId } = useParams()
  return <p>at world {worldId}</p>
}

function mount(api: ApiClient): void {
  render(
    <ApiProvider value={api}>
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<WorldPickerPage />} />
          <Route path="/worlds/:worldId" element={<Landing />} />
        </Routes>
      </MemoryRouter>
    </ApiProvider>,
  )
}

const json = (name: string, body: unknown): File =>
  new File([JSON.stringify(body)], name, { type: 'application/json' })

describe('WorldPickerPage', () => {
  it('creates a world and opens it', async () => {
    const api = makeApi({
      createWorld: vi.fn(() =>
        Promise.resolve({
          id: 'w9',
          name: 'Chicago',
          slug: 'chicago',
          ownerId: 'a',
          role: 'owner',
        } as WorldView),
      ),
    })
    mount(api)
    await screen.findByRole('heading', { name: 'Your worlds' })
    fireEvent.change(screen.getByLabelText('World name'), { target: { value: 'Chicago' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(api.createWorld).toHaveBeenCalledWith('Chicago'))
    // routes by the readable slug, not the opaque id
    expect(await screen.findByText('at world chicago')).toBeTruthy()
  })

  it('shows a create error', async () => {
    const api = makeApi({
      createWorld: vi.fn(() => Promise.reject(new ApiClientError(400, 'x', 'bad name'))),
    })
    mount(api)
    fireEvent.click(await screen.findByRole('button', { name: 'Create' }))
    expect((await screen.findByRole('alert')).textContent).toBe('bad name')
  })

  it('imports a world from a JSON export', async () => {
    const api = makeApi({
      importWorld: vi.fn(() => Promise.resolve({ worldId: 'wimp', slug: 'imported', counts: {} })),
    })
    mount(api)
    const input = await screen.findByLabelText('World export file')
    fireEvent.change(input, {
      target: { files: [json('Chicago.json', { version: 1, tables: {} })] },
    })
    await waitFor(() =>
      expect(api.importWorld).toHaveBeenCalledWith('Chicago', { version: 1, tables: {} }),
    )
    expect(await screen.findByText('at world imported')).toBeTruthy()
  })

  it('rejects invalid JSON and surfaces a server import error', async () => {
    const api = makeApi({
      importWorld: vi.fn(() => Promise.reject(new ApiClientError(403, 'forbidden', 'denied'))),
    })
    mount(api)
    const input = await screen.findByLabelText('World export file')
    fireEvent.change(input, { target: { files: [new File(['not json'], 'x.json')] } })
    expect((await screen.findByRole('alert')).textContent).toBe('That file is not valid JSON.')
    fireEvent.change(input, { target: { files: [json('y.json', { version: 1, tables: {} })] } })
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('denied'))
  })

  it('ignores a file change with no file', async () => {
    const api = makeApi({})
    mount(api)
    const input = await screen.findByLabelText('World export file')
    fireEvent.change(input, { target: { files: [] } })
    expect(api.importWorld).not.toHaveBeenCalled()
  })
})
