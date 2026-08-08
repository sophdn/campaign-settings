import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ApiClientError, type ApiClient, type MemberView, type Passage } from '../api'
import { makeApi } from '../testing/fake-api'
import { EntityPassagesPanel } from './entity-passages-panel'

const passage = (over: Partial<Passage> = {}): Passage => ({
  id: 'p1',
  entity_id: 'e',
  author_id: 'a',
  body: 'He keeps the ledger.',
  position: 0,
  status: 'published',
  visibility: 'dm_only',
  ...over,
})

const MEMBERS: MemberView[] = [
  { accountId: 'a', username: 'dm', role: 'owner', joinedAt: '2026-07-20T10:00:00.000Z' },
  { accountId: 'p1', username: 'player-one', role: 'player', joinedAt: '2026-07-20T10:00:00.000Z' },
]

function renderPanel(api: ApiClient, onChanged = vi.fn()): { onChanged: () => void } {
  render(
    <EntityPassagesPanel api={api} worldId="w" kind="npc" entityId="e" onChanged={onChanged} />,
  )
  return { onChanged }
}

describe('EntityPassagesPanel', () => {
  it('says the page has only its description when there are no reveals', async () => {
    renderPanel(makeApi({ listPassages: vi.fn(() => Promise.resolve([])) }))
    expect(await screen.findByText(/No reveals yet/)).toBeTruthy()
  })

  it('lists reveals in the order the server returned them', async () => {
    renderPanel(
      makeApi({
        listPassages: vi.fn(() =>
          Promise.resolve([
            passage({ id: 'p1', body: 'FIRST', position: 0 }),
            passage({ id: 'p2', body: 'SECOND', position: 1 }),
          ]),
        ),
        listMembers: vi.fn(() => Promise.resolve(MEMBERS)),
      }),
    )
    // `Reveal <label>` is the textarea; `Reveal <label> visibility` is the
    // select beside it, so match exactly rather than by prefix.
    expect((await screen.findByLabelText('Reveal FIRST')).nodeName).toBe('TEXTAREA')
    expect((screen.getByLabelText('Reveal FIRST') as HTMLTextAreaElement).value).toBe('FIRST')
    expect((screen.getByLabelText('Reveal SECOND') as HTMLTextAreaElement).value).toBe('SECOND')
  })

  /**
   * The fail-closed rule, at the surface a DM actually touches. The panel sends
   * NO visibility on create, so the column default (dm_only) decides — a new
   * reveal is never accidentally born public.
   */
  it('adds a reveal without naming a visibility, so it starts hidden', async () => {
    const createPassage = vi.fn(() => Promise.resolve(passage({ body: 'new' })))
    const { onChanged } = renderPanel(
      makeApi({ createPassage, listPassages: vi.fn(() => Promise.resolve([])) }),
    )
    await screen.findByText(/No reveals yet/)

    fireEvent.change(screen.getByLabelText('New reveal'), { target: { value: 'a fresh secret' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add reveal' }))

    await waitFor(() => expect(createPassage).toHaveBeenCalled())
    const [, , , input] = createPassage.mock.calls[0] as unknown as [
      string,
      string,
      string,
      Record<string, unknown>,
    ]
    expect(input.body).toBe('a fresh secret')
    expect(input).not.toHaveProperty('visibility')
    // the page re-reads its composed body, since it just changed
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
  })

  it('refuses to add an empty reveal', async () => {
    const createPassage = vi.fn(() => Promise.resolve(passage()))
    renderPanel(makeApi({ createPassage, listPassages: vi.fn(() => Promise.resolve([])) }))
    await screen.findByText(/No reveals yet/)

    fireEvent.change(screen.getByLabelText('New reveal'), { target: { value: '   ' } })
    expect((screen.getByRole('button', { name: 'Add reveal' }) as HTMLButtonElement).disabled).toBe(
      true,
    )
    expect(createPassage).not.toHaveBeenCalled()
  })

  it('saves an edited reveal, and only once it actually differs', async () => {
    const updatePassage = vi.fn(() => Promise.resolve(passage({ body: 'edited' })))
    renderPanel(
      makeApi({
        updatePassage,
        listPassages: vi.fn(() => Promise.resolve([passage({ body: 'original' })])),
      }),
    )
    const field = await screen.findByLabelText('Reveal original')
    const save = screen.getByRole('button', { name: 'Save original' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)

    fireEvent.change(field, { target: { value: 'edited' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save original' }))
    await waitFor(() => expect(updatePassage).toHaveBeenCalledWith('w', 'p1', { body: 'edited' }))
  })

  /**
   * Reordering SWAPS two positions rather than reindexing the list, so a failure
   * between the two writes leaves an order that is merely wrong rather than one
   * where several rows claim the same slot.
   */
  it('reorders by swapping the two neighbours’ positions', async () => {
    const updatePassage = vi.fn(() => Promise.resolve(passage()))
    renderPanel(
      makeApi({
        updatePassage,
        listPassages: vi.fn(() =>
          Promise.resolve([
            passage({ id: 'p1', body: 'FIRST', position: 0 }),
            passage({ id: 'p2', body: 'SECOND', position: 1 }),
          ]),
        ),
      }),
    )
    await screen.findByLabelText('Reveal FIRST')
    fireEvent.click(screen.getByRole('button', { name: 'Move FIRST down' }))

    await waitFor(() => expect(updatePassage).toHaveBeenCalledTimes(2))
    expect(updatePassage.mock.calls[0]).toEqual(['w', 'p1', { position: 1 }])
    expect(updatePassage.mock.calls[1]).toEqual(['w', 'p2', { position: 0 }])
  })

  it('cannot move the first one up or the last one down', async () => {
    renderPanel(
      makeApi({
        listPassages: vi.fn(() =>
          Promise.resolve([
            passage({ id: 'p1', body: 'FIRST', position: 0 }),
            passage({ id: 'p2', body: 'SECOND', position: 1 }),
          ]),
        ),
      }),
    )
    await screen.findByLabelText('Reveal FIRST')
    const disabled = (name: string): boolean =>
      (screen.getByRole('button', { name }) as HTMLButtonElement).disabled
    expect(disabled('Move FIRST up')).toBe(true)
    expect(disabled('Move SECOND down')).toBe(true)
    expect(disabled('Move FIRST down')).toBe(false)
  })

  it('confirms before deleting, and does nothing until confirmed', async () => {
    const deletePassage = vi.fn(() => Promise.resolve(undefined))
    renderPanel(
      makeApi({
        deletePassage,
        listPassages: vi.fn(() => Promise.resolve([passage({ body: 'doomed' })])),
      }),
    )
    await screen.findByLabelText('Reveal doomed')

    fireEvent.click(screen.getByRole('button', { name: 'Delete doomed' }))
    expect(deletePassage).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Really delete doomed' }))
    await waitFor(() => expect(deletePassage).toHaveBeenCalledWith('w', 'p1'))
  })

  it('backs out of a delete without deleting', async () => {
    const deletePassage = vi.fn(() => Promise.resolve(undefined))
    renderPanel(
      makeApi({
        deletePassage,
        listPassages: vi.fn(() => Promise.resolve([passage({ body: 'spared' })])),
      }),
    )
    await screen.findByLabelText('Reveal spared')
    fireEvent.click(screen.getByRole('button', { name: 'Delete spared' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(await screen.findByRole('button', { name: 'Delete spared' })).toBeTruthy()
    expect(deletePassage).not.toHaveBeenCalled()
  })

  it('sets a reveal’s visibility through the shared control', async () => {
    const updatePassage = vi.fn(() => Promise.resolve(passage()))
    renderPanel(
      makeApi({
        updatePassage,
        listPassages: vi.fn(() => Promise.resolve([passage({ body: 'secret' })])),
        listMembers: vi.fn(() => Promise.resolve(MEMBERS)),
      }),
    )
    const select = await screen.findByLabelText('Reveal secret visibility')
    fireEvent.change(select, { target: { value: 'restricted' } })

    await waitFor(() =>
      expect(updatePassage).toHaveBeenCalledWith('w', 'p1', { visibility: 'restricted' }),
    )
    // and the per-player list is what appears — the owner is not offered a grant
    // to themselves, so only the one player shows
    expect(await screen.findByRole('button', { name: 'Grant player-one' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Grant dm' })).toBeNull()
  })

  it('grants and revokes a player on one reveal', async () => {
    let grants: string[] = []
    // Stateful, because the control RE-READS the grant list after every toggle
    // rather than patching local state — a mock that never changed would make
    // the revoke half of this test unreachable.
    const grantPassageAccess = vi.fn((_w: string, _p: string, accountId: string) => {
      grants = [accountId]
      return Promise.resolve(undefined)
    })
    const revokePassageAccess = vi.fn(() => {
      grants = []
      return Promise.resolve(undefined)
    })
    renderPanel(
      makeApi({
        grantPassageAccess,
        revokePassageAccess,
        listPassageGrants: vi.fn(() => Promise.resolve(grants)),
        listPassages: vi.fn(() =>
          Promise.resolve([passage({ body: 'shared', visibility: 'restricted' })]),
        ),
        listMembers: vi.fn(() => Promise.resolve(MEMBERS)),
      }),
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Grant player-one' }))
    await waitFor(() => expect(grantPassageAccess).toHaveBeenCalledWith('w', 'p1', 'p1'))

    fireEvent.click(await screen.findByRole('button', { name: 'Revoke player-one' }))
    await waitFor(() => expect(revokePassageAccess).toHaveBeenCalledWith('w', 'p1', 'p1'))
  })

  it('surfaces a refused write instead of pretending it worked', async () => {
    renderPanel(
      makeApi({
        listPassages: vi.fn(() => Promise.resolve([passage({ body: 'x' })])),
        deletePassage: vi.fn(() =>
          Promise.reject(new ApiClientError(403, 'forbidden', 'owner only')),
        ),
      }),
    )
    await screen.findByLabelText('Reveal x')
    fireEvent.click(screen.getByRole('button', { name: 'Delete x' }))
    fireEvent.click(screen.getByRole('button', { name: 'Really delete x' }))
    // the SERVER's reason, not a generic one — errorMessage prefers it
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain('owner only')
  })

  it('reports a failed load rather than rendering an empty panel', async () => {
    renderPanel(
      makeApi({
        listPassages: vi.fn(() =>
          Promise.reject(new ApiClientError(500, 'oops', 'server fell over')),
        ),
      }),
    )
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain('server fell over')
  })
})

describe('EntityPassagesPanel — the shared visibility control', () => {
  it('reports a failed grant-list load against the reveal, naming the right noun', async () => {
    renderPanel(
      makeApi({
        listPassages: vi.fn(() =>
          Promise.resolve([passage({ body: 'x', visibility: 'restricted' })]),
        ),
        listMembers: vi.fn(() => Promise.resolve(MEMBERS)),
        // Rejecting with a NON-Error is what exercises the fallback copy:
        // errorMessage prefers an Error's own message and only falls back for
        // values that carry none.
        listPassageGrants: vi.fn(() => Promise.reject('no message here')),
      }),
    )
    // The control is shared with entities, so it takes its noun from the
    // subject — "reveal" here, "page" there.
    expect(await screen.findByText(/Could not load who can see this reveal/)).toBeTruthy()
  })

  it('moves a reveal up as well as down', async () => {
    const updatePassage = vi.fn(() => Promise.resolve(passage()))
    renderPanel(
      makeApi({
        updatePassage,
        listPassages: vi.fn(() =>
          Promise.resolve([
            passage({ id: 'p1', body: 'FIRST', position: 0 }),
            passage({ id: 'p2', body: 'SECOND', position: 1 }),
          ]),
        ),
      }),
    )
    await screen.findByLabelText('Reveal SECOND')
    fireEvent.click(screen.getByRole('button', { name: 'Move SECOND up' }))

    await waitFor(() => expect(updatePassage).toHaveBeenCalledTimes(2))
    expect(updatePassage.mock.calls[0]).toEqual(['w', 'p2', { position: 0 }])
    expect(updatePassage.mock.calls[1]).toEqual(['w', 'p1', { position: 1 }])
  })

  /**
   * Unmounting mid-flight must not land the previous subject's grants in the
   * new one's state — that is what the `cancelled` guard in VisibilityControl
   * is for. Nothing is asserted about the DOM afterwards because the point is
   * that nothing happens: no state update, no unmounted-component warning.
   */
  it('drops an in-flight grant load when the panel unmounts', async () => {
    let release: (v: string[]) => void = () => {}
    const pending = new Promise<string[]>((resolve) => {
      release = resolve
    })
    const { unmount } = render(
      <EntityPassagesPanel
        api={makeApi({
          listPassages: vi.fn(() =>
            Promise.resolve([passage({ body: 'x', visibility: 'restricted' })]),
          ),
          listMembers: vi.fn(() => Promise.resolve(MEMBERS)),
          listPassageGrants: vi.fn(() => pending),
        })}
        worldId="w"
        kind="npc"
        entityId="e"
        onChanged={vi.fn()}
      />,
    )
    await screen.findByLabelText('Reveal x')
    unmount()
    release(['p1'])
    await pending
  })
})

describe('EntityPassagesPanel — edges of the list', () => {
  it('labels a reveal with no text so its controls are still nameable', async () => {
    renderPanel(makeApi({ listPassages: vi.fn(() => Promise.resolve([passage({ body: '' })])) }))
    // Without a fallback the buttons would be named "Save ", "Delete " and so on
    // — indistinguishable from each other and unusable with a screen reader.
    expect(await screen.findByRole('button', { name: 'Save Empty reveal' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Delete Empty reveal' })).toBeTruthy()
  })
})

describe('EntityPassagesPanel — reviewing player proposals', () => {
  const proposal = (over: Partial<Passage> = {}) =>
    passage({
      id: 'prop1',
      body: 'I think he runs the ledger.',
      status: 'proposed',
      visibility: 'restricted',
      author_id: 'p1',
      ...over,
    })

  it('shows proposals apart from the DM’s own reveals', async () => {
    renderPanel(
      makeApi({
        listPassages: vi.fn(() =>
          Promise.resolve([passage({ id: 'mine', body: 'MY REVEAL' }), proposal()]),
        ),
        listMembers: vi.fn(() => Promise.resolve(MEMBERS)),
      }),
    )
    expect(await screen.findByRole('region', { name: 'Suggestions awaiting review' })).toBeTruthy()
    // the proposal's text is quoted, NOT put in an editable box — accepting a
    // suggestion should not silently become accepting a rewrite of it
    expect(screen.getByText('I think he runs the ledger.').nodeName).toBe('BLOCKQUOTE')
    expect(screen.queryByLabelText('Reveal I think he runs the ledger.')).toBeNull()
    // the DM's own reveal is still editable
    expect(screen.getByLabelText('Reveal MY REVEAL')).toBeTruthy()
  })

  it('accepts at the visibility the owner picks, not a default', async () => {
    const acceptPassage = vi.fn(() => Promise.resolve(passage() as never))
    renderPanel(
      makeApi({ acceptPassage, listPassages: vi.fn(() => Promise.resolve([proposal()])) }),
    )

    const label = 'I think he runs the ledger.'.slice(0, 40)
    fireEvent.change(await screen.findByLabelText(`Publish ${label} as`, { exact: true }), {
      target: { value: 'dm_only' },
    })
    fireEvent.click(screen.getByRole('button', { name: `Accept ${label}` }))

    await waitFor(() => expect(acceptPassage).toHaveBeenCalledWith('w', 'prop1', 'dm_only'))
  })

  it('rejects a proposal', async () => {
    const rejectPassage = vi.fn(() => Promise.resolve(undefined))
    renderPanel(
      makeApi({ rejectPassage, listPassages: vi.fn(() => Promise.resolve([proposal()])) }),
    )
    const label = 'I think he runs the ledger.'.slice(0, 40)
    fireEvent.click(await screen.findByRole('button', { name: `Reject ${label}` }))
    await waitFor(() => expect(rejectPassage).toHaveBeenCalledWith('w', 'prop1'))
  })

  it('names the controls of a suggestion with no text', async () => {
    renderPanel(makeApi({ listPassages: vi.fn(() => Promise.resolve([proposal({ body: '' })])) }))
    expect(await screen.findByRole('button', { name: 'Accept Empty suggestion' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Reject Empty suggestion' })).toBeTruthy()
  })

  it('surfaces a refused accept', async () => {
    renderPanel(
      makeApi({
        listPassages: vi.fn(() => Promise.resolve([proposal()])),
        acceptPassage: vi.fn(() => Promise.reject(new ApiClientError(403, 'forbidden', 'no'))),
      }),
    )
    const label = 'I think he runs the ledger.'.slice(0, 40)
    fireEvent.click(await screen.findByRole('button', { name: `Accept ${label}` }))
    expect((await screen.findByRole('alert')).textContent).toBe('no')
  })
})
