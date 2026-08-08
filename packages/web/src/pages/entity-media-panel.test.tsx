import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { type ApiClient, ApiClientError, type MediaAttachment } from '../api'
import { ApiProvider } from '../app/api-context'
import { ModalProvider } from '../app/modal/modal-context'
import { makeApi } from '../testing/fake-api'
import { EntityMediaPanel } from './entity-media-panel'

/**
 * The Images panel. The upload button being absent for a player is a courtesy,
 * not the enforcement — that lives server-side and is pinned by
 * `http-media-upload.test.ts`. What is asserted here is the shape of the surface:
 * thumbnails not full-size sources in the gallery, a real refusal shown when the
 * server sends one, and a picker that can be used twice in a row.
 */

const attachment = (over: Partial<MediaAttachment> = {}): MediaAttachment => ({
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
  ...over,
})

function mount(api: ApiClient, canEdit = true): void {
  render(
    <ApiProvider value={api}>
      <ModalProvider>
        <EntityMediaPanel worldId="w1" kind="npc" id="e1" canEdit={canEdit} />
      </ModalProvider>
    </ApiProvider>,
  )
}

const pngFile = (name = 'pic.png'): File =>
  new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], name, { type: 'image/png' })

/** Drive the file input the way a picker does. */
function pick(file: File): void {
  const input = screen.getByLabelText('Add an image')
  Object.defineProperty(input, 'files', { value: [file], configurable: true })
  fireEvent.change(input)
}

describe('EntityMediaPanel', () => {
  it('renders the THUMBNAIL in the gallery, not the full-size source', async () => {
    // A page with a dozen attachments must not pull a dozen full-size images.
    const api = makeApi({
      listEntityMedia: vi.fn(() => Promise.resolve([attachment()])),
      mediaThumbnailUrl: (w, id) => `/thumb/${w}/${id}`,
      mediaRawUrl: (w, id) => `/raw/${w}/${id}`,
    })
    mount(api)

    const img = (await screen.findByAltText('View mira.png full size')) as HTMLImageElement
    expect(img.getAttribute('src')).toBe('/thumb/w1/m1')
    expect(img.getAttribute('loading')).toBe('lazy')
    // A button, not a link: it opens a dialog on this page rather than going
    // anywhere, and the alt text says what activating it does.
    expect(img.closest('a')).toBeNull()
    expect(img.closest('button')).toBeTruthy()
  })

  it('opens the full-size image in the shared modal, and fetches the SOURCE for it', async () => {
    const api = makeApi({
      listEntityMedia: vi.fn(() => Promise.resolve([attachment()])),
      mediaThumbnailUrl: (w, id) => `/thumb/${w}/${id}`,
      mediaRawUrl: (w, id) => `/raw/${w}/${id}`,
    })
    mount(api)

    fireEvent.click(await screen.findByRole('button', { name: 'View mira.png full size' }))

    // The app's ONE modal, named by the file, so a screen reader announces which
    // image opened rather than "dialog".
    const dialog = await screen.findByRole('dialog', { name: 'mira.png' })
    const full = within(dialog).getByAltText('mira.png') as HTMLImageElement
    expect(full.getAttribute('src')).toBe('/raw/w1/m1')
    // Looking closely is the point, so the source is what loads — not the
    // thumbnail scaled up.
    expect(full.getAttribute('src')).not.toBe('/thumb/w1/m1')
    // The way out to the browser's own zoom and save survives.
    expect(
      within(dialog).getByRole('link', { name: 'Open mira.png in a new tab' }).getAttribute('href'),
    ).toBe('/raw/w1/m1')
  })

  it('says so when there is nothing attached, differently for an owner and a player', async () => {
    const api = makeApi({ listEntityMedia: vi.fn(() => Promise.resolve([])) })
    const owner = render(
      <ApiProvider value={api}>
        <EntityMediaPanel worldId="w1" kind="npc" id="e1" canEdit={true} />
      </ApiProvider>,
    )
    expect(await screen.findByText(/Add one above/)).toBeTruthy()
    owner.unmount()

    mount(api, false)
    expect(await screen.findByText(/No images on this entry/)).toBeTruthy()
  })

  it('generates a thumbnail, uploads, and reloads the gallery', async () => {
    const uploadEntityMedia = vi.fn(() => Promise.resolve(attachment()))
    const listEntityMedia = vi.fn(() => Promise.resolve([]))
    mount(makeApi({ uploadEntityMedia, listEntityMedia }))
    await screen.findByLabelText('Add an image')

    const file = pngFile('portrait.png')
    pick(file)

    await waitFor(() => expect(uploadEntityMedia).toHaveBeenCalled())
    const [worldId, kind, id, sent] = uploadEntityMedia.mock.calls[0] as unknown[]
    expect([worldId, kind, id]).toEqual(['w1', 'npc', 'e1'])
    expect(sent).toBe(file)
    // jsdom has no canvas encoder, so the thumbnail is null here — which is the
    // documented fallback, not a failure. The upload still goes through.
    expect(await screen.findByText('Added portrait.png')).toBeTruthy()
    await waitFor(() => expect(listEntityMedia).toHaveBeenCalledTimes(2))
  })

  it('surfaces the server refusal verbatim rather than a generic failure', async () => {
    const api = makeApi({
      uploadEntityMedia: vi.fn(() =>
        Promise.reject(
          new ApiClientError(
            400,
            'unsupported_image',
            'that file is not a JPEG, PNG, or WebP image',
          ),
        ),
      ),
    })
    mount(api)
    await screen.findByLabelText('Add an image')
    pick(pngFile())

    expect(await screen.findByText(/not a JPEG, PNG, or WebP image/)).toBeTruthy()
  })

  it('clears the picker so the SAME file can be retried after a failure', async () => {
    // Without this a rejected upload cannot be retried: re-picking an identical
    // file fires no change event, so the retry silently does nothing.
    const api = makeApi({
      uploadEntityMedia: vi.fn(() => Promise.reject(new Error('boom'))),
    })
    mount(api)
    const input = (await screen.findByLabelText('Add an image')) as HTMLInputElement
    pick(pngFile())

    await screen.findByText('boom')
    expect(input.value).toBe('')
  })

  it('removes an attachment and reloads', async () => {
    const deleteMedia = vi.fn(() => Promise.resolve())
    const listEntityMedia = vi.fn(() => Promise.resolve([attachment()]))
    mount(makeApi({ deleteMedia, listEntityMedia }))

    fireEvent.click(await screen.findByRole('button', { name: 'Remove mira.png' }))
    await waitFor(() => expect(deleteMedia).toHaveBeenCalledWith('w1', 'm1'))
    await waitFor(() => expect(listEntityMedia).toHaveBeenCalledTimes(2))
  })

  it('reports a failed removal instead of pretending it worked', async () => {
    const api = makeApi({
      listEntityMedia: vi.fn(() => Promise.resolve([attachment()])),
      deleteMedia: vi.fn(() => Promise.reject(new ApiClientError(403, 'forbidden', 'no write'))),
    })
    mount(api)
    fireEvent.click(await screen.findByRole('button', { name: 'Remove mira.png' }))
    expect((await screen.findByRole('alert')).textContent).toBe('no write')
  })

  it('offers a player neither an upload control nor a remove button', async () => {
    const api = makeApi({ listEntityMedia: vi.fn(() => Promise.resolve([attachment()])) })
    mount(api, false)

    await screen.findByAltText('View mira.png full size')
    expect(screen.queryByLabelText('Add an image')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Remove mira.png' })).toBeNull()
  })

  it('ignores attachments left behind under a kind the vocabulary no longer has', async () => {
    // `media_kind` is a closed set now (`image` | `map`) and the importer
    // narrows on the way in — but the COLUMN is still text, and a world
    // imported before that narrowing can hold `portrait`, `handout`, or
    // anything else dm-manager's free-text column accepted. The cast is the
    // point of the test: this row is not constructible through the type, and it
    // is exactly what an older database contains.
    const legacy = { ...attachment({ id: 'm2', original_filename: 'x.mp3' }), media_kind: 'audio' }
    const api = makeApi({
      listEntityMedia: vi.fn(() => Promise.resolve([legacy as MediaAttachment])),
    })
    mount(api)
    expect(await screen.findByText(/Add one above/)).toBeTruthy()
    expect(screen.queryByAltText(/x\.mp3/)).toBeNull()
  })
})
