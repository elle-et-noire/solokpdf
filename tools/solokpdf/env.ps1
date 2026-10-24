param([ValidateSet('', 'v143', 'v145')][string]$Toolset = '')

$ErrorActionPreference = 'Stop'
$repoDir = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$vsDir = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (!$vsDir) { throw 'Visual Studio C++ tools were not found.' }
$bunDir = Join-Path $repoDir '.work\tools\bun-windows-x64'
$prettierBin = Join-Path $repoDir '.work\build-deps\node_modules\.bin'
$env:PATH = "$bunDir;$prettierBin;$vsDir\MSBuild\Current\Bin;$vsDir\VC\Tools\Llvm\x64\bin;" + $env:PATH
$env:NODE_PATH = Join-Path $repoDir '.work\build-deps\node_modules'
if ($Toolset) {
    $props = Join-Path $repoDir '.work\solok-toolset.props'
    New-Item -ItemType Directory -Force (Split-Path $props) | Out-Null
    Set-Content -LiteralPath $props -Value "<Project><PropertyGroup><PlatformToolset>$Toolset</PlatformToolset></PropertyGroup></Project>"
    $env:ForceImportBeforeCppProps = $props
}
Write-Host "VS: $vsDir; Bun: $(Get-Command bun -ErrorAction Stop | Select-Object -ExpandProperty Source)"
