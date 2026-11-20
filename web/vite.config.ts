import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': { target: 'http://localhost:8080', changeOrigin: false } },
  },
  build: {
    outDir: 'dist',
    // keep fonts/icons as real files so the CSP never needs data: font sources
    assetsInlineLimit: 0,
  },
});
