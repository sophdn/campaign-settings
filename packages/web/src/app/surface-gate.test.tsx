import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { type ApiClient, ApiClientError } from '../api'
import { makeApi } from '../testing/fake-api'
import { webFlags } from '../testing/flags'
import { ApiProvider } from './api-context'
import { ConfigProvider } from './config-context'
import { ModalProvider } from './modal/modal-context'
import { useSurfaceGate } from './surface-gate'

function Harness({ run }: { run: () => Promise<void> }): React.JSX.Element {
  const { gate } = useSurfaceGate()
  return (
    <button type="button" onClick={() => void gate('loginEnabled', run)}>
      go
    </button>
  )
}

function show(api: ApiClient, run: () => Promise<void>): void {
  render(
    <ApiProvider value={api}>
      <ConfigProvider>
        <ModalProvider>
          <Harness run={run} />
        </ModalProvider>
      </ConfigProvider>
    </ApiProvider>,
  )
}

const configWith = (open: boolean) => () =>
  Promise.resolve({
    flags: webFlags(true, { loginEnabled: open }),
    contactEmail: 'me@example.com',
  })

const contactDialog = (): Promise<HTMLElement> =>
  screen.findByRole('dialog', { name: 'Interested?' })

describe('useSurfaceGate', () => {
  it('runs the action when the flag is on', async () => {
    const run = vi.fn(() => Promise.resolve())
    show(makeApi({ getConfig: configWith(true) }), run)
    await waitFor(() => expect(screen.getByRole('button', { name: 'go' })).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: 'go' }))

    await waitFor(() => expect(run).toHaveBeenCalled())
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('opens the contact modal INSTEAD of acting when the flag is off', async () => {
    const run = vi.fn(() => Promise.resolve())
    const getConfig = vi.fn(configWith(false))
    show(makeApi({ getConfig }), run)
    await waitFor(() => expect(getConfig).toHaveBeenCalled())

    fireEvent.click(screen.getByRole('button', { name: 'go' }))

    expect(await contactDialog()).toBeTruthy()
    expect(run).not.toHaveBeenCalled()
  })

  it('opens the contact modal when the SERVER refuses, even though the flag looked open', async () => {
    // The SPA's flags are a cache; the server is the truth. This is the path a
    // flag flipped between page load and click takes.
    const run = vi.fn(() =>
      Promise.reject(new ApiClientError(403, 'surface_disabled', 'not available')),
    )
    show(makeApi({ getConfig: configWith(true) }), run)

    fireEvent.click(screen.getByRole('button', { name: 'go' }))

    expect(await contactDialog()).toBeTruthy()
  })

  it('re-throws any other failure — it is a gate, not an error swallower', async () => {
    const run = vi.fn(() => Promise.reject(new ApiClientError(401, 'invalid_credentials', 'nope')))
    const onError = vi.fn()
    function Rethrower(): React.JSX.Element {
      const { gate } = useSurfaceGate()
      return (
        <button type="button" onClick={() => void gate('loginEnabled', run).catch(onError)}>
          go
        </button>
      )
    }
    render(
      <ApiProvider value={makeApi({ getConfig: configWith(true) })}>
        <ConfigProvider>
          <ModalProvider>
            <Rethrower />
          </ModalProvider>
        </ConfigProvider>
      </ApiProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'go' }))

    await waitFor(() => expect(onError).toHaveBeenCalled())
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('lets the action through while the config probe is still in flight', async () => {
    // The SPA's flags start fail-closed. Pre-empting on them would refuse a
    // working surface to anyone who clicked before the probe landed; the server
    // decides instead. Clicking on the very first render exercises exactly that.
    const run = vi.fn(() => Promise.resolve())
    show(makeApi({ getConfig: () => new Promise(() => {}) }), run)

    fireEvent.click(screen.getByRole('button', { name: 'go' }))

    await waitFor(() => expect(run).toHaveBeenCalled())
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
