// 解析内置提示和技能资源所在路径。
import path from 'node:path';

// Packaged launches pin built-in instructions to the same immutable build as the server and UI.
// Development and direct server launches keep the repository root as their default.
export function builtinResourcePath(directory: 'prompts' | 'skills', ...segments: string[]) {
  return path.resolve(process.env.ELYSIA_RESOURCE_ROOT || process.cwd(), directory, ...segments);
}
