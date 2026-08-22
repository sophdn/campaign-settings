import { webFlags } from '../testing/flags'
import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { makeApi } from '../testing/fake-api'
import { ApiProvider } from './api-context'
import { ConfigProvider, useConfig } from './config-context'

function Probe(): React.JSX.Element {
  const { flags, contactEmail, loading } = useConfig()
  return (
    <div>
      <span data-testid="loading">{String(loading)}</span>
      <span data-testid="signup">{String(flags.publicSignupEnabled)}</span>
      <span data-testid="email">{contactEmail}</span>
    </div>
  )
}

function renderWithApi(api: ReturnType<typeof makeApi>) {
  return render(
    <ApiProvider value={api}>
      <ConfigProvider>
        <Probe />
      </ConfigProvider>
    </ApiProvider>,
  )
}

describe('ConfigProvider', () => {
  it('exposes fetched config once the probe resolves', async () => {
    const getConfig = vi.fn(() =>
      Promise.resolve({ flags: webFlags(true), contactEmail: 'hi@example.com' }),
    )
    renderWithApi(makeApi({ getConfig }))
    await waitFor(() => expect(screen.getByTestId('loading').textContent).toBe('false'))
    expect(screen.getByTestId('signup').textContent).toBe('true')
    expect(screen.getByTestId('email').textContent).toBe('hi@example.com')
    expect(getConfig).toHaveBeenCalledTimes(1)
  })

  it('stays fail-closed on the defaults when the probe fails', async () => {
    renderWithApi(makeApi({ getConfig: () => Promise.reject(new Error('down')) }))
    await waitFor(() => expect(screen.getByTestId('loading').textContent).toBe('false'))
    expect(screen.getByTestId('signup').textContent).toBe('false')
    expect(screen.getByTestId('email').textContent).toBe('')
  })
})

describe('useConfig', () => {
  it('throws when used outside a ConfigProvider', () => {
    function Orphan(): React.JSX.Element {
      useConfig()
      return <div />
    }
    expect(() => render(<Orphan />)).toThrow('useConfig must be used within a ConfigProvider')
  })
})
