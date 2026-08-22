import { ModalProvider } from '../app/modal/modal-context'
import { webFlags } from '../testing/flags'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '../api'
import { ApiProvider } from '../app/api-context'
import { AuthProvider } from '../app/auth-context'
import { ConfigProvider } from '../app/config-context'
import { makeApi } from '../testing/fake-api'
import { LoginPage } from './login-page'

function renderPage(api: ApiClient): void {
  render(
    <ApiProvider value={api}>
      <ConfigProvider>
        <ModalProvider>
          <AuthProvider>
            <MemoryRouter>
              <LoginPage />
            </MemoryRouter>
          </AuthProvider>
        </ModalProvider>
      </ConfigProvider>
    </ApiProvider>,
  )
}

describe('LoginPage sign-up affordance', () => {
  it('offers a way to create an account when public signup is open', async () => {
    renderPage(
      makeApi({
        getConfig: vi.fn(() =>
          Promise.resolve({
            flags: webFlags(true),
            contactEmail: 'hi@example.com',
          }),
        ),
      }),
    )
    const link = await screen.findByRole('link', { name: 'Create an account' })
    expect(link.getAttribute('href')).toBe('/register')
  })

  it('offers no sign-up link when signup is closed — the flag fails closed', async () => {
    // Stated explicitly: the fake defaults every surface OPEN so that flow
    // suites are not accidentally testing the gate, so a suite about a closed
    // flag has to say which flag it means.
    renderPage(
      makeApi({
        getConfig: () =>
          Promise.resolve({
            flags: webFlags(true, { publicSignupEnabled: false }),
            contactEmail: 'x@example.com',
          }),
      }),
    )
    // the rest of the form is there, so this is absence-of-link, not absence-of-page
    expect(await screen.findByRole('button', { name: 'Log in' })).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'Create an account' })).toBeNull()
    // recovery stays available — it is gated on its own flag, not on signup
    expect(screen.getByRole('link', { name: 'Forgot your password?' })).toBeTruthy()
  })
})
