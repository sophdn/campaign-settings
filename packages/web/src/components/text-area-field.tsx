import { useId } from 'react'
import type { WikiEntry } from '../api'
import { BracketPicker } from './bracket-picker'

/** Default visible height for a prose field, in rows. */
export const DEFAULT_ROWS = 6

/**
 * A labeled, full-width textarea. The visible label doubles as the textarea's
 * accessible name unless `ariaLabel` overrides it (e.g. a terse a11y name beside
 * a longer visible prompt). Shared by the Suggestions and Notes forms.
 *
 * Passing `candidates` upgrades it to a `[[name]]` picker over those entities.
 * The upgrade lives here, on the ONE control all three prose surfaces already
 * use, so the entity editor, notes and suggestions cannot end up with three
 * copies that drift.
 *
 * The picker variant associates its label EXPLICITLY (htmlFor/id) rather than by
 * wrapping. A wrapping <label> would enclose the suggestion listbox, and a
 * label's accessible text is the text of its contents — so every open
 * suggestion would be read out as part of the field's own name.
 */
export function TextAreaField({
  label,
  value,
  onChange,
  ariaLabel,
  rows,
  placeholder,
  hint,
  candidates,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  ariaLabel?: string
  rows?: number
  placeholder?: string
  /** Persistent guidance rendered under the field and tied to it for a11y. */
  hint?: string
  /** When present, `[[` opens a picker over these entities. */
  candidates?: ReadonlyArray<WikiEntry>
}): React.JSX.Element {
  const reactId = useId()
  const fieldId = `${reactId}-field`
  const hintId = hint ? `${reactId}-hint` : undefined
  // Prose fields are for paragraphs, and the HTML default of 2 rows is a slot
  // for a sentence. Six is roughly a short paragraph before scrolling starts;
  // callers wanting more (the suggestion form asks for 8) still say so.
  const rowCount = rows ?? DEFAULT_ROWS
  const hintNode = hint ? (
    <span className="field-hint" id={hintId}>
      {hint}
    </span>
  ) : null

  if (candidates) {
    return (
      <div className="bracket-field">
        <label htmlFor={fieldId}>{label}</label>
        <BracketPicker
          id={fieldId}
          value={value}
          onChange={onChange}
          candidates={candidates}
          {...(ariaLabel ? { ariaLabel } : {})}
          rows={rowCount}
          {...(placeholder ? { placeholder } : {})}
          {...(hintId ? { describedBy: hintId } : {})}
        />
        {hintNode}
      </div>
    )
  }

  return (
    <label>
      {label}
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        {...(ariaLabel ? { 'aria-label': ariaLabel } : {})}
        rows={rowCount}
        {...(placeholder ? { placeholder } : {})}
        {...(hintId ? { 'aria-describedby': hintId } : {})}
      />
      {hintNode}
    </label>
  )
}
