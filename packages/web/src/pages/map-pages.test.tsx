import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type ApiClient,
  ApiClientError,
  type MapPin,
  type MapWithImage,
  type MemberRole,
  type WorldMap,
} from '../api'
import { ApiProvider } from '../app/api-context'
import { WorldRoleProvider } from '../app/world-context'
import { makeApi } from '../testing/fake-api'
import { MapDetailPage } from './map-detail-page'
import { EntityMaps, MapsPage } from './maps-page'

/**
 * The maps index and one map's page.
 *
 * Nothing here filters pins: every pin that reaches the page has already had
 * its target resolved server-side, and a pin naming an entity the reader may
 * not see never arrives. Re-filtering in the browser would be a second place
 * that could disagree with the first.
 */

const MAP: WorldMap = {
  id: 'map1',
  world_id: 'w1',
  name: 'Saltmarsh',
  description: 'The town and its harbour.',
  visibility: 'public',
  source_width: 1000,
  source_height: 500,
  created_at: '2026-01-01',
}

const PIN: MapPin = {
  id: 'pin1',
  map_id: 'map1',
  entity_id: 'e1',
  x: 0.25,
  y: 0.5,
  label: null,
  target: { kind: 'npc', id: 'e1', name: 'The Harbourmaster' },
}

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      disconnect(): void {}
    },
  )
  HTMLElement.prototype.setPointerCapture = (): void => {}
})

function mount(api: ApiClient, path: string, role: MemberRole = 'owner'): void {
  render(
    <ApiProvider value={api}>
      <WorldRoleProvider value={{ worldId: 'w1', worldName: 'W', role, refreshWorld: vi.fn() }}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/worlds/:worldId/maps" element={<MapsPage />} />
            <Route path="/worlds/:worldId/maps/:mapId" element={<MapDetailPage />} />
            <Route path="/worlds/:worldId/:kind/:id" element={<h1>Entity page</h1>} />
          </Routes>
        </MemoryRouter>
      </WorldRoleProvider>
    </ApiProvider>,
  )
}

describe('MapsPage', () => {
  it('lists the world’s maps and links to each', async () => {
    const api = makeApi({ listMaps: vi.fn(() => Promise.resolve([MAP])) })
    mount(api, '/worlds/w1/maps')

    const link = await screen.findByRole('link', { name: /Saltmarsh/ })
    expect(link.getAttribute('href')).toBe('/worlds/w1/maps/map1')
  })

  it('marks a GM-only map so the DM can see at a glance what players cannot', async () => {
    const api = makeApi({
      listMaps: vi.fn(() => Promise.resolve([{ ...MAP, visibility: 'dm_only' as const }])),
    })
    mount(api, '/worlds/w1/maps')
    expect(await screen.findByText('GM only')).toBeTruthy()
  })

  it('creates a map and reloads the list', async () => {
    const createMap = vi.fn(() => Promise.resolve(MAP))
    const listMaps = vi.fn(() => Promise.resolve([]))
    mount(makeApi({ createMap, listMaps }), '/worlds/w1/maps')

    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'The North' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))

    await waitFor(() => expect(createMap).toHaveBeenCalledWith('w1', { name: 'The North' }))
    await waitFor(() => expect(listMaps).toHaveBeenCalledTimes(2))
  })

  it('reports a refused creation instead of silently doing nothing', async () => {
    const api = makeApi({
      createMap: vi.fn(() => Promise.reject(new ApiClientError(403, 'forbidden', 'no write'))),
    })
    mount(api, '/worlds/w1/maps')
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'x' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect((await screen.findByRole('alert')).textContent).toBe('no write')
  })

  it('offers a player no way to create a map', async () => {
    const api = makeApi({ listMaps: vi.fn(() => Promise.resolve([MAP])) })
    mount(api, '/worlds/w1/maps', 'player')
    await screen.findByRole('link', { name: /Saltmarsh/ })
    expect(screen.queryByLabelText('Name')).toBeNull()
  })

  it('says the world has no maps rather than showing an empty grid', async () => {
    mount(makeApi({ listMaps: vi.fn(() => Promise.resolve([])) }), '/worlds/w1/maps')
    expect(await screen.findByText('No maps yet.')).toBeTruthy()
  })
})

describe('MapDetailPage', () => {
  const withImage: MapWithImage = {
    map: MAP,
    image: {
      id: 'm1',
      world_id: 'w1',
      owner_kind: 'map',
      owner_id: 'map1',
      media_kind: 'map',
      original_filename: 'saltmarsh.png',
      mime_type: 'image/png',
      byte_size: '100',
      thumbnail_path: null,
      created_at: '2026-01-01',
    },
  }

  it('renders the map with its pins', async () => {
    const api = makeApi({
      getMap: vi.fn(() => Promise.resolve(withImage)),
      listPins: vi.fn(() => Promise.resolve([PIN])),
      mediaRawUrl: () => '/raw/m1',
    })
    mount(api, '/worlds/w1/maps/map1')

    expect(await screen.findByRole('heading', { name: 'Saltmarsh' })).toBeTruthy()
    // Once in the overlay, once in the list beside it — the list is how a pin
    // on a zoomed-off-screen part of the map stays reachable.
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: 'The Harbourmaster' })).toHaveLength(2),
    )
  })

  it('navigates to the entity a pin marks', async () => {
    const api = makeApi({
      getMap: vi.fn(() => Promise.resolve(withImage)),
      listPins: vi.fn(() => Promise.resolve([PIN])),
    })
    mount(api, '/worlds/w1/maps/map1')

    const buttons = await screen.findAllByRole('button', { name: 'The Harbourmaster' })
    fireEvent.click(buttons[0] as HTMLElement)
    expect(await screen.findByRole('heading', { name: 'Entity page' })).toBeTruthy()
  })

  it('places a pin: enter add mode, click the map, pick the entity', async () => {
    const createPin = vi.fn(() => Promise.resolve(PIN))
    const listPins = vi.fn(() => Promise.resolve([]))
    const api = makeApi({
      getMap: vi.fn(() => Promise.resolve(withImage)),
      listPins,
      createPin,
      listWiki: vi.fn(() =>
        Promise.resolve([{ kind: 'npc', id: 'e1', name: 'The Harbourmaster' }]),
      ),
    })
    mount(api, '/worlds/w1/maps/map1')

    fireEvent.click(await screen.findByRole('button', { name: 'Add pin' }))
    expect(screen.getByText('Click the map to place a pin.')).toBeTruthy()

    const frame = screen.getByTestId('map-frame')
    fireEvent.pointerDown(frame, { pointerId: 1, clientX: 10, clientY: 10 })
    fireEvent.pointerUp(frame, { pointerId: 1, clientX: 10, clientY: 10 })

    // A pin needs a WHERE and a WHAT; the map supplies only the first.
    const picker = await screen.findByLabelText('Pin an entity')
    fireEvent.click(await within(picker).findByRole('button', { name: 'The Harbourmaster' }))

    await waitFor(() => expect(createPin).toHaveBeenCalled())
    const [, mapId, input] = createPin.mock.calls[0] as unknown[]
    expect(mapId).toBe('map1')
    expect((input as { kind: string; entityId: string }).kind).toBe('npc')
    await waitFor(() => expect(listPins).toHaveBeenCalledTimes(2))
  })

  it('abandons a placement on cancel without creating anything', async () => {
    const createPin = vi.fn(() => Promise.resolve(PIN))
    const api = makeApi({
      getMap: vi.fn(() => Promise.resolve(withImage)),
      createPin,
      listWiki: vi.fn(() =>
        Promise.resolve([{ kind: 'npc', id: 'e1', name: 'The Harbourmaster' }]),
      ),
    })
    mount(api, '/worlds/w1/maps/map1')

    fireEvent.click(await screen.findByRole('button', { name: 'Add pin' }))
    const frame = screen.getByTestId('map-frame')
    fireEvent.pointerDown(frame, { pointerId: 1, clientX: 10, clientY: 10 })
    fireEvent.pointerUp(frame, { pointerId: 1, clientX: 10, clientY: 10 })

    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    expect(screen.queryByLabelText('Pin an entity')).toBeNull()
    expect(createPin).not.toHaveBeenCalled()
  })

  it('removes a pin and reloads', async () => {
    const deletePin = vi.fn(() => Promise.resolve())
    const listPins = vi.fn(() => Promise.resolve([PIN]))
    const api = makeApi({ getMap: vi.fn(() => Promise.resolve(withImage)), listPins, deletePin })
    mount(api, '/worlds/w1/maps/map1')

    fireEvent.click(await screen.findByRole('button', { name: 'Remove pin for The Harbourmaster' }))
    await waitFor(() => expect(deletePin).toHaveBeenCalledWith('w1', 'map1', 'pin1'))
    await waitFor(() => expect(listPins).toHaveBeenCalledTimes(2))
  })

  it('reports a refused pin removal', async () => {
    const api = makeApi({
      getMap: vi.fn(() => Promise.resolve(withImage)),
      listPins: vi.fn(() => Promise.resolve([PIN])),
      deletePin: vi.fn(() => Promise.reject(new ApiClientError(403, 'forbidden', 'no write'))),
    })
    mount(api, '/worlds/w1/maps/map1')
    fireEvent.click(await screen.findByRole('button', { name: 'Remove pin for The Harbourmaster' }))
    expect((await screen.findByRole('alert')).textContent).toBe('no write')
  })

  it('uploads a map image and reloads the map so its dimensions arrive', async () => {
    const uploadMapImage = vi.fn(() => Promise.resolve({ sourceWidth: 900, sourceHeight: 600 }))
    const getMap = vi.fn(() => Promise.resolve({ map: MAP, image: null }))
    mount(makeApi({ getMap, uploadMapImage }), '/worlds/w1/maps/map1')

    const input = await screen.findByLabelText('Upload a map image')
    const file = new File([new Uint8Array([1])], 'saltmarsh.png', { type: 'image/png' })
    Object.defineProperty(input, 'files', { value: [file], configurable: true })
    fireEvent.change(input)

    await waitFor(() => expect(uploadMapImage).toHaveBeenCalled())
    // Without the reload the viewer would keep drawing at the old size — or at
    // no size at all, which is the case here.
    await waitFor(() => expect(getMap).toHaveBeenCalledTimes(2))
  })

  it('offers no pin control at all until there is an image to pin onto', async () => {
    const api = makeApi({ getMap: vi.fn(() => Promise.resolve({ map: MAP, image: null })) })
    mount(api, '/worlds/w1/maps/map1')
    await screen.findByLabelText('Upload a map image')
    expect(screen.queryByRole('button', { name: 'Add pin' })).toBeNull()
  })

  it('offers a player the map but none of the controls', async () => {
    const api = makeApi({
      getMap: vi.fn(() => Promise.resolve(withImage)),
      listPins: vi.fn(() => Promise.resolve([PIN])),
    })
    mount(api, '/worlds/w1/maps/map1', 'player')

    expect(await screen.findByRole('heading', { name: 'Saltmarsh' })).toBeTruthy()
    // A player can look at the map and follow a pin, and can do nothing else.
    expect(screen.getAllByRole('button', { name: 'The Harbourmaster' }).length).toBeGreaterThan(0)
    for (const name of ['Add pin', 'Delete map', 'Remove pin for The Harbourmaster']) {
      expect(screen.queryByRole('button', { name })).toBeNull()
    }
    expect(screen.queryByLabelText(/map image/)).toBeNull()
  })

  it('shows the load error rather than an empty map', async () => {
    const api = makeApi({ getMap: vi.fn(() => Promise.reject(new Error('map boom'))) })
    mount(api, '/worlds/w1/maps/map1')
    expect((await screen.findByRole('alert')).textContent).toBe('map boom')
  })

  it('relabels a pin — a marker reads as its label, so renaming is the common case', async () => {
    const updatePin = vi.fn(() => Promise.resolve(PIN))
    const listPins = vi.fn(() => Promise.resolve([PIN]))
    mount(
      makeApi({ getMap: vi.fn(() => Promise.resolve(withImage)), listPins, updatePin }),
      '/worlds/w1/maps/map1',
    )

    const field = await screen.findByLabelText('Label for The Harbourmaster')
    // Nothing to save until something changes.
    expect(screen.getByRole('button', { name: 'Save label' })).toHaveProperty('disabled', true)

    fireEvent.change(field, { target: { value: 'The docks' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save label' }))

    await waitFor(() =>
      expect(updatePin).toHaveBeenCalledWith('w1', 'map1', 'pin1', { label: 'The docks' }),
    )
    await waitFor(() => expect(listPins).toHaveBeenCalledTimes(2))
  })

  it('moves a pin by dragging it, reporting the new NORMALIZED position', async () => {
    const updatePin = vi.fn(() => Promise.resolve(PIN))
    mount(
      makeApi({
        getMap: vi.fn(() => Promise.resolve(withImage)),
        updatePin,
        listPins: vi.fn(() => Promise.resolve([PIN])),
      }),
      '/worlds/w1/maps/map1',
    )

    const marker = (await screen.findAllByRole('button', { name: 'The Harbourmaster' }))[0]!
    fireEvent.pointerDown(marker, { pointerId: 1, clientX: 10, clientY: 10 })
    fireEvent.pointerMove(marker, { pointerId: 1, clientX: 60, clientY: 40 })
    fireEvent.pointerUp(marker, { pointerId: 1, clientX: 60, clientY: 40 })
    fireEvent.click(marker) // the click a browser fires after the drag

    await waitFor(() => expect(updatePin).toHaveBeenCalled())
    const patch = (updatePin.mock.calls[0] as unknown[])[3] as { x: number; y: number }
    // Fractions of the image, not screen pixels — the only thing the schema accepts.
    expect(patch.x).toBeGreaterThanOrEqual(0)
    expect(patch.x).toBeLessThanOrEqual(1)
    expect(patch.y).toBeGreaterThanOrEqual(0)
    expect(patch.y).toBeLessThanOrEqual(1)
    // …and the drag did not also navigate away from the map it was moved on.
    expect(screen.queryByRole('heading', { name: 'Entity page' })).toBeNull()
  })

  it('treats a press that never travelled as a click, not a move', async () => {
    const updatePin = vi.fn(() => Promise.resolve(PIN))
    mount(
      makeApi({
        getMap: vi.fn(() => Promise.resolve(withImage)),
        updatePin,
        listPins: vi.fn(() => Promise.resolve([PIN])),
      }),
      '/worlds/w1/maps/map1',
    )

    const marker = (await screen.findAllByRole('button', { name: 'The Harbourmaster' }))[0]!
    fireEvent.pointerDown(marker, { pointerId: 1, clientX: 10, clientY: 10 })
    fireEvent.pointerUp(marker, { pointerId: 1, clientX: 10, clientY: 10 })
    // A browser fires click after pointerup; jsdom does not, so it is explicit.
    // This also proves the drag suppression does not swallow an ordinary click.
    fireEvent.click(marker)

    expect(updatePin).not.toHaveBeenCalled()
    expect(await screen.findByRole('heading', { name: 'Entity page' })).toBeTruthy()
  })

  it('offers a player no label field, and a pin they cannot drag', async () => {
    const updatePin = vi.fn(() => Promise.resolve(PIN))
    mount(
      makeApi({
        getMap: vi.fn(() => Promise.resolve(withImage)),
        updatePin,
        listPins: vi.fn(() => Promise.resolve([PIN])),
      }),
      '/worlds/w1/maps/map1',
      'player',
    )

    const marker = (await screen.findAllByRole('button', { name: 'The Harbourmaster' }))[0]!
    expect(screen.queryByLabelText('Label for The Harbourmaster')).toBeNull()

    fireEvent.pointerDown(marker, { pointerId: 1, clientX: 10, clientY: 10 })
    fireEvent.pointerMove(marker, { pointerId: 1, clientX: 60, clientY: 40 })
    fireEvent.pointerUp(marker, { pointerId: 1, clientX: 60, clientY: 40 })
    expect(updatePin).not.toHaveBeenCalled()
  })

  it('says so when a map has no pins', async () => {
    const api = makeApi({
      getMap: vi.fn(() => Promise.resolve(withImage)),
      listPins: vi.fn(() => Promise.resolve([])),
    })
    mount(api, '/worlds/w1/maps/map1')
    expect(await screen.findByText('Nothing pinned on this map yet.')).toBeTruthy()
  })
})

describe('EntityMaps (the reverse lookup on an entity page)', () => {
  const mountEntityMaps = (api: ApiClient): void => {
    render(
      <ApiProvider value={api}>
        <MemoryRouter initialEntries={['/worlds/w1/npc/e1']}>
          <Routes>
            <Route path="/worlds/:worldId/:kind/:id" element={<EntityMaps kind="npc" id="e1" />} />
            <Route path="/worlds/:worldId/maps/:mapId" element={<h1>Map page</h1>} />
          </Routes>
        </MemoryRouter>
      </ApiProvider>,
    )
  }

  it('lists the maps that pin this entity and links to each', async () => {
    const api = makeApi({
      listEntityMaps: vi.fn(() =>
        Promise.resolve([{ mapId: 'map1', mapName: 'Saltmarsh', pinId: 'p1', label: null }]),
      ),
    })
    mountEntityMaps(api)

    const link = await screen.findByRole('link', { name: 'Saltmarsh' })
    expect(link.getAttribute('href')).toBe('/worlds/w1/maps/map1')
  })

  it('shows a pin’s label beside the map when one was written', async () => {
    const api = makeApi({
      listEntityMaps: vi.fn(() =>
        Promise.resolve([{ mapId: 'map1', mapName: 'Saltmarsh', pinId: 'p1', label: 'The docks' }]),
      ),
    })
    mountEntityMaps(api)
    expect(await screen.findByText('The docks')).toBeTruthy()
  })

  it('renders nothing at all when the entity is on no map', async () => {
    // An entity that appears on no map should not carry an empty panel arguing
    // about it.
    const api = makeApi({ listEntityMaps: vi.fn(() => Promise.resolve([])) })
    mountEntityMaps(api)
    await waitFor(() => expect(api.listEntityMaps).toHaveBeenCalled())
    expect(screen.queryByLabelText('Pinned on maps')).toBeNull()
  })
})
