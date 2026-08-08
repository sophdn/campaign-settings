import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { App } from './App'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('App', () => {
  it('boots, probes the session, and shows the login page when signed out', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 401,
          statusText: '',
          json: () => Promise.resolve({ error: { code: 'unauthenticated', message: 'x' } }),
        } as Response),
      ),
    )
    render(<App />)
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Log in' })).toBeTruthy()
    })
  })
})
