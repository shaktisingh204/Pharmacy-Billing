import { defineConfig } from 'vite'
import { fileURLToPath, URL } from 'node:url'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@contract': fileURLToPath(new URL('../contract/types.ts', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      // The Rust binary serves the API; in dev it runs alongside on :8080.
      '/api': { target: 'http://127.0.0.1:8080', changeOrigin: true },
    },
  },
  build: {
    rollupOptions: {
      output: {
        // Rolldown (Vite 8) accepts only the function form; the object form the
        // scaffold shipped was silently invalid.
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return undefined
          if (/node_modules\/(react|react-dom|react-router|react-router-dom)\//.test(id)) return 'vendor'
          // Dexie stays: Phase 1 mock store, Phase 7 offline mirror + outbox.
          if (/node_modules\/dexie/.test(id)) return 'db'
          return undefined
        },
      },
    },
  },

})
