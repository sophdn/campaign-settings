import { FLAG_SPECS, type FeatureFlags } from './registry'

/**
 * Parse a boolean feature-flag value. Only the exact (trimmed, case-insensitive)
 * string `true` or `false` is honoured; anything else — undefined, empty, or a
 * typo — falls back to the flag's declared default, so a misconfigured value can
 * never silently flip an access gate open.
 */
export function parseFlag(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback
  switch (raw.trim().toLowerCase()) {
    case 'true':
      return true
    case 'false':
      return false
    default:
      return fallback
  }
}

/**
 * Evaluate every declared flag against the environment (defaults to
 * `process.env`). Pure given its `env` argument, so it is fully unit-testable
 * without touching the real process environment — the same shape as
 * {@link loadAuthConfig}.
 */
/**
 * Every flag set to one value. `openFlags()` is the "everything on" evaluation
 * a fully-open deployment wants, and the shape suites use when their subject is
 * a FLOW rather than the gate — a test of the invitation flow should not have to
 * restate the access policy, and restating it in fourteen setups is how they
 * drift from the real defaults.
 */
export function allFlags(value: boolean): FeatureFlags {
  const flags = {} as { [K in keyof FeatureFlags]: boolean }
  for (const key of Object.keys(FLAG_SPECS) as (keyof FeatureFlags)[]) flags[key] = value
  return flags
}

/** Shorthand for a deployment with every gated surface open. */
export const openFlags = (): FeatureFlags => allFlags(true)

export function loadFlags(env: NodeJS.ProcessEnv = process.env): FeatureFlags {
  const flags = {} as { [K in keyof FeatureFlags]: boolean }
  for (const key of Object.keys(FLAG_SPECS) as (keyof FeatureFlags)[]) {
    const spec = FLAG_SPECS[key]
    flags[key] = parseFlag(env[spec.envVar], spec.default)
  }
  return flags
}
