import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

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
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            return 'vendor';
          }
        }
      }
    }
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
        target: 'http://127.0.0.1:3001',
        changeOrigin: true,
        secure: false,
        configure: (proxy, _options) => {
          proxy.on('error', (err, _req, _res) => {
            if (err.code === 'ECONNRESET' || err.code === 'ECONNREFUSED') {
              return;
            }
            console.error('proxy error', err);
          });
        },
      },
      '/socket.io': {
        target: 'http://127.0.0.1:3001',
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
  optimizeDeps: {
    include: ['react', 'react-dom', 'recharts', 'framer-motion', 'fuse.js', 'react-window']
  }
});
