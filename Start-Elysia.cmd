@echo off
rem 从项目目录启动，失败时保留窗口以便查看错误。
cd /d "%~dp0"
node scripts\launch.mjs
if errorlevel 1 pause
