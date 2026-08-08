import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { PrivacyPage } from './privacy-page'
import { TermsPage } from './terms-page'

const show = (el: React.JSX.Element): void => {
  render(<MemoryRouter>{el}</MemoryRouter>)
}

/**
 * These assertions are deliberately about FACTS, not phrasing. Each one pins a
 * claim that must stay true of the code — if a retention window or the deletion
 * cascade changes and the page is not updated, one of these fails.
 */
describe('PrivacyPage — the claims that must match the code', () => {
  it('names every retention window the code actually configures', () => {
    show(<PrivacyPage />)
    expect(screen.getByText(/expire 30 days after they start/i)).toBeTruthy()
    expect(screen.getByText(/at most once every five\s*minutes/i)).toBeTruthy()
    expect(screen.getByText(/expire after one hour and work once/i)).toBeTruthy()
    expect(screen.getByText(/expire after 24 hours and work once/i)).toBeTruthy()
    expect(screen.getByText(/expire after seven days and work once/i)).toBeTruthy()
  })

  it('says the raw User-Agent is never stored, which is the unusual claim', () => {
    show(<PrivacyPage />)
    expect(screen.getByText(/raw User-Agent your browser sends is never stored/i)).toBeTruthy()
  })

  it('does not claim immediate session deletion, because expired rows can outlive their expiry', () => {
    show(<PrivacyPage />)
    expect(screen.getByText(/can hold expired rows a while longer/i)).toBeTruthy()
  })

  it('describes deletion as real, and names what survives it', () => {
    show(<PrivacyPage />)
    expect(screen.getByText(/This is a real delete/i)).toBeTruthy()
    expect(screen.getByText(/Worlds you belong to are not deleted/i)).toBeTruthy()
    expect(screen.getByText(/a GM already accepted stays part of that/i)).toBeTruthy()
    expect(screen.getByText(/refused until you hand it to another member/i)).toBeTruthy()
  })

  it('states that leaving a world deletes that world’s notes and characters', () => {
    show(<PrivacyPage />)
    expect(screen.getByText(/deletes your notes and characters in that world/i)).toBeTruthy()
    expect(screen.getByText(/offers you a download of that/i)).toBeTruthy()
  })

  it('links the terms page', () => {
    show(<PrivacyPage />)
    expect(screen.getByRole('link', { name: 'Terms of use' })).toBeTruthy()
  })
})

describe('TermsPage', () => {
  it('takes the no-warranty position and tells people to keep their own backups', () => {
    show(<TermsPage />)
    expect(screen.getByText(/provided as is, with no warranty/i)).toBeTruthy()
    expect(screen.getByText(/Keep your own backups/i)).toBeTruthy()
    expect(screen.getByText(/MIT licence/i)).toBeTruthy()
  })

  it('says what happens to content if the service stops', () => {
    show(<TermsPage />)
    expect(screen.getByRole('heading', { name: 'If the service stops' })).toBeTruthy()
    expect(screen.getByText(/enough notice to export your worlds/i)).toBeTruthy()
  })

  it('describes sharing the way the app actually enforces it', () => {
    show(<TermsPage />)
    // GM-granted, server-enforced on read — not "what their character has discovered"
    expect(screen.getByText(/server enforces that on every read/i)).toBeTruthy()
  })

  it('does not pretend to be legal advice or a support organisation', () => {
    show(<TermsPage />)
    expect(screen.getByText(/not legal advice/i)).toBeTruthy()
    expect(screen.getByText(/one person and an email address/i)).toBeTruthy()
  })

  it('links the privacy page', () => {
    show(<TermsPage />)
    expect(screen.getByRole('link', { name: 'Privacy' })).toBeTruthy()
  })
})
