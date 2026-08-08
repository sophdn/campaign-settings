import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { type ApiClient, ApiClientError, type PublicAccount } from '../api'
import { ApiProvider } from '../app/api-context'
import { AuthProvider } from '../app/auth-context'
import { makeApi } from '../testing/fake-api'
import { InvitePage } from './invite-page'

const DM: PublicAccount = { id: 'a', username: 'dm' }
const PREVIEW = { world: { name: 'Chicago', slug: 'chicago' }, targeted: false }

function renderPage(api: ApiClient): void {
  render(
    <ApiProvider value={api}>
      <AuthProvider>
        <MemoryRouter initialEntries={['/invite/tok-123']}>
          <Routes>
            <Route path="/invite/:token" element={<InvitePage />} />
            <Route path="/worlds/:worldId" element={<h1>Inside the world</h1>} />
            <Route path="/login" element={<h1>Log in</h1>} />
          </Routes>
        </MemoryRouter>
      </AuthProvider>
    </ApiProvider>,
  )
}

const invited = (over: Partial<ApiClient> = {}): ApiClient =>
  makeApi({ previewInvitation: vi.fn(() => Promise.resolve(PREVIEW)), ...over })

const fill = (label: string, value: string): void => {
  fireEvent.change(screen.getByLabelText(label), { target: { value } })
}

describe('InvitePage — already signed in', () => {
  it('names the world and joins it on one click', async () => {
    const acceptInvitation = vi.fn(() =>
      Promise.resolve({ worldName: 'Chicago', worldSlug: 'chicago' }),
    )
    renderPage(invited({ me: vi.fn(() => Promise.resolve(DM)), acceptInvitation }))

    expect(await screen.findByRole('heading', { name: /been invited to Chicago/ })).toBeTruthy()
    expect(screen.getByText(/signed in as dm/i)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Join Chicago' }))
    await waitFor(() => expect(acceptInvitation).toHaveBeenCalledWith('tok-123'))
    expect(await screen.findByRole('heading', { name: 'Inside the world' })).toBeTruthy()
  })

  it('surfaces a refusal at the moment of joining', async () => {
    renderPage(
      invited({
        me: vi.fn(() => Promise.resolve(DM)),
        acceptInvitation: () =>
          Promise.reject(new ApiClientError(400, 'invalid_invitation', 'no longer valid')),
      }),
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Join Chicago' }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/no longer valid/i)
  })
})

describe('InvitePage — no account yet', () => {
  it('registers with the token and lands inside the world', async () => {
    const register = vi.fn(() => Promise.resolve({ id: 'b', username: 'newcomer' }))
    renderPage(invited({ register }))

    await screen.findByRole('heading', { name: /been invited to Chicago/ })
    fill('Username', 'newcomer')
    fill('Email', 'newcomer@example.com')
    fill('Password', 'pw-123456')
    fireEvent.click(screen.getByRole('button', { name: 'Create account and join' }))

    await waitFor(() =>
      expect(register).toHaveBeenCalledWith({
        username: 'newcomer',
        email: 'newcomer@example.com',
        password: 'pw-123456',
        inviteToken: 'tok-123',
      }),
    )
    expect(await screen.findByRole('heading', { name: 'Inside the world' })).toBeTruthy()
  })

  it('surfaces a taken username without losing the invitation', async () => {
    renderPage(
      invited({
        register: () =>
          Promise.reject(new ApiClientError(409, 'username_taken', 'username already taken')),
      }),
    )
    await screen.findByRole('heading', { name: /been invited to Chicago/ })
    fill('Username', 'player')
    fill('Email', 'newcomer@example.com')
    fill('Password', 'pw-123456')
    fireEvent.click(screen.getByRole('button', { name: 'Create account and join' }))

    expect((await screen.findByRole('alert')).textContent).toMatch(/already taken/i)
    // the form is still there to try again — the token was not spent
    expect(screen.getByRole('button', { name: 'Create account and join' })).toBeTruthy()
  })
})

describe('InvitePage — dead link', () => {
  it('says the invitation is gone and names no world', async () => {
    renderPage(
      makeApi({
        previewInvitation: () =>
          Promise.reject(new ApiClientError(400, 'invalid_invitation', 'no longer valid')),
      }),
    )
    expect(
      await screen.findByRole('heading', { name: 'This invitation is no longer valid' }),
    ).toBeTruthy()
    // a dead token must not leak which world it pointed at
    expect(screen.queryByText(/Chicago/)).toBeNull()
    expect(screen.getByRole('link', { name: 'Go to log in' })).toBeTruthy()
  })
})
