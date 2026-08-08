import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { type ApiClient, ApiClientError } from '../api'
import { ApiProvider } from '../app/api-context'
import { makeApi } from '../testing/fake-api'
import { VerifyEmailPage } from './verify-email-page'

function show(api: ApiClient, search = '?token=raw-token'): void {
  render(
    <ApiProvider value={api}>
      <MemoryRouter initialEntries={[`/verify-email${search}`]}>
        <VerifyEmailPage />
      </MemoryRouter>
    </ApiProvider>,
  )
}

describe('VerifyEmailPage', () => {
  it('verifies the token from the query string and says what is now possible', async () => {
    const verifyEmail = vi.fn(() => Promise.resolve())
    show(makeApi({ verifyEmail }))

    expect(await screen.findByText('Your email is verified')).toBeTruthy()
    expect(verifyEmail).toHaveBeenCalledWith('raw-token')
    expect(screen.getByText(/create worlds and invite players/i)).toBeTruthy()
  })

  it('shows one indistinguishable refusal for a dead link, and where to get a new one', async () => {
    show(
      makeApi({
        verifyEmail: () =>
          Promise.reject(
            new ApiClientError(400, 'invalid_or_expired_token', 'this link is no longer valid'),
          ),
      }),
    )

    expect(await screen.findByText('This link is no longer valid')).toBeTruthy()
    expect(screen.getByText(/ask for a new one from your account page/i)).toBeTruthy()
  })

  it('treats a missing token as a dead link rather than crashing', async () => {
    const verifyEmail = vi.fn(() => Promise.reject(new Error('bad request')))
    show(makeApi({ verifyEmail }), '')

    expect(await screen.findByText('This link is no longer valid')).toBeTruthy()
    expect(verifyEmail).toHaveBeenCalledWith('')
  })
})
