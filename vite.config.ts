import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

export default defineConfig({
  root: 'frontend',
  base: './',
  plugins: [react(), viteSingleFile()],
  build: {
    outDir: '../web',
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2022'
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8787',
      '/health': 'http://127.0.0.1:8787'
    }
  }
});
