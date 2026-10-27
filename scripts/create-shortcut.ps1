# 为当前项目创建指向隐藏启动器的 Windows 快捷方式，Destination 默认使用当前用户桌面。
# 路径由脚本所在目录计算；已有同名快捷方式的参数若与本项目不同则拒绝覆盖。
# EN: Create a Windows shortcut to this checkout's hidden launcher, defaulting Destination to
# the user's desktop. Resolve paths from the script directory and reject a same-name shortcut
# whose launcher arguments differ from this project's entry.
param([string]$Destination = [Environment]::GetFolderPath('Desktop'))
# 缺失图标或目录等错误立即终止，避免继续写入不完整的快捷方式。
# EN: Stop on errors such as a missing icon or directory instead of saving an incomplete shortcut.
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$entry = Join-Path $projectRoot 'Start-Elysia.vbs'
$icon = Join-Path $projectRoot 'assets\brand\app-icon.ico'
if (-not (Test-Path -LiteralPath $icon)) { throw "Application icon is missing: $icon" }
$target = Join-Path ([IO.Path]::GetFullPath($Destination)) 'Elysia.lnk'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($target)
# 只在参数指向本项目入口时复用现有快捷方式；此判断不依据显示名称推测归属。
# EN: Reuse an existing shortcut only when its arguments target this entry; its display name alone is insufficient.
if ((Test-Path -LiteralPath $target) -and $shortcut.Arguments -ne ('"' + $entry + '"')) {
    throw "Existing shortcut belongs to another application: $target"
}
# 使用系统 wscript.exe 调用 VBS，完整路径加引号以支持空格；工作目录固定为项目根目录。
# EN: Invoke VBS with system wscript.exe, quote its full path for spaces, and use the project root as working directory.
$shortcut.TargetPath = Join-Path $env:SystemRoot 'System32\wscript.exe'
$shortcut.Arguments = '"' + $entry + '"'
$shortcut.WorkingDirectory = $projectRoot
$shortcut.Description = 'Elysia - local agent workspace'
$shortcut.IconLocation = $icon + ',0'
$shortcut.WindowStyle = 7
# 保存后输出实际路径，调用方可据此定位产物；不启动应用。
# EN: Save and return the resulting path for callers to locate the shortcut without launching the app.
$shortcut.Save()
Write-Output $target
