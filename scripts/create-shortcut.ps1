param([string]$Destination = [Environment]::GetFolderPath('Desktop'))
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$entry = Join-Path $projectRoot 'Start-Elysia.vbs'
$icon = Join-Path $projectRoot 'assets\brand\app-icon.ico'
if (-not (Test-Path -LiteralPath $icon)) { throw "Application icon is missing: $icon" }
$target = Join-Path ([IO.Path]::GetFullPath($Destination)) 'Elysia.lnk'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($target)
if ((Test-Path -LiteralPath $target) -and $shortcut.Arguments -ne ('"' + $entry + '"')) {
    throw "Existing shortcut belongs to another application: $target"
}
$shortcut.TargetPath = Join-Path $env:SystemRoot 'System32\wscript.exe'
$shortcut.Arguments = '"' + $entry + '"'
$shortcut.WorkingDirectory = $projectRoot
$shortcut.Description = 'Elysia - local agent workspace'
$shortcut.IconLocation = $icon + ',0'
$shortcut.WindowStyle = 7
$shortcut.Save()
Write-Output $target
