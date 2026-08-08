/**
 * A segmented control: a labelled group of buttons where exactly one is active
 * (marked with `aria-pressed`). THE single source for the app's toggle pattern —
 * the wiki List/Graph switch, the suggestions status filter, etc. — so the
 * markup, a11y, and active-state styling live (and are tested) in one place.
 */
export function SegmentedToggle<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string
  options: ReadonlyArray<{ value: T; label: string }>
  value: T
  onChange: (value: T) => void
}): React.JSX.Element {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
