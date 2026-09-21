import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // AC-37「零网络请求」：本扩展无动态 import，
    // 关掉 Vite 注入的 modulepreload polyfill（它内部含 fetch 调用），
    // 让产物里不存在任何网络相关代码路径。
    modulePreload: { polyfill: false },
    rollupOptions: {
      input: {
        popup: 'popup.html',
        app: 'app.html',
      },
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
} as any);
