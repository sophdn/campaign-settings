import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import type { ApiClient, MemberRole, TrashEntry } from '../api'
import { ApiProvider } from '../app/api-context'
import { WorldRoleProvider } from '../app/world-context'
import { makeApi } from '../testing/fake-api'
import { TrashPage } from './trash-page'

function mount(api: ApiClient, role: MemberRole = 'owner'): void {
  render(
    <ApiProvider value={api}>
      <WorldRoleProvider
        value={{ worldId: 'chicago', worldName: 'Chicago', role, refreshWorld: vi.fn() }}
      >
        <MemoryRouter initialEntries={['/worlds/chicago/trash']}>
          <Routes>
            <Route path="/worlds/:worldId/trash" element={<TrashPage />} />
          </Routes>
        </MemoryRouter>
      </WorldRoleProvider>
    </ApiProvider>,
  )
}

const HARBOURMASTER: TrashEntry = {
  kind: 'npc',
  id: 'npc-1',
  name: 'The Harbourmaster',
  deleted_at: '2026-08-08T10:00:00.000Z',
}
const HOLLOW_MAN: TrashEntry = {
  kind: 'npc',
  id: 'npc-2',
  name: 'The Hollow Man',
  deleted_at: '2026-08-08T09:00:00.000Z',
}
const SALTMARSH: TrashEntry = {
  kind: 'settlement',
  id: 'set-1',
  name: 'Saltmarsh',
  deleted_at: '2026-08-07T10:00:00.000Z',
}

describe('TrashPage', () => {
  it('groups deleted rows by kind and restores one', async () => {
    const restoreTrashed = vi.fn(() => Promise.resolve())
    const listTrash = vi
      .fn<() => Promise<TrashEntry[]>>()
      .mockResolvedValueOnce([HARBOURMASTER, HOLLOW_MAN, SALTMARSH])
      .mockResolvedValue([HOLLOW_MAN, SALTMARSH])
    mount(makeApi({ listTrash, restoreTrashed }))

    expect(await screen.findByText('The Harbourmaster')).toBeTruthy()
    // Grouped: each kind gets its own labelled region, named by the registry,
    // and two rows of the same kind land in the same one.
    const npcs = screen.getByRole('region', { name: 'Deleted NPC' })
    expect(npcs.querySelectorAll('li')).toHaveLength(2)
    expect(screen.getByRole('region', { name: 'Deleted Settlement' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Restore The Harbourmaster' }))
    await waitFor(() => expect(restoreTrashed).toHaveBeenCalledWith('chicago', 'npc', 'npc-1'))
    // The list is re-read, so the restored row leaves the trash on screen too.
    await waitFor(() => expect(screen.queryByText('The Harbourmaster')).toBeNull())
    expect(screen.getByText('Saltmarsh')).toBeTruthy()
  })

  it('will not permanently delete on one click — the confirmation names the entity', async () => {
    const purgeTrashed = vi.fn(() => Promise.resolve())
    mount(makeApi({ listTrash: () => Promise.resolve([HARBOURMASTER]), purgeTrashed }))

    fireEvent.click(
      await screen.findByRole('button', { name: 'Delete The Harbourmaster permanently' }),
    )
    expect(purgeTrashed).not.toHaveBeenCalled()

    // The warning is an alert and says the entity's name, so it cannot be read
    // as being about some other row in the list.
    expect(screen.getByRole('alert').textContent).toContain('Delete The Harbourmaster permanently?')

    fireEvent.click(
      screen.getByRole('button', { name: 'Yes, delete The Harbourmaster permanently' }),
    )
    await waitFor(() => expect(purgeTrashed).toHaveBeenCalledWith('chicago', 'npc', 'npc-1'))
  })

  it('backing out of a permanent delete leaves the row alone', async () => {
    const purgeTrashed = vi.fn(() => Promise.resolve())
    mount(makeApi({ listTrash: () => Promise.resolve([HARBOURMASTER]), purgeTrashed }))

    fireEvent.click(
      await screen.findByRole('button', { name: 'Delete The Harbourmaster permanently' }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Keep The Harbourmaster' }))

    expect(purgeTrashed).not.toHaveBeenCalled()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByText('The Harbourmaster')).toBeTruthy()
  })

  it('says so when the trash is empty', async () => {
    mount(makeApi({ listTrash: () => Promise.resolve([]) }))
    expect(await screen.findByText('Nothing has been deleted.')).toBeTruthy()
  })

  it('renders a kind the registry has never heard of as its raw name', async () => {
    // The trash is the one list that can outlive a taxonomy change: a row
    // deleted under a kind that a later migration removed still has to be
    // restorable, and a blank label would leave the owner unable to tell what
    // they were looking at.
    const ancient: TrashEntry = { ...HARBOURMASTER, kind: 'homunculus' }
    mount(makeApi({ listTrash: () => Promise.resolve([ancient]) }))

    expect(await screen.findByRole('region', { name: 'Deleted homunculus' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Restore The Harbourmaster' })).toBeTruthy()
  })

  it('reports a failed load rather than looking like an empty trash', async () => {
    // The distinction matters here more than on most pages: "nothing has been
    // deleted" and "we could not find out" are the same blank screen, and one
    // of them is a lie about where someone's work went.
    mount(makeApi({ listTrash: () => Promise.reject('offline') }))
    expect(await screen.findByText('Could not load the trash')).toBeTruthy()
    expect(screen.queryByText('Nothing has been deleted.')).toBeNull()
  })

  it('surfaces a failed restore instead of pretending it worked', async () => {
    // The server's own words when it has some (`errorMessage` prefers them)…
    const restoreTrashed = vi.fn(() => Promise.reject(new Error('that is not in the trash')))
    mount(makeApi({ listTrash: () => Promise.resolve([HARBOURMASTER]), restoreTrashed }))

    fireEvent.click(await screen.findByRole('button', { name: 'Restore The Harbourmaster' }))
    expect(await screen.findByText('that is not in the trash')).toBeTruthy()
    // …and the row is still listed, because nothing was restored.
    expect(screen.getByText('The Harbourmaster')).toBeTruthy()
  })

  it('falls back to its own wording when the failure carries none', async () => {
    const purgeTrashed = vi.fn(() => Promise.reject('offline'))
    mount(makeApi({ listTrash: () => Promise.resolve([HARBOURMASTER]), purgeTrashed }))

    fireEvent.click(
      await screen.findByRole('button', { name: 'Delete The Harbourmaster permanently' }),
    )
    fireEvent.click(
      screen.getByRole('button', { name: 'Yes, delete The Harbourmaster permanently' }),
    )
    expect(await screen.findByText('Could not delete that permanently')).toBeTruthy()
  })

  it('tells a player there is nothing here for them, and does not ask the server', async () => {
    const listTrash = vi.fn(() => Promise.resolve([]))
    mount(makeApi({ listTrash }), 'player')

    expect(
      screen.getByText('Only the GM can see what has been deleted from this world.'),
    ).toBeTruthy()
    // Asking as a player would only draw a 403 — the same reasoning the members
    // page uses for the invitation list.
    expect(listTrash).not.toHaveBeenCalled()
  })
})
