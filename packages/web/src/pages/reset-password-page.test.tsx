import { ConfigProvider } from '../app/config-context'
import { ModalProvider } from '../app/modal/modal-context'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { ApiProvider } from '../app/api-context'
import { makeApi } from '../testing/fake-api'
import { ResetPasswordPage } from './reset-password-page'

function renderAt(url: string, api = makeApi()) {
  return render(
    <ApiProvider value={api}>
      <ConfigProvider>
        <ModalProvider>
          <MemoryRouter initialEntries={[url]}>
            <Routes>
              <Route path="/reset-password" element={<ResetPasswordPage />} />
              <Route path="/login" element={<h1>Log in</h1>} />
            </Routes>
          </MemoryRouter>
        </ModalProvider>
      </ConfigProvider>
    </ApiProvider>,
  )
}

describe('ResetPasswordPage', () => {
  it('rejects a link with no token', () => {
    renderAt('/reset-password')
    expect(screen.getByRole('heading', { name: 'Invalid reset link' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Set new password' })).toBeNull()
  })

  it('confirms a new password and returns to login', async () => {
    const confirmPasswordReset = vi.fn(() => Promise.resolve())
    renderAt('/reset-password?token=abc', makeApi({ confirmPasswordReset }))
    fireEvent.change(screen.getByLabelText('New password'), {
      target: { value: 'new-password-1' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Set new password' }))

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Log in' })).toBeTruthy())
    expect(confirmPasswordReset).toHaveBeenCalledWith('abc', 'new-password-1')
  })

  it('surfaces the server error on a rejected token', async () => {
    renderAt(
      '/reset-password?token=bad',
      makeApi({ confirmPasswordReset: () => Promise.reject(new Error('nope')) }),
    )
    fireEvent.change(screen.getByLabelText('New password'), {
      target: { value: 'new-password-1' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Set new password' }))
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
  })
})
