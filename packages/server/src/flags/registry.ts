/**
 * The feature-flag registry: the ONE place flags are declared. Add a flag by
 * adding a field to {@link FeatureFlags} and a matching spec below — nothing
 * else changes. {@link loadFlags} walks this map, and the `/api/config` route
 * exposes the evaluated result to the SPA. Flags are booleans read from the
 * environment; access-gating flags default to `false` so a missing or
 * malformed value fails closed.
 */

/**
 * The declared feature flags, as evaluated booleans.
 *
 * Every access-gating flag is FAIL-CLOSED: off unless the environment says
 * exactly `true`. The portfolio deployment ships with all of them off and the
 * blocked surfaces route to the contact modal instead; flipping one on restores
 * the real flow with no code change. A flag being off is enforced SERVER-SIDE
 * — the SPA hiding a form is a courtesy, never the gate.
 */
export interface FeatureFlags {
  /**
   * Public self-serve registration is open. Invitation holders can still
   * register while this is off — the token is its own authorisation.
   */
  publicSignupEnabled: boolean
  /**
   * The real login flow. Off for the portfolio, which auto-logs visitors into a
   * shared read-only demo account and has no use for a login form; flipping it
   * on restores real sign-in for invited users.
   */
  loginEnabled: boolean
  /** The forgot-password flow. Pointless while login is off, and gated separately. */
  passwordResetEnabled: boolean
  /** Player-to-GM suggestions. The one write a player has, so it is gated too. */
  suggestionsEnabled: boolean
  /**
   * Self-service account management: password, username, session list,
   * revoke-all, verification resend, and account deletion.
   *
   * This exists because of a concrete hazard, not for symmetry. The demo
   * auto-login puts EVERY visitor on one SHARED account, so an open /account
   * page lets any visitor change the shared password and lock out everyone
   * else — including the seeded e2e flows. Off by default closes that.
   */
  accountManagementEnabled: boolean
  /**
   * Demo mode: the portfolio's shared, read-only auto-login principal.
   *
   * Off on the private instance, so none of the demo behaviour is ever live
   * there. This is the runtime seam task 3564 specifies — demo versus real is a
   * switch, not a fork, because a fork is what causes mirror drift.
   */
  demoModeEnabled: boolean
}

/** How one flag is read: its environment variable and its fail-closed default. */
export interface FlagSpec {
  envVar: string
  default: boolean
}

/** One spec per flag; the keys are exactly the keys of {@link FeatureFlags}. */
export const FLAG_SPECS: { readonly [K in keyof FeatureFlags]: FlagSpec } = {
  publicSignupEnabled: { envVar: 'PUBLIC_SIGNUP_ENABLED', default: false },
  loginEnabled: { envVar: 'LOGIN_ENABLED', default: false },
  passwordResetEnabled: { envVar: 'PASSWORD_RESET_ENABLED', default: false },
  suggestionsEnabled: { envVar: 'SUGGESTIONS_ENABLED', default: false },
  accountManagementEnabled: { envVar: 'ACCOUNT_MANAGEMENT_ENABLED', default: false },
  demoModeEnabled: { envVar: 'DEMO_MODE', default: false },
}
