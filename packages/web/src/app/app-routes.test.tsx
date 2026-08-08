import { ModalProvider } from './modal/modal-context'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
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
  it('bounces a signed-out visitor to /login (and the catch-all routes there too)', async () => {
    renderApp(makeApi({}), '/totally/unknown')
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

  it('renders the world layout + wiki index for a member', async () => {
    const api = makeApi({ me: vi.fn(() => Promise.resolve(DM)) })
    renderApp(api, '/worlds/w1')
    // the index route is now the Wiki page
    expect(await screen.findByRole('heading', { name: 'Wiki' })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Wiki' })).toBeTruthy()
    // the retired surfaces are gone from the rail
    expect(screen.queryByRole('link', { name: 'Graph' })).toBeNull()
    expect(screen.queryByRole('link', { name: 'Characters' })).toBeNull()
    expect(screen.queryByRole('link', { name: 'Overview' })).toBeNull()
  })

  it('logs out and returns to login', async () => {
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
    expect(await screen.findByRole('heading', { name: 'Log in' })).toBeTruthy()
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
