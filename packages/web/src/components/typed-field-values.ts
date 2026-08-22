import type { FieldDef } from '@campaign-settings/shared'

/**
 * The conversion between a typed entity column and the string a form control
 * holds — kept sans-React so the rules that decide what gets SENT to the server
 * are unit-testable without rendering anything.
 *
 * Form state is uniformly `Record<string, string>` (a checkbox is `'true'` /
 * `'false'`) because that is what the existing name/description editor already
 * uses, and one shape means one `set()` and one save path rather than a
 * discriminated union threaded through every control.
 */

/** A field whose current input cannot be turned into a value worth sending. */
const SKIP = Symbol('skip')

/** Read a field off a loaded entity as the string its control will hold. */
export function fieldToInput(field: FieldDef, entity: Record<string, unknown>): string {
  const raw = entity[field.key]
  if (raw === null || raw === undefined) return ''
  if (field.type === 'boolean') return raw ? 'true' : 'false'
  return String(raw)
}

/** Every field of a kind, read off an entity into initial form state. */
export function initialFieldValues(
  fields: readonly FieldDef[],
  entity: Record<string, unknown>,
): Record<string, string> {
  return Object.fromEntries(fields.map((f) => [f.key, fieldToInput(f, entity)]))
}

/**
 * The value to send for one field, or SKIP to leave it out of the patch.
 *
 * Clearing an input means `null` on a nullable column and the empty value on a
 * NOT NULL one — the distinction `FieldDef.nullable` exists for. A number that
 * will not parse is SKIPPED rather than coerced: sending 0 for what someone
 * typed would overwrite a good stored figure with a wrong one, and a patch that
 * omits the key leaves the column alone.
 */
function patchValue(field: FieldDef, input: string): unknown | typeof SKIP {
  switch (field.type) {
    case 'boolean':
      return input === 'true'

    case 'number': {
      const trimmed = input.trim()
      if (trimmed === '') return field.nullable ? null : 0
      const n = Number(trimmed)
      return Number.isFinite(n) ? n : SKIP
    }

    case 'entityRef': {
      // Always nullable in practice, but honour the flag rather than assume:
      // an empty picker on a NOT NULL ref would be a constraint violation, and
      // skipping is the only non-destructive answer.
      const trimmed = input.trim()
      if (trimmed !== '') return trimmed
      return field.nullable ? null : SKIP
    }

    default: {
      // text | textarea | enum — all string columns.
      if (input === '') return field.nullable ? null : ''
      return input
    }
  }
}

/** The typed patch for a kind's fields, ready for `api.updateEntity`. */
export function toEntityPatch(
  fields: readonly FieldDef[],
  values: Record<string, string>,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {}
  for (const field of fields) {
    const value = patchValue(field, values[field.key] ?? '')
    if (value !== SKIP) patch[field.key] = value
  }
  return patch
}

/** Whether a stored value is worth showing on the read view at all. */
export function hasValue(field: FieldDef, entity: Record<string, unknown>): boolean {
  const raw = entity[field.key]
  if (raw === null || raw === undefined || raw === '') return false
  // A settlement with population 0 has not had one set — the hint on that field
  // says as much, and the demographics panel estimates it instead.
  if (field.type === 'number' && raw === 0) return false
  return true
}

/** The label to display for an `enum` value, falling back to the raw string. */
export function optionLabel(field: FieldDef, value: string): string {
  return field.options?.find((o) => o.value === value)?.label ?? value
}
