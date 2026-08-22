import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// Make the suite self-sufficient for DATABASE_URL (and friends): load the
// repo-root .env into process.env so `pnpm check-all` — and the pre-commit hook
// that runs it — pass in a fresh shell / CI / agent without the caller having
// pre-exported it. Worker forks inherit this. Already-set vars win
// (loadEnvFile does not override), so an intentional shell override still holds.
// Resolved relative to this file so it works regardless of cwd.
const envPath = fileURLToPath(new URL('.env', import.meta.url))
if (existsSync(envPath)) process.loadEnvFile(envPath)

// Root config: discovers per-package projects and owns the repo-wide coverage gate.
// Coverage threshold is 95% on ALL FOUR metrics (branches included) — the demanding gate.
export default defineConfig({
  test: {
    projects: ['packages/*'],
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      all: true,
      include: ['packages/*/src/**/*.{ts,tsx}'],
      exclude: [
        '**/*.test.{ts,tsx}',
        '**/*.config.ts',
        '**/main.ts',
        '**/main.tsx',
        '**/testing/**',
      ],
      thresholds: {
        statements: 95,
        branches: 95,
        functions: 95,
        lines: 95,
      },
    },
  },
})
