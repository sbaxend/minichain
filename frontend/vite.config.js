import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// During `npm run explorer:dev`, API calls are forwarded to the explorer
// demo's API (started separately with `npm run demo:explorer`).
const API_TARGET = process.env.MINICHAIN_API ?? 'http://127.0.0.1:5180';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1', // local-only
    port: 5173,
    strictPort: true,
    proxy: { '/api': { target: API_TARGET, changeOrigin: true } },
  },
  preview: { host: '127.0.0.1' },
  build: { outDir: 'dist', emptyOutDir: true },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.js'],
    include: ['src/**/*.test.{js,jsx}'],
  },
});
