import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { type ApiClient, ApiClientError, type MediaAttachment } from '../api'
import { ApiProvider } from '../app/api-context'
import { makeApi } from '../testing/fake-api'
import { EntityAvatar } from './entity-avatar'

vi.mock('../app/thumbnail', () => ({
  makeThumbnail: () => Promise.resolve(new Blob(['t'], { type: 'image/jpeg' })),
}))

const attachment = (over: Partial<MediaAttachment> = {}): MediaAttachment => ({
  id: 'm1',
  world_id: 'w1',
  owner_kind: 'npc',
  owner_id: 'e1',
  media_kind: 'image',
  original_filename: 'mira.png',
  mime_type: 'image/png',
  byte_size: '100',
  thumbnail_path: 'w1/npc/e1/m1-thumb.jpg',
  is_primary: true,
  created_at: '2026-08-21T00:00:00Z',
  ...over,
})

function renderAvatar(api: ApiClient, canEdit = true): void {
  render(
    <ApiProvider value={api}>
      <EntityAvatar worldId="w1" kind="npc" id="e1" canEdit={canEdit} />
    </ApiProvider>,
  )
}

const pick = (): void => {
  const input = screen.getByLabelText(/main image/) as HTMLInputElement
  const file = new File(['bytes'], 'portrait.png', { type: 'image/png' })
  fireEvent.change(input, { target: { files: [file] } })
}

describe('EntityAvatar', () => {
  it('renders the nominated image as a thumbnail, not the full-size source', async () => {
    renderAvatar(makeApi({ getPrimaryMedia: vi.fn(() => Promise.resolve(attachment())) }))
    const img = (await screen.findByRole('img')) as HTMLImageElement
    // The gallery made the same choice for the same reason: this is a 6rem disc.
    expect(img.src).toContain('variant=thumbnail')
    expect(img.alt).toBe('mira.png')
  })

  it('shows a neutral placeholder for an entity with no image, not a broken frame', async () => {
    renderAvatar(makeApi({ getPrimaryMedia: vi.fn(() => Promise.resolve(null)) }))
    await waitFor(() => expect(screen.queryByRole('img')).toBeNull())
    expect(document.querySelector('.entity-avatar-empty')).toBeTruthy()
  })

  it('offers an owner a named control, worded for adding or for changing', async () => {
    const api = makeApi({ getPrimaryMedia: vi.fn(() => Promise.resolve(null)) })
    renderAvatar(api)
    expect(await screen.findByLabelText('Add a main image')).toBeTruthy()

    document.body.innerHTML = ''
    renderAvatar(makeApi({ getPrimaryMedia: vi.fn(() => Promise.resolve(attachment())) }))
    expect(await screen.findByLabelText('Change the main image')).toBeTruthy()
  })

  it('offers a player no control at all', async () => {
    renderAvatar(makeApi({ getPrimaryMedia: vi.fn(() => Promise.resolve(attachment())) }), false)
    await screen.findByRole('img')
    expect(screen.queryByLabelText(/main image/)).toBeNull()
  })

  it('uploads the picked file and nominates it in one gesture', async () => {
    const uploadEntityMedia = vi.fn(() => Promise.resolve(attachment({ id: 'new' })))
    const setPrimaryMedia = vi.fn(() => Promise.resolve(attachment({ id: 'new' })))
    renderAvatar(
      makeApi({
        getPrimaryMedia: vi.fn(() => Promise.resolve(null)),
        uploadEntityMedia,
        setPrimaryMedia,
      }),
    )
    await screen.findByLabelText('Add a main image')
    pick()

    // One intention — "let this be the picture" — even though it is two calls.
    await waitFor(() => expect(uploadEntityMedia).toHaveBeenCalled())
    await waitFor(() => expect(setPrimaryMedia).toHaveBeenCalledWith('w1', 'npc', 'e1', 'new'))
  })

  it('surfaces the server’s refusal rather than failing silently', async () => {
    renderAvatar(
      makeApi({
        getPrimaryMedia: vi.fn(() => Promise.resolve(null)),
        uploadEntityMedia: vi.fn(() =>
          Promise.reject(new ApiClientError(413, 'too_large', 'that image is too large')),
        ),
      }),
    )
    await screen.findByLabelText('Add a main image')
    pick()
    expect((await screen.findByRole('alert')).textContent).toBe('that image is too large')
  })
})
