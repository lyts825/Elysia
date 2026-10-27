/**
 * 导出原生供应商实现及适配器注册表。
 * 消费方可通过此入口同时使用协议适配器及注册能力，无需依赖内部文件路径。
 * 兼容旧的 NativeProvider 导入路径，适配器选择仍通过注册表按协议和认证方式精确匹配。
 * 保持原生适配器的兼容导出，同时由注册表承担实际协议与认证方式选择。
 *
 * EN: Exports native provider implementations and the adapter registry.
 * Consumers can use protocol adapters and registry capabilities through this entry without importing internal paths.
 * Preserves the old NativeProvider import; adapter selection still requires exact protocol/authentication registry matching.
 * Preserves compatible native exports while the registry selects actual protocol/authentication adapters.
 */
export * from './native.js';
export * from './registry.js';
