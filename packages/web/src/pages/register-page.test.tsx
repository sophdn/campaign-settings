import { ModalProvider } from '../app/modal/modal-context'
import { webFlags } from '../testing/flags'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { type ApiClient, ApiClientError, type PublicConfig } from '../api'
import { ApiProvider } from '../app/api-context'
import { AuthProvider } from '../app/auth-context'
import { ConfigProvider } from '../app/config-context'
import { makeApi } from '../testing/fake-api'
import { RegisterPage } from './register-page'

const openConfig: PublicConfig = {
  flags: webFlags(true),
  contactEmail: 'hi@example.com',
}

function renderPage(api: ApiClient): void {
  render(
    <ApiProvider value={api}>
      <ConfigProvider>
        <ModalProvider>
          <AuthProvider>
            <MemoryRouter initialEntries={['/register']}>
              <Routes>
                <Route path="/register" element={<RegisterPage />} />
                <Route path="/login" element={<h1>Log in</h1>} />
                <Route path="/" element={<h1>Your worlds</h1>} />
              </Routes>
            </MemoryRouter>
          </AuthProvider>
        </ModalProvider>
      </ConfigProvider>
    </ApiProvider>,
  )
}

const openApi = (over: Partial<ApiClient> = {}): ApiClient =>
  makeApi({ getConfig: vi.fn(() => Promise.resolve(openConfig)), ...over })

const fill = (label: string, value: string): void => {
  fireEvent.change(screen.getByLabelText(label), { target: { value } })
}

describe('RegisterPage', () => {
  it('creates the account and lands the new user inside the app', async () => {
    const register = vi.fn(() => Promise.resolve({ id: 'a', username: 'newcomer' }))
    renderPage(openApi({ register }))
    await screen.findByRole('heading', { name: 'Create an account' })

    fill('Username', 'newcomer')
    fill('Email', 'newcomer@example.com')
    fill('Password', 'pw-123456')
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }))

    await waitFor(() =>
      expect(register).toHaveBeenCalledWith({
        username: 'newcomer',
        email: 'newcomer@example.com',
        password: 'pw-123456',
      }),
    )
    expect(await screen.findByRole('heading', { name: 'Your worlds' })).toBeTruthy()
  })

  it('surfaces a taken username and keeps the person on the form', async () => {
    renderPage(
      openApi({
        register: () =>
          Promise.reject(new ApiClientError(409, 'username_taken', 'username already taken')),
      }),
    )
    await screen.findByRole('heading', { name: 'Create an account' })

    fill('Username', 'newcomer')
    fill('Email', 'newcomer@example.com')
    fill('Password', 'pw-123456')
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }))

    expect((await screen.findByRole('alert')).textContent).toMatch(/already taken/i)
    expect(screen.getByRole('heading', { name: 'Create an account' })).toBeTruthy()
  })

  it('surfaces a taken email', async () => {
    renderPage(
      openApi({
        register: () =>
          Promise.reject(new ApiClientError(409, 'email_taken', 'email already registered')),
      }),
    )
    await screen.findByRole('heading', { name: 'Create an account' })

    fill('Username', 'newcomer')
    fill('Email', 'taken@example.com')
    fill('Password', 'pw-123456')
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }))

    expect((await screen.findByRole('alert')).textContent).toMatch(/already registered/i)
  })

  it('sends someone to log in when signup is closed', async () => {
    renderPage(
      makeApi({
        getConfig: () =>
          Promise.resolve({
            flags: webFlags(true, { publicSignupEnabled: false }),
            contactEmail: 'x@example.com',
          }),
      }),
    )
    expect(await screen.findByRole('heading', { name: 'Log in' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Create an account' })).toBeNull()
  })

  it('sends someone to log in when the config probe fails, rather than offering a door that would slam', async () => {
    renderPage(makeApi({ getConfig: () => Promise.reject(new Error('offline')) }))
    expect(await screen.findByRole('heading', { name: 'Log in' })).toBeTruthy()
  })
})
