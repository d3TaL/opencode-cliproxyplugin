#Requires -Version 5.1
<#
.SYNOPSIS
Downloads and installs CLIProxyAPI for OpenCode v1 from a public GitHub repository.
.EXAMPLE
.\install-online.ps1 -Repository owner/repository
.EXAMPLE
.\install-online.ps1 -Repository owner/repository -Ref v1.0.0 -NonInteractive
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9][A-Za-z0-9_.-]*$')]
    [string] $Repository,
    [ValidateNotNullOrEmpty()]
    [string] $Ref = 'main',
    [string] $ConfigDir,
    [string] $BaseUrl,
    [string] $ModelsUrl,
    [ValidateSet('chat', 'responses')]
    [string] $Protocol,
    [string] $ProviderName,
    [Security.SecureString] $ApiKey,
    [string] $OpenCodePath = 'opencode',
    [switch] $NonInteractive
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$encodedRef = [Uri]::EscapeDataString($Ref)
$downloadBase = "https://raw.githubusercontent.com/$Repository/$encodedRef"
if (-not $PSCmdlet.ShouldProcess("$Repository ($Ref)", 'Download installer and plugin, then install for the current user')) {
    return
}

$temporaryDir = Join-Path ([IO.Path]::GetTempPath()) ('cliproxyapi-download-' + [Guid]::NewGuid().ToString('N'))
$originalTls = [Net.ServicePointManager]::SecurityProtocol
try {
    [Net.ServicePointManager]::SecurityProtocol = $originalTls -bor [Net.SecurityProtocolType]::Tls12
    New-Item -ItemType Directory -Path $temporaryDir | Out-Null
    $files = @(
        'install.ps1'
        'opencode-cliproxyapi/package.json'
        'opencode-cliproxyapi/LICENSE'
        'opencode-cliproxyapi/src/index.ts'
        'opencode-cliproxyapi/src/catalog.ts'
    )
    foreach ($relativePath in $files) {
        $destination = Join-Path $temporaryDir $relativePath
        New-Item -ItemType Directory -Path (Split-Path $destination -Parent) -Force | Out-Null
        Write-Host "Downloading $relativePath"
        Invoke-WebRequest -Uri "$downloadBase/$relativePath" -OutFile $destination -UseBasicParsing -TimeoutSec 60 -ErrorAction Stop
        if (-not (Test-Path -LiteralPath $destination -PathType Leaf) -or
            (Get-Item -LiteralPath $destination).Length -eq 0) {
            throw "Downloaded file is missing or empty: $relativePath"
        }
    }

    $installArguments = @{}
    foreach ($name in @('ConfigDir', 'BaseUrl', 'ModelsUrl', 'Protocol', 'ProviderName', 'ApiKey', 'OpenCodePath', 'NonInteractive')) {
        if ($PSBoundParameters.ContainsKey($name)) { $installArguments[$name] = $PSBoundParameters[$name] }
    }
    $installArguments['SourcePath'] = Join-Path $temporaryDir 'opencode-cliproxyapi'
    & (Join-Path $temporaryDir 'install.ps1') @installArguments
} finally {
    [Net.ServicePointManager]::SecurityProtocol = $originalTls
    # Only remove the unique directory created by this invocation.
    $resolvedDir = [IO.Path]::GetFullPath($temporaryDir)
    $tempPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if ($resolvedDir.StartsWith($tempPrefix, [StringComparison]::OrdinalIgnoreCase) -and
        [IO.Path]::GetFileName($resolvedDir).StartsWith('cliproxyapi-download-') -and
        (Test-Path -LiteralPath $resolvedDir)) {
        Remove-Item -LiteralPath $resolvedDir -Recurse -Force
    }
}
