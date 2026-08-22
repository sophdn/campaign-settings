import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient, MemberRole, WorldExport, WorldView } from '../api'
import { ApiProvider } from '../app/api-context'
import { WorldRoleProvider } from '../app/world-context'
import { makeApi } from '../testing/fake-api'
import { exportFilename, WorldSettingsPage } from './world-settings-page'

/** Where the router ended up, so a rename's redirect is observable. */
function Here(): React.JSX.Element {
  return <p>at {useLocation().pathname}</p>
}

function mount(
  api: ApiClient,
  { role = 'owner', refreshWorld = vi.fn() }: { role?: MemberRole; refreshWorld?: () => void } = {},
): ReturnType<typeof render> {
  return render(
    <ApiProvider value={api}>
      <WorldRoleProvider value={{ worldId: 'chicago', worldName: 'Chicago', role, refreshWorld }}>
        <MemoryRouter initialEntries={['/worlds/chicago/settings']}>
          <Routes>
            <Route path="/worlds/:worldId/settings" element={<WorldSettingsPage />} />
          </Routes>
          <Here />
        </MemoryRouter>
      </WorldRoleProvider>
    </ApiProvider>,
  )
}

const RENAMED: WorldView = {
  id: 'w',
  name: 'VTM Detroit',
  slug: 'vtm-detroit',
  ownerId: 'a',
  role: 'owner',
}

describe('WorldSettingsPage', () => {
  it('renames the world and follows it to its new address', async () => {
    const renameWorld = vi.fn(() => Promise.resolve(RENAMED))
    const refreshWorld = vi.fn()
    mount(makeApi({ renameWorld }), { refreshWorld })

    const field = screen.getByLabelText('Name')
    expect((field as HTMLInputElement).value).toBe('Chicago')
    fireEvent.change(field, { target: { value: 'VTM Detroit' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }))

    await waitFor(() => expect(renameWorld).toHaveBeenCalledWith('chicago', 'VTM Detroit'))
    // The old address is dead the moment the server answers, so the app must
    // move rather than leave the reader on it.
    expect(await screen.findByText('at /worlds/vtm-detroit/settings')).toBeTruthy()
    // and the chrome re-reads the world, so the rail stops showing the old name
    expect(refreshWorld).toHaveBeenCalled()
  })

  it('says the address will change before the rename is confirmed', () => {
    mount(makeApi({}))
    expect(screen.getByText(/web address changes with the name/i)).toBeTruthy()
    expect(screen.getByText(/Links your players have saved/i)).toBeTruthy()
  })

  it('will not send a blank name', () => {
    const renameWorld = vi.fn(() => Promise.resolve(RENAMED))
    mount(makeApi({ renameWorld }))

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: '   ' } })
    const save = screen.getByRole('button', { name: 'Save name' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    fireEvent.click(save)
    expect(renameWorld).not.toHaveBeenCalled()
  })

  it('surfaces a refusal and stays put', async () => {
    const renameWorld = vi.fn(() => Promise.reject(new Error('not the owner')))
    mount(makeApi({ renameWorld }))

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Mine Now' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }))

    expect((await screen.findByRole('alert')).textContent).toBe('not the owner')
    expect(screen.getByText('at /worlds/chicago/settings')).toBeTruthy()
  })

  it('tells a player there is nothing here for them, and offers them no field', () => {
    mount(makeApi({}), { role: 'player' })
    expect(screen.getByText(/Only the GM can change/i)).toBeTruthy()
    expect(screen.queryByLabelText('Name')).toBeNull()
  })
})

describe('WorldSettingsPage — export', () => {
  const EXPORT: WorldExport = { version: 1, tables: { entities: [{ id: 'e1', name: 'Mira' }] } }

  /**
   * jsdom implements neither half of the blob-URL pair, and the component's
   * whole job here is to mint one and hand it to a download link. Stubbing them
   * is what makes the saved BYTES observable — without it the test could only
   * assert that a click happened.
   */
  let revoked: string[] = []
  let blobs = new Map<string, Blob>()
  beforeEach(() => {
    revoked = []
    blobs = new Map()
    let n = 0
    URL.createObjectURL = vi.fn((blob: Blob) => {
      const url = `blob:test/${(n += 1)}`
      blobs.set(url, blob)
      return url
    })
    URL.revokeObjectURL = vi.fn((url: string) => revoked.push(url))
  })

  it('names the file for the world and the day it was taken', () => {
    // Against a fixed date, because the component reads the real clock and an
    // assertion on today's name would be true only today.
    expect(exportFilename('chicago', new Date('2026-08-08T22:30:00Z'))).toBe(
      'chicago-2026-08-08.json',
    )
    expect(exportFilename('vtm-detroit', new Date('2026-01-02T00:00:00Z'))).toBe(
      'vtm-detroit-2026-01-02.json',
    )
  })

  it('saves the world as a real file the browser downloads', async () => {
    const exportWorld = vi.fn(() => Promise.resolve(EXPORT))
    mount(makeApi({ exportWorld }))

    fireEvent.click(screen.getByRole('button', { name: 'Prepare an export' }))
    await waitFor(() => expect(exportWorld).toHaveBeenCalledWith('chicago'))

    // A download link, not JSON rendered into the page — a wall of text on
    // screen is not a copy of anything.
    const link = (await screen.findByRole('link', { name: /^Download / })) as HTMLAnchorElement
    expect(link.getAttribute('download')).toMatch(/^chicago-\d{4}-\d{2}-\d{2}\.json$/)

    // …and the bytes behind it are the export the server sent.
    const saved = blobs.get(link.getAttribute('href') ?? '')
    expect(saved?.type).toBe('application/json')
    expect(JSON.parse(await saved!.text())).toEqual(EXPORT)
  })

  it('revokes the blob URL when the page goes away, so a world is not pinned in memory', async () => {
    const view = mount(makeApi({ exportWorld: vi.fn(() => Promise.resolve(EXPORT)) }))
    fireEvent.click(screen.getByRole('button', { name: 'Prepare an export' }))
    const link = (await screen.findByRole('link', { name: /^Download / })) as HTMLAnchorElement
    const url = link.getAttribute('href') ?? ''

    view.unmount()
    expect(revoked).toContain(url)
  })

  it('surfaces a refused export rather than offering a link to nothing', async () => {
    const exportWorld = vi.fn(() => Promise.reject(new Error('world export requires owner role')))
    mount(makeApi({ exportWorld }))

    fireEvent.click(screen.getByRole('button', { name: 'Prepare an export' }))
    expect(await screen.findByText('world export requires owner role')).toBeTruthy()
    expect(screen.queryByRole('link', { name: /^Download / })).toBeNull()
  })

  it('offers a player no export control at all', () => {
    const exportWorld = vi.fn(() => Promise.resolve(EXPORT))
    mount(makeApi({ exportWorld }), { role: 'player' })

    expect(screen.queryByRole('button', { name: 'Prepare an export' })).toBeNull()
    expect(screen.queryByLabelText('Export this world')).toBeNull()
    expect(exportWorld).not.toHaveBeenCalled()
  })
})
