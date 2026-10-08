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
        // v1.3：popup 已删除，主入口改为侧边栏；background 是 MV3 service worker
        panel: 'panel.html',
        app: 'app.html',
        background: 'src/ui/background.ts',
      },
      // service worker 必须是单文件、路径固定、无哈希 —— MV3 按 manifest 里的路径加载。
      // 输出 .js 而非 .ts：chrome-extension:// 下 .ts 的 MIME 判定不可靠。
      output: {
        entryFileNames: (chunk: { name: string }) =>
          chunk.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js',
      },
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
} as any);
