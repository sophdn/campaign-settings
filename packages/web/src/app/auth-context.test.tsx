import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import type { ApiClient, PublicAccount } from '../api'
import { DemoPage } from '../pages/demo-page'
import { makeApi } from '../testing/fake-api'
import { ApiProvider } from './api-context'
import { AuthProvider } from './auth-context'
import { RequireAuth } from './require-auth'

/**
 * The boot probe races whatever the visitor is doing. `/demo` is the sharpest
 * case — it signs in the moment it mounts, with no click in between — so these
 * mount the real DemoPage behind the real RequireAuth rather than asserting on
 * the provider's internals. What matters is where the visitor ends up.
 */

/** A promise plus the handles to settle it whenever the test chooses. */
function deferred<T>(): {
  promise: Promise<T>
  resolve: (v: T) => void
  reject: (e: Error) => void
} {
  let resolve!: (v: T) => void
  let reject!: (e: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function show(api: ApiClient): void {
  render(
    <ApiProvider value={api}>
      <AuthProvider>
        <MemoryRouter initialEntries={['/demo']}>
          <Routes>
            <Route path="/demo" element={<DemoPage />} />
            <Route element={<RequireAuth />}>
              <Route path="/" element={<h1>Your worlds</h1>} />
            </Route>
            <Route path="/login" element={<h1>Log in</h1>} />
          </Routes>
        </MemoryRouter>
      </AuthProvider>
    </ApiProvider>,
  )
}

describe('AuthProvider — the boot probe against a sign-in that beats it', () => {
  it('keeps the visitor signed in when the probe answers after the demo login', async () => {
    // The order that broke the demo: a cold server answers /api/demo-login
    // first, and the session probe — sent before there was any cookie to
    // present — comes back 'nobody' a moment later.
    const probe = deferred<PublicAccount>()
    const demoLogin = vi.fn(() => Promise.resolve(DEMO))
    show(makeApi({ me: () => probe.promise, demoLogin }))

    await waitFor(() => expect(demoLogin).toHaveBeenCalled())
    probe.reject(new Error('anon'))

    // The stale answer must not evict the newer one, or RequireAuth bounces a
    // visitor who IS signed in to the login page they were spared.
    expect(await screen.findByRole('heading', { name: 'Your worlds' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Log in' })).toBeNull()
  })

  it('lands the visitor without waiting for a probe that has nothing to say', async () => {
    // The other half of the same race, and the one CI caught: the probe is not
    // wrong, just slow. A demo visitor is signed in and RequireAuth holds a
    // spinner over them anyway, because `loading` was tied to a request whose
    // answer stopped mattering the moment the sign-in landed. This probe never
    // settles at all, which is the limit of "slow".
    const probe = deferred<PublicAccount>()
    show(makeApi({ me: () => probe.promise, demoLogin: () => Promise.resolve(DEMO) }))

    expect(await screen.findByRole('heading', { name: 'Your worlds' })).toBeTruthy()
  })

  it('still shows the login page when nobody signed in at all', async () => {
    const probe = deferred<PublicAccount>()
    show(
      makeApi({
        me: () => probe.promise,
        demoLogin: () => Promise.reject(new Error('demo is off')),
      }),
    )
    probe.reject(new Error('anon'))

    // The probe is the only word on it here, and it still has the last one.
    expect(await screen.findByRole('heading', { name: 'The demo is not available' })).toBeTruthy()
  })
})

const DEMO: PublicAccount = { id: 'demo', username: 'demo' }
