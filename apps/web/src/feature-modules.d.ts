/* 声明构建工具加载功能模块时使用的类型。 */
declare module 'virtual:elysia-plan-alignment' {
  // 构建插件提供可动态导入的入口地址，而非直接导出组件。
  const entryUrl: string;
  export default entryUrl;
}
