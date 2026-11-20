import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  // API_TARGET overrides the dev proxy target (e.g. when :8080 is taken locally).
  const apiTarget = loadEnv(mode, '.', '').API_TARGET || 'http://localhost:8080';
  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy: { '/api': { target: apiTarget, changeOrigin: false } },
    },
    build: {
      outDir: 'dist',
      // keep fonts/icons as real files so the CSP never needs data: font sources
      assetsInlineLimit: 0,
    },
  };
});
