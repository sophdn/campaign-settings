import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import type { WorldView } from '../api'
import { makeApi } from '../testing/fake-api'
import { ApiProvider } from './api-context'
import { AppLayout } from './app-layout'
import { AuthProvider } from './auth-context'
import { WorldLayout } from './world-layout'
import { useIsOwner, useWorld, WorldRoleProvider } from './world-context'

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
            {/* Somewhere for the drawer's links to go, so the close-on-navigate
                behaviour has a route to actually reach. */}
            <Route path="notes" element={<p>notes</p>} />
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
    // Maps folded out of its own hardcoded rail link into the Primary tier,
    // and routes to the bespoke /maps index rather than the :kind catch-all.
    expect(screen.getByRole('link', { name: 'Maps' }).getAttribute('href')).toBe('/worlds/w1/maps')
    // the durable surfaces remain
    expect(screen.getByRole('link', { name: 'Dashboard' }).getAttribute('href')).toBe('/worlds/w1')
    expect(screen.getByRole('link', { name: 'Wiki' }).getAttribute('href')).toBe('/worlds/w1/wiki')
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

describe('the nav drawer', () => {
  /** The rail as rendered inside the drawer, not the one in the grid column. */
  const drawerNav = (): HTMLElement | null =>
    screen.getByRole('dialog').querySelector('.world-nav-drawer')

  it('offers a named, collapsed hamburger at every width', async () => {
    renderLayout()
    // Rendered always and hidden ABOVE the breakpoint by CSS, not mounted on a
    // measured width — a JS breakpoint would disagree with the stylesheet's the
    // moment one of them changed.
    const toggle = await screen.findByRole('button', { name: 'World sections' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('opens the rail as a dialog, and reports its own expanded state', async () => {
    renderLayout()
    fireEvent.click(await screen.findByRole('button', { name: 'World sections' }))

    const dialog = screen.getByRole('dialog')
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(dialog.getAttribute('aria-label')).toBe('World sections')
    expect(
      screen.getByRole('button', { name: 'World sections' }).getAttribute('aria-expanded'),
    ).toBe('true')
    // The SAME list, not a second copy: a link reachable on a desktop and
    // missing on a phone is what two copies produce.
    expect(within(drawerNav() as HTMLElement).getByRole('link', { name: 'Wiki' })).toBeTruthy()
    expect(within(drawerNav() as HTMLElement).getByRole('link', { name: 'Members' })).toBeTruthy()
  })

  it('closes on Escape, which is the shared modal’s doing rather than its own', async () => {
    renderLayout()
    fireEvent.click(await screen.findByRole('button', { name: 'World sections' }))
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('closes on navigation, so it does not cover the page it just opened', async () => {
    renderLayout()
    fireEvent.click(await screen.findByRole('button', { name: 'World sections' }))
    // Keyed on the PATH, so a link inside the collapsible tiers closes it too
    // without needing a handler of its own.
    fireEvent.click(within(drawerNav() as HTMLElement).getByRole('link', { name: 'Notes' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })
})

describe('useIsOwner', () => {
  // Both role states of THE owner-affordance predicate, pinned where the rule
  // is stated (world-context.tsx). Every owner-only branch in the app derives
  // from this one value, so these two assertions are the role-state coverage
  // for all of them.
  function Probe(): React.JSX.Element {
    return <p>{useIsOwner() ? 'owner-affordances' : 'player-view'}</p>
  }

  it('is true for the world owner and false for a player', () => {
    const value = (role: 'owner' | 'player') => ({
      worldId: 'w',
      worldName: 'W',
      role,
      refreshWorld: vi.fn(),
    })
    render(
      <WorldRoleProvider value={value('owner')}>
        <Probe />
      </WorldRoleProvider>,
    )
    expect(screen.getByText('owner-affordances')).toBeTruthy()

    cleanup()
    render(
      <WorldRoleProvider value={value('player')}>
        <Probe />
      </WorldRoleProvider>,
    )
    expect(screen.getByText('player-view')).toBeTruthy()
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
