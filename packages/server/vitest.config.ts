import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'server',
    environment: 'node',
    // DB-backed suites each CREATE/DROP an isolated database against one shared
    // Postgres. Running files in parallel lets concurrent CREATE DATABASE calls
    // collide on the template ("being accessed by other users") — load-dependent,
    // so it passes locally but trips in CI. Serialize files to make it
    // deterministic; tests within a file already run sequentially.
    fileParallelism: false,
  },
})
