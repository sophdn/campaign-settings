import { fireEvent, screen } from '@testing-library/react'

/**
 * Unfold a secondary panel that renders as a closed accordion.
 *
 * A closed `<details>` hides its contents from the accessibility tree, so a
 * role query cannot reach a control inside one. That is the behaviour, not an
 * obstacle: a test that switched to a non-accessibility query to reach past the
 * fold would stop proving the panel was closed at all.
 *
 * (Test-only — excluded from coverage.)
 */
export function openAccordion(name: string): void {
  const region = screen.getByRole('region', { name })
  const summary = region.querySelector('summary')
  if (!summary) throw new Error(`panel "${name}" has no accordion to open`)
  fireEvent.click(summary)
}
