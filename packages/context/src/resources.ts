/**
 * 解析内置提示和技能资源所在路径。
 * 打包资源与服务端构建固定一致，最终路径安全由具体读取器继续核验。
 *
 * EN: Resolves paths for built-in prompts and skill resources.
 * Pins packaged resources to the server build while concrete readers enforce final path safety.
 */
import path from 'node:path';

/**
 * 打包启动将内置指导固定在与服务端及界面相同的不可变构建中。
 * 开发与直接服务端启动默认仍使用仓库根目录。
 * 以打包资源根目录或当前工作目录为基准，拼接 prompts／skills 下的资源路径。
 *
 * EN: Packaged launches pin built-in instructions to the same immutable build as the server and UI.
 * Development and direct server launches keep the repository root as their default.
 * Resolves prompts/skills paths beneath the packaged resource root or current working directory.
 */
export function builtinResourcePath(directory: 'prompts' | 'skills', ...segments: string[]) {
  /**
   * 此函数只定位根目录；真实路径包含关系与已注册文件限制由各资源读取器继续核验。
   *
   * EN: Only locates the root; resource readers additionally enforce real-path containment and registered-file restrictions.
   */
  return path.resolve(process.env.ELYSIA_RESOURCE_ROOT || process.cwd(), directory, ...segments);
}
