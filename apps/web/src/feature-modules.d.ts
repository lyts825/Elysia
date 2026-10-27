/**
 * 声明构建工具加载功能模块时使用的类型。
 * 为虚拟功能模块清单提供编译期声明，使动态加载保留manifest类型；不创建运行时注册表。
 * EN: Declares types for build-generated feature entry modules. Declares the virtual feature-module manifest for compilation so dynamic loading retains manifest types without creating a runtime registry.
 */
/**
 * 该声明只满足 TypeScript 类型检查，实际 URL 由 Vite 的计划入口插件在开发/构建时生成。
 * EN: This declaration satisfies type checking only; Vite creates the actual plan entry URL in development/build.
 */
declare module 'virtual:elysia-plan-alignment' {
  /**
   * 构建插件提供可动态导入的入口地址，而非直接导出组件。
   * EN: The build plugin exports an importable entry address, not the component itself.
   */
  const entryUrl: string;
  export default entryUrl;
}
