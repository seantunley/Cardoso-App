import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
const _require = createRequire(import.meta.url)
const pkg = _require('./package.json')

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  logLevel: 'error',
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          "vendor-react": ["react", "react-dom", "react-router-dom"],
          "vendor-query": ["@tanstack/react-query"],
          "vendor-ui": ["lucide-react"],
          "vendor-charts": ["recharts"],
        },
      },
    },
  },
  server: {
    host: true, // bind to 0.0.0.0 so LAN devices can connect
    port: 6009,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://localhost:3101',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, '/api'), // Ensures /api stays
      },
    },
  },
})