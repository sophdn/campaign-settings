import { webFlags } from '../../testing/flags'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { makeApi } from '../../testing/fake-api'
import { ApiProvider } from '../api-context'
import { ConfigProvider } from '../config-context'
import { ModalProvider } from '../modal/modal-context'
import { useContactModal } from './contact-modal'

function Harness(): React.JSX.Element {
  const { openContact } = useContactModal()
  return (
    <button type="button" onClick={openContact}>
      contact
    </button>
  )
}

function renderWithEmail(email: string) {
  const getConfig = vi.fn(() => Promise.resolve({ flags: webFlags(false), contactEmail: email }))
  const api = makeApi({ getConfig })
  render(
    <ApiProvider value={api}>
      <ConfigProvider>
        <ModalProvider>
          <Harness />
        </ModalProvider>
      </ConfigProvider>
    </ApiProvider>,
  )
  return { api, getConfig }
}

describe('contact modal', () => {
  it('opens a modal with a mailto to the deploy-configured address', async () => {
    const { getConfig } = renderWithEmail('me@example.com')
    // let the config probe resolve so contactEmail is populated
    await waitFor(() => expect(getConfig).toHaveBeenCalledTimes(1))

    fireEvent.click(screen.getByRole('button', { name: 'contact' }))

    const dialog = await screen.findByRole('dialog', { name: 'Interested?' })
    const link = screen.getByRole('link', { name: 'me@example.com' })
    expect(link.getAttribute('href')).toBe('mailto:me@example.com')
    // no form and nothing that could post: the affordance is a plain mailto
    expect(dialog.querySelector('form')).toBeNull()
  })
})
