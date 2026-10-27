// 导出原生供应商实现及适配器注册表。
// 消费方可通过此入口同时使用协议适配器及注册能力，无需依赖内部文件路径。
// 兼容旧的 NativeProvider 导入路径，适配器选择仍通过注册表按协议和认证方式精确匹配。
export * from './native.js';
export * from './registry.js';
