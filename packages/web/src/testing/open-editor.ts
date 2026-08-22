import { fireEvent, screen } from '@testing-library/react'

/**
 * Open an entity page's editor, which starts collapsed behind a pencil.
 *
 * Every test that edits an entity calls this first. The collapsed state IS the
 * behaviour under test elsewhere, so reaching past the toggle — querying the
 * hidden form by label rather than pressing the button a person would press —
 * would quietly weaken the very assertion the page was changed to make.
 *
 * (Test-only — excluded from coverage.)
 */
export async function openEditor(label: 'entity' | 'session' = 'entity'): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: `Edit ${label}` }))
}
