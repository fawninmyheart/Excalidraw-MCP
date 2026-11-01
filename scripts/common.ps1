Set-StrictMode -Version 2.0

function Get-ExcalidrawInstallDir {
    param([string]$Path)
    if (-not $Path) {
        if ($env:EXCALIDRAW_MCP_HOME) { $Path = $env:EXCALIDRAW_MCP_HOME }
        else { $Path = Join-Path $env:LOCALAPPDATA 'Excalidraw-MCP' }
    }
    $providerPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path)
    return [IO.Path]::GetFullPath($providerPath).TrimEnd([char[]]'\/')
}

function Write-Utf8File {
    param([string]$Path, [string]$Content)
    [IO.File]::WriteAllText($Path, $Content, (New-Object Text.UTF8Encoding($false)))
}

function Assert-InstallChildPath {
    param([string]$Path, [string]$InstallDir)
    $fullPath = [IO.Path]::GetFullPath($Path)
    $prefix = [IO.Path]::GetFullPath($InstallDir).TrimEnd([char[]]'\/') + [IO.Path]::DirectorySeparatorChar
    if (-not $fullPath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing file operation outside the installation directory: $fullPath"
    }
    return $fullPath
}

function Get-Installation {
    param([string]$InstallDir)
    $configPath = Join-Path $InstallDir 'installation.json'
    if (-not (Test-Path -LiteralPath $configPath)) {
        throw "Installation not found at $InstallDir. Run install.ps1 first."
    }
    $config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($config.version -ne 1 -or [IO.Path]::GetFullPath($config.installDir).TrimEnd([char[]]'\/') -ne $InstallDir) {
        throw 'The installation configuration does not match this directory.'
    }
    return $config
}

function Invoke-CheckedNative {
    param([string]$FilePath, [string[]]$Arguments)
    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed with exit code ${LASTEXITCODE}: $FilePath $($Arguments -join ' ')"
    }
}

function Get-ListeningPort {
    param([int]$Port)
    return ,@(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
}
