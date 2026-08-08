import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import type { WorldView } from '../api'
import { makeApi } from '../testing/fake-api'
import { ApiProvider } from './api-context'
import { AppLayout } from './app-layout'
import { AuthProvider } from './auth-context'
import { WorldLayout } from './world-layout'
import { useWorld } from './world-context'

/** The seeded world view, with whichever field the test is about overridden. */
const world = (over: Partial<WorldView> = {}): WorldView => ({
  id: 'w',
  name: 'W',
  slug: 'w1',
  ownerId: 'a',
  role: 'owner',
  ...over,
})

function renderLayout(api = makeApi({})): void {
  render(
    <ApiProvider value={api}>
      <MemoryRouter initialEntries={['/worlds/w1']}>
        <Routes>
          <Route path="/worlds/:worldId" element={<WorldLayout />}>
            <Route index element={<p>home</p>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </ApiProvider>,
  )
}

describe('WorldLayout', () => {
  it('shows an error when the world cannot be resolved', async () => {
    renderLayout(makeApi({ getWorld: vi.fn(() => Promise.reject(new Error('not a member'))) }))
    expect((await screen.findByRole('alert')).textContent).toBe('not a member')
  })

  it('shows a not-found message when the world resolves empty', async () => {
    renderLayout(makeApi({ getWorld: vi.fn(() => Promise.resolve(undefined as never)) }))
    expect((await screen.findByRole('alert')).textContent).toBe('World not found')
  })

  it('groups the entity rail into collapsible tiers and drops the retired surfaces', async () => {
    renderLayout()
    // tier section headers
    expect(await screen.findByText('Primary')).toBeTruthy()
    expect(screen.getByText('Secondary')).toBeTruthy()
    expect(screen.getByText('Tertiary')).toBeTruthy()
    // a representative kind from each tier is linked
    expect(screen.getByRole('link', { name: 'NPCs' }).getAttribute('href')).toBe('/worlds/w1/npc')
    expect(screen.getByRole('link', { name: 'Deities' }).getAttribute('href')).toBe(
      '/worlds/w1/deity',
    )
    // the durable surfaces remain
    expect(screen.getByRole('link', { name: 'Wiki' })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Notes' })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Suggestions' })).toBeTruthy()
    // retired surfaces are gone
    expect(screen.queryByRole('link', { name: 'Graph' })).toBeNull()
    expect(screen.queryByRole('link', { name: 'Characters' })).toBeNull()
    expect(screen.queryByRole('link', { name: 'Overview' })).toBeNull()
  })

  it('names the world in the rail, so which one you are in is not left to the URL', async () => {
    renderLayout(
      makeApi({
        getWorld: vi.fn(() => Promise.resolve(world({ name: 'VTM Detroit' }))),
      }),
    )
    expect(await screen.findByText('VTM Detroit')).toBeTruthy()
  })

  it('offers Settings to the owner and not to a player', async () => {
    renderLayout()
    expect((await screen.findByRole('link', { name: 'Settings' })).getAttribute('href')).toBe(
      '/worlds/w1/settings',
    )

    cleanup()
    renderLayout(
      makeApi({
        getWorld: vi.fn(() => Promise.resolve(world({ role: 'player' }))),
      }),
    )
    // Presentation only — the endpoint refuses them whatever the rail shows.
    expect(await screen.findByRole('link', { name: 'Wiki' })).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'Settings' })).toBeNull()
  })
})

describe('AppLayout', () => {
  it('omits the account chrome when signed out', async () => {
    const api = makeApi({ me: vi.fn(() => Promise.reject(new Error('anon'))) })
    render(
      <ApiProvider value={api}>
        <AuthProvider>
          <MemoryRouter>
            <Routes>
              <Route path="/" element={<AppLayout />} />
            </Routes>
          </MemoryRouter>
        </AuthProvider>
      </ApiProvider>,
    )
    expect(screen.getByText('CampaignSettings')).toBeTruthy()
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Log out' })).toBeNull())
  })
})

describe('useWorld', () => {
  it('throws outside a world route', () => {
    function Bad(): null {
      useWorld()
      return null
    }
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => render(<Bad />)).toThrow(/world route/)
    vi.restoreAllMocks()
  })
})
