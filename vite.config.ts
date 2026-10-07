import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { inlineWebBuild } from './scripts/vite-inline-web.ts';

export default defineConfig(({ mode }) => {
  const localApiUrl = loadEnv(mode, '.', 'SINALOA_LOCAL_API_URL').SINALOA_LOCAL_API_URL || 'http://127.0.0.1:8787';
  return {
    root: 'frontend',
    base: './',
    plugins: [react(), inlineWebBuild()],
    build: {
      outDir: '../web',
      emptyOutDir: true,
      sourcemap: false,
      target: 'es2022'
    },
    server: {
      port: 5173,
      proxy: {
        '/api': localApiUrl,
        '/health': localApiUrl
      }
    }
  };
});
