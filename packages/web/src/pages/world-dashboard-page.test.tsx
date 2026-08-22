import { render, screen, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import type { MemberRole, WorldDashboard } from '../api'
import { ApiProvider } from '../app/api-context'
import { WorldRoleProvider } from '../app/world-context'
import { makeApi } from '../testing/fake-api'
import { WorldDashboardPage } from './world-dashboard-page'

/** A dashboard payload with whichever field the test is about overridden. */
const dashboard = (over: Partial<WorldDashboard> = {}): WorldDashboard => ({
  session: {
    id: 's1',
    name: 'Leaving the garrison',
    playedAt: null,
    capturedText: 'During the night, an attack occurs.',
    ordering: 'updated_at',
    touches: [
      { id: 't1', entityId: 'e1', entityKind: 'npc', entityName: 'Coal Spirit', touchType: 'met' },
      {
        id: 't2',
        entityId: 'e2',
        entityKind: 'location',
        entityName: 'Domewatch Garrison',
        touchType: 'other',
      },
    ],
  },
  party: [
    { id: 'pc1', name: 'Lun', accountId: null, playerName: null },
    { id: 'pc2', name: 'Bright', accountId: 'acc2', playerName: 'rowan' },
  ],
  myCharacter: null,
  counts: { pc: 2, npc: 21, map: 2 },
  ...over,
})

function renderDashboard(role: MemberRole, data: WorldDashboard = dashboard()): void {
  const api = makeApi({ getDashboard: vi.fn(() => Promise.resolve(data)) })
  render(
    <ApiProvider value={api}>
      <WorldRoleProvider
        value={{ worldId: 'w1', worldName: 'spirit-call', role, refreshWorld: () => {} }}
      >
        <MemoryRouter initialEntries={['/worlds/w1']}>
          <Routes>
            <Route path="/worlds/:worldId" element={<WorldDashboardPage />} />
          </Routes>
        </MemoryRouter>
      </WorldRoleProvider>
    </ApiProvider>,
  )
}

describe('WorldDashboardPage', () => {
  it('names the world and states what a GM can do', async () => {
    renderDashboard('owner')
    expect(await screen.findByRole('heading', { name: 'spirit-call' })).toBeTruthy()
    const role = screen.getByLabelText('Your role')
    expect(role.textContent).toContain('You write this world')
  })

  it('states what a player can do instead of naming their role alone', async () => {
    renderDashboard('player')
    const role = await screen.findByLabelText('Your role')
    expect(role.textContent).toContain('keep notes only you can write')
    expect(role.textContent).not.toContain('You write this world')
  })

  it('shows the GM the session first, then the party', async () => {
    renderDashboard('owner')
    // The role panel renders before the fetch resolves, so wait on a panel that
    // only exists once it has — otherwise the order assertion sees one element.
    await screen.findByLabelText('Jump to')
    const labels = screen.getAllByRole('region').map((p) => p.getAttribute('aria-label'))
    expect(labels).toEqual(['Your role', 'Where you left off', 'The party', 'Jump to'])
  })

  it('shows a player their character first, then the session, and no party', async () => {
    renderDashboard(
      'player',
      dashboard({ myCharacter: { id: 'pc2', name: 'Bright', accountId: 'acc2' } }),
    )
    await screen.findByLabelText('Jump to')
    const labels = screen.getAllByRole('region').map((p) => p.getAttribute('aria-label'))
    expect(labels).toEqual(['Your role', 'Your character', 'Where you left off', 'Jump to'])
    expect(
      within(screen.getByLabelText('Your character')).getByRole('link', { name: 'Bright' }),
    ).toBeTruthy()
  })

  it('labels the session panel for work-recency and says which rule placed it', async () => {
    renderDashboard('owner')
    const panel = await screen.findByLabelText('Where you left off')
    // Never "Last session": the updated_at fallback promotes an edited old one.
    expect(panel.textContent).toContain('most recently edited')
    expect(panel.textContent).not.toContain('Last session')
  })

  it('names an in-world date when the session has one, and says so when it does not', async () => {
    renderDashboard('owner')
    expect((await screen.findByLabelText('Where you left off')).textContent).toContain(
      'no in-world date',
    )

    cleanupAndRender('owner', {
      ...dashboard(),
      session: { ...dashboard().session!, playedAt: '14th of Rain', ordering: 'played_at' },
    })
    const panel = await screen.findByLabelText('Where you left off')
    expect(panel.textContent).toContain('14th of Rain')
    expect(panel.textContent).toContain('most recent in-world date')
  })

  it('offers the GM the fix for an undated session and withholds it from a player', async () => {
    renderDashboard('owner')
    expect(await screen.findByRole('link', { name: 'Set one' })).toBeTruthy()

    cleanupAndRender('player')
    await screen.findByLabelText('Where you left off')
    expect(screen.queryByRole('link', { name: 'Set one' })).toBeNull()
  })

  it('splits the session’s entities into met and also-involved quick links', async () => {
    renderDashboard('owner')
    const panel = await screen.findByLabelText('Where you left off')
    expect(within(panel).getByText('Met')).toBeTruthy()
    expect(within(panel).getByText('Also involved')).toBeTruthy()
    expect(
      within(panel)
        .getByRole('link', { name: /Coal Spirit/ })
        .getAttribute('href'),
    ).toBe('/worlds/w1/npc/e1')
    expect(
      within(panel)
        .getByRole('link', { name: /Domewatch Garrison/ })
        .getAttribute('href'),
    ).toBe('/worlds/w1/location/e2')
  })

  it('names the party and says which characters have no player', async () => {
    renderDashboard('owner')
    const party = await screen.findByLabelText('The party')
    expect(within(party).getByRole('link', { name: 'Lun' }).getAttribute('href')).toBe(
      '/worlds/w1/pc/pc1',
    )
    expect(within(party).getByText('No player linked')).toBeTruthy()
    expect(within(party).getByText('rowan')).toBeTruthy()
  })

  it('tells a player with no character what happens next rather than showing a blank', async () => {
    renderDashboard('player')
    const panel = await screen.findByLabelText('Your character')
    expect(panel.textContent).toContain('No character linked to you yet')
    expect(panel.textContent).toContain('Your GM links a character to your account')
  })

  it('offers to write up the first session when the world has none, GM only', async () => {
    renderDashboard('owner', dashboard({ session: null }))
    const panel = await screen.findByLabelText('Where you left off')
    expect(panel.textContent).toContain('No sessions written up yet')
    expect(within(panel).getByRole('link', { name: 'Write up a session' })).toBeTruthy()

    cleanupAndRender('player', dashboard({ session: null }))
    const playerPanel = await screen.findByLabelText('Where you left off')
    expect(playerPanel.textContent).toContain('No sessions written up yet')
    expect(within(playerPanel).queryByRole('link', { name: 'Write up a session' })).toBeNull()
  })

  it('omits an empty touch group and the excerpt when the session has neither', async () => {
    renderDashboard(
      'owner',
      dashboard({
        session: {
          id: 's1',
          name: 'Quiet one',
          playedAt: null,
          capturedText: '',
          ordering: 'updated_at',
          touches: [],
        },
      }),
    )
    const panel = await screen.findByLabelText('Where you left off')
    expect(within(panel).queryByText('Met')).toBeNull()
    expect(within(panel).queryByText('Also involved')).toBeNull()
    expect(panel.querySelector('.session-excerpt')).toBeNull()
  })

  it('renders only the group a session has, when every touch is one type', async () => {
    renderDashboard(
      'owner',
      dashboard({
        session: {
          ...dashboard().session!,
          touches: [
            {
              id: 't1',
              entityId: 'e1',
              entityKind: 'npc',
              entityName: 'Coal Spirit',
              touchType: 'met',
            },
          ],
        },
      }),
    )
    const panel = await screen.findByLabelText('Where you left off')
    expect(within(panel).getByText('Met')).toBeTruthy()
    expect(within(panel).queryByText('Also involved')).toBeNull()
  })

  it('says the world has no characters rather than showing an empty party list', async () => {
    renderDashboard('owner', dashboard({ party: [] }))
    const party = await screen.findByLabelText('The party')
    expect(party.textContent).toContain('No characters yet')
  })

  it('links the Primary kinds with the viewer’s own counts, Maps included', async () => {
    renderDashboard('owner')
    const jump = await screen.findByLabelText('Jump to')
    // Maps folded into the shared primary array, so it is a quick link here for
    // exactly the same reason it is a rail link.
    expect(within(jump).getByRole('link', { name: /Maps/ }).getAttribute('href')).toBe(
      '/worlds/w1/maps',
    )
    expect(within(jump).getByRole('link', { name: /NPCs/ }).getAttribute('href')).toBe(
      '/worlds/w1/npc',
    )
    expect(within(jump).getByRole('link', { name: /NPCs/ }).textContent).toContain('21')
    // A kind the server did not count reads as 0 rather than blank.
    expect(within(jump).getByRole('link', { name: /Sessions/ }).textContent).toContain('0')
  })
})

/** Unmount the previous render before mounting a second one in the same test. */
function cleanupAndRender(role: MemberRole, data: WorldDashboard = dashboard()): void {
  document.body.innerHTML = ''
  renderDashboard(role, data)
}
