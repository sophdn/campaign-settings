import { ENTITY_KINDS } from '@campaign-settings/shared'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import type { FeatureFlags } from '../api'
import { ApiProvider } from '../app/api-context'
import { ConfigProvider } from '../app/config-context'
import { ModalProvider } from '../app/modal/modal-context'
import { makeApi } from '../testing/fake-api'
import { webFlags } from '../testing/flags'
import { LandingPage } from './landing-page'

/**
 * Render the landing page against a deployment with the given posture. The
 * flags are the whole point of this page's conditionals, so every test states
 * the posture it is describing rather than inheriting a default.
 */
function show(flags: Partial<FeatureFlags>, contactEmail = 'gm@example.com'): void {
  const api = makeApi({
    getConfig: vi.fn(() => Promise.resolve({ flags: webFlags(false, flags), contactEmail })),
  })
  render(
    <ApiProvider value={api}>
      <ConfigProvider>
        <ModalProvider>
          <MemoryRouter>
            <LandingPage />
          </MemoryRouter>
        </ModalProvider>
      </ConfigProvider>
    </ApiProvider>,
  )
}

describe('LandingPage — what a visitor with no session can read', () => {
  it('explains the app without needing a login', async () => {
    show({})
    expect(await screen.findByRole('heading', { name: 'CampaignSettings' })).toBeTruthy()
    expect(screen.getByText(/decides who sees what/i)).toBeTruthy()
    // the visibility promise is the product; it must survive a copy edit
    expect(screen.getByText(/missing from the API/i)).toBeTruthy()
  })

  it('counts the entry kinds from the shared source rather than hardcoding a number', async () => {
    show({})
    expect(
      await screen.findByText(new RegExp(`${ENTITY_KINDS.length} kinds of entry`)),
    ).toBeTruthy()
  })

  it('gives the getting-started steps in the words the real UI uses', async () => {
    show({})
    await screen.findByRole('heading', { name: 'Getting started' })
    // Each of these names a control that e2e/specs/landing.spec.ts then clicks.
    for (const control of [
      /Your worlds/,
      /New world/,
      /Members/,
      /Invite/,
      /Who can see this/,
      /Only the players you choose/,
    ]) {
      expect(screen.getAllByText(control).length, String(control)).toBeGreaterThan(0)
    }
  })
})

describe('LandingPage — the doors it offers follow the flags', () => {
  it('offers the demo only when demo mode is on', async () => {
    show({ demoModeEnabled: true })
    expect(await screen.findByRole('link', { name: 'Look around the demo' })).toBeTruthy()
  })

  it('hides the demo when demo mode is off', async () => {
    show({})
    await screen.findByRole('heading', { name: 'Getting in' })
    expect(screen.queryByRole('link', { name: 'Look around the demo' })).toBeNull()
  })

  it('offers registration when public signup is open', async () => {
    show({ publicSignupEnabled: true })
    expect(await screen.findByRole('link', { name: 'Create an account' })).toBeTruthy()
    expect(screen.queryByText(/invitation-only/i)).toBeNull()
  })

  /**
   * The launch posture: signup closed, demo on. The page must say so plainly
   * instead of showing a Create-an-account link that the server would refuse.
   */
  it('says accounts are invitation-only when signup is closed, with a way to ask', async () => {
    show({ demoModeEnabled: true })
    expect(await screen.findByText(/invitation-only/i)).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'Create an account' })).toBeNull()
    const mailto = screen.getByRole('link', { name: /gm@example.com/ })
    expect(mailto.getAttribute('href')).toBe('mailto:gm@example.com')
  })

  it('falls back to the contact modal when the deployment configured no address', async () => {
    show({}, '')
    const button = await screen.findByRole('button', { name: 'get in touch' })
    button.click()
    expect(await screen.findByText(/Interested\?/)).toBeTruthy()
  })

  it('offers log-in only when sign-in is switched on', async () => {
    show({ loginEnabled: true })
    expect(await screen.findByRole('link', { name: 'Log in' })).toBeTruthy()
  })

  it('hides log-in when sign-in is switched off', async () => {
    show({})
    await screen.findByRole('heading', { name: 'Getting in' })
    expect(screen.queryByRole('link', { name: 'Log in' })).toBeNull()
  })

  it('always links the terms and privacy pages, whatever is gated', async () => {
    show({})
    expect(await screen.findByRole('link', { name: 'Terms' })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Privacy' })).toBeTruthy()
  })
})
