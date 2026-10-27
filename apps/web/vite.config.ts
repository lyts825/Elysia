// 配置前端开发代理、构建输出及计划对齐模块入口。
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

/**
 * 为计划对齐面板提供稳定的虚拟入口。开发时指向源码；生产构建将其输出为独立 chunk，
 * 返回构建器生成的资源 URL，供加载失败后的重试使用。
 */
function planAlignmentEntry(): Plugin {
  const virtualId = 'virtual:elysia-plan-alignment';
  const resolvedId = '\0' + virtualId;
  let building = false;
  return {
    name: 'elysia-plan-alignment-entry',
    configResolved(config) {
      building = config.command === 'build';
    },
    resolveId(id) {
      return id === virtualId ? resolvedId : undefined;
    },
    load(id) {
      if (id !== resolvedId) return;
      if (!building) return 'export default "/src/features/plan-alignment/PlanAlignmentPanel.tsx";';
      const reference = this.emitFile({
        type: 'chunk',
        id: fileURLToPath(new URL('./src/features/plan-alignment/PlanAlignmentPanel.tsx', import.meta.url)),
        name: 'plan-alignment',
        preserveSignature: 'strict',
      });
      return `export default import.meta.ROLLUP_FILE_URL_${reference};`;
    },
  };
}
// 开发服务只监听本机；API、终端和预览请求转发到同一个本地后端。
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react(), planAlignmentEntry()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:' + (process.env.ELYSIA_PORT || '4317'),
      '/terminal': 'http://127.0.0.1:' + (process.env.ELYSIA_PORT || '4317'),
      '/preview': 'http://127.0.0.1:' + (process.env.ELYSIA_PORT || '4317'),
    },
  },
  build: { outDir: 'dist', emptyOutDir: true, assetsInlineLimit: 0 },
});
