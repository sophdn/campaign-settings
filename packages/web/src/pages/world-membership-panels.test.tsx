import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { type ApiClient, ApiClientError, type MemberView } from '../api'
import { makeApi } from '../testing/fake-api'
import {
  AcceptOwnershipPanel,
  LeaveWorldPanel,
  TransferOwnershipPanel,
} from './world-membership-panels'

const member = (over: Partial<MemberView> = {}): MemberView => ({
  accountId: 'p1',
  username: 'player-one',
  role: 'player',
  joinedAt: '2026-07-20T10:00:00.000Z',
  ...over,
})

beforeEach(() => {
  // jsdom has no object-URL implementation; the leave panel builds one for the
  // data download, so stub it rather than let the component throw.
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => 'blob:my-data'),
  })
})

describe('LeaveWorldPanel', () => {
  it('states what leaving destroys before offering the button', () => {
    render(<LeaveWorldPanel api={makeApi()} worldId="w" onLeft={vi.fn()} />)
    expect(screen.getByText(/permanently deletes your notes and characters/i)).toBeTruthy()
  })

  it('offers the data download built from the caller-scoped routes', async () => {
    const listNotes = vi.fn(() => Promise.resolve([]))
    render(<LeaveWorldPanel api={makeApi({ listNotes })} worldId="w" onLeft={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Prepare my data for download' }))

    const link = (await screen.findByRole('link', {
      name: 'Download my notes and characters',
    })) as HTMLAnchorElement
    expect(link.getAttribute('download')).toBe('my-data-w.json')
    expect(listNotes).toHaveBeenCalledWith('w')
  })

  it('surfaces a failure to assemble the download', async () => {
    render(
      <LeaveWorldPanel
        api={makeApi({ listNotes: () => Promise.reject(new Error('boom')) })}
        worldId="w"
        onLeft={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Prepare my data for download' }))
    expect(await screen.findByRole('alert')).toBeTruthy()
  })

  it('requires a confirmation step before leaving', async () => {
    const leaveWorld = vi.fn(() => Promise.resolve())
    const onLeft = vi.fn()
    render(<LeaveWorldPanel api={makeApi({ leaveWorld })} worldId="w" onLeft={onLeft} />)

    fireEvent.click(screen.getByRole('button', { name: 'Leave this world' }))
    expect(leaveWorld).not.toHaveBeenCalled()
    expect(screen.getByText(/cannot be undone/i)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Yes, leave and delete my data' }))
    await waitFor(() => expect(leaveWorld).toHaveBeenCalledWith('w'))
    await waitFor(() => expect(onLeft).toHaveBeenCalled())
  })

  it('backs out of the confirmation without leaving', () => {
    const leaveWorld = vi.fn(() => Promise.resolve())
    render(<LeaveWorldPanel api={makeApi({ leaveWorld })} worldId="w" onLeft={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Leave this world' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(screen.getByRole('button', { name: 'Leave this world' })).toBeTruthy()
    expect(leaveWorld).not.toHaveBeenCalled()
  })

  it('surfaces the owner refusal rather than pretending it worked', async () => {
    const onLeft = vi.fn()
    render(
      <LeaveWorldPanel
        api={makeApi({
          leaveWorld: () =>
            Promise.reject(
              new ApiClientError(409, 'owner_cannot_leave', 'transfer ownership or delete'),
            ),
        })}
        worldId="w"
        onLeft={onLeft}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Leave this world' }))
    fireEvent.click(screen.getByRole('button', { name: 'Yes, leave and delete my data' }))

    expect((await screen.findByRole('alert')).textContent).toMatch(/transfer ownership/i)
    expect(onLeft).not.toHaveBeenCalled()
  })
})

describe('TransferOwnershipPanel', () => {
  const render1 = (api: ApiClient, members: MemberView[] = [member()]) =>
    render(
      <TransferOwnershipPanel api={api} worldId="w" members={members} onTransferred={vi.fn()} />,
    )

  it('says the owner cannot leave and that the recipient must accept', async () => {
    render1(makeApi())
    expect(screen.getByText(/cannot leave a world you own/i)).toBeTruthy()
    expect(await screen.findByText(/nothing changes until they do/i)).toBeTruthy()
  })

  it('offers the world to the chosen member', async () => {
    const offerOwnership = vi.fn(() => Promise.resolve())
    render1(makeApi({ offerOwnership }), [member(), member({ accountId: 'p2', username: 'two' })])

    fireEvent.change(await screen.findByLabelText('Member'), { target: { value: 'p2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Offer ownership' }))

    await waitFor(() => expect(offerOwnership).toHaveBeenCalledWith('w', 'p2'))
  })

  it('defaults to the first member when the picker is untouched', async () => {
    const offerOwnership = vi.fn(() => Promise.resolve())
    render1(makeApi({ offerOwnership }))
    fireEvent.click(await screen.findByRole('button', { name: 'Offer ownership' }))
    await waitFor(() => expect(offerOwnership).toHaveBeenCalledWith('w', 'p1'))
  })

  it('shows an outstanding offer and makes clear ownership has NOT moved', async () => {
    render1(
      makeApi({
        getPendingTransfer: vi.fn(() =>
          Promise.resolve({ accountId: 'p1', username: 'player-one' }),
        ),
      }),
    )
    expect(await screen.findByText(/Offered to player-one/)).toBeTruthy()
    expect(screen.getByText(/you are still the owner/i)).toBeTruthy()
    // and the offer form is not also on screen
    expect(screen.queryByRole('button', { name: 'Offer ownership' })).toBeNull()
  })

  it('withdraws an outstanding offer', async () => {
    const cancelOwnershipOffer = vi.fn(() => Promise.resolve())
    const getPendingTransfer = vi
      .fn<() => Promise<{ accountId: string; username: string } | null>>()
      .mockResolvedValueOnce({ accountId: 'p1', username: 'player-one' })
      .mockResolvedValue(null)
    render1(makeApi({ cancelOwnershipOffer, getPendingTransfer }))

    fireEvent.click(await screen.findByRole('button', { name: 'Withdraw the offer' }))

    await waitFor(() => expect(cancelOwnershipOffer).toHaveBeenCalledWith('w'))
    expect(await screen.findByRole('button', { name: 'Offer ownership' })).toBeTruthy()
  })

  it('says so when there is nobody to hand it to', async () => {
    render1(makeApi(), [])
    expect(await screen.findByText(/nobody to hand it to yet/i)).toBeTruthy()
  })

  it('surfaces a refused offer', async () => {
    render1(
      makeApi({
        offerOwnership: () =>
          Promise.reject(new ApiClientError(400, 'not_a_member', 'not a member')),
      }),
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Offer ownership' }))
    expect(await screen.findByRole('alert')).toBeTruthy()
  })

  it('surfaces a failure to check for a pending offer', async () => {
    render1(makeApi({ getPendingTransfer: () => Promise.reject(new Error('boom')) }))
    expect(await screen.findByRole('alert')).toBeTruthy()
  })
})

describe('AcceptOwnershipPanel', () => {
  it('spells out what accepting commits you to', () => {
    render(<AcceptOwnershipPanel api={makeApi()} worldId="w" onAccepted={vi.fn()} />)
    expect(screen.getByText(/current owner becomes a player/i)).toBeTruthy()
    expect(screen.getByText(/not be able to leave without handing it on/i)).toBeTruthy()
  })

  it('accepts and notifies the caller', async () => {
    const acceptOwnership = vi.fn(() => Promise.resolve())
    const onAccepted = vi.fn()
    render(
      <AcceptOwnershipPanel
        api={makeApi({ acceptOwnership })}
        worldId="w"
        onAccepted={onAccepted}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Accept ownership' }))

    await waitFor(() => expect(acceptOwnership).toHaveBeenCalledWith('w'))
    await waitFor(() => expect(onAccepted).toHaveBeenCalled())
  })

  it('surfaces a refused accept', async () => {
    const onAccepted = vi.fn()
    render(
      <AcceptOwnershipPanel
        api={makeApi({
          acceptOwnership: () => Promise.reject(new ApiClientError(403, 'forbidden', 'not yours')),
        })}
        worldId="w"
        onAccepted={onAccepted}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Accept ownership' }))

    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(onAccepted).not.toHaveBeenCalled()
  })
})
