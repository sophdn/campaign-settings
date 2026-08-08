import { buildNameIndex, parseBrackets, resolveBracket } from '@campaign-settings/shared'
import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import type { WikiEntry } from '../api'
import { buildWikiCandidates } from './entity-description'
import { DEFAULT_ROWS, TextAreaField } from './text-area-field'

const ENTRIES: WikiEntry[] = [
  { kind: 'npc', id: 'n1', name: 'Silas Crow' },
  { kind: 'npc', id: 'n2', name: 'Mira Vane' },
  { kind: 'location', id: 'l1', name: 'Saltmarsh Docks' },
  { kind: 'organization', id: 'o1', name: 'The Ashen Hand' },
]

/** Drives the picker the way a form does: controlled value, real state. */
function Harness({ entries = ENTRIES }: { entries?: WikiEntry[] }): React.JSX.Element {
  const [value, setValue] = useState('')
  return (
    <>
      <TextAreaField
        label="Description"
        value={value}
        onChange={setValue}
        candidates={buildWikiCandidates(entries)}
      />
      <output data-testid="value">{value}</output>
    </>
  )
}

/** Type `text` and leave the caret at its end, as a real author would. */
function typeInto(el: HTMLTextAreaElement, text: string): void {
  fireEvent.change(el, { target: { value: text, selectionStart: text.length } })
  fireEvent.keyUp(el, { key: 'a' })
}

const box = (): HTMLTextAreaElement => screen.getByLabelText('Description') as HTMLTextAreaElement
const options = (): HTMLElement[] => screen.queryAllByRole('option')

describe('BracketPicker', () => {
  it('stays closed until a bracket marker is opened', () => {
    render(<Harness />)
    typeInto(box(), 'just prose')
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(box().getAttribute('aria-expanded')).toBe('false')
  })

  it('opens on `[[` and lists entities before anything is typed', () => {
    render(<Harness />)
    typeInto(box(), 'Met [[')
    // The author who has just typed `[[` is the one who needs to see what exists.
    expect(screen.getByRole('listbox')).toBeTruthy()
    expect(options().map((o) => o.textContent)).toEqual([
      expect.stringContaining('Silas Crow'),
      expect.stringContaining('Mira Vane'),
      expect.stringContaining('The Ashen Hand'),
      expect.stringContaining('Saltmarsh Docks'),
    ])
  })

  it('filters fuzzily on what follows the brackets', () => {
    render(<Harness />)
    typeInto(box(), 'Met [[sil')
    expect(options()).toHaveLength(1)
    expect(options()[0]?.textContent ?? '').toContain('Silas Crow')
  })

  it('shows each entity KIND, so you know which one you are linking', () => {
    render(<Harness />)
    typeInto(box(), 'Met [[salt')
    expect(options()[0]?.textContent ?? '').toContain('Saltmarsh Docks')
    expect(options()[0]?.textContent ?? '').toMatch(/location/i)
  })

  it('inserts a marker that RESOLVES to the chosen entity', () => {
    render(<Harness />)
    typeInto(box(), 'Met [[sil')
    fireEvent.mouseDown(options()[0]!)

    const saved = screen.getByTestId('value').textContent ?? ''
    expect(saved).toBe('Met [[Silas Crow]]')
    // The guarantee that matters: round-trip it through the real resolver.
    const index = buildNameIndex([{ kind: 'npc', rows: [{ id: 'n1', name: 'Silas Crow' }] }])
    const marker = parseBrackets(saved)[0]!
    expect(resolveBracket(marker.name, index)).toEqual({ kind: 'npc', id: 'n1' })
  })

  it('is keyboard-operable: arrows move, Enter selects', () => {
    render(<Harness />)
    typeInto(box(), 'Met [[')
    fireEvent.keyDown(box(), { key: 'ArrowDown' })
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(screen.getByTestId('value').textContent).toBe('Met [[Mira Vane]]')
  })

  it('wraps around at the ends of the list', () => {
    render(<Harness />)
    typeInto(box(), 'Met [[')
    fireEvent.keyDown(box(), { key: 'ArrowUp' }) // wraps to the last option
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(screen.getByTestId('value').textContent).toBe('Met [[Saltmarsh Docks]]')
  })

  it('dismisses on Escape WITHOUT altering the text', () => {
    render(<Harness />)
    typeInto(box(), 'Met [[Mira')
    expect(screen.getByRole('listbox')).toBeTruthy()
    fireEvent.keyDown(box(), { key: 'Escape' })
    // The browser fires keyup next, which re-reads selectionStart. Without a
    // sticky dismissal that alone reopened the list — a real bug e2e caught.
    fireEvent.keyUp(box(), { key: 'Escape' })
    expect(screen.queryByRole('listbox')).toBeNull()
    // An author naming something that does not exist yet is doing so on purpose.
    expect(screen.getByTestId('value').textContent).toBe('Met [[Mira')
  })

  it('closes once the marker is closed', () => {
    render(<Harness />)
    typeInto(box(), 'Met [[Silas Crow]] and then')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('announces itself as a combobox over a listbox', () => {
    render(<Harness />)
    const el = box()
    expect(el.getAttribute('role')).toBe('combobox')
    expect(el.getAttribute('aria-autocomplete')).toBe('list')
    typeInto(el, 'Met [[')
    expect(el.getAttribute('aria-expanded')).toBe('true')
    // The active option is announced, which is what a screen reader reads out.
    const activeId = el.getAttribute('aria-activedescendant')
    expect(activeId).toBeTruthy()
    expect(document.getElementById(activeId!)?.textContent).toContain('Silas Crow')
    expect(el.getAttribute('aria-controls')).toBe(screen.getByRole('listbox').id)
  })

  it('offers ONE row per resolvable name when two entities collide', () => {
    // `[[name]]` addresses by name alone, so only the precedence winner (npc) is
    // reachable. Offering the shadowed location would insert text that resolves
    // elsewhere — a lie the author could not see.
    render(
      <Harness
        entries={[
          { kind: 'location', id: 'l9', name: 'Raven' },
          { kind: 'npc', id: 'n9', name: 'Raven' },
        ]}
      />,
    )
    typeInto(box(), 'Met [[rav')
    expect(options()).toHaveLength(1)
    expect(options()[0]?.textContent ?? '').toMatch(/npc/i)
  })

  it('caps the list and says how many it withheld', () => {
    const many: WikiEntry[] = Array.from({ length: 12 }, (_, i) => ({
      kind: 'npc',
      id: `n${i}`,
      name: `Guard ${i}`,
    }))
    render(<Harness entries={many} />)
    typeInto(box(), 'Met [[guard')
    expect(options()).toHaveLength(8)
    // Silent truncation would read as "that is everything".
    expect(screen.getByText(/4 more/)).toBeTruthy()
  })
})

describe('default size', () => {
  it('opens tall enough for a paragraph rather than the HTML default of two rows', () => {
    render(<TextAreaField label="Description" value="" onChange={() => {}} />)
    expect((screen.getByLabelText('Description') as HTMLTextAreaElement).rows).toBe(DEFAULT_ROWS)
  })

  it('applies the same default in the picker variant', () => {
    render(<Harness />)
    expect(box().rows).toBe(DEFAULT_ROWS)
  })

  it('still lets a caller ask for a different height', () => {
    render(<TextAreaField label="Tall" value="" onChange={() => {}} rows={8} />)
    expect((screen.getByLabelText('Tall') as HTMLTextAreaElement).rows).toBe(8)
  })
})

describe('discoverability hint', () => {
  it('tells the author the syntax exists, and ties the text to the field', () => {
    // Nothing in the app named the `[[ ]]` format before this: every mention was
    // a code comment. A picker does not fix that on its own — you still have to
    // know to type `[[` before anything helpful happens.
    render(
      <TextAreaField
        label="Note"
        value=""
        onChange={() => {}}
        candidates={buildWikiCandidates(ENTRIES)}
        hint="Type [[ to link another entry. Matches on its name; capitalisation does not matter."
      />,
    )
    const field = screen.getByLabelText('Note')
    const describedBy = field.getAttribute('aria-describedby')
    expect(describedBy).toBeTruthy()

    const hint = document.getElementById(describedBy!)
    expect(hint?.textContent ?? '').toContain('[[')
    // The two facts that decide whether a hand-typed link resolves.
    expect(hint?.textContent ?? '').toMatch(/name/i)
    expect(hint?.textContent ?? '').toMatch(/capitalisation/i)
  })

  it('is optional — a field without one has nothing dangling', () => {
    render(<TextAreaField label="Bare" value="" onChange={() => {}} />)
    expect(screen.getByLabelText('Bare').getAttribute('aria-describedby')).toBeNull()
  })
})

describe('TextAreaField without candidates', () => {
  it('stays a plain textarea with no combobox semantics', () => {
    render(<TextAreaField label="Plain" value="x" onChange={() => {}} />)
    const el = screen.getByLabelText('Plain')
    expect(el.getAttribute('role')).not.toBe('combobox')
    expect(screen.queryByRole('listbox')).toBeNull()
  })
})
