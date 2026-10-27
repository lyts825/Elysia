// 解析内置提示和技能资源所在路径。
import path from 'node:path';

// Packaged launches pin built-in instructions to the same immutable build as the server and UI.
// Development and direct server launches keep the repository root as their default.
/** 以打包资源根目录或当前工作目录为基准，拼接 prompts／skills 下的资源路径。 */
export function builtinResourcePath(directory: 'prompts' | 'skills', ...segments: string[]) {
  // 此函数只定位根目录；真实路径包含关系与已注册文件限制由各资源读取器继续核验。
  return path.resolve(process.env.ELYSIA_RESOURCE_ROOT || process.cwd(), directory, ...segments);
}
