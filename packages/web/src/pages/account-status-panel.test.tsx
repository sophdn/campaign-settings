import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { AccountStatus, ApiClient } from '../api'
import { makeApi } from '../testing/fake-api'
import { AccountStatusPanel } from './account-status-panel'

const status = (over: Partial<AccountStatus> = {}): AccountStatus => ({
  emailVerified: true,
  limits: { worldsPerAccount: 5, entitiesPerWorld: 2000, mediaBytesPerWorld: 100 * 1024 * 1024 },
  usage: { worlds: 2 },
  ...over,
})

const show = (api: ApiClient): void => {
  render(<AccountStatusPanel api={api} />)
}

const withStatus = (s: AccountStatus, over: Partial<ApiClient> = {}): ApiClient =>
  makeApi({ accountStatus: vi.fn(() => Promise.resolve(s)), ...over })

describe('AccountStatusPanel — verification', () => {
  it('says so when verified, and does not nag', async () => {
    show(withStatus(status()))
    expect(await screen.findByText('Your email address is verified.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /verification email/ })).toBeNull()
  })

  it('explains exactly what is blocked while unverified', async () => {
    show(withStatus(status({ emailVerified: false })))
    expect(await screen.findByText(/cannot create a world or invite anyone/i)).toBeTruthy()
  })

  it('resends and confirms without claiming the address exists', async () => {
    const resendVerification = vi.fn(() => Promise.resolve())
    show(withStatus(status({ emailVerified: false }), { resendVerification }))

    fireEvent.click(await screen.findByRole('button', { name: 'Send me a new verification email' }))

    await waitFor(() => expect(resendVerification).toHaveBeenCalled())
    expect(await screen.findByText(/If that address is reachable/i)).toBeTruthy()
  })

  it('surfaces a failed resend', async () => {
    show(
      withStatus(status({ emailVerified: false }), {
        resendVerification: () => Promise.reject(new Error('boom')),
      }),
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Send me a new verification email' }))
    expect(await screen.findByRole('alert')).toBeTruthy()
  })
})

describe('AccountStatusPanel — limits', () => {
  it('shows every ceiling before the user can hit one', async () => {
    show(withStatus(status()))
    expect(await screen.findByText('Worlds you own: 2 of 5')).toBeTruthy()
    expect(screen.getByText('Pages per world: up to 2000')).toBeTruthy()
    expect(screen.getByText('Images per world: up to 100 MB')).toBeTruthy()
  })

  it('surfaces a failure to load the status', async () => {
    show(makeApi({ accountStatus: () => Promise.reject(new Error('boom')) }))
    expect(await screen.findByRole('alert')).toBeTruthy()
  })
})
