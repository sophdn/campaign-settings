import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import type { ApiClient, MemberRole, MemberView } from '../api'
import { ApiProvider } from '../app/api-context'
import { ConfigProvider } from '../app/config-context'
import { ModalProvider } from '../app/modal/modal-context'
import { WorldRoleProvider } from '../app/world-context'
import { makeApi } from '../testing/fake-api'
import { openEditor } from '../testing/open-editor'
import { EntityDetailPage } from './entity-detail-page'

function mount(api: ApiClient, path: string, role: MemberRole = 'owner'): void {
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

/** The wiki corpus a ref picker draws its options from. */
const WIKI = [
  { kind: 'species', id: 'sp1', name: 'Elf' },
  { kind: 'species', id: 'sp2', name: 'Dwarf' },
  { kind: 'culture', id: 'cu1', name: 'Coastfolk' },
]

const val = (label: string): string =>
  (screen.getByLabelText(label) as HTMLInputElement | HTMLSelectElement).value

describe('typed field editor', () => {
  it('renders an NPC’s registry fields and saves them alongside name + description', async () => {
    const api = makeApi({
      getEntity: vi.fn(() =>
        Promise.resolve({
          id: 'n1',
          name: 'Aelin',
          description: 'a baker',
          occupation: 'Baker',
          species_id: 'sp1',
          culture_id: null,
        }),
      ),
      updateEntity: vi.fn(() => Promise.resolve({ id: 'n1' })),
      listWiki: vi.fn(() => Promise.resolve(WIKI)),
    })
    mount(api, '/worlds/w1/npc/n1')
    await openEditor()

    await waitFor(() => expect(val('Name')).toBe('Aelin'))
    expect(val('Occupation')).toBe('Baker')
    expect(val('Species')).toBe('sp1')
    expect(val('Culture')).toBe('') // null reads as the "None" option, not "null"

    fireEvent.change(screen.getByLabelText('Occupation'), { target: { value: 'Guard' } })
    fireEvent.change(screen.getByLabelText('Species'), { target: { value: 'sp2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      expect(api.updateEntity).toHaveBeenCalledWith('w1', 'npc', 'n1', {
        name: 'Aelin',
        description: 'a baker',
        occupation: 'Guard',
        species_id: 'sp2',
        culture_id: null,
      }),
    )
  })

  it('offers a settlement’s axes as their labels and saves the stored values', async () => {
    const api = makeApi({
      getEntity: vi.fn(() =>
        Promise.resolve({ id: 's1', name: 'Harbour', size: 'town', wealth: '', population: 0 }),
      ),
      updateEntity: vi.fn(() => Promise.resolve({ id: 's1' })),
      listWiki: vi.fn(() => Promise.resolve(WIKI)),
    })
    mount(api, '/worlds/w1/settlement/s1')
    await openEditor()

    await waitFor(() => expect(val('Size')).toBe('town'))
    const size = screen.getByLabelText('Size') as HTMLSelectElement
    expect([...size.options].map((o) => o.textContent)).toEqual([
      '— None —',
      'Hamlet',
      'Village',
      'Town',
      'City',
      'Kingdom / capital',
    ])

    fireEvent.change(screen.getByLabelText('Size'), { target: { value: 'city' } })
    fireEvent.change(screen.getByLabelText('Wealth'), { target: { value: 'rich' } })
    fireEvent.change(screen.getByLabelText('Population'), { target: { value: '4200' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      expect(api.updateEntity).toHaveBeenCalledWith(
        'w1',
        'settlement',
        's1',
        expect.objectContaining({ size: 'city', wealth: 'rich', population: 4200 }),
      ),
    )
  })

  it('edits booleans as checkboxes and sends them as booleans', async () => {
    const api = makeApi({
      getEntity: vi.fn(() =>
        Promise.resolve({ id: 'sp1', name: 'Wisp', is_corporeal: true, is_sentient: false }),
      ),
      updateEntity: vi.fn(() => Promise.resolve({ id: 'sp1' })),
      listWiki: vi.fn(() => Promise.resolve(WIKI)),
    })
    mount(api, '/worlds/w1/species/sp1')
    await openEditor()

    await waitFor(() => expect(screen.getByLabelText('Corporeal')).toBeTruthy())
    expect((screen.getByLabelText('Corporeal') as HTMLInputElement).checked).toBe(true)
    expect((screen.getByLabelText('Sentient') as HTMLInputElement).checked).toBe(false)

    // Both directions: one box off, the other on. Checking a box that starts
    // false is the direction a "skip the empties" save would silently drop.
    fireEvent.click(screen.getByLabelText('Corporeal'))
    fireEvent.click(screen.getByLabelText('Sentient'))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      expect(api.updateEntity).toHaveBeenCalledWith(
        'w1',
        'species',
        'sp1',
        expect.objectContaining({ is_corporeal: false, is_sentient: true }),
      ),
    )
  })

  it('edits prose fields as textareas and hints a checkbox without breaking its name', async () => {
    const api = makeApi({
      getEntity: vi.fn(() =>
        Promise.resolve({
          id: 'm1',
          name: 'Tidecalling',
          cost_summary: 'a year of your voice',
          is_taught: true,
        }),
      ),
      updateEntity: vi.fn(() => Promise.resolve({ id: 'm1' })),
      listWiki: vi.fn(() => Promise.resolve([])),
    })
    mount(api, '/worlds/w1/magic_system/m1')
    await openEditor()

    // `cost_summary` is a textarea in the registry, so it gets the multi-line
    // control rather than a single-line input.
    const cost = (await screen.findByLabelText('Cost')) as HTMLTextAreaElement
    expect(cost.tagName).toBe('TEXTAREA')
    expect(cost.value).toBe('a year of your voice')

    // A checkbox with a hint keeps "Taught" as its whole accessible name.
    const taught = screen.getByLabelText('Taught') as HTMLInputElement
    expect(taught.type).toBe('checkbox')
    expect(taught.checked).toBe(true)
    const describedBy = taught.getAttribute('aria-describedby')
    expect(document.getElementById(describedBy!)?.textContent).toContain('born into')

    fireEvent.change(cost, { target: { value: 'a memory' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(api.updateEntity).toHaveBeenCalledWith(
        'w1',
        'magic_system',
        'm1',
        expect.objectContaining({ cost_summary: 'a memory', is_taught: true }),
      ),
    )
  })

  it('shows a field’s hint without swallowing its accessible name', async () => {
    // The hint is described-by, not part of the label — otherwise the field's
    // accessible name would be "Kind free-form, soft taxonomy: …".
    const api = makeApi({
      getEntity: vi.fn(() => Promise.resolve({ id: 'r1', name: 'Iron' })),
      listWiki: vi.fn(() => Promise.resolve([])),
    })
    mount(api, '/worlds/w1/resource/r1')
    await openEditor()

    const field = await screen.findByLabelText('Scarcity')
    expect(field).toBeTruthy()
    const describedBy = field.getAttribute('aria-describedby')
    expect(describedBy).toBeTruthy()
    expect(document.getElementById(describedBy!)?.textContent).toContain('abundant')
  })

  it('renders no extra controls for a kind with no typed fields', async () => {
    const api = makeApi({
      getEntity: vi.fn(() => Promise.resolve({ id: 'i1', name: 'Sword' })),
      listWiki: vi.fn(() => Promise.resolve([])),
    })
    mount(api, '/worlds/w1/item/i1')
    await openEditor()
    await waitFor(() => expect(val('Name')).toBe('Sword'))
    expect(screen.queryByLabelText('Occupation')).toBeNull()
    expect(screen.queryByLabelText('Size')).toBeNull()
  })
})

const JOINED = '2026-01-01T00:00:00.000Z'
const MEMBERS: MemberView[] = [
  { accountId: 'a-dm', username: 'dm', role: 'owner', joinedAt: JOINED },
  { accountId: 'a-mira', username: 'mira', role: 'player', joinedAt: JOINED },
  { accountId: 'a-sam', username: 'sam', role: 'player', joinedAt: JOINED },
]

describe('the PC “Played by” picker', () => {
  it('offers this world’s players by username and saves the account id', async () => {
    const api = makeApi({
      getEntity: vi.fn(() => Promise.resolve({ id: 'p1', name: 'Roland', account_id: null })),
      updateEntity: vi.fn(() => Promise.resolve({ id: 'p1' })),
      listWiki: vi.fn(() => Promise.resolve(WIKI)),
      listMembers: vi.fn(() => Promise.resolve(MEMBERS)),
    })
    mount(api, '/worlds/w1/pc/p1')
    await openEditor()

    await waitFor(() => expect(val('Played by')).toBe(''))
    const options = Array.from(
      (screen.getByLabelText('Played by') as HTMLSelectElement).options,
    ).map((o) => o.textContent)
    // Players only — the GM does not play one of the party's characters — plus
    // an explicit way to leave it unclaimed.
    expect(options).toEqual(['— Nobody —', 'mira', 'sam'])

    fireEvent.change(screen.getByLabelText('Played by'), { target: { value: 'a-sam' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      expect(api.updateEntity).toHaveBeenCalledWith(
        'w1',
        'pc',
        'p1',
        expect.objectContaining({ account_id: 'a-sam' }),
      ),
    )
  })

  it('says the world has no players rather than offering an empty list', async () => {
    const api = makeApi({
      getEntity: vi.fn(() => Promise.resolve({ id: 'p1', name: 'Roland', account_id: null })),
      listWiki: vi.fn(() => Promise.resolve(WIKI)),
      listMembers: vi.fn(() => Promise.resolve([MEMBERS[0]!])),
    })
    mount(api, '/worlds/w1/pc/p1')
    await openEditor()

    await waitFor(() =>
      expect(
        Array.from((screen.getByLabelText('Played by') as HTMLSelectElement).options).map(
          (o) => o.textContent,
        ),
      ).toEqual(['No players in this world yet']),
    )
  })

  it('fetches members only for a kind that has somewhere to put them', async () => {
    // Asserted from the PLAYER view: an owner's page also loads members for the
    // visibility panel, which would mask whether this hook fired at all.
    const onNpc = vi.fn(() => Promise.resolve(MEMBERS))
    mount(
      makeApi({
        getEntity: vi.fn(() => Promise.resolve({ id: 'n1', name: 'Aelin' })),
        listWiki: vi.fn(() => Promise.resolve(WIKI)),
        listMembers: onNpc,
      }),
      '/worlds/w1/npc/n1',
      'player',
    )
    await waitFor(() => expect(screen.getByText('Aelin')).toBeTruthy())
    expect(onNpc).not.toHaveBeenCalled()

    const onPc = vi.fn(() => Promise.resolve(MEMBERS))
    mount(
      makeApi({
        getEntity: vi.fn(() => Promise.resolve({ id: 'p1', name: 'Roland', account_id: 'a-mira' })),
        listWiki: vi.fn(() => Promise.resolve(WIKI)),
        listMembers: onPc,
      }),
      '/worlds/w1/pc/p1',
      'player',
    )
    await waitFor(() => expect(onPc).toHaveBeenCalledWith('w1'))
  })

  it('shows a player the username, never the account id', async () => {
    const api = makeApi({
      getEntity: vi.fn(() => Promise.resolve({ id: 'p1', name: 'Roland', account_id: 'a-mira' })),
      listWiki: vi.fn(() => Promise.resolve(WIKI)),
      listMembers: vi.fn(() => Promise.resolve(MEMBERS)),
    })
    mount(api, '/worlds/w1/pc/p1', 'player')

    expect(await screen.findByText('Played by')).toBeTruthy()
    expect(screen.getByText('mira')).toBeTruthy()
    expect(screen.queryByText('a-mira')).toBeNull()
  })

  it('drops the row when the linked account is no longer a member', async () => {
    // Same rule the entity refs follow: an id is not a fallback rendering of a
    // name, it is a leak of the one field a page has no business showing.
    const api = makeApi({
      getEntity: vi.fn(() => Promise.resolve({ id: 'p1', name: 'Roland', account_id: 'a-gone' })),
      listWiki: vi.fn(() => Promise.resolve(WIKI)),
      listMembers: vi.fn(() => Promise.resolve(MEMBERS)),
    })
    mount(api, '/worlds/w1/pc/p1', 'player')

    await waitFor(() => expect(screen.getByText('Roland')).toBeTruthy())
    expect(screen.queryByText('Played by')).toBeNull()
    expect(screen.queryByText('a-gone')).toBeNull()
  })
})

describe('typed fields on the player read view', () => {
  it('lists the set fields with their labels and resolves a ref to a link', async () => {
    const api = makeApi({
      getEntity: vi.fn(() =>
        Promise.resolve({
          id: 'n1',
          name: 'Aelin',
          description: 'a baker',
          occupation: 'Baker',
          species_id: 'sp1',
          culture_id: null,
        }),
      ),
      listWiki: vi.fn(() => Promise.resolve(WIKI)),
    })
    mount(api, '/worlds/w1/npc/n1', 'player')

    expect(await screen.findByText('Occupation')).toBeTruthy()
    expect(screen.getByText('Baker')).toBeTruthy()
    const link = screen.getByRole('link', { name: 'Elf' })
    expect(link.getAttribute('href')).toBe('/worlds/w1/species/sp1')
    // An unset field is not listed at all rather than shown blank.
    expect(screen.queryByText('Culture')).toBeNull()
  })

  it('drops a ref the viewer cannot resolve instead of printing a bare id', async () => {
    // The species is restricted or deleted, so it is absent from the viewer's
    // wiki corpus — the name is exactly what the visibility filter protects.
    const api = makeApi({
      getEntity: vi.fn(() =>
        Promise.resolve({ id: 'n1', name: 'Aelin', species_id: 'secret-species' }),
      ),
      listWiki: vi.fn(() => Promise.resolve([])),
    })
    mount(api, '/worlds/w1/npc/n1', 'player')

    await screen.findByRole('heading', { name: 'Aelin' })
    expect(screen.queryByText('Species')).toBeNull()
    expect(screen.queryByText('secret-species')).toBeNull()
  })

  it('shows a settlement’s axis LABEL, not the stored value', async () => {
    const api = makeApi({
      getEntity: vi.fn(() => Promise.resolve({ id: 's1', name: 'Harbour', size: 'city' })),
      listWiki: vi.fn(() => Promise.resolve([])),
    })
    mount(api, '/worlds/w1/settlement/s1', 'player')
    expect(await screen.findByText('City')).toBeTruthy()
  })

  it('lists a boolean either way, because false is an answer', async () => {
    const api = makeApi({
      getEntity: vi.fn(() =>
        Promise.resolve({ id: 'sp1', name: 'Wisp', is_corporeal: false, is_sentient: true }),
      ),
      listWiki: vi.fn(() => Promise.resolve([])),
    })
    mount(api, '/worlds/w1/species/sp1', 'player')
    await screen.findByRole('heading', { name: 'Wisp' })
    const details = screen.getByLabelText('Details')
    expect(details.textContent).toContain('Corporeal')
    expect(details.textContent).toContain('No')
    expect(details.textContent).toContain('Sentient')
    expect(details.textContent).toContain('Yes')
  })
})

describe('imported metadata', () => {
  it('is offered to an owner when the entity carries some', async () => {
    const api = makeApi({
      getEntity: vi.fn(() =>
        Promise.resolve({ id: 'n1', name: 'Aelin', imported_metadata: { source_id: 'legacy-42' } }),
      ),
      listWiki: vi.fn(() => Promise.resolve([])),
    })
    mount(api, '/worlds/w1/npc/n1')
    await openEditor()
    expect(await screen.findByText('Imported metadata')).toBeTruthy()
    expect(screen.getByText(/legacy-42/)).toBeTruthy()
  })

  it('is absent when there is none, and never shown to a player', async () => {
    const none = makeApi({
      getEntity: vi.fn(() => Promise.resolve({ id: 'n1', name: 'Aelin' })),
      listWiki: vi.fn(() => Promise.resolve([])),
    })
    mount(none, '/worlds/w1/npc/n1')
    await screen.findByLabelText('Name')
    expect(screen.queryByText('Imported metadata')).toBeNull()
  })

  it('stays owner-only — it can hold detail curated out of the visible entity', async () => {
    const api = makeApi({
      getEntity: vi.fn(() =>
        Promise.resolve({ id: 'n1', name: 'Aelin', imported_metadata: { secret: 'legacy-42' } }),
      ),
      listWiki: vi.fn(() => Promise.resolve([])),
    })
    mount(api, '/worlds/w1/npc/n1', 'player')
    await screen.findByRole('heading', { name: 'Aelin' })
    expect(screen.queryByText('Imported metadata')).toBeNull()
    expect(screen.queryByText(/legacy-42/)).toBeNull()
  })
})

describe('typed field edge cases', () => {
  it('treats an empty imported-metadata object as none at all', async () => {
    // The importer writes `{}` for a row it found nothing extra on; a
    // disclosure control that expands to two braces is noise, not provenance.
    const api = makeApi({
      getEntity: vi.fn(() => Promise.resolve({ id: 'n1', name: 'Aelin', imported_metadata: {} })),
      listWiki: vi.fn(() => Promise.resolve([])),
    })
    mount(api, '/worlds/w1/npc/n1')
    await openEditor()
    await waitFor(() => expect(val('Name')).toBe('Aelin'))
    expect(screen.queryByText('Imported metadata')).toBeNull()
  })

  it('renders a hintless checkbox and a hintless value field without one', async () => {
    // `is_sentient` carries no hint where `is_taught` does; both must render.
    const api = makeApi({
      getEntity: vi.fn(() => Promise.resolve({ id: 'sp1', name: 'Wisp', is_sentient: true })),
      listWiki: vi.fn(() => Promise.resolve([])),
    })
    mount(api, '/worlds/w1/species/sp1')
    await openEditor()
    const sentient = await screen.findByLabelText('Sentient')
    expect(sentient.getAttribute('aria-describedby')).toBeNull()
    expect((screen.getByLabelText('Kingdom') as HTMLInputElement).type).toBe('text')
  })
})
