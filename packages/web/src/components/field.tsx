import { type InputHTMLAttributes, type ReactNode, useId } from 'react'

/**
 * The hint's markup, shared by both controls below and matching
 * {@link TextAreaField}'s — one `.field-hint` rule styles all three.
 */
function Hint({ id, text }: { id: string; text: string }): React.JSX.Element {
  return (
    <span className="field-hint" id={id}>
      {text}
    </span>
  )
}

/**
 * A labelled text input — the single-line sibling of {@link TextAreaField}. The
 * visible label doubles as the accessible name unless `ariaLabel` overrides it.
 * Controlled via `value`/`onChange(string)`; other native input props (`type`,
 * `placeholder`, `autoComplete`, `disabled`, …) spread through.
 *
 * With a `hint`, the label is associated EXPLICITLY (htmlFor/id) instead of by
 * wrapping. A label's accessible name is the text of its contents, so a wrapped
 * hint would be read out as part of the field's own name — "Kind, free-form,
 * soft taxonomy: mineral, agricultural, …" — and `getByLabelText('Kind')` would
 * stop matching it. Described-by is the correct relationship for guidance.
 */
export function TextField({
  label,
  value,
  onChange,
  ariaLabel,
  hint,
  ...rest
}: {
  label: string
  value: string
  onChange: (value: string) => void
  ariaLabel?: string
  /** Persistent guidance rendered under the field and tied to it for a11y. */
  hint?: string
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>): React.JSX.Element {
  const reactId = useId()
  const fieldId = `${reactId}-field`
  const hintId = `${reactId}-hint`

  const input = (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      {...(ariaLabel === undefined ? {} : { 'aria-label': ariaLabel })}
      {...(hint === undefined ? {} : { id: fieldId, 'aria-describedby': hintId })}
      {...rest}
    />
  )

  if (hint === undefined) {
    return (
      <label>
        {label}
        {input}
      </label>
    )
  }
  return (
    <div className="hinted-field">
      <label htmlFor={fieldId}>{label}</label>
      {input}
      <Hint id={hintId} text={hint} />
    </div>
  )
}

/** One `<optgroup>`: a heading and the options under it. */
export interface SelectGroup<T extends string> {
  label: string
  options: ReadonlyArray<{ value: T; label: ReactNode }>
}

/**
 * A labelled `<select>` over `{ value, label }` options. Same label/accessible-name
 * and `hint` contract as {@link TextField}.
 *
 * Pass `groups` instead of `options` to render `<optgroup>` headings. It is a real
 * `<optgroup>` rather than a disabled option used as a separator, because the
 * former is what assistive technology announces as a group — the latter looks like
 * a heading and reads as an unselectable choice.
 *
 * `hideLabel` drops the VISIBLE label and nothing else. Use it where the panel's
 * own heading already says what the control is — a panel headed "Type" holding a
 * select labelled "Type" says it twice. HIDING A LABEL IS NOT DELETING IT: the
 * accessible name is kept, as an `aria-label`, so the control is still named for
 * a screen reader and still found by `getByLabelText`. Never reach for this to
 * tidy a control whose purpose is not stated anywhere else on the page.
 */
export function SelectField<T extends string>({
  label,
  value,
  onChange,
  ariaLabel,
  hideLabel = false,
  hint,
  options,
  groups,
}: {
  label: string
  value: T
  onChange: (value: T) => void
  ariaLabel?: string
  /** Drop the visible label; the accessible name is kept. See the docstring. */
  hideLabel?: boolean
  hint?: string
  options?: ReadonlyArray<{ value: T; label: ReactNode }>
  groups?: ReadonlyArray<SelectGroup<T>>
}): React.JSX.Element {
  const reactId = useId()
  const fieldId = `${reactId}-field`
  const hintId = `${reactId}-hint`
  // With no visible label there is nothing else naming the control, so the
  // accessible name falls back to the label text rather than going missing.
  const accessibleName = ariaLabel ?? label

  const select = (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
      {...(hideLabel
        ? { 'aria-label': accessibleName }
        : ariaLabel === undefined
          ? {}
          : { 'aria-label': ariaLabel })}
      {...(hint === undefined ? {} : { id: fieldId, 'aria-describedby': hintId })}
    >
      {options?.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
      {groups?.map((g) => (
        <optgroup key={g.label} label={g.label}>
          {g.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  )

  if (hideLabel) {
    return (
      <div className="hinted-field">
        {select}
        {hint === undefined ? null : <Hint id={hintId} text={hint} />}
      </div>
    )
  }
  if (hint === undefined) {
    return (
      <label>
        {label}
        {select}
      </label>
    )
  }
  return (
    <div className="hinted-field">
      <label htmlFor={fieldId}>{label}</label>
      {select}
      <Hint id={hintId} text={hint} />
    </div>
  )
}

/**
 * A labelled checkbox. The boolean sibling of {@link TextField} — `<input
 * type="checkbox">` needs its own control because the shared one is
 * value/onChange over a string, and a checkbox's state is `checked`.
 */
export function CheckboxField({
  label,
  checked,
  onChange,
  ariaLabel,
  hint,
}: {
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
  ariaLabel?: string
  hint?: string
}): React.JSX.Element {
  const reactId = useId()
  const hintId = `${reactId}-hint`
  return (
    <div className="checkbox-field">
      <label>
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          {...(ariaLabel === undefined ? {} : { 'aria-label': ariaLabel })}
          {...(hint === undefined ? {} : { 'aria-describedby': hintId })}
        />
        {label}
      </label>
      {hint === undefined ? null : <Hint id={hintId} text={hint} />}
    </div>
  )
}
