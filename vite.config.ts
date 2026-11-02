import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { routeAvailabilityValidatorPlugin } from './frontend/build/route-availability.ts';
import { remoteAuthValidatorPlugin } from './frontend/build/remote-auth.ts';

export default defineConfig(({ mode, command }) => {
  const localApiUrl = loadEnv(mode, '.', 'ENVOI_LOCAL_API_URL').ENVOI_LOCAL_API_URL || 'http://127.0.0.1:8787';
  return {
    root: 'frontend',
    base: command === 'build' ? '/web/' : './',
    plugins: [routeAvailabilityValidatorPlugin(), remoteAuthValidatorPlugin(), react()],
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
