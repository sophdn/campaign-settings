import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { ApiClientError, type ApiClient, type MemberRole } from '../api'
import { ApiProvider } from '../app/api-context'
import { ConfigProvider } from '../app/config-context'
import { ModalProvider } from '../app/modal/modal-context'
import { WorldRoleProvider } from '../app/world-context'
import { makeApi } from '../testing/fake-api'
import { EntityDetailPage } from './entity-detail-page'

/** A settlement whose axes give the model something to work with. */
const HARBOUR = {
  id: 'st1',
  name: 'Saltmarket',
  size: 'city',
  wealth: 'rich',
  terrain: 'coastal',
}

function mount(
  api: ApiClient,
  role: MemberRole = 'owner',
  path = '/worlds/w1/settlement/st1',
): void {
  render(
    <ApiProvider value={api}>
      <ConfigProvider>
        <ModalProvider>
          <WorldRoleProvider value={{ worldId: 'w1', worldName: 'W', role, refreshWorld: vi.fn() }}>
            <MemoryRouter initialEntries={[path]}>
              <Routes>
                <Route path="/worlds/:worldId/:kind/:id" element={<EntityDetailPage />} />
              </Routes>
            </MemoryRouter>
          </WorldRoleProvider>
        </ModalProvider>
      </ConfigProvider>
    </ApiProvider>,
  )
}

const settlementApi = (entity: Record<string, unknown>, over: Partial<ApiClient> = {}): ApiClient =>
  makeApi({
    getEntity: vi.fn(() => Promise.resolve(entity as never)),
    listWiki: vi.fn(() => Promise.resolve([])),
    ...over,
  })

describe('settlement demographics', () => {
  it('shows the population and census the shared model derives from the axes', async () => {
    mount(settlementApi(HARBOUR))
    const panel = await screen.findByLabelText('Demographics')

    // The exact figures are the shared engine's, exhaustively tested there —
    // what matters here is that this panel shows ITS answer rather than a
    // second implementation of the model.
    expect(panel.textContent).toContain('Estimated population:')
    expect(panel.textContent).toMatch(/Estimated population:\s*\d+/)
    expect(panel.textContent).not.toContain('Estimated population: 0')
    expect(screen.getByText('Likely denizens')).toBeTruthy()
  })

  it('is absent entirely when no size is set, rather than reading zero', async () => {
    // Size is the model's driver; without it there is no estimate to show.
    mount(settlementApi({ id: 'st2', name: 'Nowhere', size: '', wealth: '', terrain: '' }))
    await screen.findByLabelText('Name')
    expect(screen.queryByLabelText('Demographics')).toBeNull()
  })

  it('is absent on kinds that are not settlements', async () => {
    mount(settlementApi({ id: 'n1', name: 'Aelin' }), 'owner', '/worlds/w1/npc/n1')
    await screen.findByLabelText('Name')
    expect(screen.queryByLabelText('Demographics')).toBeNull()
  })

  it('creates an NPC seeded with the role and opens it', async () => {
    const createEntity = vi.fn(() => Promise.resolve({ id: 'npc9', name: 'Smith' }))
    mount(settlementApi(HARBOUR, { createEntity }))
    const panel = await screen.findByLabelText('Demographics')

    // Whichever roles the model returns, the first one is a button.
    const role = panel.querySelector('.denizen-list button') as HTMLButtonElement
    expect(role).toBeTruthy()
    const label = role.textContent ?? ''
    fireEvent.click(role)

    // Named for the role rather than a generated person — the DM replaces it —
    // and the occupation is set so the NPC arrives already classified.
    await waitFor(() =>
      expect(createEntity).toHaveBeenCalledWith('w1', 'npc', { name: label, occupation: label }),
    )
  })

  it('shows a player the census without offering to create anything', async () => {
    const createEntity = vi.fn()
    mount(settlementApi(HARBOUR, { createEntity }), 'player')
    const panel = await screen.findByLabelText('Demographics')

    expect(panel.textContent).toContain('Estimated population:')
    expect(panel.querySelector('.denizen-list button')).toBeNull()
    expect(screen.queryByText('Pick a role to create a blank NPC for it.')).toBeNull()
    expect(createEntity).not.toHaveBeenCalled()
  })

  it('surfaces a failed create instead of navigating away', async () => {
    const createEntity = vi.fn(() =>
      Promise.reject(new ApiClientError(403, 'forbidden', 'entity cap reached')),
    )
    mount(settlementApi(HARBOUR, { createEntity }))
    const panel = await screen.findByLabelText('Demographics')
    fireEvent.click(panel.querySelector('.denizen-list button') as HTMLButtonElement)
    expect((await screen.findByRole('alert')).textContent).toBe('entity cap reached')
  })
})
