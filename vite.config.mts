import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  // Electron loads the built renderer over file://, so asset URLs must stay relative.
  base: './',
  plugins: [react(), tailwindcss()],
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
