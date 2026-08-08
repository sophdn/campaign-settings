import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { type ApiClient, ApiClientError, type MediaAttachment, type MemberRole } from '../api'
import { ApiProvider } from '../app/api-context'
import { ConfigProvider } from '../app/config-context'
import { ModalProvider } from '../app/modal/modal-context'
import { WorldRoleProvider } from '../app/world-context'
import { makeApi } from '../testing/fake-api'
import { EntityDetailPage } from './entity-detail-page'
import { EntityListPage } from './entity-list-page'

function mount(api: ApiClient, path: string, role: MemberRole = 'owner'): { unmount: () => void } {
  // Config + Modal are what `useSurfaceGate` needs, and a player's entity page
  // now carries a gated control (ProposePassagePanel). The real app wraps the
  // whole tree in both, so the harness does too rather than the panel reaching
  // around the gate.
  return render(
    <ApiProvider value={api}>
      <ConfigProvider>
        <ModalProvider>
          <WorldRoleProvider value={{ worldId: 'w1', worldName: 'W', role, refreshWorld: vi.fn() }}>
            <MemoryRouter initialEntries={[path]}>
              <Routes>
                <Route path="/worlds/:worldId/:kind" element={<EntityListPage />} />
                <Route path="/worlds/:worldId/:kind/:id" element={<EntityDetailPage />} />
              </Routes>
            </MemoryRouter>
          </WorldRoleProvider>
        </ModalProvider>
      </ConfigProvider>
    </ApiProvider>,
  )
}

const value = (label: string): string => (screen.getByLabelText(label) as HTMLInputElement).value

describe('EntityListPage', () => {
  it('lists entities under their kind label and creates a new one', async () => {
    const api = makeApi({
      listEntities: vi.fn(() => Promise.resolve([{ id: 'e1', name: 'Mira' }, { id: 'e2' }])),
      createEntity: vi.fn(() => Promise.resolve({ id: 'e3', name: 'New' })),
    })
    mount(api, '/worlds/w1/npc')
    expect(await screen.findByText('Mira')).toBeTruthy()
    expect(screen.getByText('e2')).toBeTruthy() // entity without a name falls back to its id
    expect(screen.getByRole('heading', { name: 'NPCs' })).toBeTruthy() // kind label from the registry

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'New' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(api.createEntity).toHaveBeenCalledWith('w1', 'npc', { name: 'New' }))
    await waitFor(() => expect(api.listEntities).toHaveBeenCalledTimes(2)) // reloaded after create
  })

  it('shows a create error and a load error', async () => {
    const api = makeApi({
      createEntity: vi.fn(() => Promise.reject(new ApiClientError(403, 'forbidden', 'no write'))),
    })
    const first = mount(api, '/worlds/w1/npc')
    await screen.findByRole('button', { name: 'Add' })
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'x' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect((await screen.findByRole('alert')).textContent).toBe('no write')
    first.unmount()

    const api2 = makeApi({ listEntities: vi.fn(() => Promise.reject(new Error('load boom'))) })
    mount(api2, '/worlds/w2/npc')
    expect((await screen.findByRole('alert')).textContent).toBe('load boom')
  })

  it('falls back to the raw kind when it is not in the registry', async () => {
    mount(makeApi({ listEntities: vi.fn(() => Promise.resolve([])) }), '/worlds/w1/madeupkind')
    expect(await screen.findByRole('heading', { name: 'madeupkind' })).toBeTruthy()
  })

  it('shows an empty-state when a kind has no entities', async () => {
    mount(makeApi({ listEntities: vi.fn(() => Promise.resolve([])) }), '/worlds/w1/session')
    expect(await screen.findByText('No sessions yet.')).toBeTruthy()
  })
})

describe('session detail (bespoke fields)', () => {
  it('edits a session over name/played-at/summary and saves the session fields', async () => {
    const api = makeApi({
      getEntity: vi.fn(() =>
        Promise.resolve({
          id: 's1',
          name: 'Session 1',
          played_at: '2026-06-27',
          captured_text: 'log',
        }),
      ),
      updateEntity: vi.fn(() => Promise.resolve({ id: 's1' })),
      deleteEntity: vi.fn(() => Promise.resolve()),
      listEntities: vi.fn(() => Promise.resolve([])),
    })
    mount(api, '/worlds/w1/session/s1')
    await waitFor(() => expect(value('Name')).toBe('Session 1'))
    expect(value('Played at')).toBe('2026-06-27')
    expect((screen.getByLabelText('Summary') as HTMLTextAreaElement).value).toBe('log')

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Session 1 — recap' } })
    fireEvent.change(screen.getByLabelText('Played at'), { target: { value: '2026-07-01' } })
    fireEvent.change(screen.getByLabelText('Summary'), { target: { value: 'a better log' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(api.updateEntity).toHaveBeenCalledWith('w1', 'session', 's1', {
        name: 'Session 1 — recap',
        played_at: '2026-07-01',
        captured_text: 'a better log',
      }),
    )
    expect(await screen.findByText('Saved')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(api.deleteEntity).toHaveBeenCalledWith('w1', 'session', 's1'))
    expect(await screen.findByText('No sessions yet.')).toBeTruthy() // navigated back to the list
  })

  it('surfaces session save/delete errors', async () => {
    const api = makeApi({
      getEntity: vi.fn(() => Promise.resolve({ id: 's1', name: 'Session 1' })),
      updateEntity: vi.fn(() => Promise.reject(new Error('save boom'))),
      deleteEntity: vi.fn(() => Promise.reject(new Error('del boom'))),
    })
    mount(api, '/worlds/w1/session/s1')
    await waitFor(() => expect(value('Name')).toBe('Session 1'))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('save boom')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(await screen.findByText('del boom')).toBeTruthy()
  })

  it('shows a session read-only (no Save/Delete) for a player', async () => {
    const api = makeApi({
      getEntity: vi.fn(() =>
        Promise.resolve({
          id: 's1',
          name: 'Session 1',
          played_at: '2026-06-27',
          captured_text: 'recap',
        }),
      ),
    })
    mount(api, '/worlds/w1/session/s1', 'player')
    expect(await screen.findByRole('heading', { name: 'Session 1' })).toBeTruthy()
    expect(screen.getByText('2026-06-27')).toBeTruthy()
    expect(screen.getByText('recap')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull()
  })

  it('defaults a bare session to empty fields for the owner', async () => {
    const api = makeApi({
      getEntity: vi.fn(() => Promise.resolve({ id: 's9' })),
      listEntities: vi.fn(() => Promise.resolve([])),
    })
    mount(api, '/worlds/w1/session/s9')
    await waitFor(() => expect(value('Name')).toBe(''))
    expect(value('Played at')).toBe('')
    expect((screen.getByLabelText('Summary') as HTMLTextAreaElement).value).toBe('')
  })

  it('falls back to the id and hides an absent date for a bare session (player)', async () => {
    const api = makeApi({ getEntity: vi.fn(() => Promise.resolve({ id: 's7' })) })
    mount(api, '/worlds/w1/session/s7', 'player')
    expect(await screen.findByRole('heading', { name: 's7' })).toBeTruthy()
  })

  it('renders [[mentions]] in a session recap as links', async () => {
    const api = makeApi({
      getEntity: vi.fn(() =>
        Promise.resolve({
          id: 's1',
          name: 'Session 1',
          captured_text: 'The party met [[Connie]].',
        }),
      ),
      listWiki: vi.fn(() => Promise.resolve([{ kind: 'npc', id: 'e2', name: 'Connie' }])),
    })
    mount(api, '/worlds/w1/session/s1', 'player')
    const link = await screen.findByRole('link', { name: 'Connie' })
    expect(link.getAttribute('href')).toBe('/worlds/w1/npc/e2')
  })
})

describe('EntityDetailPage', () => {
  it('edits, saves, and deletes a loaded entity', async () => {
    const api = makeApi({
      getEntity: vi.fn(() => Promise.resolve({ id: 'e1', name: 'Mira', description: 'old' })),
      updateEntity: vi.fn(() => Promise.resolve({ id: 'e1' })),
      deleteEntity: vi.fn(() => Promise.resolve()),
      listEntities: vi.fn(() => Promise.resolve([])),
    })
    mount(api, '/worlds/w1/npc/e1')
    await waitFor(() => expect(value('Name')).toBe('Mira'))

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Mira II' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(api.updateEntity).toHaveBeenCalledWith('w1', 'npc', 'e1', {
        name: 'Mira II',
        description: 'old',
      }),
    )
    expect(await screen.findByText('Saved')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(api.deleteEntity).toHaveBeenCalled())
    // navigated back to the list
    expect(await screen.findByRole('heading', { name: 'NPCs' })).toBeTruthy()
  })

  it('renders attached images in the media gallery', async () => {
    const api = makeApi({
      getEntity: vi.fn(() => Promise.resolve({ id: 'e1', name: 'Mira' })),
      listEntityMedia: vi.fn<() => Promise<MediaAttachment[]>>(() =>
        Promise.resolve([
          {
            id: 'm1',
            world_id: 'w1',
            owner_kind: 'npc',
            owner_id: 'e1',
            media_kind: 'image',
            original_filename: 'mira.png',
            mime_type: 'image/png',
            byte_size: '100',
            thumbnail_path: null,
            created_at: '2026-01-01',
          },
        ]),
      ),
    })
    mount(api, '/worlds/w1/npc/e1', 'player')
    expect(await screen.findByAltText('View mira.png full size')).toBeTruthy()
  })

  it('offers a back link to the wiki landing', async () => {
    const api = makeApi({ getEntity: vi.fn(() => Promise.resolve({ id: 'e1', name: 'Mira' })) })
    mount(api, '/worlds/w1/npc/e1', 'player')
    const back = await screen.findByRole('link', { name: 'Back to wiki' })
    expect(back.getAttribute('href')).toBe('/worlds/w1')
  })

  it('surfaces a load error and write errors', async () => {
    const api = makeApi({ getEntity: vi.fn(() => Promise.reject(new Error('missing'))) })
    const first = mount(api, '/worlds/w1/npc/e1')
    expect((await screen.findByRole('alert')).textContent).toBe('missing')
    first.unmount()

    const api2 = makeApi({
      getEntity: vi.fn(() => Promise.resolve({ id: 'e1', name: 'Mira' })),
      updateEntity: vi.fn(() => Promise.reject(new Error('save boom'))),
      deleteEntity: vi.fn(() => Promise.reject(new Error('del boom'))),
    })
    mount(api2, '/worlds/w1/npc/e1')
    await waitFor(() => expect(value('Name')).toBe('Mira'))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('save boom')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(await screen.findByText('del boom')).toBeTruthy()
  })
})

describe('player (read-only) view', () => {
  it('hides the create form on the list for a player', async () => {
    const api = makeApi({
      listEntities: vi.fn(() => Promise.resolve([{ id: 'e1', name: 'Mira' }])),
    })
    mount(api, '/worlds/w1/npc', 'player')
    expect(await screen.findByText('Mira')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Add' })).toBeNull()
  })

  it('shows an entity read-only (no Save/Delete) for a player', async () => {
    const api = makeApi({
      getEntity: vi.fn(() => Promise.resolve({ id: 'e1', name: 'Mira', description: 'a fixer' })),
    })
    mount(api, '/worlds/w1/npc/e1', 'player')
    expect(await screen.findByRole('heading', { name: 'Mira' })).toBeTruthy()
    expect(screen.getByText('a fixer')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull()
  })

  it('falls back to the id (and a blank description) for a bare entity', async () => {
    const api = makeApi({ getEntity: vi.fn(() => Promise.resolve({ id: 'e7' })) })
    mount(api, '/worlds/w1/npc/e7', 'player')
    expect(await screen.findByRole('heading', { name: 'e7' })).toBeTruthy()
  })

  it('renders [[name]] references in a description as links to the entity', async () => {
    const api = makeApi({
      getEntity: vi.fn(() =>
        Promise.resolve({ id: 'e1', name: 'Mira', description: 'Allied with [[Connie]].' }),
      ),
      listWiki: vi.fn(() => Promise.resolve([{ kind: 'npc', id: 'e2', name: 'Connie' }])),
    })
    mount(api, '/worlds/w1/npc/e1', 'player')
    const link = await screen.findByRole('link', { name: 'Connie' })
    expect(link.getAttribute('href')).toBe('/worlds/w1/npc/e2')
  })
})

describe('EntityDetailPage — change type', () => {
  it('owner reclassifies the entity via the change-type control', async () => {
    const api = makeApi({
      getEntity: vi.fn(() => Promise.resolve({ id: 'e', name: 'Mara', description: 'd' })),
      changeEntityKind: vi.fn(() => Promise.resolve({ id: 'e', kind: 'pc' })),
    })
    mount(api, '/worlds/w1/npc/e', 'owner')
    const select = (await screen.findByLabelText('Type')) as HTMLSelectElement
    // the select reflects the CURRENT kind by default; the button is inert until changed
    expect(select.value).toBe('npc')
    expect(Array.from(select.options).map((o) => o.value)).toContain('npc')
    const btn = screen.getByRole('button', { name: 'Change type' }) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    fireEvent.change(select, { target: { value: 'pc' } })
    expect(btn.disabled).toBe(false)
    fireEvent.click(btn)
    await waitFor(() => expect(api.changeEntityKind).toHaveBeenCalledWith('w1', 'npc', 'e', 'pc'))
  })

  it('surfaces a change-type error and hides the control from players', async () => {
    const api = makeApi({
      getEntity: vi.fn(() => Promise.resolve({ id: 'e', name: 'Mara' })),
      changeEntityKind: vi.fn(() =>
        Promise.reject(new ApiClientError(400, 'invalid_kind_change', 'nope')),
      ),
    })
    const first = mount(api, '/worlds/w1/npc/e', 'owner')
    fireEvent.change(await screen.findByLabelText('Type'), { target: { value: 'pc' } })
    fireEvent.click(screen.getByRole('button', { name: 'Change type' }))
    expect((await screen.findByRole('status')).textContent).toBe('nope')
    first.unmount()

    const api2 = makeApi({ getEntity: vi.fn(() => Promise.resolve({ id: 'e', name: 'Mara' })) })
    mount(api2, '/worlds/w1/npc/e', 'player')
    await screen.findByText('Mara')
    expect(screen.queryByRole('button', { name: 'Change type' })).toBeNull()
  })
})

describe('EntityDetailPage — linked entities panel', () => {
  const api = () =>
    makeApi({
      getEntity: vi.fn(() =>
        Promise.resolve({ id: 'e1', name: 'Mira', description: 'Owes [[Silas Crow]] a favour.' }),
      ),
      listWiki: vi.fn(() =>
        Promise.resolve([
          { kind: 'npc', id: 'n1', name: 'Silas Crow' },
          { kind: 'location', id: 'l1', name: 'Saltmarsh Docks' },
        ]),
      ),
    })

  it('sits between Type and Who can see this', async () => {
    mount(api(), '/worlds/w1/npc/e1')
    await screen.findByRole('heading', { name: 'Linked entities' })

    const headings = screen
      .getAllByRole('heading')
      .map((h) => h.textContent ?? '')
      .filter((t) => ['Type', 'Linked entities', 'Who can see this'].includes(t))
    expect(headings).toEqual(['Type', 'Linked entities', 'Who can see this'])
  })

  it('lists what the SAVED body links to on load', async () => {
    mount(api(), '/worlds/w1/npc/e1')
    const panel = await screen.findByRole('region', { name: 'Linked entities' })
    await waitFor(() =>
      expect(
        within(panel)
          .getByRole('link', { name: /Silas Crow/ })
          .getAttribute('href'),
      ).toBe('/worlds/w1/npc/n1'),
    )
  })

  it('follows the description box as it is edited, before any save', async () => {
    mount(api(), '/worlds/w1/npc/e1')
    const panel = await screen.findByRole('region', { name: 'Linked entities' })
    await waitFor(() =>
      expect(within(panel).getByRole('link', { name: /Silas Crow/ })).toBeTruthy(),
    )

    fireEvent.change(screen.getByLabelText('Description'), {
      target: { value: 'Now drinks at [[Saltmarsh Docks]] instead.' },
    })

    // A reference becomes reachable as soon as it is written, not on save.
    await waitFor(() =>
      expect(
        within(panel)
          .getByRole('link', { name: /Saltmarsh Docks/ })
          .getAttribute('href'),
      ).toBe('/worlds/w1/location/l1'),
    )
    expect(within(panel).queryByRole('link', { name: /Silas Crow/ })).toBeNull()
  })

  it('shows the empty state for a player viewing a body with no links', async () => {
    const readerApi = makeApi({
      getEntity: vi.fn(() => Promise.resolve({ id: 'e1', name: 'Mira', description: 'no links' })),
      listWiki: vi.fn(() => Promise.resolve([{ kind: 'npc', id: 'n1', name: 'Silas Crow' }])),
    })
    mount(readerApi, '/worlds/w1/npc/e1', 'player')
    const panel = await screen.findByRole('region', { name: 'Linked entities' })
    expect(within(panel).queryByRole('link')).toBeNull()
  })
})
