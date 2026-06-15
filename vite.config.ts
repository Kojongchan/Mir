import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // web-ifc ships large WASM/JS; keep it out of dependency pre-bundling
  optimizeDeps: {
    exclude: ['web-ifc'],
  },
  server: {
    port: 5173,
    host: true,
  },
});
