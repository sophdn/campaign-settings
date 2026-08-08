import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Plain React + DOM web app (no react-native-web). The dev server proxies /api
// to the fastify server during local dev.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { '/api': 'http://localhost:8787' },
  },
})
