import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react(),
  ],
  base: '/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    minify: 'esbuild',
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('/react/') || id.includes('/react-dom/') || id.includes('/scheduler/')) return 'vendor-react'
            if (id.includes('/react-router')) return 'vendor-react'
            if (id.includes('/recharts/')) return 'vendor-charts'
            if (id.includes('/framer-motion/') || id.includes('/lucide-react/')) return 'vendor-ui'
            if (id.includes('/socket.io')) return 'vendor-socket'
            return 'vendor-other'
          }
        }
      }
    },
    assetsInlineLimit: 4096, // inline small assets as base64; keep larger ones as files
  },
  server: {
    port: 5173,
    open: false,
    hmr: { overlay: true },
    watch: {
      ignored: ['**/.venv/**', '**/data/**']
    },
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: true,
        secure: false,
        configure: (proxy, _options) => {
          proxy.on('error', (err, _req, _res) => {
            if (err.code === 'ECONNRESET' || err.code === 'ECONNREFUSED') {
              // Silently ignore during restarts
              return;
            }
            console.error('proxy error', err);
          });
        },
      },
      '/socket.io': {
        target: 'http://127.0.0.1:3000',
        ws: true,
        changeOrigin: true,
        configure: (proxy, _options) => {
          proxy.on('error', (err, _req, _res) => {
            if (err.code === 'ECONNRESET' || err.code === 'ECONNREFUSED') return;
            console.error('ws proxy error', err);
          });
        }
      }
    }
  },
  // Optimize dev server pre-bundling
  optimizeDeps: {
    include: ['react', 'react-dom', 'recharts', 'framer-motion', 'fuse.js', 'react-window']
  }
});

