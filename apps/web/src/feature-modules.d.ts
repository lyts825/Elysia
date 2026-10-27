/* 声明构建工具加载功能模块时使用的类型。 */
// 该声明只满足 TypeScript 类型检查，实际 URL 由 Vite 的计划入口插件在开发/构建时生成。
declare module 'virtual:elysia-plan-alignment' {
  // 构建插件提供可动态导入的入口地址，而非直接导出组件。
  const entryUrl: string;
  export default entryUrl;
}
