import { activeBracketQuery, completeBracket, fuzzySearch } from '@campaign-settings/shared'
import { useCallback, useId, useMemo, useRef, useState } from 'react'
import type { WikiEntry } from '../api'
import { kindColor, kindLabel } from '../pages/kind-color'

/**
 * How many suggestions are offered at once. A cap rather than a scroll of the
 * whole world: past a handful the list stops being a glance and becomes its own
 * search problem. Stated here rather than buried, because a silent truncation
 * reads as "that's everything" when it is not — the count is surfaced in the UI
 * when there are more matches than rows.
 */
export const MAX_SUGGESTIONS = 8

/**
 * A textarea that completes `[[name]]` references against the world's entities.
 *
 * The problem this solves is that `[[name]]` matched on an entity name the
 * author had to remember exactly, with no in-app statement of the format and no
 * help until after a wrong name had already been typed and rendered red. This
 * makes the invalid state hard to reach instead of merely legible: every name it
 * inserts is one that resolves.
 *
 * It is an AUTHORING AID, NOT A VALIDATOR. Text whose brackets do not resolve
 * still saves — an author referencing something they have not created yet is
 * doing something legitimate, and the red preview still marks it.
 */
export function BracketPicker({
  value,
  onChange,
  candidates,
  ariaLabel,
  rows,
  placeholder,
  describedBy,
  id,
}: {
  value: string
  onChange: (value: string) => void
  candidates: ReadonlyArray<WikiEntry>
  ariaLabel?: string
  /** Required: TextAreaField always resolves a height, so there is no
   *  "unspecified" case to branch on here. */
  rows: number
  placeholder?: string
  describedBy?: string
  id?: string
}): React.JSX.Element {
  const ref = useRef<HTMLTextAreaElement | null>(null)
  const [caret, setCaret] = useState<number | null>(null)
  const [active, setActive] = useState(0)
  /**
   * Escape suppresses the list until the author does something that means they
   * want it again (types, or moves the caret by clicking). Clearing the caret
   * instead is not enough: the `keyup` that follows Escape's `keydown` re-reads
   * `selectionStart` and would reopen the list immediately.
   */
  const [dismissed, setDismissed] = useState(false)
  // Unique per instance: two pickers on one page must not share a listbox id.
  const listId = `${useId()}-suggestions`

  const marker = useMemo(
    () => (caret === null ? null : activeBracketQuery(value, caret)),
    [value, caret],
  )

  const matches = useMemo(() => {
    if (!marker) return []
    // A blank query lists entities rather than nothing: fuzzySearch already
    // returns every item for an empty query, and someone who has just typed
    // `[[` is precisely who needs to see what exists.
    return fuzzySearch(candidates, marker.query, { text: (e) => e.name }).map((r) => r.item)
  }, [marker, candidates])

  const shown = matches.slice(0, MAX_SUGGESTIONS)
  const open = marker !== null && shown.length > 0 && !dismissed
  const activeIndex = Math.min(active, Math.max(shown.length - 1, 0))

  const syncCaret = useCallback((el: HTMLTextAreaElement): void => {
    setCaret(el.selectionStart)
  }, [])

  const choose = useCallback(
    (entry: WikiEntry): void => {
      if (!marker) return
      const next = completeBracket(value, marker, entry.name)
      onChange(next.text)
      setActive(0)
      setDismissed(false)
      // Put the caret past the inserted `]]` once React has written the value,
      // so typing continues after the link instead of inside it.
      requestAnimationFrame(() => {
        const el = ref.current
        if (!el) return
        el.focus()
        el.setSelectionRange(next.caret, next.caret)
        setCaret(next.caret)
      })
    },
    [marker, value, onChange],
  )

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (!open) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((i) => (i + 1) % shown.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => (i - 1 + shown.length) % shown.length)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const pick = shown[activeIndex]
      if (pick) choose(pick)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      // Dismiss without touching the text — the author may be writing a name
      // that does not exist yet on purpose.
      setDismissed(true)
    }
    // Tab is deliberately not handled: focus leaves the field and the list
    // closes on blur, so the picker can never trap keyboard focus.
  }

  return (
    <div className="bracket-picker">
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => {
          onChange(e.target.value)
          syncCaret(e.currentTarget)
          setDismissed(false)
        }}
        onKeyUp={(e) => syncCaret(e.currentTarget)}
        onClick={(e) => {
          syncCaret(e.currentTarget)
          setDismissed(false)
        }}
        onSelect={(e) => syncCaret(e.currentTarget)}
        onBlur={() => setCaret(null)}
        onKeyDown={onKeyDown}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        {...(open && shown[activeIndex]
          ? { 'aria-activedescendant': `${listId}-${activeIndex}` }
          : {})}
        {...(ariaLabel ? { 'aria-label': ariaLabel } : {})}
        rows={rows}
        {...(placeholder ? { placeholder } : {})}
        {...(describedBy ? { 'aria-describedby': describedBy } : {})}
        {...(id ? { id } : {})}
      />
      {open ? (
        <ul
          className="bracket-suggestions"
          id={listId}
          role="listbox"
          aria-label="Entity suggestions"
        >
          {shown.map((entry, i) => (
            <li
              key={`${entry.kind}:${entry.id}`}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === activeIndex}
              className={i === activeIndex ? 'is-active' : undefined}
              // onMouseDown, not onClick: mousedown fires before the textarea's
              // blur, which would otherwise close the list before the click landed.
              onMouseDown={(e) => {
                e.preventDefault()
                choose(entry)
              }}
              onMouseEnter={() => setActive(i)}
            >
              <span className="bracket-suggestion-name">{entry.name}</span>
              <span className="bracket-suggestion-kind" style={{ color: kindColor(entry.kind) }}>
                {kindLabel(entry.kind)}
              </span>
            </li>
          ))}
          {matches.length > shown.length ? (
            <li className="bracket-suggestions-more" role="presentation">
              {matches.length - shown.length} more — keep typing to narrow
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  )
}
