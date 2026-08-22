import { ConfigProvider } from '../app/config-context'
import { ModalProvider } from '../app/modal/modal-context'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import {
  type ApiClient,
  ApiClientError,
  type MemberRole,
  type PlayerNote,
  type Suggestion,
} from '../api'
import { ApiProvider } from '../app/api-context'
import { WorldRoleProvider } from '../app/world-context'
import { makeApi } from '../testing/fake-api'
import { NotesPage } from './notes-page'
import { SuggestionsPage } from './suggestions-page'

function mount(
  api: ApiClient,
  element: React.JSX.Element,
  role: MemberRole = 'player',
): { unmount: () => void } {
  return render(
    <ApiProvider value={api}>
      <ConfigProvider>
        <ModalProvider>
          <WorldRoleProvider value={{ worldId: 'w1', worldName: 'W', role, refreshWorld: vi.fn() }}>
            <MemoryRouter>{element}</MemoryRouter>
          </WorldRoleProvider>
        </ModalProvider>
      </ConfigProvider>
    </ApiProvider>,
  )
}

const note = (over: Partial<PlayerNote>): PlayerNote => ({
  id: 'n1',
  world_id: 'w1',
  author_id: 'p1',
  body: 'mine',
  created_at: '',
  updated_at: '',
  ...over,
})

describe('NotesPage', () => {
  it('lists, creates, and deletes notes', async () => {
    const api = makeApi({ listNotes: vi.fn(() => Promise.resolve([note({})])) })
    mount(api, <NotesPage />)
    expect(await screen.findByText('mine')).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Note'), { target: { value: 'new note' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }))
    await waitFor(() => expect(api.createNote).toHaveBeenCalledWith('w1', 'new note'))

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(api.deleteNote).toHaveBeenCalledWith('w1', 'n1'))
  })

  it('renders [[name]] references in a note body as links', async () => {
    const api = makeApi({
      listNotes: vi.fn(() => Promise.resolve([note({ body: 'Talk to [[Connie]].' })])),
      listWiki: vi.fn(() => Promise.resolve([{ kind: 'npc', id: 'e2', name: 'Connie' }])),
    })
    mount(api, <NotesPage />)
    const link = await screen.findByRole('link', { name: 'Connie' })
    expect(link.getAttribute('href')).toBe('/worlds/w1/npc/e2')
  })

  it('surfaces load and action errors', async () => {
    const a = makeApi({ listNotes: vi.fn(() => Promise.reject(new Error('load boom'))) })
    const first = mount(a, <NotesPage />)
    expect((await screen.findByRole('alert')).textContent).toBe('load boom')
    first.unmount()

    const b = makeApi({
      createNote: vi.fn(() => Promise.reject(new ApiClientError(403, 'x', 'denied'))),
    })
    mount(b, <NotesPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Add note' }))
    expect((await screen.findByRole('alert')).textContent).toBe('denied')
  })

  it('shows a delete error', async () => {
    const api = makeApi({
      listNotes: vi.fn(() => Promise.resolve([note({})])),
      deleteNote: vi.fn(() => Promise.reject(new Error('cannot delete'))),
    })
    mount(api, <NotesPage />)
    await screen.findByText('mine')
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect((await screen.findByRole('alert')).textContent).toBe('cannot delete')
  })
})

describe('SuggestionsPage', () => {
  const suggestion = (over: Partial<Suggestion>): Suggestion => ({
    id: 's1',
    world_id: 'w1',
    author_id: 'p1',
    target_entity_kind: 'npc',
    target_entity_id: 'e1',
    proposed: {},
    status: 'pending',
    created_at: '',
    ...over,
  })

  it('shows the DM the target type, name, and body with accept/reject', async () => {
    const api = makeApi({
      listSuggestions: vi.fn(() =>
        Promise.resolve([
          suggestion({ target_entity_kind: 'npc', proposed: { description: 'fix the bio' } }),
        ]),
      ),
      getEntity: vi.fn(() => Promise.resolve({ id: 'e1', name: 'Tunnel-Rat' })),
    })
    mount(api, <SuggestionsPage />, 'owner')
    expect(await screen.findByText('NPC')).toBeTruthy()
    expect(await screen.findByText('Tunnel-Rat')).toBeTruthy()
    expect(await screen.findByText('fix the bio')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Propose' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }))
    await waitFor(() => expect(api.acceptSuggestion).toHaveBeenCalledWith('w1', 's1'))
    // the reload (and per-row name refetch) remounts the row; await its return
    fireEvent.click(await screen.findByRole('button', { name: 'Reject' }))
    await waitFor(() => expect(api.rejectSuggestion).toHaveBeenCalledWith('w1', 's1'))
  })

  it('falls back to the target id when the entity has no name', async () => {
    const api = makeApi({
      listSuggestions: vi.fn(() =>
        Promise.resolve([suggestion({ target_entity_id: 'e9', proposed: { description: 'x' } })]),
      ),
      getEntity: vi.fn(() => Promise.resolve({ id: 'e9' })),
    })
    mount(api, <SuggestionsPage />, 'owner')
    expect(await screen.findByText('e9')).toBeTruthy()
  })

  it('surfaces list and accept errors', async () => {
    const a = makeApi({ listSuggestions: vi.fn(() => Promise.reject(new Error('sload'))) })
    const first = mount(a, <SuggestionsPage />, 'owner')
    expect((await screen.findByRole('alert')).textContent).toBe('sload')
    first.unmount()

    const b = makeApi({
      listSuggestions: vi.fn(() => Promise.resolve([suggestion({})])),
      acceptSuggestion: vi.fn(() => Promise.reject(new Error('saccept'))),
    })
    mount(b, <SuggestionsPage />, 'owner')
    fireEvent.click(await screen.findByRole('button', { name: 'Accept' }))
    expect((await screen.findByRole('alert')).textContent).toBe('saccept')
  })

  it('renders a missing target without crashing and gives a player no review actions', async () => {
    const api = makeApi({
      listSuggestions: vi.fn(() =>
        Promise.resolve([
          suggestion({ target_entity_kind: null, target_entity_id: null, proposed: {} }),
        ]),
      ),
    })
    mount(api, <SuggestionsPage />, 'player')
    // body falls back to the raw proposed json; no name/kind to resolve
    expect(await screen.findByText('{}')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull()
  })

  it('shows an empty state when there are no suggestions', async () => {
    const api = makeApi({ listSuggestions: vi.fn(() => Promise.resolve([])) })
    mount(api, <SuggestionsPage />, 'owner')
    expect(await screen.findByText('No suggestions yet.')).toBeTruthy()
  })

  it('renders [[name]] references in a suggestion body as links', async () => {
    const api = makeApi({
      listSuggestions: vi.fn(() =>
        Promise.resolve([suggestion({ proposed: { description: 'See [[Connie]] about it.' } })]),
      ),
      listWiki: vi.fn(() => Promise.resolve([{ kind: 'npc', id: 'e2', name: 'Connie' }])),
    })
    mount(api, <SuggestionsPage />, 'owner')
    const link = await screen.findByRole('link', { name: 'Connie' })
    expect(link.getAttribute('href')).toBe('/worlds/w1/npc/e2')
  })

  it('is a review surface only — the authoring form moved to the entity page', async () => {
    const api = makeApi({ listSuggestions: vi.fn(() => Promise.resolve([])) })
    mount(api, <SuggestionsPage />, 'player')
    expect(await screen.findByRole('heading', { name: 'My Suggestions' })).toBeTruthy()
    // Suggesting now happens where the player is reading (ProposePassagePanel).
    // The queue itself stays so nothing already in it is stranded.
    expect(screen.queryByRole('heading', { name: 'New Suggestion' })).toBeNull()
    expect(screen.queryByLabelText('Proposed description')).toBeNull()
  })

  it('toggles the list between all, pending, and processed', async () => {
    const api = makeApi({
      listSuggestions: vi.fn(() =>
        Promise.resolve([
          suggestion({ id: 'p1', status: 'pending', proposed: { description: 'pending one' } }),
          suggestion({ id: 'a1', status: 'accepted', proposed: { description: 'accepted one' } }),
          suggestion({ id: 'r1', status: 'rejected', proposed: { description: 'rejected one' } }),
        ]),
      ),
    })
    mount(api, <SuggestionsPage />, 'owner')
    // default: all three visible
    expect(await screen.findByText('pending one')).toBeTruthy()
    expect(screen.getByText('accepted one')).toBeTruthy()
    expect(screen.getByText('rejected one')).toBeTruthy()

    // pending: only the pending row
    fireEvent.click(screen.getByRole('button', { name: 'Pending' }))
    expect(screen.getByText('pending one')).toBeTruthy()
    expect(screen.queryByText('accepted one')).toBeNull()
    expect(screen.queryByText('rejected one')).toBeNull()

    // processed: the two terminal rows, not the pending one
    fireEvent.click(screen.getByRole('button', { name: 'Processed' }))
    expect(screen.queryByText('pending one')).toBeNull()
    expect(screen.getByText('accepted one')).toBeTruthy()
    expect(screen.getByText('rejected one')).toBeTruthy()
  })

  it('shows a filter-scoped empty state when a filter hides every row', async () => {
    const api = makeApi({
      listSuggestions: vi.fn(() =>
        Promise.resolve([suggestion({ status: 'pending', proposed: { description: 'p' } })]),
      ),
    })
    mount(api, <SuggestionsPage />, 'owner')
    fireEvent.click(await screen.findByRole('button', { name: 'Processed' }))
    expect(screen.getByText('No processed suggestions.')).toBeTruthy()
  })
})
