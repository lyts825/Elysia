/**
 * 配置 React 前端的本机开发代理、生产资源输出和计划对齐面板的虚拟入口。
 * 开发与生产使用同一个虚拟模块协议：开发返回源码地址，构建返回独立资源地址，
 * 让页面可以按需加载并重试该面板；服务端 API 的实现与授权仍由后端负责。
 * EN: Configure local React development proxies, production assets, and the plan-alignment
 * virtual entry. Development returns a source URL and builds return a separate asset URL,
 * enabling lazy loading and retries; the backend owns API behavior and authorization.
 */
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

/**
 * 为计划对齐面板提供稳定的虚拟入口。开发时指向源码；生产构建将其输出为独立 chunk，
 * 返回构建器生成的资源 URL，供加载失败后的重试使用。
 * EN: Provide a stable virtual entry for the plan-alignment panel. Development targets source;
 * production emits a separate chunk and exports its generated URL for load retries.
 */
function planAlignmentEntry(): Plugin {
  const virtualId = 'virtual:elysia-plan-alignment';
  const resolvedId = '\0' + virtualId;
  let building = false;
  return {
    name: 'elysia-plan-alignment-entry',
    /**
     * 在最终配置确定后记录运行模式，避免在解析入口时误用尚未解析的配置。
     * EN: Capture the resolved command before entry resolution so the plugin uses the final mode.
     */
    configResolved(config) {
      building = config.command === 'build';
    },
    /**
     * 只接管本插件的虚拟标识，使用空字符前缀避免与真实文件模块冲突。
     * EN: Resolve only this plugin's virtual ID, using a null prefix to avoid real-file collisions.
     */
    resolveId(id) {
      return id === virtualId ? resolvedId : undefined;
    },
    /**
     * 开发时导出源码路径，生产时发射保留导出签名的独立 chunk，并由 Rollup 解析最终 URL。
     * 该模块只提供地址，不直接导入面板，加载时机及失败重试留给页面控制。
     * EN: Export a source path in development or emit a separate chunk with its export signature
     * preserved in production. Rollup supplies its final URL; the page owns loading and retries.
     */
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
/**
 * 开发服务只监听本机；API、终端和预览请求转发到同一个本地后端。
 * 生产构建保留独立资源文件，便于按 URL 定位和加载，不将小资源内联进脚本。
 * EN: Bind development to loopback and proxy API, terminal, and preview requests to one local
 * backend. Keep production assets as separate URL-addressable files rather than inlining them.
 */
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
