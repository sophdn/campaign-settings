import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// DOM component tests run under jsdom; globals enable @testing-library/react's
// automatic cleanup between tests.
export default defineConfig({
  plugins: [react()],
  test: {
    name: 'web',
    environment: 'jsdom',
    globals: true,
  },
})
