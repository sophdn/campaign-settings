import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { type ApiClient, ApiClientError, type PublicAccount, type SessionSummary } from '../api'
import { ApiProvider } from '../app/api-context'
import { AuthProvider } from '../app/auth-context'
import { makeApi } from '../testing/fake-api'
import { AccountPage } from './account-page'

const DM: PublicAccount = { id: 'a', username: 'dm' }

const session = (over: Partial<SessionSummary> = {}): SessionSummary => ({
  createdAt: '2026-07-20T10:00:00.000Z',
  lastSeenAt: '2026-07-27T09:00:00.000Z',
  deviceLabel: 'Firefox on Linux',
  current: false,
  ...over,
})

function renderPage(api: ApiClient): void {
  render(
    <ApiProvider value={api}>
      <AuthProvider>
        <MemoryRouter>
          <AccountPage />
        </MemoryRouter>
      </AuthProvider>
    </ApiProvider>,
  )
}

/** A signed-in fake with whatever session list the test needs. */
const signedIn = (over: Partial<ApiClient> = {}): ApiClient =>
  makeApi({ me: vi.fn(() => Promise.resolve(DM)), ...over })

const fill = (label: string, value: string): void => {
  fireEvent.change(screen.getByLabelText(label), { target: { value } })
}

describe('AccountPage — username', () => {
  it('renames the account and confirms', async () => {
    const changeUsername = vi.fn(() => Promise.resolve({ id: 'a', username: 'game-master' }))
    renderPage(signedIn({ changeUsername }))

    fill('Username', 'game-master')
    fireEvent.click(screen.getByRole('button', { name: 'Save username' }))

    await waitFor(() => expect(changeUsername).toHaveBeenCalledWith('game-master'))
    expect(await screen.findByText('Username updated.')).toBeTruthy()
  })

  it('surfaces the taken-username error from the server', async () => {
    renderPage(
      signedIn({
        changeUsername: () =>
          Promise.reject(new ApiClientError(409, 'username_taken', 'username already taken')),
      }),
    )

    fill('Username', 'player')
    fireEvent.click(screen.getByRole('button', { name: 'Save username' }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/already taken/i)
  })
})

describe('AccountPage — password', () => {
  it('changes the password, warns about other devices, clears the fields, and refreshes the list', async () => {
    const changePassword = vi.fn(() => Promise.resolve())
    const listSessions = vi.fn(() => Promise.resolve([session({ current: true })]))
    renderPage(signedIn({ changePassword, listSessions }))
    await waitFor(() => expect(listSessions).toHaveBeenCalledTimes(1))

    expect(screen.getByText(/signs you out everywhere else/i)).toBeTruthy()

    fill('Current password', 'old-password-1')
    fill('New password', 'new-password-2')
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }))

    await waitFor(() =>
      expect(changePassword).toHaveBeenCalledWith('old-password-1', 'new-password-2'),
    )
    expect(await screen.findByText('Password updated.')).toBeTruthy()
    // the entered credentials do not linger in the DOM
    expect((screen.getByLabelText('Current password') as HTMLInputElement).value).toBe('')
    expect((screen.getByLabelText('New password') as HTMLInputElement).value).toBe('')
    // the list is re-read, because other devices were just signed out
    await waitFor(() => expect(listSessions).toHaveBeenCalledTimes(2))
  })

  it('surfaces a wrong-current-password rejection and keeps the fields', async () => {
    renderPage(
      signedIn({
        changePassword: () =>
          Promise.reject(
            new ApiClientError(401, 'invalid_credentials', 'invalid username or password'),
          ),
      }),
    )

    fill('Current password', 'wrong')
    fill('New password', 'new-password-2')
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/invalid/i)
    expect((screen.getByLabelText('New password') as HTMLInputElement).value).toBe('new-password-2')
  })
})

describe('AccountPage — sessions', () => {
  it('lists sessions, marks this device, and names an unknown client', async () => {
    const listSessions = vi.fn(() =>
      Promise.resolve([
        session({ deviceLabel: 'Safari on iOS', current: true }),
        session({ deviceLabel: null }),
      ]),
    )
    renderPage(signedIn({ listSessions }))

    expect(await screen.findByText(/Safari on iOS — this device/)).toBeTruthy()
    expect(screen.getByText('Unknown device')).toBeTruthy()
  })

  it('shows an empty state when nothing is listed', async () => {
    renderPage(signedIn({ listSessions: vi.fn(() => Promise.resolve([])) }))
    expect(await screen.findByText('No active sessions.')).toBeTruthy()
  })

  it('ends other sessions and re-reads the list', async () => {
    const revokeOtherSessions = vi.fn(() => Promise.resolve())
    const listSessions = vi
      .fn<() => Promise<SessionSummary[]>>()
      .mockResolvedValueOnce([
        session({ current: true }),
        session({ deviceLabel: 'Safari on iOS' }),
      ])
      .mockResolvedValue([session({ current: true })])
    renderPage(signedIn({ revokeOtherSessions, listSessions }))

    expect(await screen.findByText(/Safari on iOS/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Sign out everywhere else' }))

    await waitFor(() => expect(revokeOtherSessions).toHaveBeenCalled())
    await waitFor(() => expect(screen.queryByText(/Safari on iOS/)).toBeNull())
  })

  it('surfaces a failure to load the list', async () => {
    renderPage(signedIn({ listSessions: () => Promise.reject(new Error('boom')) }))
    expect(await screen.findByRole('alert')).toBeTruthy()
  })

  it('surfaces a failure to end other sessions', async () => {
    renderPage(
      signedIn({
        listSessions: vi.fn(() => Promise.resolve([session({ current: true })])),
        revokeOtherSessions: () => Promise.reject(new Error('boom')),
      }),
    )
    await screen.findByText(/Firefox on Linux/)
    fireEvent.click(screen.getByRole('button', { name: 'Sign out everywhere else' }))
    expect(await screen.findByRole('alert')).toBeTruthy()
  })
})
