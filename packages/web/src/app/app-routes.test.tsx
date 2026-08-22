import { ModalProvider } from './modal/modal-context'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { type ApiClient, ApiClientError, type PublicAccount, type WorldView } from '../api'
import { makeApi } from '../testing/fake-api'
import { ApiProvider } from './api-context'
import { AppRoutes } from './app-routes'
import { AuthProvider, useAuth } from './auth-context'
import { ConfigProvider } from './config-context'

const DM: PublicAccount = { id: 'a', username: 'dm' }

/** Mirrors App.tsx's provider nesting — the login page now reads the flags. */
function renderApp(api: ApiClient, path: string): void {
  render(
    <ApiProvider value={api}>
      <ConfigProvider>
        <ModalProvider>
          <AuthProvider>
            <MemoryRouter initialEntries={[path]}>
              <AppRoutes />
            </MemoryRouter>
          </AuthProvider>
        </ModalProvider>
      </ConfigProvider>
    </ApiProvider>,
  )
}

const fill = (label: string, value: string): void => {
  fireEvent.change(screen.getByLabelText(label), { target: { value } })
}

describe('app shell + routing', () => {
  it('lands a signed-out visitor on the public landing page (and the catch-all routes there too)', async () => {
    renderApp(makeApi({}), '/totally/unknown')
    expect(await screen.findByRole('heading', { name: 'CampaignSettings' })).toBeTruthy()
  })

  /**
   * `/` is the only authenticated route that is public. A deep link into a
   * world is a request to see something specific, and the answer to that is
   * still "sign in" — not a marketing page that drops the thing they asked for.
   */
  it('still bounces a signed-out visitor to /login from a deep link', async () => {
    renderApp(makeApi({}), '/worlds/w1/members')
    expect(await screen.findByRole('heading', { name: 'Log in' })).toBeTruthy()
  })

  it('shows the world picker with the account chrome when signed in', async () => {
    const api = makeApi({
      me: vi.fn(() => Promise.resolve(DM)),
      listWorlds: vi.fn(() =>
        Promise.resolve([
          { id: 'w1', name: 'Chicago', ownerId: 'a', role: 'owner' },
        ] as WorldView[]),
      ),
    })
    renderApp(api, '/')
    expect(await screen.findByRole('heading', { name: 'Your worlds' })).toBeTruthy()
    // header + create/import forms render immediately; the world list streams in
    // once listWorlds resolves, so await the card rather than reading it sync.
    expect(await screen.findByText('Chicago')).toBeTruthy()
    expect(screen.getByText('owner')).toBeTruthy()
    expect(screen.getByText('dm')).toBeTruthy() // layout chrome
  })

  it('logs in through the form and lands on the picker', async () => {
    const login = vi.fn(() => Promise.resolve(DM))
    const api = makeApi({ login, listWorlds: vi.fn(() => Promise.resolve([])) })
    renderApp(api, '/login')
    await screen.findByRole('heading', { name: 'Log in' })

    fill('Username', 'dm')
    fill('Password', 'pw-123456')
    fireEvent.click(screen.getByRole('button', { name: 'Log in' }))

    await waitFor(() => expect(login).toHaveBeenCalledWith('dm', 'pw-123456'))
    expect(await screen.findByRole('heading', { name: 'Your worlds' })).toBeTruthy()
    expect(await screen.findByText('No worlds yet.')).toBeTruthy()
  })

  it('surfaces a structured login error', async () => {
    const api = makeApi({
      login: vi.fn(() =>
        Promise.reject(new ApiClientError(401, 'invalid_credentials', 'bad creds')),
      ),
    })
    renderApp(api, '/login')
    await screen.findByRole('heading', { name: 'Log in' })
    fill('Username', 'dm')
    fill('Password', 'nope')
    fireEvent.click(screen.getByRole('button', { name: 'Log in' }))
    expect((await screen.findByRole('alert')).textContent).toContain('bad creds')
  })

  it('uses a generic message for a non-Error login rejection', async () => {
    const api = makeApi({ login: vi.fn(() => Promise.reject('network')) })
    renderApp(api, '/login')
    await screen.findByRole('heading', { name: 'Log in' })
    fill('Username', 'dm')
    fill('Password', 'nope')
    fireEvent.click(screen.getByRole('button', { name: 'Log in' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Login failed')
  })

  it('renders the world layout + dashboard for a member, with the wiki one link away', async () => {
    const api = makeApi({ me: vi.fn(() => Promise.resolve(DM)) })
    renderApp(api, '/worlds/w1')
    // the index route is the dashboard; the wiki index moved to /wiki
    expect(await screen.findByLabelText('Your role')).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Wiki' })).toBeNull()
    expect(screen.getByRole('link', { name: 'Dashboard' })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Wiki' }).getAttribute('href')).toBe('/worlds/w1/wiki')
    // the retired surfaces are gone from the rail
    expect(screen.queryByRole('link', { name: 'Graph' })).toBeNull()
    expect(screen.queryByRole('link', { name: 'Characters' })).toBeNull()
    expect(screen.queryByRole('link', { name: 'Overview' })).toBeNull()
  })

  it('renders the wiki index at its own path', async () => {
    const api = makeApi({ me: vi.fn(() => Promise.resolve(DM)) })
    renderApp(api, '/worlds/w1/wiki')
    expect(await screen.findByRole('heading', { name: 'Wiki' })).toBeTruthy()
  })

  it('logs out and returns to the landing page', async () => {
    const logout = vi.fn(() => Promise.resolve())
    const api = makeApi({
      me: vi.fn(() => Promise.resolve(DM)),
      logout,
      listWorlds: vi.fn(() => Promise.resolve([])),
    })
    renderApp(api, '/')
    await screen.findByRole('heading', { name: 'Your worlds' })
    fireEvent.click(screen.getByRole('button', { name: 'Log out' }))
    await waitFor(() => expect(logout).toHaveBeenCalled())
    // Logging out on `/` now reveals the landing page rather than a login form.
    // A demo visitor leaving the demo is the common case, and handing them a
    // login form for an account they were never offered is the wrong exit.
    expect(await screen.findByRole('heading', { name: 'CampaignSettings' })).toBeTruthy()
  })

  /**
   * The server refuses the demo principal the whole `/api/account/*` family,
   * reads included, because the account is shared. Linking to a page that can
   * only fail is worse than not offering it.
   */
  it('offers the account page to a normal account and not to the demo principal', async () => {
    const withWorlds = (account: PublicAccount): ApiClient =>
      makeApi({
        me: vi.fn(() => Promise.resolve(account)),
        listWorlds: vi.fn(() => Promise.resolve([])),
      })

    renderApp(withWorlds(DM), '/')
    expect(await screen.findByRole('link', { name: 'dm' })).toBeTruthy()
    cleanup()

    renderApp(withWorlds({ id: 'd', username: 'demo', isDemo: true }), '/')
    await screen.findByRole('heading', { name: 'Your worlds' })
    expect(screen.getByText('demo')).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'demo' })).toBeNull()
  })

  it('useAuth throws outside an AuthProvider', () => {
    function Bad(): null {
      useAuth()
      return null
    }
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => render(<Bad />)).toThrow(/AuthProvider/)
    vi.restoreAllMocks()
  })
})
