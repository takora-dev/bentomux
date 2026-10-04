<#
.SYNOPSIS
    Installs Bentomux on Windows.

.DESCRIPTION
    Reads the release manifest published by CI, downloads the Windows build for
    this machine, verifies its SHA-256 and runs it: the per-user NSIS setup by
    preference (no UAC prompt), the MSI as a fallback when a release ships no
    setup.exe.

    Run it directly, or through the bootstrap that survives environments where
    `irm | iex` is blocked:

        powershell -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/takora-dev/bentomux/master/installers/install.ps1 | iex"

.PARAMETER ManifestUrl
    Release manifest to read. Defaults to the newest GitHub release. A non-HTTPS
    URL (http mirror or a file:// path) is accepted for offline installs.

.PARAMETER DryRun
    Resolve and verify the release, then stop before installing.

.EXAMPLE
    irm ... | iex
    $env:BENTOMUX_DRY_RUN = '1'; irm ... | iex

.NOTES
    Environment: BENTOMUX_MANIFEST_URL, BENTOMUX_REPO, BENTOMUX_DRY_RUN.
#>
[CmdletBinding()]
param(
    [string]$ManifestUrl = $env:BENTOMUX_MANIFEST_URL,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$ProgressPreference = 'SilentlyContinue'
# Tls12; the enum member is absent on Windows PowerShell 5.1.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072

function Write-Step([string]$Message) { Write-Host "  > $Message" -ForegroundColor Green }
function Write-Note([string]$Message) { Write-Host "  ! $Message" -ForegroundColor Yellow }
function Fail([string]$Message) {
    Write-Host "  x $Message" -ForegroundColor Red
    exit 1
}

$Repo = if ($env:BENTOMUX_REPO) { $env:BENTOMUX_REPO } else { 'takora-dev/bentomux' }
if (-not $ManifestUrl) {
    $ManifestUrl = "https://github.com/$Repo/releases/latest/download/latest.json"
}
# A custom manifest may point at a local mirror (http mirror or file:// path);
# an HTTPS manifest keeps the downloads HTTPS-only so a hijacked asset URL
# cannot downgrade them.
$CurlProto = if ($ManifestUrl -like 'https://*') { '=https' } else { '=http,https,file' }
if ($env:BENTOMUX_DRY_RUN -eq '1') { $DryRun = $true }

$CurlExe = $null
$curlCommand = Get-Command curl.exe -ErrorAction SilentlyContinue
if ($curlCommand) { $CurlExe = $curlCommand.Source }

# A manifest or asset URL may point at a local mirror: a file:// URI or a plain
# filesystem path (offline install from a share). Everything else goes to curl.
function Get-LocalPath([string]$Url) {
    if ($Url -like 'file://*') { return ([Uri]$Url).LocalPath }
    if ($Url -like 'http://*' -or $Url -like 'https://*') { return $null }
    return $Url
}

function Get-Manifest([string]$Url) {
    $localPath = Get-LocalPath $Url
    if ($localPath) {
        return Get-Content -Raw -LiteralPath $localPath | ConvertFrom-Json
    }
    if ($CurlExe) {
        $text = & $CurlExe --fail --silent --show-error --location --proto $CurlProto --tlsv1.2 `
            --retry 3 --connect-timeout 10 --max-time 60 $Url
        if ($LASTEXITCODE -ne 0) { Fail "cannot reach $Url" }
        return ($text -join "`n") | ConvertFrom-Json
    }
    return Invoke-RestMethod -Uri $Url -UseBasicParsing
}

function Get-RemoteFile([string]$Url, [string]$Path) {
    $localPath = Get-LocalPath $Url
    if ($localPath) {
        Copy-Item -LiteralPath $localPath -Destination $Path
        return
    }
    if ($CurlExe) {
        & $CurlExe --fail --silent --show-error --location --proto $CurlProto --tlsv1.2 `
            --retry 3 --connect-timeout 10 --max-time 900 --output $Path $Url
        if ($LASTEXITCODE -ne 0) { Fail "download failed: $Url" }
        return
    }
    Invoke-WebRequest -Uri $Url -OutFile $Path -UseBasicParsing
}

function Get-Asset($Manifest, [string]$Name) {
    $match = $Manifest.assets.PSObject.Properties | Where-Object { $_.Name -eq $Name } | Select-Object -First 1
    if ($match) { return $match.Value }
    return $null
}

$target = $null
$fallbackTarget = $null
# PROCESSOR_ARCHITECTURE, not RuntimeInformation.OSArchitecture: that type does not
# resolve reliably in Windows PowerShell 5.1, which is what the documented
# `powershell -ExecutionPolicy Bypass -c "irm ... | iex"` one-liner runs.
# PROCESSOR_ARCHITEW6432 is set when a 32-bit shell runs on 64-bit Windows.
# Off Windows no architecture is reported (scripts/verify-installer.ps1 exercises
# the dry-run path there); x64 is the only Windows build published.
$arch = $env:PROCESSOR_ARCHITECTURE
if ($env:PROCESSOR_ARCHITEW6432) { $arch = $env:PROCESSOR_ARCHITEW6432 }
if (-not $arch) { $arch = 'AMD64' }
switch ($arch) {
    'AMD64' { $target = 'windows-x86_64'; $fallbackTarget = 'windows-x86_64-msi' }
    'ARM64' {
        Write-Note 'no native arm64 build is published yet; installing the x64 build (runs under emulation)'
        $target = 'windows-x86_64'
        $fallbackTarget = 'windows-x86_64-msi'
    }
    default { Fail "unsupported architecture: $arch" }
}

Write-Step "target: $target"
Write-Step "manifest: $ManifestUrl"
$manifest = Get-Manifest $ManifestUrl
if (-not $manifest.PSObject.Properties['assets']) {
    Fail "$ManifestUrl does not look like a Bentomux release manifest (no assets)"
}

$asset = Get-Asset $manifest $target
$useMsi = $false
if (-not $asset) {
    $asset = Get-Asset $manifest $fallbackTarget
    $useMsi = $true
}
if (-not $asset) {
    $available = ($manifest.assets.PSObject.Properties.Name) -join ', '
    Fail "release $($manifest.version) has no Windows build (available: $available)"
}

$url = $asset.url
$fileName = $url.Split('/')[-1]
Write-Step "release: v$($manifest.version)"
Write-Step "package: $fileName ($($asset.format))"
if ($DryRun) {
    Write-Step "url: $url"
    Write-Step "sha256: $($asset.sha256)"
    Write-Step 'dry run: not downloading or installing'
    exit 0
}

$temp = Join-Path ([IO.Path]::GetTempPath()) ("bentomux-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temp -Force | Out-Null
try {
    $file = Join-Path $temp $fileName
    Write-Step "downloading $fileName"
    Get-RemoteFile $url $file

    $hash = (Get-FileHash -Path $file -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($hash -ne $asset.sha256.ToLowerInvariant()) {
        Fail "checksum mismatch for $fileName`: expected $($asset.sha256), got $hash"
    }
    Write-Step 'checksum verified'

    if ($useMsi) {
        Write-Step 'running the MSI package (silent, may prompt for elevation)'
        $process = Start-Process -FilePath 'msiexec.exe' -ArgumentList @('/i', "`"$file`"", '/qn', '/norestart') -Wait -PassThru
    } else {
        Write-Step 'running the per-user setup (silent, no elevation)'
        $process = Start-Process -FilePath $file -ArgumentList @('/S') -Wait -PassThru
    }
    if ($process.ExitCode -ne 0) {
        $hint = if ($useMsi) { '; the MSI needs administrator rights, so run this from an elevated terminal' } else { '' }
        Fail "the installer exited with code $($process.ExitCode)$hint"
    }

    $candidates = @((Join-Path $env:LOCALAPPDATA 'Bentomux\Bentomux.exe'))
    if ($env:ProgramFiles) { $candidates += (Join-Path $env:ProgramFiles 'Bentomux\Bentomux.exe') }
    $found = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
    if ($found) {
        Write-Step "installed: $found"
    } else {
        Write-Note 'the installer finished but Bentomux.exe was not found where expected; use the Start Menu shortcut'
    }
    Write-Step "Bentomux $($manifest.version) installed"
} finally {
    Remove-Item -Path $temp -Recurse -Force -ErrorAction SilentlyContinue
}
