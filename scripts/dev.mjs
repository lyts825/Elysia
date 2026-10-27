// 以开发模式复用统一启动入口。
process.argv.push('--dev');
await import('./launch.mjs');
