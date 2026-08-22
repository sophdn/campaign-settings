import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { type ApiClient, ApiClientError, type MemberRole } from '../api'
import { ApiProvider } from '../app/api-context'
import { ConfigProvider } from '../app/config-context'
import { ModalProvider } from '../app/modal/modal-context'
import { WorldRoleProvider } from '../app/world-context'
import { makeApi } from '../testing/fake-api'
import { CurrencyPanel, toDrafts, toStored } from './currency-panel'
import { EntityDetailPage } from './entity-detail-page'

const CROWN = {
  id: 'c1',
  name: 'Crown',
  symbol: 'C',
  denominations: [{ name: 'penny', multiplier: 0.01 }],
  base_rate_to: null,
  rate: null,
}

const OTHERS = [
  { id: 'c1', name: 'Crown' },
  { id: 'c2', name: 'Mark' },
]

function mount(api: ApiClient, role: MemberRole = 'owner'): void {
  render(
    <ApiProvider value={api}>
      <ConfigProvider>
        <ModalProvider>
          <WorldRoleProvider value={{ worldId: 'w1', worldName: 'W', role, refreshWorld: vi.fn() }}>
            <MemoryRouter initialEntries={['/worlds/w1/currency/c1']}>
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

const currencyApi = (entity: Record<string, unknown>, over: Partial<ApiClient> = {}): ApiClient =>
  makeApi({
    getEntity: vi.fn(() => Promise.resolve(entity as never)),
    listEntities: vi.fn(() => Promise.resolve(OTHERS as never)),
    listWiki: vi.fn(() => Promise.resolve([])),
    updateEntity: vi.fn(() => Promise.resolve({ id: 'c1' })),
    ...over,
  })

/**
 * Wait for the panel AND its currency list, which arrive on separate requests.
 * Touching the form before the list lands reads a half-loaded anchor picker.
 */
async function findLoadedPanel(): Promise<HTMLElement> {
  const panel = await screen.findByLabelText('Currency')
  await waitFor(() =>
    expect((screen.getByLabelText('Base currency') as HTMLSelectElement).options.length).toBe(2),
  )
  return panel
}

describe('the stored denomination shape', () => {
  it('round-trips {name, multiplier} — dm-manager’s shape, which the importer copies', () => {
    // A second shape here would make imported and app-authored currencies read
    // differently, since the importer copies dm-manager's blob verbatim.
    expect(toDrafts([{ name: 'penny', multiplier: 0.01 }])).toEqual([
      { name: 'penny', multiplier: '0.01' },
    ])
    expect(toStored([{ name: ' penny ', multiplier: '0.01' }])).toEqual([
      { name: 'penny', multiplier: 0.01 },
    ])
  })

  it('drops unnamed rows and zeroes an unparseable multiplier', () => {
    expect(toStored([{ name: '   ', multiplier: '5' }])).toEqual([])
    expect(toStored([{ name: 'shard', multiplier: 'lots' }])).toEqual([
      { name: 'shard', multiplier: 0 },
    ])
  })

  it('survives a malformed stored blob instead of throwing', () => {
    // jsonb is opaque to the schema, so nothing guarantees the shape.
    expect(toDrafts(null)).toEqual([])
    expect(toDrafts('not an array')).toEqual([])
    expect(toDrafts([null, 42, { multiplier: 3 }, { name: 'ok' }])).toEqual([
      { name: 'ok', multiplier: '' },
    ])
  })
})

describe('currency panel', () => {
  it('edits denominations and saves them in the stored shape', async () => {
    const api = currencyApi(CROWN)
    mount(api)
    await findLoadedPanel()

    expect((screen.getByLabelText('Denomination 1 name') as HTMLInputElement).value).toBe('penny')
    fireEvent.click(screen.getByRole('button', { name: 'Add denomination' }))
    fireEvent.change(screen.getByLabelText('Denomination 2 name'), {
      target: { value: 'shilling' },
    })
    fireEvent.change(screen.getByLabelText('Denomination 2 multiplier'), {
      target: { value: '0.5' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save currency' }))

    await waitFor(() =>
      expect(api.updateEntity).toHaveBeenCalledWith('w1', 'currency', 'c1', {
        denominations: [
          { name: 'penny', multiplier: 0.01 },
          { name: 'shilling', multiplier: 0.5 },
        ],
        base_rate_to: null,
        rate: null,
      }),
    )
  })

  it('removes a denomination row', async () => {
    const api = currencyApi(CROWN)
    mount(api)
    await findLoadedPanel()
    fireEvent.click(screen.getByRole('button', { name: 'Remove 1' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save currency' }))
    await waitFor(() =>
      expect(api.updateEntity).toHaveBeenCalledWith(
        'w1',
        'currency',
        'c1',
        expect.objectContaining({ denominations: [] }),
      ),
    )
  })

  it('never offers a currency itself as its own anchor', async () => {
    // The server refuses a self-anchor; not offering it means the refusal is
    // never the way a person finds out.
    mount(currencyApi(CROWN))
    await findLoadedPanel()
    const select = screen.getByLabelText('Base currency') as HTMLSelectElement
    const labels = [...select.options].map((o) => o.textContent)
    expect(labels).toEqual(['— None —', 'Mark'])
  })

  it('offers a rate only once an anchor is picked, and clears it when dropped', async () => {
    const api = currencyApi({ ...CROWN, base_rate_to: 'c2', rate: 4 })
    mount(api)
    await findLoadedPanel()
    expect((screen.getByLabelText('Rate') as HTMLInputElement).value).toBe('4')

    fireEvent.change(screen.getByLabelText('Base currency'), { target: { value: '' } })
    expect(screen.queryByLabelText('Rate')).toBeNull() // meaningless without an anchor

    fireEvent.click(screen.getByRole('button', { name: 'Save currency' }))
    await waitFor(() =>
      expect(api.updateEntity).toHaveBeenCalledWith(
        'w1',
        'currency',
        'c1',
        expect.objectContaining({ base_rate_to: null, rate: null }),
      ),
    )
  })

  it('surfaces the server’s refusal of a cycle rather than restating the rule', async () => {
    const api = currencyApi(CROWN, {
      updateEntity: vi.fn(() =>
        Promise.reject(
          new ApiClientError(400, 'invalid_currency', 'base_rate_to chain would cycle through c1'),
        ),
      ),
    })
    mount(api)
    await findLoadedPanel()
    fireEvent.change(screen.getByLabelText('Base currency'), { target: { value: 'c2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save currency' }))
    expect((await screen.findByRole('alert')).textContent).toContain('cycle')
  })

  it('shows a player the denominations and the anchor, with no controls', async () => {
    mount(currencyApi({ ...CROWN, base_rate_to: 'c2', rate: 4 }), 'player')
    const panel = await screen.findByLabelText('Currency')
    expect(panel.textContent).toContain('penny')
    expect(panel.textContent).toContain('×0.01')
    // The anchor's NAME comes from the currency list, a second request — so
    // this has to wait for it rather than read a half-loaded panel.
    expect(await screen.findByRole('link', { name: 'Mark' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Save currency' })).toBeNull()
    expect(screen.queryByLabelText('Base currency')).toBeNull()
  })

  it('shows a player nothing at all for a currency with neither', async () => {
    mount(currencyApi({ id: 'c1', name: 'Crown', denominations: [] }), 'player')
    await screen.findByRole('heading', { name: 'Crown' })
    expect(screen.queryByLabelText('Currency')).toBeNull()
  })
})

describe('currency panel edge values', () => {
  it('saves an unparseable rate as no rate rather than as NaN', async () => {
    // The control is type=number, but a paste can still land junk in it, and
    // NaN in a jsonb/numeric column is worse than an absent rate.
    const api = currencyApi({ ...CROWN, base_rate_to: 'c2', rate: 4 })
    mount(api)
    await findLoadedPanel()
    fireEvent.change(screen.getByLabelText('Rate'), { target: { value: 'a few' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save currency' }))
    await waitFor(() =>
      expect(api.updateEntity).toHaveBeenCalledWith(
        'w1',
        'currency',
        'c1',
        expect.objectContaining({ base_rate_to: 'c2', rate: null }),
      ),
    )
  })

  it('falls back to ids and a ? when a currency has no name or no rate', async () => {
    // Nothing guarantees an anchor target still has a name the viewer can see,
    // and an anchor can be set before its rate is.
    const api = makeApi({
      getEntity: vi.fn(() =>
        Promise.resolve({ ...CROWN, base_rate_to: 'c2', rate: null } as never),
      ),
      listEntities: vi.fn(() => Promise.resolve([{ id: 'c2' }] as never)),
      listWiki: vi.fn(() => Promise.resolve([])),
    })
    mount(api, 'player')
    const link = await screen.findByRole('link', { name: 'c2' })
    expect(link.getAttribute('href')).toBe('/worlds/w1/currency/c2')
    expect(screen.getByLabelText('Currency').textContent).toContain('?')
  })

  it('labels an unnamed currency by its id in the anchor picker', async () => {
    const api = makeApi({
      getEntity: vi.fn(() => Promise.resolve(CROWN as never)),
      listEntities: vi.fn(() =>
        Promise.resolve([{ id: 'c1', name: 'Crown' }, { id: 'c9' }] as never),
      ),
      listWiki: vi.fn(() => Promise.resolve([])),
      updateEntity: vi.fn(() => Promise.resolve({ id: 'c1' })),
    })
    mount(api)
    await findLoadedPanel()
    const select = screen.getByLabelText('Base currency') as HTMLSelectElement
    expect([...select.options].map((o) => o.textContent)).toEqual(['— None —', 'c9'])
  })

  /*
    The two halves of what `key={entity.id}` used to buy, now that the render site
    is deliberately unkeyed (bug 1221 — the key duplicated the panel on the built
    SPA). Rendering the panel directly is the point: the `entity` prop has to
    change the way the detail route changes it.
  */
  const MARK = {
    id: 'c2',
    name: 'Mark',
    denominations: [{ name: 'ore', multiplier: 0.02 }],
    base_rate_to: null,
    rate: null,
  }

  const renderPanel = (entity: Record<string, unknown>) => {
    const api = currencyApi(entity)
    const view = render(
      <ApiProvider value={api}>
        <MemoryRouter>
          <CurrencyPanel
            api={api}
            worldId="w1"
            entity={entity as never}
            canEdit
            onSaved={vi.fn()}
          />
        </MemoryRouter>
      </ApiProvider>,
    )
    return { api, view }
  }

  it('re-seeds its drafts when the page moves to a DIFFERENT currency', async () => {
    const { api, view } = renderPanel(CROWN)
    expect(
      (await screen.findByLabelText('Denomination 1 name')) as HTMLInputElement,
    ).toHaveProperty('value', 'penny')

    view.rerender(
      <ApiProvider value={api}>
        <MemoryRouter>
          <CurrencyPanel api={api} worldId="w1" entity={MARK as never} canEdit onSaved={vi.fn()} />
        </MemoryRouter>
      </ApiProvider>,
    )

    // Without the re-seed this would still read 'penny' — the previous currency's
    // half-edited state shown on another currency's page.
    await waitFor(() =>
      expect(screen.getByLabelText('Denomination 1 name')).toHaveProperty('value', 'ore'),
    )
  })

  it('keeps half-typed rows when the parent refetches the SAME currency', async () => {
    // The failure the original comment warned about: a re-seed that fired on every
    // parent refetch would throw away what the DM was in the middle of typing.
    const { api, view } = renderPanel(CROWN)
    await screen.findByLabelText('Denomination 1 name')
    fireEvent.change(screen.getByLabelText('Denomination 1 name'), {
      target: { value: 'half-typed' },
    })

    // A new object with the SAME id, as a refetch produces.
    view.rerender(
      <ApiProvider value={api}>
        <MemoryRouter>
          <CurrencyPanel
            api={api}
            worldId="w1"
            entity={{ ...CROWN } as never}
            canEdit
            onSaved={vi.fn()}
          />
        </MemoryRouter>
      </ApiProvider>,
    )

    expect(screen.getByLabelText('Denomination 1 name')).toHaveProperty('value', 'half-typed')
  })
})
