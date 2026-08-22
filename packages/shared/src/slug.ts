/**
 * URL slugs for worlds. Pure + sans-IO so both the server (world creation, the
 * backfill migration) and tests can share one implementation. Uniqueness is the
 * caller's job — `slugify` produces a candidate, `nextAvailableSlug` deduplicates
 * a candidate against an already-taken set.
 */

/**
 * A lowercase, ascii, dash-separated slug derived from a human name. Accents are
 * folded to their base letters; every run of non-alphanumerics collapses to a
 * single dash; leading/trailing dashes are trimmed. A name with no usable
 * characters (e.g. only punctuation or emoji) falls back to `"world"` so the
 * result is never empty.
 */
// Combining diacritical marks left behind after NFKD decomposition.
const COMBINING_MARKS = new RegExp('[\\u0300-\\u036f]', 'g')

export function slugify(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'world'
}

/**
 * The first of `base`, `base-2`, `base-3`, … that is not already in `taken`.
 * Used to keep world slugs unique under the DB's unique constraint when two
 * worlds share a name.
 */
export function nextAvailableSlug(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`
    if (!taken.has(candidate)) return candidate
  }
}
