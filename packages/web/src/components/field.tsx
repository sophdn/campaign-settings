import type { InputHTMLAttributes, ReactNode } from 'react'

/**
 * A labelled text input — the single-line sibling of {@link TextAreaField}. The
 * visible label doubles as the accessible name unless `ariaLabel` overrides it.
 * Controlled via `value`/`onChange(string)`; other native input props (`type`,
 * `placeholder`, `autoComplete`, `disabled`, …) spread through.
 */
export function TextField({
  label,
  value,
  onChange,
  ariaLabel,
  ...rest
}: {
  label: string
  value: string
  onChange: (value: string) => void
  ariaLabel?: string
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>): React.JSX.Element {
  return (
    <label>
      {label}
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        {...(ariaLabel === undefined ? {} : { 'aria-label': ariaLabel })}
        {...rest}
      />
    </label>
  )
}

/**
 * A labelled `<select>` over `{ value, label }` options. Same label/accessible-name
 * contract as {@link TextField}.
 */
export function SelectField<T extends string>({
  label,
  value,
  onChange,
  ariaLabel,
  options,
}: {
  label: string
  value: T
  onChange: (value: T) => void
  ariaLabel?: string
  options: ReadonlyArray<{ value: T; label: ReactNode }>
}): React.JSX.Element {
  return (
    <label>
      {label}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        {...(ariaLabel === undefined ? {} : { 'aria-label': ariaLabel })}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  )
}
