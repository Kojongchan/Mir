import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // web-ifc ships large WASM/JS; keep it out of dependency pre-bundling
  optimizeDeps: {
    exclude: ['web-ifc'],
  },
  build: {
    // Q1 — 무거운 벤더를 개별 청크로 분리(초기 번들 축소 + 캐시 효율).
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('recharts') || id.includes('/d3-') || id.includes('victory-vendor')) return 'charts';
          if (id.includes('pdfjs-dist')) return 'pdf';
          if (id.includes('web-ifc')) return 'webifc';
          if (id.includes('/three/') || id.includes('three-mesh-bvh')) return 'three';
          if (id.includes('mammoth') || id.includes('xlsx')) return 'docs';
          if (id.includes('qrcode') || id.includes('/encode-utf8/') || id.includes('/dijkstrajs/')) return 'qrcode';
          if (id.includes('@supabase')) return 'supabase';
          if (id.includes('react-router') || id.includes('react-dom') || id.includes('/react/')) return 'react';
          return undefined;
        },
      },
    },
  },
  server: {
    port: 5173,
    host: true,
  },
});
