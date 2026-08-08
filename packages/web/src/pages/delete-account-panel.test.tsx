import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { type ApiClient, ApiClientError, type BlockingWorld } from '../api'
import { makeApi } from '../testing/fake-api'
import { DeleteAccountPanel } from './delete-account-panel'

const world = (over: Partial<BlockingWorld> = {}): BlockingWorld => ({
  id: 'w1',
  name: 'Chicago by Night',
  slug: 'chicago',
  ...over,
})

const assign = vi.fn()

beforeEach(() => {
  assign.mockClear()
  vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:all-my-data') })
  // The panel navigates hard after a successful delete — there is no signed-in
  // state left to reconcile, so a router push would be a lie.
  vi.stubGlobal('location', { assign })
})

const show = (api: ApiClient): void => {
  render(<DeleteAccountPanel api={api} />)
}

describe('DeleteAccountPanel — what it says', () => {
  it('states the cascade and that it is permanent', () => {
    show(makeApi())
    expect(screen.getByText(/cannot be undone and nothing is kept/i)).toBeTruthy()
    expect(screen.getByText(/notes and characters in every world/i)).toBeTruthy()
  })

  it('says worlds and already-accepted contributions survive', () => {
    show(makeApi())
    expect(screen.getByText(/Worlds you belong to stay/i)).toBeTruthy()
  })
})

describe('DeleteAccountPanel — blocking worlds', () => {
  it('names the worlds that must be resolved first and offers no delete button', async () => {
    show(makeApi({ deletionBlockers: vi.fn(() => Promise.resolve([world()])) }))

    expect(await screen.findByText('Chicago by Night')).toBeTruthy()
    expect(screen.getByText(/Hand each one to another member/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Delete my account' })).toBeNull()
  })

  it('pluralises honestly for more than one', async () => {
    show(
      makeApi({
        deletionBlockers: vi.fn(() =>
          Promise.resolve([world(), world({ id: 'w2', name: 'Second' })]),
        ),
      }),
    )
    expect(await screen.findByText(/You still own these worlds/i)).toBeTruthy()
  })

  it('offers the delete button once nothing blocks it', async () => {
    show(makeApi())
    expect(await screen.findByRole('button', { name: 'Delete my account' })).toBeTruthy()
  })

  it('surfaces a failure to check', async () => {
    show(makeApi({ deletionBlockers: () => Promise.reject(new Error('boom')) }))
    expect(await screen.findByRole('alert')).toBeTruthy()
  })
})

describe('DeleteAccountPanel — the export', () => {
  it('assembles the caller’s own data across every world', async () => {
    const listWorlds = vi.fn(() =>
      Promise.resolve([{ id: 'w1', name: 'W', slug: 'w', ownerId: 'a', role: 'player' as const }]),
    )
    const listNotes = vi.fn(() => Promise.resolve([]))
    const listCharacters = vi.fn(() => Promise.resolve([]))
    show(makeApi({ listWorlds, listNotes, listCharacters }))

    fireEvent.click(screen.getByRole('button', { name: 'Prepare all my data for download' }))

    const link = (await screen.findByRole('link', {
      name: 'Download all my data',
    })) as HTMLAnchorElement
    expect(link.getAttribute('download')).toBe('my-campaign-settings-data.json')
    expect(listNotes).toHaveBeenCalledWith('w1')
    expect(listCharacters).toHaveBeenCalledWith('w1')
  })

  it('surfaces a failure to assemble it', async () => {
    show(makeApi({ listWorlds: () => Promise.reject(new Error('boom')) }))
    fireEvent.click(screen.getByRole('button', { name: 'Prepare all my data for download' }))
    expect(await screen.findByRole('alert')).toBeTruthy()
  })
})

describe('DeleteAccountPanel — deleting', () => {
  it('requires a confirmation step and the current password', async () => {
    const deleteAccount = vi.fn(() => Promise.resolve())
    show(makeApi({ deleteAccount }))

    fireEvent.click(await screen.findByRole('button', { name: 'Delete my account' }))
    expect(deleteAccount).not.toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText('Your password'), { target: { value: 'pw-123456' } })
    fireEvent.click(screen.getByRole('button', { name: 'Permanently delete my account' }))

    await waitFor(() => expect(deleteAccount).toHaveBeenCalledWith('pw-123456'))
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/login'))
  })

  it('backs out without deleting', async () => {
    const deleteAccount = vi.fn(() => Promise.resolve())
    show(makeApi({ deleteAccount }))

    fireEvent.click(await screen.findByRole('button', { name: 'Delete my account' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(screen.getByRole('button', { name: 'Delete my account' })).toBeTruthy()
    expect(deleteAccount).not.toHaveBeenCalled()
  })

  it('surfaces a wrong password and stays put', async () => {
    show(
      makeApi({
        deleteAccount: () =>
          Promise.reject(new ApiClientError(401, 'invalid_credentials', 'invalid password')),
      }),
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Delete my account' }))
    fireEvent.change(screen.getByLabelText('Your password'), { target: { value: 'wrong' } })
    fireEvent.click(screen.getByRole('button', { name: 'Permanently delete my account' }))

    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(assign).not.toHaveBeenCalled()
  })

  it('re-checks the blockers when a delete is refused for owning a world', async () => {
    const deletionBlockers = vi
      .fn<() => Promise<BlockingWorld[]>>()
      .mockResolvedValueOnce([])
      .mockResolvedValue([world()])
    show(
      makeApi({
        deletionBlockers,
        deleteAccount: () =>
          Promise.reject(new ApiClientError(409, 'owns_worlds', 'still owns worlds')),
      }),
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Delete my account' }))
    fireEvent.change(screen.getByLabelText('Your password'), { target: { value: 'pw-123456' } })
    fireEvent.click(screen.getByRole('button', { name: 'Permanently delete my account' }))

    // the newly-discovered blocker is now on screen instead of the form
    expect(await screen.findByText('Chicago by Night')).toBeTruthy()
    expect(assign).not.toHaveBeenCalled()
  })
})
