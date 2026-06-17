import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // web-ifc ships large WASM/JS; keep it out of dependency pre-bundling
  optimizeDeps: {
    exclude: ['web-ifc'],
  },
  build: {
    rollupOptions: {
      output: {
        // 무거운 3D/IFC 라이브러리를 각자의 청크로 분리.
        // 라우트 지연 로딩(App.tsx)과 함께 초기 번들에서 빠지고,
        // 개별 캐싱·병렬 다운로드가 가능해진다.
        manualChunks(id) {
          if (id.includes('node_modules/web-ifc')) return 'web-ifc';
          if (id.includes('node_modules/three')) return 'three';
          if (id.includes('node_modules/react') || id.includes('node_modules/scheduler'))
            return 'react-vendor';
        },
      },
    },
    // web-ifc 청크는 emscripten 글루(JS)로 본질적으로 크고 더 쪼갤 수 없다.
    // 이미 라우트 지연 로딩으로 초기 번들에서 빠졌으므로(초기 로딩 무관),
    // 이 분리된 벤더 청크가 경고를 내지 않도록 기준을 그 위로 올린다.
    chunkSizeWarningLimit: 3200,
  },
  server: {
    port: 5173,
    host: true,
  },
});
