#requires -Version 5.1
param([string]$InstallDir)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'scripts\common.ps1')
$InstallDir = Get-ExcalidrawInstallDir $InstallDir
$config = Get-Installation $InstallDir
$previousHome = $env:EXCALIDRAW_MCP_HOME
try {
    $env:EXCALIDRAW_MCP_HOME = $InstallDir
    & $config.nodePath (Join-Path $config.toolDir 'scripts\doctor.mjs')
    $doctorExit = $LASTEXITCODE
} finally { $env:EXCALIDRAW_MCP_HOME = $previousHome }
exit $doctorExit
