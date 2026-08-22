import type { FeatureFlags } from '../api'

/**
 * Every flag set to one value, for tests. Mirrors the server's `allFlags` so a
 * suite can say "everything open" or "everything closed" without restating the
 * access policy — restating it in twenty tests is how they drift from the real
 * fail-closed defaults. (Test-only — excluded from coverage.)
 */
export function webFlags(value: boolean, over: Partial<FeatureFlags> = {}): FeatureFlags {
  return {
    publicSignupEnabled: value,
    loginEnabled: value,
    passwordResetEnabled: value,
    suggestionsEnabled: value,
    accountManagementEnabled: value,
    demoModeEnabled: value,
    ...over,
  }
}
