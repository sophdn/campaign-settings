import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '../api'
import { ApiProvider } from '../app/api-context'
import { makeApi } from '../testing/fake-api'
import { EntitySessions } from './entity-sessions'

function mount(api: ApiClient): ReturnType<typeof render> {
  return render(
    <ApiProvider value={api}>
      <MemoryRouter initialEntries={['/worlds/w1']}>
        <Routes>
          <Route path="/worlds/:worldId" element={<EntitySessions kind="npc" id="n1" />} />
        </Routes>
      </MemoryRouter>
    </ApiProvider>,
  )
}

describe('EntitySessions', () => {
  it('lists the sessions referencing the entity, with played-at and link type', async () => {
    const api = makeApi({
      listEntitySessions: vi.fn(() =>
        Promise.resolve([
          { id: 's1', name: 'Session 1', played_at: '2026-06-27', link: 'touch' as const },
          { id: 's2', name: 'Session 2', played_at: null, link: 'bracket' as const },
        ]),
      ),
    })
    mount(api)
    const link = await screen.findByRole('link', { name: 'Session 1' })
    expect(link.getAttribute('href')).toBe('/worlds/w1/session/s1')
    expect(screen.getByText(/2026-06-27/)).toBeTruthy()
    expect(screen.getByText('touch')).toBeTruthy()
    expect(screen.getByText('bracket')).toBeTruthy()
  })

  it('renders nothing when the entity has no session history', async () => {
    const api = makeApi({ listEntitySessions: vi.fn(() => Promise.resolve([])) })
    mount(api)
    await waitFor(() => expect(api.listEntitySessions).toHaveBeenCalled())
    expect(screen.queryByRole('heading', { name: 'Sessions' })).toBeNull()
  })
})
