import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { type ApiClient, ApiClientError } from '../api'
import { ApiProvider } from '../app/api-context'
import { AuthProvider } from '../app/auth-context'
import { makeApi } from '../testing/fake-api'
import { DemoPage } from './demo-page'

function show(api: ApiClient): void {
  render(
    <ApiProvider value={api}>
      <AuthProvider>
        <MemoryRouter initialEntries={['/demo']}>
          <Routes>
            <Route path="/demo" element={<DemoPage />} />
            <Route path="/" element={<h1>Your worlds</h1>} />
          </Routes>
        </MemoryRouter>
      </AuthProvider>
    </ApiProvider>,
  )
}

describe('DemoPage', () => {
  it('signs the visitor in and drops them straight into the app, with nothing to click', async () => {
    const demoLogin = vi.fn(() => Promise.resolve({ id: 'demo', username: 'demo' }))
    show(makeApi({ demoLogin }))

    await waitFor(() => expect(demoLogin).toHaveBeenCalled())
    expect(await screen.findByRole('heading', { name: 'Your worlds' })).toBeTruthy()
    // a visitor who followed "try the demo" has already said yes
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('takes no arguments — the endpoint cannot be asked for another identity', async () => {
    const demoLogin = vi.fn(() => Promise.resolve({ id: 'demo', username: 'demo' }))
    show(makeApi({ demoLogin }))

    await waitFor(() => expect(demoLogin).toHaveBeenCalledWith())
  })

  it('says so plainly when the demo is switched off', async () => {
    show(
      makeApi({
        demoLogin: () =>
          Promise.reject(new ApiClientError(403, 'surface_disabled', 'the demo is not available')),
      }),
    )

    expect(await screen.findByRole('heading', { name: 'The demo is not available' })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Go to log in' })).toBeTruthy()
  })

  it('says so when the demo account has not been provisioned', async () => {
    show(
      makeApi({
        demoLogin: () =>
          Promise.reject(new ApiClientError(503, 'demo_unavailable', 'no demo account exists')),
      }),
    )

    expect((await screen.findByRole('alert')).textContent).toMatch(/no demo account exists/i)
  })
})
