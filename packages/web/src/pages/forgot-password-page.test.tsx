import { ConfigProvider } from '../app/config-context'
import { ModalProvider } from '../app/modal/modal-context'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { ApiProvider } from '../app/api-context'
import { makeApi } from '../testing/fake-api'
import { ForgotPasswordPage } from './forgot-password-page'

function renderPage(api = makeApi()) {
  return render(
    <ApiProvider value={api}>
      <ConfigProvider>
        <ModalProvider>
          <MemoryRouter>
            <ForgotPasswordPage />
          </MemoryRouter>
        </ModalProvider>
      </ConfigProvider>
    </ApiProvider>,
  )
}

describe('ForgotPasswordPage', () => {
  it('requests a reset and shows a neutral confirmation (no existence oracle)', async () => {
    const requestPasswordReset = vi.fn(() => Promise.resolve())
    renderPage(makeApi({ requestPasswordReset }))
    fireEvent.change(screen.getByLabelText('Username or email'), {
      target: { value: 'dm@example.com' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send reset link' }))

    await waitFor(() => expect(screen.getByRole('status')).toBeTruthy())
    expect(requestPasswordReset).toHaveBeenCalledWith('dm@example.com')
    expect(screen.getByRole('status').textContent).toMatch(/if an account matches/i)
    // the form is replaced by the confirmation
    expect(screen.queryByRole('button', { name: 'Send reset link' })).toBeNull()
  })

  it('surfaces an error when the request fails', async () => {
    renderPage(makeApi({ requestPasswordReset: () => Promise.reject(new Error('boom')) }))
    fireEvent.change(screen.getByLabelText('Username or email'), { target: { value: 'x' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send reset link' }))
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
  })
})
