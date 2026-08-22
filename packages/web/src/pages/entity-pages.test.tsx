import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { type ApiClient, ApiClientError, type MediaAttachment, type MemberRole } from '../api'
import { ApiProvider } from '../app/api-context'
import { ConfigProvider } from '../app/config-context'
import { ModalProvider } from '../app/modal/modal-context'
import { WorldRoleProvider } from '../app/world-context'
import { makeApi } from '../testing/fake-api'
import { openAccordion } from '../testing/open-accordion'
import { openEditor } from '../testing/open-editor'
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
    await openEditor('session')
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
    await openEditor('session')
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
    await openEditor('session')
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
    // Scoped to the entry: the mentions panel now lists the same name as a
    // plain row link, so an unscoped query matches the prose AND the row.
    const entry = await screen.findByLabelText('Entry')
    const link = within(entry).getByRole('link', { name: 'Connie' })
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
    await openEditor()
    await waitFor(() => expect(value('Name')).toBe('Mira'))

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Mira II' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    // A save now carries the kind's typed fields too, at whatever they hold —
    // an NPC that arrived with none sends the empty values for them rather
    // than omitting the keys. Their own coverage is in
    // entity-typed-fields.test.tsx; this asserts the core fields still ride.
    await waitFor(() =>
      expect(api.updateEntity).toHaveBeenCalledWith('w1', 'npc', 'e1', {
        name: 'Mira II',
        description: 'old',
        occupation: '',
        species_id: null,
        culture_id: null,
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
            is_primary: false,
            created_at: '2026-01-01',
          },
        ]),
      ),
    })
    mount(api, '/worlds/w1/npc/e1', 'player')
    expect(await screen.findByAltText('View mira.png full size')).toBeTruthy()
  })

  it('offers a back link to the wiki index, which is where its label says', async () => {
    const api = makeApi({ getEntity: vi.fn(() => Promise.resolve({ id: 'e1', name: 'Mira' })) })
    mount(api, '/worlds/w1/npc/e1', 'player')
    const back = await screen.findByRole('link', { name: 'Back to wiki' })
    // The world root is the dashboard now, so a link reading "Back to wiki"
    // that pointed there would send the reader somewhere else entirely.
    expect(back.getAttribute('href')).toBe('/worlds/w1/wiki')
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
    await openEditor()
    await waitFor(() => expect(value('Name')).toBe('Mira'))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('save boom')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(await screen.findByText('del boom')).toBeTruthy()
  })
})

describe('the collapsed editor', () => {
  const npc = () =>
    makeApi({
      getEntity: vi.fn(() =>
        Promise.resolve({ id: 'e1', name: 'Mira', description: 'a baker', body: 'a baker' }),
      ),
      updateEntity: vi.fn(() => Promise.resolve({ id: 'e1' })),
      deleteEntity: vi.fn(() => Promise.resolve()),
    })

  it('opens readable, with the form and its Delete out of reach', async () => {
    mount(npc(), '/worlds/w1/npc/e1')
    // The prose an owner came to read is the page, not a preview inside a form.
    expect(await screen.findByRole('heading', { name: 'Mira' })).toBeTruthy()
    expect(within(screen.getByLabelText('Entry')).getByText('a baker')).toBeTruthy()
    expect(screen.queryByRole('form', { name: 'Edit entity' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull()
  })

  it('names the pencil, reports its state, and toggles the form both ways', async () => {
    mount(npc(), '/worlds/w1/npc/e1')
    const pencil = await screen.findByRole('button', { name: 'Edit entity' })
    expect(pencil.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(pencil)
    expect(screen.getByRole('form', { name: 'Edit entity' })).toBeTruthy()
    const open = screen.getByRole('button', { name: 'Hide the entity editor' })
    expect(open.getAttribute('aria-expanded')).toBe('true')

    fireEvent.click(open)
    expect(screen.queryByRole('form', { name: 'Edit entity' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Edit entity' })).toBeTruthy()
  })

  it('keeps an in-progress edit when the form is folded away and reopened', async () => {
    mount(npc(), '/worlds/w1/npc/e1')
    await openEditor()
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Mira II' } })

    // Closing is show/hide, not Cancel. An owner who folds the form to re-read
    // the page must find their three paragraphs still there.
    fireEvent.click(screen.getByRole('button', { name: 'Hide the entity editor' }))
    await openEditor()
    expect(value('Name')).toBe('Mira II')
  })

  it('offers a player the same read view and no pencil at all', async () => {
    mount(npc(), '/worlds/w1/npc/e1', 'player')
    expect(await screen.findByRole('heading', { name: 'Mira' })).toBeTruthy()
    expect(within(screen.getByLabelText('Entry')).getByText('a baker')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Edit entity' })).toBeNull()
  })

  it('collapses the session editor the same way, behind its own pencil', async () => {
    const api = makeApi({
      getEntity: vi.fn(() =>
        Promise.resolve({ id: 's1', name: 'Session 1', captured_text: 'recap' }),
      ),
    })
    mount(api, '/worlds/w1/session/s1')
    expect(await screen.findByRole('heading', { name: 'Session 1' })).toBeTruthy()
    expect(within(screen.getByLabelText('Entry')).getByText('recap')).toBeTruthy()
    expect(screen.queryByRole('form', { name: 'Edit session' })).toBeNull()

    await openEditor('session')
    expect(screen.getByRole('form', { name: 'Edit session' })).toBeTruthy()
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
    const entry = await screen.findByLabelText('Entry')
    const link = within(entry).getByRole('link', { name: 'Connie' })
    expect(link.getAttribute('href')).toBe('/worlds/w1/npc/e2')
  })
})

describe('EntityDetailPage — panel headings and rows', () => {
  const api = () =>
    makeApi({
      getEntity: vi.fn(() => Promise.resolve({ id: 'e', name: 'Mara', description: 'd' })),
    })

  it('says "Type" once — as the heading, with the control’s name kept', async () => {
    mount(api(), '/worlds/w1/npc/e', 'owner')
    const panel = await screen.findByRole('region', { name: 'Type' })
    expect(within(panel).getByRole('heading', { name: 'Type' })).toBeTruthy()
    // No <label> repeating the heading; the select still answers to the name.
    expect(panel.querySelector('label')).toBeNull()
    openAccordion('Type')
    expect(within(panel).getByRole('combobox', { name: 'Type' })).toBeTruthy()
  })

  it('opens Type closed, and puts Change type beside the dropdown rather than under it', async () => {
    mount(api(), '/worlds/w1/npc/e', 'owner')
    const panel = await screen.findByRole('region', { name: 'Type' })
    expect(panel.querySelector('details')?.hasAttribute('open')).toBe(false)

    openAccordion('Type')
    // Same flex ROW, so they share a line. The field wrapper is a full-width
    // column, which is what used to push the button onto the next one.
    const row = panel.querySelector('.inline-control')
    expect(row).toBeTruthy()
    expect(row?.querySelector('select')).toBeTruthy()
    expect(row?.querySelector('button')?.textContent).toBe('Change type')
  })
})

describe('EntityDetailPage — change type', () => {
  it('owner reclassifies the entity via the change-type control', async () => {
    const api = makeApi({
      getEntity: vi.fn(() => Promise.resolve({ id: 'e', name: 'Mara', description: 'd' })),
      changeEntityKind: vi.fn(() => Promise.resolve({ id: 'e', kind: 'pc' })),
    })
    mount(api, '/worlds/w1/npc/e', 'owner')
    // Type is a closed accordion now, so its select is out of the accessibility
    // tree until the panel is unfolded. Queried by ROLE and accessible name,
    // which is what proves the hidden visible label kept the name.
    await screen.findByRole('region', { name: 'Type' })
    openAccordion('Type')
    const select = screen.getByRole('combobox', { name: 'Type' }) as HTMLSelectElement
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
    await screen.findByRole('region', { name: 'Type' })
    openAccordion('Type')
    fireEvent.change(screen.getByRole('combobox', { name: 'Type' }), { target: { value: 'pc' } })
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

  it('sits between Type and Who can see this, as two panels rather than one', async () => {
    mount(api(), '/worlds/w1/npc/e1')
    await screen.findByRole('heading', { name: 'Mentioned in this entry' })

    const wanted = ['Type', 'Relationships', 'Mentioned in this entry', 'Who can see this']
    const headings = screen
      .getAllByRole('heading')
      .map((h) => h.textContent ?? '')
      .filter((t) => wanted.includes(t))
    expect(headings).toEqual(wanted)
  })

  it('lists what the SAVED body links to on load', async () => {
    mount(api(), '/worlds/w1/npc/e1')
    const panel = await screen.findByRole('region', { name: 'Mentioned in this entry' })
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
    const panel = await screen.findByRole('region', { name: 'Mentioned in this entry' })
    await waitFor(() =>
      expect(within(panel).getByRole('link', { name: /Silas Crow/ })).toBeTruthy(),
    )

    await openEditor()
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
    const panel = await screen.findByRole('region', { name: 'Mentioned in this entry' })
    expect(within(panel).queryByRole('link')).toBeNull()
  })
})
