import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { type ApiClient, ApiClientError } from '../api'
import { ApiProvider } from '../app/api-context'
import { ConfigProvider } from '../app/config-context'
import { ModalProvider } from '../app/modal/modal-context'
import { makeApi } from '../testing/fake-api'
import { webFlags } from '../testing/flags'
import { ProposePassagePanel } from './propose-passage-panel'

function mount(api: ApiClient, onProposed = vi.fn()): { onProposed: () => void } {
  render(
    <ApiProvider value={api}>
      <ConfigProvider>
        <ModalProvider>
          <ProposePassagePanel
            api={api}
            worldId="w"
            kind="npc"
            entityId="e"
            candidates={[]}
            onProposed={onProposed}
          />
        </ModalProvider>
      </ConfigProvider>
    </ApiProvider>,
  )
  return { onProposed }
}

const openConfig = (over: Record<string, unknown> = {}) =>
  makeApi({
    getConfig: vi.fn(() =>
      Promise.resolve({ flags: webFlags(true), contactEmail: 'help@example.com' }),
    ),
    ...over,
  })

describe('ProposePassagePanel', () => {
  it('sends the text and nothing else, then clears and confirms', async () => {
    const proposePassage = vi.fn(() => Promise.resolve({ id: 'p' } as never))
    const { onProposed } = mount(openConfig({ proposePassage }))

    const field = screen.getByLabelText('Your suggestion')
    fireEvent.change(field, { target: { value: 'He runs the ledger.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send to GM' }))

    // Four arguments, the last of which is the body — there is no visibility,
    // status or author to pass, because the server decides all three.
    await waitFor(() =>
      expect(proposePassage).toHaveBeenCalledWith('w', 'npc', 'e', 'He runs the ledger.'),
    )
    // The clear lands a turn later than the call itself — the panel empties the
    // field only once the request has resolved — so this waits rather than
    // reading the moment the spy was seen.
    await waitFor(() => expect((field as HTMLTextAreaElement).value).toBe(''))
    expect(await screen.findByRole('status')).toBeTruthy()
    await waitFor(() => expect(onProposed).toHaveBeenCalled())
  })

  it('will not send an empty or whitespace-only suggestion', async () => {
    const proposePassage = vi.fn(() => Promise.resolve({ id: 'p' } as never))
    mount(openConfig({ proposePassage }))
    const send = screen.getByRole('button', { name: 'Send to GM' }) as HTMLButtonElement
    expect(send.disabled).toBe(true)

    fireEvent.change(screen.getByLabelText('Your suggestion'), { target: { value: '   ' } })
    expect(send.disabled).toBe(true)
    expect(proposePassage).not.toHaveBeenCalled()
  })

  it('surfaces the server’s refusal rather than pretending it sent', async () => {
    mount(
      openConfig({
        proposePassage: vi.fn(() =>
          Promise.reject(new ApiClientError(409, 'limit_reached', 'too many awaiting review')),
        ),
      }),
    )
    fireEvent.change(screen.getByLabelText('Your suggestion'), { target: { value: 'x' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send to GM' }))

    expect((await screen.findByRole('alert')).textContent).toBe('too many awaiting review')
    // the text is kept, so a refusal does not also lose what they wrote
    expect((screen.getByLabelText('Your suggestion') as HTMLTextAreaElement).value).toBe('x')
  })

  /**
   * With the surface gated off the contact modal opens INSTEAD of the request
   * going out. The endpoint refuses on its own too — this is the courtesy half.
   */
  it('opens the contact modal instead of proposing when the surface is gated off', async () => {
    const proposePassage = vi.fn(() => Promise.resolve({ id: 'p' } as never))
    const api = makeApi({
      proposePassage,
      getConfig: vi.fn(() =>
        Promise.resolve({ flags: webFlags(false), contactEmail: 'help@example.com' }),
      ),
    })
    mount(api)
    // wait for the config probe to land — before it does, the gate deliberately
    // lets the click through rather than refusing on a fail-closed default
    await waitFor(() => expect(api.getConfig).toHaveBeenCalled())

    fireEvent.change(screen.getByLabelText('Your suggestion'), { target: { value: 'x' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send to GM' }))

    expect(await screen.findByRole('dialog')).toBeTruthy()
    expect(proposePassage).not.toHaveBeenCalled()
  })
})
