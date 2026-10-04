# Same contract as scripts/verify-installer.sh, for the Windows installer: the
# fixture manifest comes from the real generator, so install.ps1 has to agree
# with it. The dry-run path touches no Windows-only API, which is why CI also
# runs this on Linux (where a real silent install would be meaningless).
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$root = Split-Path -Parent $PSScriptRoot
$temp = Join-Path ([IO.Path]::GetTempPath()) ('bentomux-verify-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temp -Force | Out-Null

function Fail([string]$Message) {
    Write-Host "verify-installer.ps1: $Message" -ForegroundColor Red
    exit 1
}

function New-Checksum([string]$FileName) {
    $path = Join-Path $temp $FileName
    [IO.File]::WriteAllBytes($path, [byte[]](1..64))
    $hash = (Get-FileHash -Path $path -Algorithm SHA256).Hash.ToLowerInvariant()
    Add-Content -Path (Join-Path $temp 'checksums.sha256') -Value "$hash  $FileName" -Encoding ascii
}

function New-Manifest([string]$Name) {
    $manifest = Join-Path $temp $Name
    & node (Join-Path $root 'scripts/release-manifest.mjs') --tag v0.1.0 `
        --checksums (Join-Path $temp 'checksums.sha256') --out $manifest | Out-Null
    if ($LASTEXITCODE -ne 0) { Fail 'the fixture manifest could not be generated' }
    $dirUri = ([Uri]("$temp" + [IO.Path]::DirectorySeparatorChar)).AbsoluteUri
    $json = (Get-Content $manifest -Raw).Replace('https://github.com/takora-dev/bentomux/releases/download/v0.1.0/', $dirUri)
    Set-Content -Path $manifest -Value $json -Encoding utf8
    return $manifest
}

function Invoke-Installer([string]$Manifest) {
    $shell = if (Get-Command powershell.exe -ErrorAction SilentlyContinue) { 'powershell.exe' } else { 'pwsh' }
    $output = & $shell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'installers/install.ps1') `
        -ManifestUrl $Manifest -DryRun 2>&1 | Out-String
    # Out-String joins with CRLF on Windows, and .NET's `$` does not match before
    # a `\r`, so an anchored assertion would pass on Linux/macOS and fail here.
    $output = $output -replace "`r`n", "`n"
    return [pscustomobject]@{ Output = $output; ExitCode = $LASTEXITCODE }
}

try {
    # 1. A release with both packages must prefer the per-user NSIS setup.
    New-Checksum 'Bentomux_0.1.0_x64-setup.exe'
    New-Checksum 'Bentomux_0.1.0_x64_en-US.msi'
    $result = Invoke-Installer (New-Manifest 'both.json')
    if ($result.ExitCode -ne 0) { Fail "dry run failed:`n$($result.Output)" }
    if ($result.Output -notmatch '\(nsis\)') { Fail "NSIS was not preferred:`n$($result.Output)" }
    if ($result.Output -notmatch 'dry run: not downloading') { Fail "dry run did not stop:`n$($result.Output)" }
    if ($result.Output -notmatch 'Bentomux_0.1\.0_x64-setup\.exe') { Fail "wrong package resolved:`n$($result.Output)" }
    if ($result.Output -notmatch '(?m)^\s+>\s+sha256: [0-9a-f]{64}$') { Fail "no checksum reported:`n$($result.Output)" }
    if ($result.Output -notmatch 'release: v0\.1\.0') { Fail "the manifest version was not read:`n$($result.Output)" }

    # 2. An older release with only the MSI must fall back to it.
    Remove-Item (Join-Path $temp 'checksums.sha256') -Force
    New-Checksum 'Bentomux_0.1.0_x64_en-US.msi'
    $result = Invoke-Installer (New-Manifest 'msi-only.json')
    if ($result.ExitCode -ne 0) { Fail "MSI fallback failed:`n$($result.Output)" }
    if ($result.Output -notmatch '\(msi\)') { Fail "MSI was not used:`n$($result.Output)" }

    # 3. A release without a Windows package must be refused, not guessed.
    Remove-Item (Join-Path $temp 'checksums.sha256') -Force
    New-Checksum 'bentomux_0.1.0_amd64.deb'
    $result = Invoke-Installer (New-Manifest 'linux-only.json')
    if ($result.ExitCode -eq 0) { Fail 'a Linux-only release was accepted' }
    if ($result.Output -notmatch 'has no Windows build') { Fail "unexpected failure:`n$($result.Output)" }

    # 4. A malformed manifest must fail loudly instead of installing nonsense.
    $broken = Join-Path $temp 'broken.json'
    Set-Content -Path $broken -Value '{"schema_version":1}' -Encoding ascii
    $result = Invoke-Installer $broken
    if ($result.ExitCode -eq 0) { Fail 'a manifest without assets was accepted' }

    # 5. An arm64 host gets the x64 build under emulation instead of a refusal.
    #    The architecture comes from PROCESSOR_ARCHITECTURE, which PowerShell 5.1
    #    does report (RuntimeInformation.OSArchitecture does not always resolve).
    Remove-Item (Join-Path $temp 'checksums.sha256') -Force
    New-Checksum 'Bentomux_0.1.0_x64-setup.exe'
    $env:PROCESSOR_ARCHITECTURE = 'ARM64'
    $env:PROCESSOR_ARCHITEW6432 = $null
    $result = Invoke-Installer (New-Manifest 'arm64.json')
    if ($result.ExitCode -ne 0) { Fail "arm64 dry run failed:`n$($result.Output)" }
    if ($result.Output -notmatch 'emulation') { Fail "arm64 was not explained:`n$($result.Output)" }
    if ($result.Output -notmatch 'Bentomux_0\.1\.0_x64-setup\.exe') { Fail "arm64 skipped the x64 build:`n$($result.Output)" }

    Write-Host 'verify-installer.ps1: ok'
} finally {
    Remove-Item -Path $temp -Recurse -Force -ErrorAction SilentlyContinue
}
