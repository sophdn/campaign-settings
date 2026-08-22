import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import type { ApiClient, CurrencyAttachment, CurrencyOwnerKind, CurrencyUser, Entity } from '../api'
import { ApiProvider } from '../app/api-context'
import { makeApi } from '../testing/fake-api'
import { CurrencyAttachmentsPanel } from './currency-attachments-panel'
import { CurrencyUsersPanel } from './currency-users-panel'

/**
 * The currencies panel, on both owner kinds, and the inverse list.
 *
 * The suite leans on ONE component serving settlement and organization: the
 * round-trip cases run over both kinds rather than duplicating a block per kind,
 * so a future per-kind fork of the component fails here rather than passing twice
 * over the same code.
 *
 * The player cases assert the ABSENCE of every control. That absence is a
 * courtesy — the server refuses a player's write with a 403 either way, and the
 * HTTP suite proves that — but a panel that renders a Detach button a player
 * cannot use is a panel that reports the wrong thing about their own world.
 */

const IRON: CurrencyAttachment = {
  id: 'ca1',
  ownerId: 'st1',
  isPrimary: true,
  notes: 'minted at the keep',
  visibility: 'public',
  currency: { id: 'cu1', name: 'Iron Mark' },
}

const CROWN: CurrencyAttachment = {
  id: 'ca2',
  ownerId: 'st1',
  isPrimary: false,
  notes: '',
  visibility: 'dm_only',
  currency: { id: 'cu2', name: 'Sunlit Crown' },
}

const CURRENCIES = [
  { id: 'cu1', name: 'Iron Mark' },
  { id: 'cu2', name: 'Sunlit Crown' },
  { id: 'cu3', name: 'The Drowned Penny' },
] as unknown as Entity[]

/** A promise that never settles — for asserting the in-flight guards. */
const pending = <T,>(): Promise<T> => new Promise<T>(() => {})

const OWNER_KINDS: CurrencyOwnerKind[] = ['settlement', 'organization']

function mount(
  attachments: CurrencyAttachment[],
  over: Partial<ApiClient> = {},
  { canEdit = true, ownerKind = 'settlement' as CurrencyOwnerKind } = {},
): ApiClient {
  const api = makeApi({
    listCurrencyAttachments: vi.fn(() => Promise.resolve(attachments)),
    listEntities: vi.fn(() => Promise.resolve(CURRENCIES)),
    ...over,
  })
  render(
    <MemoryRouter>
      <ApiProvider value={api}>
        <CurrencyAttachmentsPanel
          worldId="w1"
          ownerKind={ownerKind}
          ownerId="st1"
          canEdit={canEdit}
        />
      </ApiProvider>
    </MemoryRouter>,
  )
  return api
}

/** The row for a named currency, so assertions cannot drift onto a sibling. */
const rowFor = async (name: string): Promise<HTMLElement> => {
  const link = await screen.findByRole('link', { name })
  const row = link.closest('li')
  if (!row) throw new Error(`no row for ${name}`)
  return row
}

describe('reading the attachments', () => {
  it('lists them on BOTH owner kinds from the one component', async () => {
    for (const ownerKind of OWNER_KINDS) {
      const api = mount([IRON, CROWN], {}, { ownerKind })
      expect(await screen.findByRole('link', { name: 'Iron Mark' })).toBeTruthy()
      expect(screen.getByRole('link', { name: 'Sunlit Crown' })).toBeTruthy()
      expect(api.listCurrencyAttachments).toHaveBeenCalledWith('w1', ownerKind, 'st1')
      // Torn down between iterations rather than left stacked: two panels in one
      // document would make every `findByRole` below ambiguous.
      cleanup()
    }
  })

  it('marks the primary one', async () => {
    mount([IRON, CROWN])
    expect(within(await rowFor('Iron Mark')).getByText('Primary')).toBeTruthy()
    expect(within(await rowFor('Sunlit Crown')).queryByText('Primary')).toBeNull()
  })

  it('offers no "Make primary" on the row that already is one', async () => {
    mount([IRON, CROWN])
    expect(screen.queryByRole('button', { name: 'Make Iron Mark primary' })).toBeNull()
    expect(await screen.findByRole('button', { name: 'Make Sunlit Crown primary' })).toBeTruthy()
  })

  it('says so when there is nothing attached', async () => {
    mount([])
    expect(await screen.findByText('No currencies attached yet.')).toBeTruthy()
  })

  it('surfaces a failed read rather than rendering an empty list', async () => {
    mount([], { listCurrencyAttachments: vi.fn(() => Promise.reject(new Error('boom'))) })
    expect(await screen.findByRole('alert')).toBeTruthy()
  })
})

describe('attaching', () => {
  it('attaches the chosen currency and reloads', async () => {
    const api = mount([IRON])
    const select = await screen.findByLabelText('Attach a currency')
    fireEvent.change(select, { target: { value: 'cu2' } })
    fireEvent.change(screen.getByLabelText('Notes for the new attachment'), {
      target: { value: 'smugglers only' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Attach' }))

    await waitFor(() =>
      expect(api.attachCurrency).toHaveBeenCalledWith('w1', 'settlement', 'st1', {
        currencyId: 'cu2',
        notes: 'smugglers only',
      }),
    )
    // The list is re-read rather than patched locally: the server decides what a
    // row looks like, including which one is now primary.
    await waitFor(() => expect(api.listCurrencyAttachments).toHaveBeenCalledTimes(2))
  })

  it('omits empty notes rather than sending an empty string', async () => {
    const api = mount([])
    fireEvent.change(await screen.findByLabelText('Attach a currency'), {
      target: { value: 'cu1' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Attach' }))
    await waitFor(() =>
      expect(api.attachCurrency).toHaveBeenCalledWith('w1', 'settlement', 'st1', {
        currencyId: 'cu1',
      }),
    )
  })

  it('does not offer a currency that is already attached', async () => {
    mount([IRON])
    const select = (await screen.findByLabelText('Attach a currency')) as HTMLSelectElement
    const values = [...select.options].map((o) => o.value)
    expect(values).not.toContain('cu1')
    expect(values).toContain('cu2')
  })

  it('says so when every currency is already attached', async () => {
    mount([IRON, CROWN, { ...IRON, id: 'ca3', currency: { id: 'cu3', name: 'The Drowned Penny' } }])
    expect(
      await screen.findByText('Every currency in this world is already attached here.'),
    ).toBeTruthy()
  })

  it('says so when the world has no currencies at all', async () => {
    mount([], { listEntities: vi.fn(() => Promise.resolve([])) })
    expect(
      await screen.findByText('This world has no currencies yet. Create one to attach it here.'),
    ).toBeTruthy()
  })

  it('ignores a second click while the first attach is in flight', async () => {
    // The guard matters because the success path reloads the list: two attaches
    // of the same currency would make the second a 409 the user never asked for.
    const api = mount([], { attachCurrency: vi.fn(() => pending<never>()) })
    fireEvent.change(await screen.findByLabelText('Attach a currency'), {
      target: { value: 'cu1' },
    })
    const button = screen.getByRole('button', { name: 'Attach' })
    fireEvent.click(button)
    fireEvent.click(button)
    await waitFor(() => expect(api.attachCurrency).toHaveBeenCalledTimes(1))
  })

  it('falls back to the id for a currency with no name', async () => {
    mount([], {
      listEntities: vi.fn(() => Promise.resolve([{ id: 'cu9' }] as unknown as Entity[])),
    })
    const select = (await screen.findByLabelText('Attach a currency')) as HTMLSelectElement
    expect([...select.options].map((o) => o.textContent)).toEqual(['Choose one…', 'cu9'])
  })

  it('surfaces a refused attach — the server still guards the duplicate', async () => {
    mount([], { attachCurrency: vi.fn(() => Promise.reject(new Error('already attached'))) })
    fireEvent.change(await screen.findByLabelText('Attach a currency'), {
      target: { value: 'cu1' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Attach' }))
    expect(await screen.findByRole('alert')).toBeTruthy()
  })
})

describe('editing a row', () => {
  it('promotes one to primary', async () => {
    const api = mount([IRON, CROWN])
    fireEvent.click(await screen.findByRole('button', { name: 'Make Sunlit Crown primary' }))
    await waitFor(() =>
      expect(api.updateCurrencyAttachment).toHaveBeenCalledWith('w1', 'settlement', 'ca2', {
        isPrimary: true,
      }),
    )
  })

  it('saves notes, and offers no Save until they change', async () => {
    const api = mount([IRON])
    await rowFor('Iron Mark')
    expect(screen.queryByRole('button', { name: 'Save notes for Iron Mark' })).toBeNull()

    fireEvent.change(screen.getByLabelText('Notes for Iron Mark'), {
      target: { value: 'and at the mint' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save notes for Iron Mark' }))
    await waitFor(() =>
      expect(api.updateCurrencyAttachment).toHaveBeenCalledWith('w1', 'settlement', 'ca1', {
        notes: 'and at the mint',
      }),
    )
  })

  it('detaches', async () => {
    const api = mount([IRON])
    fireEvent.click(await screen.findByRole('button', { name: 'Detach Iron Mark' }))
    await waitFor(() => expect(api.detachCurrency).toHaveBeenCalledWith('w1', 'settlement', 'ca1'))
  })

  it('ignores a second click while the first row write is in flight', async () => {
    const api = mount([IRON], { detachCurrency: vi.fn(() => pending<void>()) })
    const button = await screen.findByRole('button', { name: 'Detach Iron Mark' })
    fireEvent.click(button)
    fireEvent.click(button)
    await waitFor(() => expect(api.detachCurrency).toHaveBeenCalledTimes(1))
  })

  it('surfaces a failed write on the row it belongs to', async () => {
    mount([IRON, CROWN], {
      detachCurrency: vi.fn(() => Promise.reject(new Error('nope'))),
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Detach Iron Mark' }))
    await waitFor(() => expect(within(screen.getByRole('alert')).queryByText(/nope/)).toBeTruthy())
  })
})

describe('per-row visibility', () => {
  it('shows the row’s own level, using the shared labels', async () => {
    mount([IRON, CROWN])
    const iron = within(await rowFor('Iron Mark')).getByLabelText(
      'Iron Mark visibility',
    ) as HTMLSelectElement
    expect(iron.value).toBe('public')
    const crown = within(await rowFor('Sunlit Crown')).getByLabelText(
      'Sunlit Crown visibility',
    ) as HTMLSelectElement
    expect(crown.value).toBe('dm_only')
    // The copy comes from `visibility-panel.tsx` rather than a second list here.
    expect([...iron.options].map((o) => o.textContent)).toEqual([
      'Everyone in the world',
      'Only you (GM)',
    ])
  })

  it('does NOT offer restricted — no ACL can grant an attachment row', async () => {
    mount([IRON])
    const select = within(await rowFor('Iron Mark')).getByLabelText(
      'Iron Mark visibility',
    ) as HTMLSelectElement
    expect([...select.options].map((o) => o.value)).toEqual(['public', 'dm_only'])
  })

  it('changes the level', async () => {
    const api = mount([IRON])
    fireEvent.change(within(await rowFor('Iron Mark')).getByLabelText('Iron Mark visibility'), {
      target: { value: 'dm_only' },
    })
    await waitFor(() =>
      expect(api.updateCurrencyAttachment).toHaveBeenCalledWith('w1', 'settlement', 'ca1', {
        visibility: 'dm_only',
      }),
    )
  })
})

describe('a player', () => {
  it('sees the rows and their notes, and no control at all', async () => {
    mount([IRON, CROWN], {}, { canEdit: false })
    expect(await screen.findByRole('link', { name: 'Iron Mark' })).toBeTruthy()
    expect(screen.getByText('minted at the keep')).toBeTruthy()

    expect(screen.queryByRole('button', { name: 'Detach Iron Mark' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Make Sunlit Crown primary' })).toBeNull()
    expect(screen.queryByLabelText('Iron Mark visibility')).toBeNull()
    expect(screen.queryByLabelText('Notes for Iron Mark')).toBeNull()
    expect(screen.queryByLabelText('Attach a currency')).toBeNull()
  })

  it('still sees which one is primary', async () => {
    mount([IRON, CROWN], {}, { canEdit: false })
    expect(within(await rowFor('Iron Mark')).getByText('Primary')).toBeTruthy()
  })

  it('gets copy that does not imply they could attach one', async () => {
    mount([], {}, { canEdit: false })
    expect(await screen.findByText('No currencies are recorded for this entry.')).toBeTruthy()
  })
})

describe('the owner changing identity', () => {
  it('re-reads when the panel moves to another owner', async () => {
    const api = makeApi({
      listCurrencyAttachments: vi.fn(() => Promise.resolve([IRON])),
      listEntities: vi.fn(() => Promise.resolve(CURRENCIES)),
    })
    const view = render(
      <MemoryRouter>
        <ApiProvider value={api}>
          <CurrencyAttachmentsPanel
            worldId="w1"
            ownerKind="settlement"
            ownerId="st1"
            canEdit={true}
          />
        </ApiProvider>
      </MemoryRouter>,
    )
    await screen.findByRole('link', { name: 'Iron Mark' })

    view.rerender(
      <MemoryRouter>
        <ApiProvider value={api}>
          <CurrencyAttachmentsPanel
            worldId="w1"
            ownerKind="settlement"
            ownerId="st2"
            canEdit={true}
          />
        </ApiProvider>
      </MemoryRouter>,
    )
    await waitFor(() =>
      expect(api.listCurrencyAttachments).toHaveBeenCalledWith('w1', 'settlement', 'st2'),
    )
  })

  it('re-reads when the owner is RECLASSIFIED, which keeps its id', async () => {
    // `change-kind.ts` clears the old kind's attachment rows on reclassify, so a
    // settlement that becomes an organization must not keep showing them. The id
    // does not change, so the KIND has to be in the fetcher's identity.
    const api = makeApi({
      listCurrencyAttachments: vi.fn((_w: string, kind: CurrencyOwnerKind) =>
        Promise.resolve(kind === 'settlement' ? [IRON] : []),
      ) as unknown as ApiClient['listCurrencyAttachments'],
      listEntities: vi.fn(() => Promise.resolve(CURRENCIES)),
    })
    const panel = (ownerKind: CurrencyOwnerKind): React.JSX.Element => (
      <MemoryRouter>
        <ApiProvider value={api}>
          <CurrencyAttachmentsPanel
            worldId="w1"
            ownerKind={ownerKind}
            ownerId="st1"
            canEdit={true}
          />
        </ApiProvider>
      </MemoryRouter>
    )
    const view = render(panel('settlement'))
    await screen.findByRole('link', { name: 'Iron Mark' })

    view.rerender(panel('organization'))
    expect(await screen.findByText('No currencies attached yet.')).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'Iron Mark' })).toBeNull()
  })
})

const USERS: CurrencyUser[] = [
  {
    attachmentId: 'ca1',
    ownerKind: 'organization',
    ownerId: 'og1',
    ownerName: 'The Merchants Guild',
    isPrimary: true,
    notes: 'reckons in it',
    visibility: 'public',
  },
  {
    attachmentId: 'ca2',
    ownerKind: 'settlement',
    ownerId: 'st1',
    ownerName: 'Blackmoor Hold',
    isPrimary: false,
    notes: '',
    visibility: 'public',
  },
]

function mountUsers(users: CurrencyUser[], over: Partial<ApiClient> = {}): ApiClient {
  const api = makeApi({ listCurrencyUsers: vi.fn(() => Promise.resolve(users)), ...over })
  render(
    <MemoryRouter>
      <ApiProvider value={api}>
        <CurrencyUsersPanel worldId="w1" currencyId="cu1" />
      </ApiProvider>
    </MemoryRouter>,
  )
  return api
}

describe('the inverse list on a currency page', () => {
  it('names both owner kinds, links each, and marks the primary ones', async () => {
    mountUsers(USERS)
    const guild = await screen.findByRole('link', { name: 'The Merchants Guild' })
    expect(guild.getAttribute('href')).toBe('/worlds/w1/organization/og1')
    expect(screen.getByRole('link', { name: 'Blackmoor Hold' }).getAttribute('href')).toBe(
      '/worlds/w1/settlement/st1',
    )
    expect(within(guild.closest('li')!).getByText('Primary')).toBeTruthy()
  })

  it('shows a user’s notes when there are any', async () => {
    mountUsers(USERS)
    expect(await screen.findByText('reckons in it')).toBeTruthy()
  })

  it('says so when nowhere uses it', async () => {
    mountUsers([])
    expect(await screen.findByText('Nowhere in this world uses this currency yet.')).toBeTruthy()
  })

  it('offers no controls — attaching happens on the owner’s page', async () => {
    mountUsers(USERS)
    await screen.findByRole('link', { name: 'The Merchants Guild' })
    expect(screen.queryAllByRole('button')).toEqual([])
  })

  it('surfaces a failed read', async () => {
    mountUsers([], { listCurrencyUsers: vi.fn(() => Promise.reject(new Error('boom'))) })
    expect(await screen.findByRole('alert')).toBeTruthy()
  })
})
