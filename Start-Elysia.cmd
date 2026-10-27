@echo off
rem 从脚本所在项目目录运行 Node 启动器，避免当前终端路径影响资源与配置定位。
rem EN: Run the Node launcher from this script's project directory so caller paths do not affect resource lookup.
cd /d "%~dp0"
rem 启动器负责构建缓存、端口和桌面进程协调；此入口仅保留控制台便于手动诊断。
rem EN: The launcher coordinates build caches, ports, and the desktop process; this entry provides a diagnostic console.
node scripts\launch.mjs
rem 失败时等待按键，防止双击启动后错误信息随窗口立即消失。
rem EN: Wait for a key after failure so double-click launches leave error output visible.
if errorlevel 1 pause
