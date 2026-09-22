import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  // Electron loads the built renderer over file://, so asset URLs must stay relative.
  base: './',
  plugins: [react(), tailwindcss()],
  // The same `@/…` alias tsconfig declares, so shadcn's generated imports - which
  // always use it - resolve through Vite too. The renderer's own modules keep their
  // relative imports; this exists for anything added by the component registry.
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  build: {
    outDir: 'dist/renderer',
    emptyOutDir: true,
    target: 'chrome128'
  },
  server: {
    port: 5173,
    strictPort: true
  }
})
