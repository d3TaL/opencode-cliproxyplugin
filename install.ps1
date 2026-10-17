#Requires -Version 5.1
<#
.SYNOPSIS
Installs the local CLIProxyAPI plugin into OpenCode v1 on Windows.
.DESCRIPTION
Copies TypeScript sources and a single-export loader into the OpenCode config
directory. Does not edit opencode.json/jsonc or require Bun, npm, or admin rights.
Existing managed files are backed up before an update. API keys are saved only
when supplied or entered, in the current user's CPA_API_KEY environment variable.
.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
.EXAMPLE
.\install.ps1 -BaseUrl http://localhost:8317 -NonInteractive
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string] $SourcePath,
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
$pluginName = 'opencode-cliproxyapi'
$loaderMarker = '// Installed by install.ps1 (opencode-cliproxyapi).'
$utf8 = New-Object System.Text.UTF8Encoding($false)

function Assert-HttpUrl([string] $Value, [string] $Name) {
    $uri = $null
    if (-not [Uri]::TryCreate($Value, [UriKind]::Absolute, [ref] $uri) -or
        $uri.Scheme -notin @('http', 'https') -or -not $uri.Host -or
        $uri.UserInfo -or $uri.Fragment) {
        throw "$Name must be an absolute HTTP(S) URL without credentials or a fragment."
    }
    if ($Name -eq 'BaseUrl' -and $uri.Query) {
        throw 'BaseUrl must not contain a query string. Use ModelsUrl for a custom catalog URL.'
    }
}

function Get-DefaultModelsUrl([string] $Value) {
    $builder = New-Object UriBuilder($Value)
    $path = $builder.Path.TrimEnd('/')
    if (-not $path.EndsWith('/v1')) { $path += '/v1' }
    $builder.Path = "$path/models"
    $builder.Query = 'client_version=pi'
    return $builder.Uri.AbsoluteUri
}

function Write-Utf8([string] $Path, [string] $Content) {
    # Replace a complete file only after its contents have been written.
    $temporaryPath = "$Path.$([Guid]::NewGuid().ToString('N')).tmp"
    try {
        [IO.File]::WriteAllText($temporaryPath, $Content, $utf8)
        if ([IO.File]::Exists($Path)) {
            [IO.File]::Replace($temporaryPath, $Path, [NullString]::Value)
        } else {
            [IO.File]::Move($temporaryPath, $Path)
        }
    } finally {
        if ([IO.File]::Exists($temporaryPath)) {
            [IO.File]::Delete($temporaryPath)
        }
    }
}

if (-not $SourcePath) {
    $SourcePath = Join-Path $PSScriptRoot $pluginName
    if (-not (Test-Path -LiteralPath $SourcePath -PathType Container)) {
        $SourcePath = $PSScriptRoot
    }
}
$SourcePath = [IO.Path]::GetFullPath($SourcePath)
foreach ($relativePath in @('package.json', 'LICENSE', 'src/index.ts', 'src/catalog.ts')) {
    if (-not (Test-Path -LiteralPath (Join-Path $SourcePath $relativePath) -PathType Leaf)) {
        throw "Plugin source file not found: $(Join-Path $SourcePath $relativePath)"
    }
}
$package = Get-Content -LiteralPath (Join-Path $SourcePath 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($package.name -ne $pluginName) {
    throw "SourcePath must point to the $pluginName package."
}

$command = Get-Command -Name $OpenCodePath -CommandType Application, ExternalScript -ErrorAction Stop
$versionOutput = @(& $command.Source --version 2>&1)
if ($LASTEXITCODE -ne 0) {
    throw "OpenCode version check failed: $($versionOutput -join ' ')"
}
$versionMatch = [regex]::Match(($versionOutput -join "`n"), '(?m)^\s*v?(\d+)\.(\d+)\.(\d+)(?:[-+][\w.-]+)?\s*$')
if (-not $versionMatch.Success -or $versionMatch.Groups[1].Value -ne '1') {
    throw "This installer requires OpenCode v1. Found: $($versionOutput -join ' ')"
}
$openCodeVersion = $versionMatch.Value.Trim()

if (-not $ConfigDir) {
    if ($env:OPENCODE_CONFIG_DIR) {
        $ConfigDir = $env:OPENCODE_CONFIG_DIR
    } elseif ($env:XDG_CONFIG_HOME) {
        $ConfigDir = Join-Path $env:XDG_CONFIG_HOME 'opencode'
    } else {
        $ConfigDir = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.config/opencode'
    }
}
$ConfigDir = [IO.Path]::GetFullPath($ConfigDir)
$installDir = Join-Path $ConfigDir 'cliproxyapi'
$pluginsDir = Join-Path $ConfigDir 'plugins'
$loaderPath = Join-Path $pluginsDir "$pluginName.ts"
$optionsPath = Join-Path $installDir 'options.json'
$manifestPath = Join-Path $installDir 'installation.json'

if (Test-Path -LiteralPath $installDir) {
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        throw "Directory already exists and is not managed by this installer: $installDir"
    }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($manifest.name -ne $pluginName) {
        throw "Unrecognized installation manifest: $manifestPath"
    }
}
if (Test-Path -LiteralPath $loaderPath) {
    $existingLoader = Get-Content -LiteralPath $loaderPath -Raw -Encoding UTF8
    if (-not $existingLoader.StartsWith($loaderMarker)) {
        throw "Refusing to overwrite an unmanaged plugin loader: $loaderPath"
    }
}

$options = [ordered]@{}
if (Test-Path -LiteralPath $optionsPath -PathType Leaf) {
    $savedOptions = Get-Content -LiteralPath $optionsPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($null -eq $savedOptions -or $savedOptions -isnot [PSCustomObject]) {
        throw "Expected a JSON object in $optionsPath"
    }
    foreach ($property in $savedOptions.PSObject.Properties) {
        $options[$property.Name] = $property.Value
    }
}
$previousBaseUrl = $options['baseURL']
if ($PSBoundParameters.ContainsKey('BaseUrl')) {
    $options['baseURL'] = $BaseUrl
} elseif (-not $options.Contains('baseURL')) {
    $options['baseURL'] = if ($env:CLIPROXY_BASE_URL) { $env:CLIPROXY_BASE_URL } else { 'http://localhost:8317/v1' }
}
if (-not $NonInteractive -and -not $WhatIfPreference -and -not $PSBoundParameters.ContainsKey('BaseUrl')) {
    $answer = Read-Host "CLIProxyAPI API URL [$($options['baseURL'])]"
    if (-not [string]::IsNullOrWhiteSpace($answer)) { $options['baseURL'] = $answer.Trim() }
}
Assert-HttpUrl $options['baseURL'] 'BaseUrl'
if (-not $options.Contains('modelsURL') -or
    ($previousBaseUrl -and $previousBaseUrl -ne $options['baseURL'] -and
        $options['modelsURL'] -eq (Get-DefaultModelsUrl $previousBaseUrl))) {
    $options['modelsURL'] = Get-DefaultModelsUrl $options['baseURL']
}
if ($PSBoundParameters.ContainsKey('ModelsUrl')) { $options['modelsURL'] = $ModelsUrl }
if (-not $NonInteractive -and -not $WhatIfPreference -and -not $PSBoundParameters.ContainsKey('ModelsUrl')) {
    $answer = Read-Host "Model catalog URL [$($options['modelsURL'])]"
    if (-not [string]::IsNullOrWhiteSpace($answer)) { $options['modelsURL'] = $answer.Trim() }
}
if ($PSBoundParameters.ContainsKey('Protocol')) { $options['protocol'] = $Protocol }
if ($PSBoundParameters.ContainsKey('ProviderName')) { $options['providerName'] = $ProviderName }
Assert-HttpUrl $options['modelsURL'] 'ModelsUrl'

# Store implementation files outside plugins/: v1 loads every export in a plugin
# entrypoint, whereas index.ts also exports catalog utilities and a module object.
$loader = @'
// Installed by install.ps1 (opencode-cliproxyapi).
import { readFileSync } from "node:fs"
import { CLIProxyAPIPlugin } from "../cliproxyapi/src/index.ts"

const options = JSON.parse(
  readFileSync(new URL("../cliproxyapi/options.json", import.meta.url), "utf8"),
)

export default (input: Parameters<typeof CLIProxyAPIPlugin>[0]) =>
  CLIProxyAPIPlugin(input, options)
'@

foreach ($fileName in @('opencode.json', 'opencode.jsonc', 'config.json')) {
    $configPath = Join-Path $ConfigDir $fileName
    if ((Test-Path -LiteralPath $configPath -PathType Leaf) -and
        (Select-String -LiteralPath $configPath -SimpleMatch $pluginName -Quiet)) {
        Write-Warning "Found $pluginName in $configPath. Remove its old plugin entry to avoid loading two copies."
    }
}

if (-not $PSCmdlet.ShouldProcess($ConfigDir, "Install local $pluginName for OpenCode $openCodeVersion")) {
    return
}

$keyToSave = $ApiKey
if ($null -eq $keyToSave -and -not $NonInteractive -and
    -not $env:CPA_API_KEY -and -not $env:CLIPROXY_API_KEY -and
    -not [Environment]::GetEnvironmentVariable('CPA_API_KEY', 'User') -and
    -not [Environment]::GetEnvironmentVariable('CLIPROXY_API_KEY', 'User')) {
    $keyToSave = Read-Host 'CLIProxyAPI API key (hidden; Enter to configure later)' -AsSecureString
}

if ((Test-Path -LiteralPath $installDir) -or (Test-Path -LiteralPath $loaderPath)) {
    $backupDir = Join-Path $ConfigDir ('.cliproxyapi-backups/' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
    if (Test-Path -LiteralPath $installDir) {
        Copy-Item -LiteralPath $installDir -Destination (Join-Path $backupDir 'cliproxyapi') -Recurse
    }
    if (Test-Path -LiteralPath $loaderPath) {
        Copy-Item -LiteralPath $loaderPath -Destination (Join-Path $backupDir "$pluginName.ts")
    }
    Write-Host "Backup: $backupDir"
}

New-Item -ItemType Directory -Path (Join-Path $installDir 'src') -Force | Out-Null
New-Item -ItemType Directory -Path $pluginsDir -Force | Out-Null
foreach ($fileName in @('index.ts', 'catalog.ts')) {
    $source = Join-Path $SourcePath "src/$fileName"
    Write-Utf8 (Join-Path $installDir "src/$fileName") ([IO.File]::ReadAllText($source))
}
Write-Utf8 (Join-Path $installDir 'LICENSE') ([IO.File]::ReadAllText((Join-Path $SourcePath 'LICENSE')))
Write-Utf8 $optionsPath (($options | ConvertTo-Json -Depth 100) + "`n")
Write-Utf8 $manifestPath (([ordered]@{
    name = $pluginName
    version = $package.version
    openCodeVersion = $openCodeVersion
    installedAt = [DateTime]::UtcNow.ToString('o')
} | ConvertTo-Json) + "`n")
Write-Utf8 $loaderPath ($loader + "`n")

if ($null -ne $keyToSave -and $keyToSave.Length -gt 0) {
    $keyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($keyToSave)
    try {
        $plainKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPointer)
        [Environment]::SetEnvironmentVariable('CPA_API_KEY', $plainKey, 'User')
        $env:CPA_API_KEY = $plainKey
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPointer)
        $plainKey = $null
    }
    Write-Host 'CPA_API_KEY saved in the current user environment.'
}

Write-Host "Installed $pluginName $($package.version) for OpenCode $openCodeVersion."
Write-Host "Connection settings: $optionsPath"
if (-not $env:CPA_API_KEY -and -not $env:CLIPROXY_API_KEY -and
    -not [Environment]::GetEnvironmentVariable('CPA_API_KEY', 'User') -and
    -not [Environment]::GetEnvironmentVariable('CLIPROXY_API_KEY', 'User')) {
    Write-Warning 'No API key is configured. Set CPA_API_KEY before starting OpenCode if your server requires authentication.'
}
Write-Host 'Restart OpenCode and your terminal, then run: opencode models cliproxyapi'
if ([Environment]::GetEnvironmentVariable('CPA_API_KEY', 'User')) {
    Write-Host 'To refresh the saved key in an already open PowerShell terminal, run:'
    Write-Host '$env:CPA_API_KEY = [Environment]::GetEnvironmentVariable("CPA_API_KEY", "User")'
}
Write-Host 'Run that command from your working project, outside the plugin source directory.'
Write-Host 'If ConfigDir is a custom location, start OpenCode with OPENCODE_CONFIG_DIR set to that directory.'
