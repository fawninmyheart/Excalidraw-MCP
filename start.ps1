#requires -Version 5.1
param([string]$InstallDir)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'scripts\common.ps1')
$InstallDir = Get-ExcalidrawInstallDir $InstallDir
$config = Get-Installation $InstallDir
$appUrl = 'http://127.0.0.1:' + $config.appPort
$canvasUrlPattern = '^' + [regex]::Escape($appUrl) + '/(?:[?#].*)?$'
$debugUrl = 'http://127.0.0.1:' + $config.cdpPort
$healthUrl = $appUrl + '/__local_health'
$logsDir = Join-Path $InstallDir 'logs'
New-Item -ItemType Directory -Path $logsDir, $config.profileDir -Force | Out-Null

function Read-LocalHealth {
    try { return Invoke-RestMethod -Uri $healthUrl -TimeoutSec 2 } catch { return $null }
}

if (-not (Test-Path -LiteralPath (Join-Path $config.buildDir 'index.html'))) { throw 'The application build is missing. Run install.ps1 again.' }
if (-not (Test-Path -LiteralPath $config.nodePath)) { throw 'The configured Node.js runtime is missing. Run install.ps1 again.' }
if (-not (Test-Path -LiteralPath $config.browserPath)) { throw 'The configured browser is missing. Run install.ps1 again.' }
$health = Read-LocalHealth
if (-not $health) {
    if ((Get-ListeningPort $config.appPort).Count) { throw "Port $($config.appPort) is occupied by another service. Use a new -InstallDir with different ports; migrate drawings by export/import if needed." }
    $serverScript = Join-Path $config.toolDir 'src\http-server.mjs'
    $previousHome = $env:EXCALIDRAW_MCP_HOME
    try {
        $env:EXCALIDRAW_MCP_HOME = $InstallDir
        $server = Start-Process -FilePath $config.nodePath -ArgumentList ('"{0}"' -f $serverScript) -WorkingDirectory $config.toolDir -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logsDir 'server.log') -RedirectStandardError (Join-Path $logsDir 'server-error.log')
    } finally { $env:EXCALIDRAW_MCP_HOME = $previousHome }
    Write-Utf8File (Join-Path $logsDir 'server.pid') ([string]$server.Id)
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
        Start-Sleep -Milliseconds 250
        $health = Read-LocalHealth
        if ($health) { break }
        if ($server.HasExited) { throw "The local server exited. Check $logsDir\server-error.log." }
    }
}
if (-not $health -or $health.service -ne 'excalidraw-local' -or [IO.Path]::GetFullPath($health.root).TrimEnd([char[]]'\/') -ne [IO.Path]::GetFullPath($config.buildDir).TrimEnd([char[]]'\/')) {
    throw "Port $($config.appPort) did not return this installation's health check."
}

$listeners = Get-ListeningPort $config.cdpPort
if ($listeners.Count) {
    if ($listeners | Where-Object { $_.LocalAddress -notin @('127.0.0.1', '::1') }) {
        throw 'The browser control port is not restricted to loopback. Stop the conflicting browser before continuing.'
    }
    $owner = Get-CimInstance Win32_Process -Filter ('ProcessId = {0}' -f $listeners[0].OwningProcess)
    if (-not $owner.CommandLine -or -not $owner.CommandLine.Contains($config.profileDir)) {
        throw "Port $($config.cdpPort) belongs to another browser or service. Use a new -InstallDir with different ports; migrate drawings by export/import if needed."
    }
    $targets = Invoke-RestMethod -Uri ($debugUrl + '/json/list') -TimeoutSec 2
    $canvas = @($targets | Where-Object { $_.type -eq 'page' -and $_.url -match $canvasUrlPattern })
    if ($canvas.Count -gt 1) { throw 'Multiple local canvases are open. Keep one dedicated canvas window.' }
    if ($canvas.Count -eq 1) { Write-Output "Excalidraw MCP is already running: $appUrl"; exit 0 }
}

$browserArgs = @(
    ('--user-data-dir="{0}"' -f $config.profileDir),
    '--remote-debugging-address=127.0.0.1',
    ('--remote-debugging-port={0}' -f $config.cdpPort),
    '--no-first-run',
    '--no-default-browser-check',
    ('--app={0}' -f $appUrl)
)
# This is the interactive drawing window the user requested, not a background helper.
Start-Process -FilePath $config.browserPath -ArgumentList $browserArgs
for ($attempt = 0; $attempt -lt 60; $attempt++) {
    Start-Sleep -Milliseconds 250
    try {
        $targets = Invoke-RestMethod -Uri ($debugUrl + '/json/list') -TimeoutSec 1
        if ($targets | Where-Object { $_.type -eq 'page' -and $_.url -match $canvasUrlPattern }) {
            Write-Output "Excalidraw MCP started: $appUrl"
            exit 0
        }
    } catch { }
}
throw 'The dedicated browser did not expose the canvas. Check its window for a startup prompt.'
