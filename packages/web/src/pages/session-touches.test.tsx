import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { type ApiClient, ApiClientError, type Touch } from '../api'
import { ApiProvider } from '../app/api-context'
import { makeApi } from '../testing/fake-api'
import { SessionTouches } from './session-touches'

const touch = (over: Partial<Touch>): Touch => ({
  id: 't1',
  world_id: 'w1',
  session_id: 'se1',
  entity_id: 'n1',
  touch_type: 'met',
  narrative_delta: '',
  created_at: '',
  updated_at: '',
  ...over,
})

const wiki = [
  { kind: 'npc', id: 'n1', name: 'Mira' },
  { kind: 'session', id: 'se1', name: 'Session 1' }, // excluded from the picker
]

function mount(api: ApiClient, isOwner = true): void {
  render(
    <ApiProvider value={api}>
      <MemoryRouter initialEntries={['/worlds/w1']}>
        <Routes>
          <Route
            path="/worlds/:worldId"
            element={<SessionTouches sessionId="se1" isOwner={isOwner} />}
          />
        </Routes>
      </MemoryRouter>
    </ApiProvider>,
  )
}

describe('SessionTouches', () => {
  it('lists touches with resolved entity names; the DM adds and removes', async () => {
    const api = makeApi({
      listTouches: vi.fn(() => Promise.resolve([touch({})])),
      listWiki: vi.fn(() => Promise.resolve(wiki)),
      createTouch: vi.fn(() => Promise.resolve(touch({ id: 't2' }))),
      deleteTouch: vi.fn(() => Promise.resolve()),
    })
    mount(api, true)

    // the existing touch renders with its type + resolved name
    const item = (await screen.findByText('met', { selector: '.touch-type' })).closest('li')
    expect(item?.textContent).toContain('Mira')

    // the picker excludes sessions
    const entitySelect = screen.getByLabelText('Entity') as HTMLSelectElement
    const optionValues = Array.from(entitySelect.options).map((o) => o.value)
    expect(optionValues).toContain('npc:n1')
    expect(optionValues).not.toContain('session:se1')

    // Add is disabled until an entity is chosen
    const addBtn = screen.getByRole('button', { name: 'Add interaction' }) as HTMLButtonElement
    expect(addBtn.disabled).toBe(true)
    fireEvent.change(entitySelect, { target: { value: 'npc:n1' } })
    fireEvent.change(screen.getByLabelText('Interaction type'), { target: { value: 'killed' } })
    expect(addBtn.disabled).toBe(false)
    fireEvent.click(addBtn)
    await waitFor(() =>
      expect(api.createTouch).toHaveBeenCalledWith('w1', 'se1', {
        entityId: 'n1',
        touchType: 'killed',
      }),
    )

    // remove the touch
    fireEvent.click(within(item as HTMLElement).getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(api.deleteTouch).toHaveBeenCalledWith('w1', 'se1', 't1'))
  })

  it('falls back to the entity id when the touched entity is not in the wiki', async () => {
    const api = makeApi({
      listTouches: vi.fn(() => Promise.resolve([touch({ entity_id: 'gone' })])),
      listWiki: vi.fn(() => Promise.resolve(wiki)),
    })
    mount(api, true)
    const item = (await screen.findByText('met', { selector: '.touch-type' })).closest('li')
    expect(item?.textContent).toContain('gone')
  })

  it('is read-only for a player (no form, no remove)', async () => {
    const api = makeApi({
      listTouches: vi.fn(() => Promise.resolve([touch({})])),
      listWiki: vi.fn(() => Promise.resolve(wiki)),
    })
    mount(api, false)
    expect(await screen.findByText('met', { selector: '.touch-type' })).toBeTruthy()
    expect(screen.queryByLabelText('Entity')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull()
  })

  it('shows an empty state, then a load error', async () => {
    const a = makeApi({ listTouches: vi.fn(() => Promise.resolve([])) })
    const first = mount(a, false)
    expect(await screen.findByText('No interactions logged yet.')).toBeTruthy()
    void first

    const b = makeApi({ listTouches: vi.fn(() => Promise.reject(new Error('touch boom'))) })
    mount(b, false)
    expect((await screen.findAllByRole('alert')).map((e) => e.textContent)).toContain('touch boom')
  })

  it('surfaces add and remove errors', async () => {
    const api = makeApi({
      listTouches: vi.fn(() => Promise.resolve([touch({})])),
      listWiki: vi.fn(() => Promise.resolve(wiki)),
      createTouch: vi.fn(() => Promise.reject(new ApiClientError(403, 'forbidden', 'no write'))),
      deleteTouch: vi.fn(() => Promise.reject(new Error('del boom'))),
    })
    mount(api, true)
    await screen.findByText('met', { selector: '.touch-type' })
    fireEvent.change(screen.getByLabelText('Entity'), { target: { value: 'npc:n1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add interaction' }))
    expect((await screen.findByRole('alert')).textContent).toBe('no write')

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    expect((await screen.findByRole('alert')).textContent).toBe('del boom')
  })

  it('ignores a submit with no entity selected (defensive guard)', async () => {
    const api = makeApi({
      listTouches: vi.fn(() => Promise.resolve([])),
      listWiki: vi.fn(() => Promise.resolve(wiki)),
      createTouch: vi.fn(() => Promise.resolve(touch({}))),
    })
    mount(api, true)
    await screen.findByText('No interactions logged yet.')
    // bypass the disabled button — submit the form directly with an empty pick
    fireEvent.submit(screen.getByRole('form', { name: 'Add interaction' }))
    await waitFor(() => expect(api.listTouches).toHaveBeenCalled())
    expect(api.createTouch).not.toHaveBeenCalled()
  })
})
