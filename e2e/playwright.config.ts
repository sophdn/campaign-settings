import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, devices } from '@playwright/test'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..')
const webDist = path.join(repoRoot, 'packages', 'web', 'dist')

// Derive an ISOLATED e2e database from the ambient DATABASE_URL (dev locally,
// the postgres service in CI) by swapping only the db name — the e2e run never
// touches dev or prod data. prepare-db.mts drops + recreates exactly this db.
const ambient =
  process.env.DATABASE_URL ?? 'postgres://campaign:campaign@localhost:5433/campaign_dev'
const e2eDatabaseUrl = (() => {
  const u = new URL(ambient)
  u.pathname = '/campaign_e2e'
  return u.toString()
})()

const PORT = 8788
const baseURL = `http://127.0.0.1:${PORT}`

export default defineConfig({
  testDir: './specs',
  // Keep all generated artifacts contained under e2e/ (gitignored + prettierignored).
  outputDir: path.join(here, 'test-results'),
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never', outputFolder: path.join(here, 'playwright-report') }]]
    : 'list',
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // Sequential so the server only boots AFTER the db is reset+seeded and the
    // SPA is built: reset db -> build web -> boot single-origin server.
    command: [
      'node --import tsx e2e/prepare-db.mts',
      'pnpm --filter @campaign-settings/web build',
      'node --import tsx packages/server/src/main.ts',
    ].join(' && '),
    cwd: repoRoot,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      DATABASE_URL: e2eDatabaseUrl,
      WEB_DIST_DIR: webDist,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      SESSION_SECRET: 'e2e-only-session-secret-at-least-32-characters-long',
      // Every gated surface ON. The specs drive the real flows end to end; the
      // gate's OWN behaviour (both flag states, server-side refusal) is covered
      // by http-access-gates.test.ts, which sets the flags it means. Leaving
      // these at their fail-closed defaults would turn the whole e2e suite into
      // an accidental test of the contact modal.
      LOGIN_ENABLED: 'true',
      PUBLIC_SIGNUP_ENABLED: 'true',
      PASSWORD_RESET_ENABLED: 'true',
      SUGGESTIONS_ENABLED: 'true',
      ACCOUNT_MANAGEMENT_ENABLED: 'true',
      DEMO_MODE: 'true',
      DEMO_USERNAME: 'e2e-demo',
      // The rate ceilings, raised out of the way. Every spec signs in through
      // the real form from one address, so the whole suite is a single caller
      // and the production ceiling (10 sign-ins per 10 minutes) stops it dead
      // — 68 specs failed on exactly that before this was here. The ceilings'
      // OWN behaviour is covered by http-rate-limits.test.ts, which sets the
      // numbers it means; leaving them at production values here would turn
      // the suite into an accidental test of the 429, the same reasoning as
      // the access-gate flags above.
      AUTH_RATE_LIMIT_MAX: '10000',
      MAIL_RATE_LIMIT_MAX: '10000',
      TOKEN_RATE_LIMIT_MAX: '10000',
      LOOKUP_RATE_LIMIT_MAX: '10000',
      NODE_ENV: 'test',
    },
  },
})
