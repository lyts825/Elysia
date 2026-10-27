// 以开发模式复用统一启动入口。
// 将开发标记传给统一启动器，仍沿用其依赖检查和单实例握手。
process.argv.push('--dev');
await import('./launch.mjs');
