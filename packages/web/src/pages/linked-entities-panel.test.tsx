import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { type ApiClient, ApiClientError, type EntityRelationship, type WikiEntry } from '../api'
import { ApiProvider } from '../app/api-context'
import { buildWikiNameIndex } from '../components/entity-description'
import { makeApi } from '../testing/fake-api'
import { LinkedEntitiesPanel, linkedEntities } from './linked-entities-panel'

const ENTRIES: WikiEntry[] = [
  { kind: 'npc', id: 'n1', name: 'Silas Crow' },
  { kind: 'npc', id: 'n2', name: 'Mira Vane' },
  { kind: 'location', id: 'l1', name: 'Saltmarsh Docks' },
]
const index = (entries: WikiEntry[] = ENTRIES) => buildWikiNameIndex(entries)

const renderPanel = (
  text: string,
  opts: { entries?: WikiEntry[]; api?: ApiClient; canEdit?: boolean } = {},
): void => {
  const entries = opts.entries ?? ENTRIES
  render(
    <ApiProvider value={opts.api ?? makeApi()}>
      <MemoryRouter>
        <LinkedEntitiesPanel
          text={text}
          worldId="w1"
          nameIndex={index(entries)}
          kind="npc"
          entityId="n1"
          candidates={entries}
          canEdit={opts.canEdit ?? false}
        />
      </MemoryRouter>
    </ApiProvider>,
  )
}

/** The mentions group, addressable in its own right. */
const mentionList = (): HTMLElement =>
  screen.getByRole('region', { name: 'Mentioned in this entry' })

const relationship = (over: Partial<EntityRelationship> = {}): EntityRelationship => ({
  id: 'r1',
  type: 'member_of',
  label: 'Member of',
  outgoing: true,
  note: '',
  qualifier: null,
  other: { kind: 'organization', id: 'o1', name: 'The Ashen Hand' },
  ...over,
})

describe('linkedEntities', () => {
  it('lists what a body links to, in order of first mention', () => {
    expect(linkedEntities('Met [[Mira Vane]] at [[Saltmarsh Docks]].', index())).toEqual([
      { kind: 'npc', id: 'n2', name: 'Mira Vane' },
      { kind: 'location', id: 'l1', name: 'Saltmarsh Docks' },
    ])
  })

  it('deduplicates by TARGET, not by the written name', () => {
    // `[[Mira Vane]]` and `[[mira vane]]` resolve to one entity, so one card.
    const links = linkedEntities('[[Mira Vane]] again, [[mira vane]] once more', index())
    expect(links).toHaveLength(1)
    expect(links[0]?.id).toBe('n2')
  })

  it('omits names that resolve to nothing', () => {
    // A dangling reference has no card to navigate to. The red marker in the body
    // reports it; repeating that here would make this a second error list.
    expect(linkedEntities('Met [[Nobody At All]] today', index())).toEqual([])
  })

  it('returns nothing for a body with no references', () => {
    expect(linkedEntities('just prose, no links', index())).toEqual([])
  })
})

describe('LinkedEntitiesPanel', () => {
  it('renders each link as a row pointing at the entity, with its kind beside it', () => {
    renderPanel('Met [[Mira Vane]] at [[Saltmarsh Docks]].')
    const list = within(mentionList()).getByRole('list')
    const links = within(list).getAllByRole('link')
    expect(links).toHaveLength(2)
    expect(links[0]?.getAttribute('href')).toBe('/worlds/w1/npc/n2')
    expect(links[1]?.getAttribute('href')).toBe('/worlds/w1/location/l1')
    // The kind tag is a sibling of the link, not part of its name.
    const rows = within(list).getAllByRole('listitem')
    expect(rows[1]?.textContent ?? '').toMatch(/location/i)
  })

  it('renders mentions as rows, NOT as the wiki index’s card grid', () => {
    // A browse grid and an inline reference list want different things: you
    // choose among cards, and you scan past rows. The wiki index keeps its grid.
    renderPanel('Met [[Mira Vane]].')
    const list = within(mentionList()).getByRole('list')
    expect(list.className).toContain('entity-rows')
    expect(list.className).not.toContain('card-grid')
    expect(within(list).getByRole('listitem').className).toContain('entity-row')
  })

  it('gives a relationship the SAME row treatment, so the two lists read as siblings', async () => {
    const api = makeApi({ listRelationships: vi.fn(() => Promise.resolve([relationship()])) })
    renderPanel('Met [[Mira Vane]].', { api })
    await screen.findByText('Member of')

    const rels = within(screen.getByRole('region', { name: 'Relationships' })).getByRole('list')
    expect(rels.className).toContain('entity-rows')
    expect(within(rels).getByRole('listitem').className).toContain('entity-row')
  })

  it('says so plainly when nothing is linked', () => {
    renderPanel('just prose')
    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.getByText(/nothing linked yet/i)).toBeTruthy()
  })

  it('is two sibling panels, with no "Linked entities" wrapper around them', () => {
    // The wrapper named a category rather than a thing. Each panel now answers
    // its own question and is addressable in its own right.
    renderPanel('Met [[Mira Vane]].')
    expect(screen.queryByRole('region', { name: 'Linked entities' })).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Linked entities' })).toBeNull()
    expect(screen.getByRole('region', { name: 'Relationships' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Relationships' })).toBeTruthy()
    expect(mentionList()).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Mentioned in this entry' })).toBeTruthy()
  })

  it('opens both panels CLOSED, because they are secondary to the prose', () => {
    renderPanel('Met [[Mira Vane]].')
    for (const name of ['Relationships', 'Mentioned in this entry']) {
      const details = screen.getByRole('region', { name }).querySelector('details')
      expect(details?.hasAttribute('open')).toBe(false)
    }
  })
})

describe('typed relationships in the panel', () => {
  it('shows a relationship labelled with its type, distinct from a bare mention', async () => {
    // The whole point of the store: a reader can tell "is a member of" from
    // "the prose here happens to mention".
    const api = makeApi({ listRelationships: vi.fn(() => Promise.resolve([relationship()])) })
    renderPanel('Met [[Mira Vane]].', { api })

    expect(await screen.findByText('Member of')).toBeTruthy()
    const link = screen.getByRole('link', { name: 'The Ashen Hand' })
    expect(link.getAttribute('href')).toBe('/worlds/w1/organization/o1')
  })

  it('shows the INVERSE label when the relationship points at this entity', async () => {
    // One stored row, read from the other end — the server has already inverted
    // it, so the two pages cannot describe the relation differently.
    const api = makeApi({
      listRelationships: vi.fn(() =>
        Promise.resolve([relationship({ label: 'Has member', outgoing: false })]),
      ),
    })
    renderPanel('', { api })
    expect(await screen.findByText('Has member')).toBeTruthy()
  })

  it('keeps a mention AND a relationship for the same entity, in their own groups', async () => {
    // Both are true at once: the body refers to it, and it is typed. Typing does
    // not consume the mention.
    const api = makeApi({
      listRelationships: vi.fn(() =>
        Promise.resolve([relationship({ other: { kind: 'npc', id: 'n2', name: 'Mira Vane' } })]),
      ),
    })
    renderPanel('Met [[Mira Vane]].', { api })

    await screen.findByText('Member of')
    expect(screen.getAllByRole('link', { name: /Mira Vane/ }).length).toBe(2)
    expect(within(mentionList()).getAllByRole('link', { name: /Mira Vane/ })).toHaveLength(1)
  })

  it('shows the note when one was written', async () => {
    const api = makeApi({
      listRelationships: vi.fn(() => Promise.resolve([relationship({ note: 'Since the fire.' })])),
    })
    renderPanel('', { api })
    expect(await screen.findByText('Since the fire.')).toBeTruthy()
  })

  it('adds a relationship and reloads', async () => {
    const createRelationship = vi.fn(() => Promise.resolve(relationship()))
    const listRelationships = vi.fn(() => Promise.resolve([]))
    renderPanel('', {
      api: makeApi({ createRelationship, listRelationships }),
      canEdit: true,
    })

    fireEvent.change(await screen.findByLabelText('Relationship'), {
      target: { value: 'ally_of' },
    })
    fireEvent.change(screen.getByLabelText('Relationship target'), { target: { value: 'n2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add relationship' }))

    await waitFor(() =>
      expect(createRelationship).toHaveBeenCalledWith('w1', 'npc', 'n1', {
        toId: 'n2',
        type: 'ally_of',
      }),
    )
    await waitFor(() => expect(listRelationships).toHaveBeenCalledTimes(2))
  })

  it('shows a qualifier as its own badge, not folded into the label or note', async () => {
    const api = makeApi({
      listRelationships: vi.fn(() =>
        Promise.resolve([
          relationship({ type: 'speaks', label: 'Speaks', qualifier: 'liturgical' }),
        ]),
      ),
    })
    renderPanel('', { api })
    expect(await screen.findByText('liturgical')).toBeTruthy()
    expect(screen.getByText('Speaks')).toBeTruthy()
  })

  it('groups the fifteen types into social and attributive', async () => {
    // 0017 took the vocabulary from eleven to fifteen. The groups are what keep
    // "Ally of" and "Speaks" from sitting in one undifferentiated run of options.
    renderPanel('', { canEdit: true })
    const picker = await screen.findByLabelText('Relationship')
    const groups = within(picker).getAllByRole('group')

    expect(groups.map((g) => g.getAttribute('label'))).toEqual([
      'Social & structural',
      'Attributes',
    ])
    expect(
      within(groups[1] as HTMLElement)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Speaks', 'Practises', 'Venerates', 'Found at'])
    // Still one flat set of choices underneath: all fifteen remain selectable.
    expect(within(picker).getAllByRole('option')).toHaveLength(15)
  })

  it('offers a role only for a type that accepts one, and sends it', async () => {
    const createRelationship = vi.fn(() => Promise.resolve(relationship()))
    renderPanel('', {
      api: makeApi({ createRelationship, listRelationships: vi.fn(() => Promise.resolve([])) }),
      canEdit: true,
    })

    // `member_of` defines no qualifier vocabulary, so the field is absent…
    expect(await screen.findByLabelText('Relationship')).toBeTruthy()
    expect(screen.queryByLabelText('Relationship role')).toBeNull()

    // …and appears once the type is one that accepts a role.
    fireEvent.change(screen.getByLabelText('Relationship'), { target: { value: 'speaks' } })
    const role = screen.getByLabelText('Relationship role')
    expect(
      within(role)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Unspecified', 'native', 'secondary', 'liturgical', 'trade'])

    fireEvent.change(role, { target: { value: 'native' } })
    fireEvent.change(screen.getByLabelText('Relationship target'), { target: { value: 'n2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add relationship' }))

    await waitFor(() =>
      expect(createRelationship).toHaveBeenCalledWith('w1', 'npc', 'n1', {
        toId: 'n2',
        type: 'speaks',
        qualifier: 'native',
      }),
    )
  })

  it('does not send a stale role after the type changes to one that takes none', async () => {
    // The server refuses a qualifier on a type with no vocabulary for it, so
    // leaking the old selection would turn a valid submission into a 400.
    const createRelationship = vi.fn(() => Promise.resolve(relationship()))
    renderPanel('', {
      api: makeApi({ createRelationship, listRelationships: vi.fn(() => Promise.resolve([])) }),
      canEdit: true,
    })

    fireEvent.change(await screen.findByLabelText('Relationship'), { target: { value: 'speaks' } })
    fireEvent.change(screen.getByLabelText('Relationship role'), { target: { value: 'native' } })
    fireEvent.change(screen.getByLabelText('Relationship'), { target: { value: 'ally_of' } })
    fireEvent.change(screen.getByLabelText('Relationship target'), { target: { value: 'n2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add relationship' }))

    await waitFor(() =>
      expect(createRelationship).toHaveBeenCalledWith('w1', 'npc', 'n1', {
        toId: 'n2',
        type: 'ally_of',
      }),
    )
  })

  it('never offers the entity itself as a target', async () => {
    // The schema refuses a self-relationship, so offering it would only ever
    // produce a refusal.
    renderPanel('', { canEdit: true })
    const options = within(await screen.findByLabelText('Relationship target')).getAllByRole(
      'option',
    )
    expect(options.map((o) => o.textContent)).not.toContain('Silas Crow')
  })

  it('cannot be submitted until a target is chosen', async () => {
    renderPanel('', { canEdit: true })
    expect(await screen.findByRole('button', { name: 'Add relationship' })).toHaveProperty(
      'disabled',
      true,
    )
  })

  it('surfaces the server refusal, including the duplicate case', async () => {
    const api = makeApi({
      createRelationship: vi.fn(() =>
        Promise.reject(
          new ApiClientError(409, 'duplicate_relationship', 'that relationship already exists'),
        ),
      ),
    })
    renderPanel('', { api, canEdit: true })
    fireEvent.change(await screen.findByLabelText('Relationship target'), {
      target: { value: 'n2' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add relationship' }))
    expect((await screen.findByRole('alert')).textContent).toBe('that relationship already exists')
  })

  it('removes a relationship and reloads', async () => {
    const deleteRelationship = vi.fn(() => Promise.resolve())
    const listRelationships = vi.fn(() => Promise.resolve([relationship()]))
    renderPanel('', {
      api: makeApi({ deleteRelationship, listRelationships }),
      canEdit: true,
    })

    fireEvent.click(await screen.findByRole('button', { name: 'Remove Member of The Ashen Hand' }))
    await waitFor(() => expect(deleteRelationship).toHaveBeenCalledWith('w1', 'r1'))
    await waitFor(() => expect(listRelationships).toHaveBeenCalledTimes(2))
  })

  it('reports a refused removal', async () => {
    const api = makeApi({
      listRelationships: vi.fn(() => Promise.resolve([relationship()])),
      deleteRelationship: vi.fn(() =>
        Promise.reject(new ApiClientError(403, 'forbidden', 'no write')),
      ),
    })
    renderPanel('', { api, canEdit: true })
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Member of The Ashen Hand' }))
    expect((await screen.findByRole('alert')).textContent).toBe('no write')
  })

  it('stays legible on an entity with many relationships', async () => {
    // A well-connected organization in a long campaign accumulates these. The
    // panel renders one flat list rather than nesting per type, so the cost is
    // linear and every row is reachable without expanding anything.
    const many = Array.from({ length: 60 }, (_, i) =>
      relationship({
        id: `r${i}`,
        other: { kind: 'npc', id: `n${i}`, name: `Member ${i}` },
      }),
    )
    renderPanel('', { api: makeApi({ listRelationships: vi.fn(() => Promise.resolve(many)) }) })

    await screen.findByRole('link', { name: 'Member 0' })
    const group = screen.getByRole('region', { name: 'Relationships' })
    expect(within(group).getAllByRole('listitem')).toHaveLength(60)
    // Nothing is truncated away silently — the last row is present too.
    expect(within(group).getByRole('link', { name: 'Member 59' })).toBeTruthy()
  })

  it('specifies a bracket-derived row in place rather than by deleting it', async () => {
    // Delete-and-retype would lose the row's source passage, which is what
    // governs who may see it — so a link written inside a secret reveal would
    // become public the moment the GM described it more precisely.
    const updateRelationship = vi.fn(() => Promise.resolve(relationship()))
    const deleteRelationship = vi.fn(() => Promise.resolve())
    renderPanel('', {
      api: makeApi({
        listRelationships: vi.fn(() => Promise.resolve([relationship({ type: 'related_to' })])),
        updateRelationship,
        deleteRelationship,
      }),
      canEdit: true,
    })

    fireEvent.click(await screen.findByRole('button', { name: 'Specify Member of The Ashen Hand' }))
    fireEvent.change(screen.getByLabelText('New relationship type'), {
      target: { value: 'ally_of' },
    })
    fireEvent.change(screen.getByLabelText('New relationship note'), {
      target: { value: 'since the fire' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save relationship' }))

    await waitFor(() =>
      expect(updateRelationship).toHaveBeenCalledWith('w1', 'r1', {
        type: 'ally_of',
        note: 'since the fire',
        qualifier: null,
      }),
    )
    expect(deleteRelationship).not.toHaveBeenCalled()
  })

  it('sends a role only for a type that accepts one', async () => {
    const updateRelationship = vi.fn(() => Promise.resolve(relationship()))
    renderPanel('', {
      api: makeApi({
        listRelationships: vi.fn(() => Promise.resolve([relationship()])),
        updateRelationship,
      }),
      canEdit: true,
    })

    fireEvent.click(await screen.findByRole('button', { name: 'Specify Member of The Ashen Hand' }))
    // `member_of` defines no vocabulary, so the field is absent…
    expect(screen.queryByLabelText('New relationship role')).toBeNull()
    fireEvent.change(screen.getByLabelText('New relationship type'), {
      target: { value: 'speaks' },
    })
    fireEvent.change(screen.getByLabelText('New relationship role'), {
      target: { value: 'native' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save relationship' }))

    await waitFor(() =>
      expect(updateRelationship).toHaveBeenCalledWith('w1', 'r1', {
        type: 'speaks',
        note: '',
        qualifier: 'native',
      }),
    )
  })

  it('reads its vocabulary from the SAME list the add-form does', async () => {
    renderPanel('', {
      api: makeApi({ listRelationships: vi.fn(() => Promise.resolve([relationship()])) }),
      canEdit: true,
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Specify Member of The Ashen Hand' }))

    // Two copies of the vocabulary is how the two forms come to offer different
    // type lists after the next type is added.
    // By ROLE and accessible name: both selects carry a visible label reading
    // "Relationship", so a label-text query matches whichever it finds first.
    const editor = screen.getByRole('combobox', { name: 'New relationship type' })
    const adder = screen.getByRole('combobox', { name: 'Relationship' })
    const names = (el: HTMLElement) =>
      within(el)
        .getAllByRole('option')
        .map((o) => o.textContent)
    expect(names(editor)).toEqual(names(adder))
  })

  it('closes the editor on Cancel without writing anything', async () => {
    const updateRelationship = vi.fn(() => Promise.resolve(relationship()))
    renderPanel('', {
      api: makeApi({
        listRelationships: vi.fn(() => Promise.resolve([relationship()])),
        updateRelationship,
      }),
      canEdit: true,
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Specify Member of The Ashen Hand' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByLabelText('New relationship type')).toBeNull()
    expect(updateRelationship).not.toHaveBeenCalled()
  })

  it('reports a refused change rather than pretending it worked', async () => {
    renderPanel('', {
      api: makeApi({
        listRelationships: vi.fn(() => Promise.resolve([relationship()])),
        updateRelationship: vi.fn(() =>
          Promise.reject(
            new ApiClientError(409, 'duplicate_relationship', 'that relationship already exists'),
          ),
        ),
      }),
      canEdit: true,
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Specify Member of The Ashen Hand' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save relationship' }))
    expect((await screen.findByRole('alert')).textContent).toBe('that relationship already exists')
  })

  it('offers a player no way to add or remove one', async () => {
    const api = makeApi({ listRelationships: vi.fn(() => Promise.resolve([relationship()])) })
    renderPanel('', { api })

    // A player reads relationships and follows them, and can do nothing else.
    await screen.findByText('Member of')
    expect(screen.getByRole('link', { name: 'The Ashen Hand' })).toBeTruthy()
    expect(screen.queryByLabelText('Relationship')).toBeNull()
    expect(screen.queryByRole('button', { name: /^Remove/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Specify/ })).toBeNull()
  })

  it('words the empty state differently for a player and for a DM', async () => {
    // A DM is told what to do next; a player is told there is nothing, because
    // there is nothing they could do about it.
    renderPanel('', { canEdit: true })
    expect(await screen.findByText(/Say how this connects/)).toBeTruthy()

    screen.getByRole('region', { name: 'Relationships' }) // the group exists either way
    render(<div />) // discard, then remount as a player
    renderPanel('', { canEdit: false })
    expect(await screen.findAllByText('No relationships recorded.')).toBeTruthy()
  })
})
