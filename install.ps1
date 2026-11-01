#requires -Version 5.1
[CmdletBinding()]
param(
    [string]$InstallDir,
    [ValidateRange(1024, 65535)][int]$AppPort = 3000,
    [ValidateRange(1024, 65535)][int]$CdpPort = 9228,
    [ValidatePattern('^[A-Za-z0-9_-]+$')][string]$McpName = 'excalidraw',
    [switch]$SkipMcpRegistration,
    [switch]$SkipShortcuts,
    [switch]$NoLaunch,
    [switch]$ForcePortableNode
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
. (Join-Path $PSScriptRoot 'scripts\common.ps1')
if ($env:OS -ne 'Windows_NT') { throw 'This installer supports Windows only.' }
$repoDir = $PSScriptRoot
$InstallDir = Get-ExcalidrawInstallDir $InstallDir
if ($InstallDir -eq [IO.Path]::GetPathRoot($InstallDir).TrimEnd([char[]]'\/')) { throw 'Choose an application directory, not a drive root.' }
$existingConfigPath = Join-Path $InstallDir 'installation.json'
if (Test-Path -LiteralPath $existingConfigPath) {
    $existingConfig = Get-Installation $InstallDir
    if (($PSBoundParameters.ContainsKey('AppPort') -and $AppPort -ne $existingConfig.appPort) -or ($PSBoundParameters.ContainsKey('CdpPort') -and $CdpPort -ne $existingConfig.cdpPort)) {
        throw 'Ports cannot be changed for an existing installation: the app port identifies its drawing storage and the browser profile retains its control port. Use a new -InstallDir with different ports, then migrate drawings using Excalidraw export/import.'
    }
    if (-not $PSBoundParameters.ContainsKey('AppPort')) { $AppPort = $existingConfig.appPort }
    if (-not $PSBoundParameters.ContainsKey('CdpPort')) { $CdpPort = $existingConfig.cdpPort }
    if (-not $PSBoundParameters.ContainsKey('McpName')) { $McpName = $existingConfig.mcpName }
}
if ($AppPort -eq $CdpPort) { throw 'AppPort and CdpPort must be different.' }
$lock = Get-Content -LiteralPath (Join-Path $repoDir 'upstream-lock.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$cacheDir = Join-Path $InstallDir 'cache'
$runtimeDir = Join-Path $InstallDir 'runtime'
$toolDir = Join-Path $InstallDir 'tool'
$sourceDir = Join-Path $InstallDir 'upstream'
$logsDir = Join-Path $InstallDir 'logs'
New-Item -ItemType Directory -Path $InstallDir, $cacheDir, $runtimeDir, $toolDir, $logsDir -Force | Out-Null
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

function Get-CheckedDownload {
    param([string]$Url, [string]$Destination, [string]$Sha256)
    if (Test-Path -LiteralPath $Destination) {
        if ((Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash -ieq $Sha256) { return }
        # Only this exact, installer-owned cache file is replaced.
        $checked = Assert-InstallChildPath $Destination $InstallDir
        Remove-Item -LiteralPath $checked
    }
    Write-Host "Downloading $Url"
    Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Destination -TimeoutSec 300
    if ((Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash -ine $Sha256) {
        throw "SHA-256 verification failed for $Destination. No archive was extracted."
    }
}

Write-Host '[1/6] Preparing the pinned Node.js runtime'
$nodePath = $null
if (-not $ForcePortableNode) {
    $existingNode = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($existingNode) {
        $existingVersion = & $existingNode.Source --version
        if ($LASTEXITCODE -eq 0 -and $existingVersion -eq ('v' + $lock.node.version)) { $nodePath = $existingNode.Source }
    }
}
if (-not $nodePath) {
    $architecture = $env:PROCESSOR_ARCHITECTURE
    if ($env:PROCESSOR_ARCHITEW6432) { $architecture = $env:PROCESSOR_ARCHITEW6432 }
    if ($architecture -eq 'ARM64') { $nodePlatform = 'win-arm64' }
    elseif ($architecture -eq 'AMD64') { $nodePlatform = 'win-x64' }
    else { throw "Unsupported Windows architecture: $architecture. Use 64-bit Windows." }
    $nodePackage = $lock.node.$nodePlatform
    $nodeArchive = Join-Path $cacheDir ('node-v' + $lock.node.version + '-' + $nodePlatform + '.zip')
    Get-CheckedDownload $nodePackage.url $nodeArchive $nodePackage.sha256
    $nodeFolder = Join-Path $runtimeDir ('node-v' + $lock.node.version + '-' + $nodePlatform)
    $nodePath = Join-Path $nodeFolder 'node.exe'
    $portableNpm = Join-Path $nodeFolder 'node_modules\npm\bin\npm-cli.js'
    $runtimeMarker = Join-Path $nodeFolder '.excalidraw-mcp-runtime.sha256'
    function Test-PortableRuntime {
        if (-not (Test-Path -LiteralPath $nodePath -PathType Leaf) -or -not (Test-Path -LiteralPath $portableNpm -PathType Leaf)) { return $false }
        try {
            $runtimeVersion = & $nodePath --version 2>$null
            if ($LASTEXITCODE -ne 0 -or $runtimeVersion -ne ('v' + $lock.node.version)) { return $false }
            $npmVersion = & $nodePath $portableNpm --version 2>$null
            return $LASTEXITCODE -eq 0 -and $npmVersion -match '^\d+\.\d+\.\d+'
        } catch { return $false }
    }
    $runtimeComplete = (Test-Path -LiteralPath $runtimeMarker -PathType Leaf) -and ([IO.File]::ReadAllText($runtimeMarker).Trim() -ieq $nodePackage.sha256)
    if ($runtimeComplete) { $runtimeComplete = Test-PortableRuntime }
    if (-not $runtimeComplete) {
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        $nodeZip = [IO.Compression.ZipFile]::OpenRead($nodeArchive)
        $hasher = [Security.Cryptography.SHA256]::Create()
        try {
            $nodePrefix = [IO.Path]::GetFileName($nodeFolder) + '/'
            foreach ($entry in $nodeZip.Entries) {
                if (-not $entry.FullName.StartsWith($nodePrefix, [StringComparison]::Ordinal)) { throw 'Unexpected path in the Node.js archive.' }
                $destination = Assert-InstallChildPath (Join-Path $runtimeDir $entry.FullName) $runtimeDir
                if ($entry.FullName.EndsWith('/')) { [IO.Directory]::CreateDirectory($destination) | Out-Null; continue }
                [IO.Directory]::CreateDirectory((Split-Path -Parent $destination)) | Out-Null
                # Repair interrupted extraction without rewriting valid files,
                # including node.exe when another local tool is using it.
                if ((Test-Path -LiteralPath $destination -PathType Leaf) -and (Get-Item -LiteralPath $destination).Length -eq $entry.Length) {
                    $entryStream = $entry.Open()
                    try { $entryHash = [Convert]::ToBase64String($hasher.ComputeHash($entryStream)) } finally { $entryStream.Dispose() }
                    $fileStream = [IO.File]::OpenRead($destination)
                    try { $fileHash = [Convert]::ToBase64String($hasher.ComputeHash($fileStream)) } finally { $fileStream.Dispose() }
                    if ($entryHash -eq $fileHash) { continue }
                }
                [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $destination, $true)
            }
        } finally { $nodeZip.Dispose(); $hasher.Dispose() }
        if (-not (Test-PortableRuntime)) { throw 'The portable Node.js or npm runtime failed its version check.' }
        Write-Utf8File $runtimeMarker $nodePackage.sha256
    }
}
$npmCli = Join-Path (Split-Path -Parent $nodePath) 'node_modules\npm\bin\npm-cli.js'
if (-not (Test-Path -LiteralPath $npmCli)) { throw 'npm is missing beside the selected Node.js runtime.' }
$previousPath = $env:PATH
$previousHusky = $env:HUSKY
try {
    $env:PATH = (Split-Path -Parent $nodePath) + ';' + $env:PATH
    $env:HUSKY = '0'

    Write-Host '[2/6] Preparing the official Excalidraw source'
    $sourceMarker = Join-Path $sourceDir '.excalidraw-mcp-upstream.json'
    if (Test-Path -LiteralPath $sourceDir) {
        if (-not (Test-Path -LiteralPath $sourceMarker)) { throw "Existing upstream directory is not managed by this installer: $sourceDir" }
        $previousSource = Get-Content -LiteralPath $sourceMarker -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($previousSource.commit -ne $lock.commit -or $previousSource.archiveSha256 -ne $lock.archiveSha256) {
            throw 'This directory contains a different upstream version. Install the new release into a separate directory; preserve the data folder.'
        }
    } else {
        $sourceArchive = Join-Path $cacheDir ('excalidraw-' + $lock.commit + '.zip')
        Get-CheckedDownload $lock.archiveUrl $sourceArchive $lock.archiveSha256
        # Strip GitHub's long top-level folder while extracting, keeping paths
        # short enough for Windows PowerShell 5.1 and installations with spaces.
        $extractedSource = Assert-InstallChildPath (Join-Path $InstallDir ('s-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))) $InstallDir
        New-Item -ItemType Directory -Path $extractedSource -Force | Out-Null
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        $archive = [IO.Compression.ZipFile]::OpenRead($sourceArchive)
        try {
            $archivePrefix = $lock.archiveRoot + '/'
            foreach ($entry in $archive.Entries) {
                if (-not $entry.FullName.StartsWith($archivePrefix, [StringComparison]::Ordinal)) { throw 'Unexpected path in the source archive.' }
                $relative = $entry.FullName.Substring($archivePrefix.Length)
                if (-not $relative) { continue }
                $destination = Assert-InstallChildPath (Join-Path $extractedSource $relative) $extractedSource
                if ($entry.FullName.EndsWith('/')) { New-Item -ItemType Directory -Path $destination -Force | Out-Null }
                else {
                    New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
                    [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $destination, $false)
                }
            }
        } finally { $archive.Dispose() }
        $checkedSourceDir = Assert-InstallChildPath $sourceDir $InstallDir
        if (-not (Test-Path -LiteralPath (Join-Path $extractedSource 'package.json'))) { throw 'The source archive does not contain the expected project.' }
        Move-Item -LiteralPath $extractedSource -Destination $checkedSourceDir
        Write-Utf8File $sourceMarker (@{ commit = $lock.commit; archiveSha256 = $lock.archiveSha256 } | ConvertTo-Json)
    }

    $overlayDir = Join-Path $repoDir 'upstream-overlay'
    $overlayFingerprint = @($lock.commit, $lock.node.version, $lock.yarnVersion)
    foreach ($file in (Get-ChildItem -LiteralPath $overlayDir -File -Recurse | Sort-Object FullName)) {
        $relative = $file.FullName.Substring($overlayDir.Length).TrimStart([char[]]'\/')
        $overlayFingerprint += $relative + ':' + (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
        $destination = Assert-InstallChildPath (Join-Path $sourceDir $relative) $InstallDir
        New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
        Copy-Item -LiteralPath $file.FullName -Destination $destination -Force
    }
    $buildEnvironment = "VITE_APP_LOCAL_AUTOMATION=true`nVITE_APP_ENABLE_TRACKING=false`nVITE_APP_DISABLE_SENTRY=true`n"
    Write-Utf8File (Join-Path $sourceDir '.env.production.local') $buildEnvironment
    $overlayFingerprint += $buildEnvironment
    $buildFingerprint = $overlayFingerprint -join "`n"
    $buildDir = Join-Path $sourceDir 'excalidraw-app\build'
    $buildMarker = Join-Path $sourceDir '.excalidraw-mcp-build.txt'
    $reuseBuild = (Test-Path -LiteralPath (Join-Path $buildDir 'index.html')) -and (Test-Path -LiteralPath $buildMarker)
    if ($reuseBuild) { $reuseBuild = [IO.File]::ReadAllText($buildMarker) -eq $buildFingerprint }
    Write-Host '[3/6] Building the editor'
    if (-not $reuseBuild) {
        Push-Location $sourceDir
        try { Invoke-CheckedNative $nodePath @($npmCli, 'exec', '--yes', ('--package=yarn@' + $lock.yarnVersion), '--', 'yarn', 'install', '--frozen-lockfile', '--non-interactive') }
        finally { Pop-Location }
        Push-Location (Join-Path $sourceDir 'excalidraw-app')
        try { Invoke-CheckedNative $nodePath @((Join-Path $sourceDir 'node_modules\vite\bin\vite.js'), 'build') }
        finally { Pop-Location }
        if (-not (Test-Path -LiteralPath (Join-Path $buildDir 'index.html'))) { throw 'The build did not produce index.html.' }
        Copy-Item -LiteralPath (Join-Path $sourceDir 'LICENSE') -Destination (Join-Path $buildDir 'LICENSE-Excalidraw.txt') -Force
        Write-Utf8File $buildMarker $buildFingerprint
    } else { Write-Host 'The pinned editor build is already current.' }

    Write-Host '[4/6] Installing the local MCP runtime'
    foreach ($folder in @('src', 'scripts')) {
        $folderRoot = Join-Path $repoDir $folder
        foreach ($file in (Get-ChildItem -LiteralPath $folderRoot -File -Recurse | Where-Object { $_.Extension -in @('.mjs', '.ps1') })) {
            $relative = $file.FullName.Substring($repoDir.Length).TrimStart([char[]]'\/')
            $destination = Assert-InstallChildPath (Join-Path $toolDir $relative) $InstallDir
            New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
            Copy-Item -LiteralPath $file.FullName -Destination $destination -Force
        }
    }
    foreach ($filename in @('package.json', 'package-lock.json', 'upstream-lock.json', 'start.ps1', 'doctor.ps1', 'LICENSE', 'THIRD_PARTY_NOTICES.md')) {
        Copy-Item -LiteralPath (Join-Path $repoDir $filename) -Destination (Join-Path $toolDir $filename) -Force
    }
    $installedLicenses = Join-Path $toolDir 'licenses'
    New-Item -ItemType Directory -Path $installedLicenses -Force | Out-Null
    foreach ($license in (Get-ChildItem -LiteralPath (Join-Path $repoDir 'licenses') -File)) {
        Copy-Item -LiteralPath $license.FullName -Destination (Join-Path $installedLicenses $license.Name) -Force
    }
    Push-Location $toolDir
    try { Invoke-CheckedNative $nodePath @($npmCli, 'ci', '--omit=dev', '--no-audit', '--no-fund') }
    finally { Pop-Location }

    function Find-DrawingBrowser {
        $candidates = @()
        foreach ($base in @(${env:ProgramFiles(x86)}, $env:ProgramFiles, $env:LOCALAPPDATA)) {
            if ($base) {
                $candidates += Join-Path $base 'Microsoft\Edge\Application\msedge.exe'
                $candidates += Join-Path $base 'Google\Chrome\Application\chrome.exe'
            }
        }
        return $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    }
    $browserPath = Find-DrawingBrowser
    if (-not $browserPath) {
        $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
        if (-not $winget) { throw 'Microsoft Edge or Google Chrome is required. Install one from its official website, then rerun install.ps1.' }
        Invoke-CheckedNative $winget.Source @('install', '--id', 'Microsoft.Edge', '--exact', '--source', 'winget', '--silent', '--accept-source-agreements', '--accept-package-agreements', '--disable-interactivity')
        $browserPath = Find-DrawingBrowser
        if (-not $browserPath) { throw 'The browser installation needs to finish before this installer can continue. Rerun install.ps1 after Microsoft Edge is available.' }
    }
    $profileDir = Join-Path $InstallDir 'data\browser'
    New-Item -ItemType Directory -Path $profileDir -Force | Out-Null
    $config = [ordered]@{ version = 1; installDir = $InstallDir; toolDir = $toolDir; buildDir = $buildDir; nodePath = $nodePath; browserPath = $browserPath; profileDir = $profileDir; appPort = $AppPort; cdpPort = $CdpPort; mcpName = $McpName }
    Write-Utf8File (Join-Path $InstallDir 'installation.json') ($config | ConvertTo-Json -Depth 5)

    Write-Host '[5/6] Generating the MCP configuration and launcher'
    $registerArgs = @((Join-Path $toolDir 'scripts\register-mcp.mjs'), '--install-dir', $InstallDir, '--name', $McpName)
    if ($SkipMcpRegistration) { $registerArgs += '--skip-register' }
    Invoke-CheckedNative $nodePath $registerArgs
    if (-not $SkipShortcuts) {
        $shortcutShell = New-Object -ComObject WScript.Shell
        $launcherPath = Join-Path $toolDir 'start.ps1'
        foreach ($shortcutFolder in @([Environment]::GetFolderPath('DesktopDirectory'), [Environment]::GetFolderPath('Programs'))) {
            $shortcutName = 'Excalidraw-MCP.lnk'
            if ($McpName -ne 'excalidraw') { $shortcutName = 'Excalidraw-MCP - ' + $McpName + '.lnk' }
            $shortcutPath = Join-Path $shortcutFolder $shortcutName
            $shortcut = $shortcutShell.CreateShortcut($shortcutPath)
            if ((Test-Path -LiteralPath $shortcutPath) -and $shortcut.Arguments -and -not $shortcut.Arguments.Contains($launcherPath)) {
                throw "A shortcut with this name belongs to another installation: $shortcutPath"
            }
            $shortcut.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
            $shortcut.Arguments = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $launcherPath + '" -InstallDir "' + $InstallDir + '"'
            $shortcut.WorkingDirectory = $toolDir
            $shortcut.WindowStyle = 7
            $shortcut.Description = 'Local Excalidraw with MCP background editing'
            $shortcut.IconLocation = Join-Path $buildDir 'favicon.ico'
            $shortcut.Save()
        }
    }

    Write-Host '[6/6] Installation complete'
    Write-Output "Install directory: $InstallDir"
    Write-Output "Canvas URL: http://127.0.0.1:$AppPort"
    Write-Output "MCP name: $McpName"
    if (-not $NoLaunch) {
        Invoke-CheckedNative (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $toolDir 'start.ps1'), '-InstallDir', $InstallDir)
        Invoke-CheckedNative (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $toolDir 'doctor.ps1'), '-InstallDir', $InstallDir)
    } else { Write-Output 'Launch was skipped. Run start.ps1 and doctor.ps1 with the same -InstallDir when ready.' }
    Write-Output 'Restart or reload the MCP client to discover the tools. Keep the dedicated canvas window open; it may be minimized.'
} finally {
    $env:PATH = $previousPath
    $env:HUSKY = $previousHusky
}
