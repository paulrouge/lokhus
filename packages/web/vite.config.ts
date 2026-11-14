import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  envDir: '../..',
  define: { global: 'globalThis' },
  server: {
    host: 'localhost',
    port: 5173,
    proxy: { '/api': { target: 'http://127.0.0.1:8787', changeOrigin: true } },
  },
  esbuild: { legalComments: 'eof' },
  build: { chunkSizeWarningLimit: 4000, sourcemap: true },
})
