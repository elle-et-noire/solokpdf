param(
    [ValidateSet('asan', 'plain')][string]$Mode = 'asan',
    [string]$ToolsDir = ''
)

$ErrorActionPreference = 'Stop'
if (!$env:SOLOKPDF_HIDDEN_DESKTOP) { throw 'Run through tools/solokpdf/run-hidden.ts' }
$repoDir = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$compiler = (Get-Command cl -ErrorAction Stop).Source
if ($ToolsDir) {
    $ToolsDir = (Resolve-Path -LiteralPath $ToolsDir).Path
    $compiler = Join-Path $ToolsDir 'bin\Hostx64\x64\cl.exe'
    $env:PATH = "$(Split-Path $compiler);$env:PATH"
    $env:INCLUDE = "$ToolsDir\include;$env:INCLUDE"
    $env:LIB = "$ToolsDir\lib\x64;$env:LIB"
}
$version = (Get-Item -LiteralPath $compiler).VersionInfo.FileVersion
$outDir = Join-Path $repoDir ".work\e38-repro\$version"
New-Item -ItemType Directory -Force $outDir | Out-Null
$source = Join-Path $PSScriptRoot 'repro.cpp'
$dll = Join-Path $outDir 'repro.dll'
$exe = Join-Path $outDir "repro-$Mode.exe"

& $compiler /nologo /Zi /Od /MT /LD /DREPRO_DLL $source "/Fe:$dll" "/Fo:$outDir\dll.obj" "/Fd:$outDir\dll.pdb" /link "/IMPLIB:$outDir\repro.lib"
if ($LASTEXITCODE) { throw 'DLL build failed' }
$flags = if ($Mode -eq 'asan') { @('/fsanitize=address', '/DREPRO_ASAN') } else { @() }
if ($Mode -eq 'asan') {
    $runtime = Join-Path (Split-Path $compiler) 'clang_rt.asan_dynamic-x86_64.dll'
    Copy-Item -LiteralPath $runtime -Destination $outDir -Force
}
& $compiler /nologo /Zi /Od /MT @flags $source "/Fe:$exe" "/Fo:$outDir\$Mode.obj" "/Fd:$outDir\$Mode.pdb"
if ($LASTEXITCODE) { throw 'EXE build failed' }

# The caller runs this script through run-hidden.ts, including both children.
foreach ($phase in @('unload', 'shutdown')) {
    $arguments = @($dll)
    if ($phase -eq 'unload') { $arguments += 'unload' }
    $output = & $exe @arguments 2>&1 | Out-String
    $exitCode = $LASTEXITCODE
    Write-Output "$version $Mode $phase exit=$exitCode $($output.Trim())"
    if ($exitCode -ne 0 -or $output -notmatch 'realloc=ok data=ok' -or ($Mode -eq 'asan' -and $output -notmatch 'asan-owned=1')) {
        throw "$Mode $phase reallocation failed"
    }
}

if ($Mode -eq 'asan') {
    $output = & $exe overflow 2>&1 | Out-String
    $exitCode = $LASTEXITCODE
    Set-Content -LiteralPath (Join-Path $outDir 'overflow.txt') -Value $output
    if ($exitCode -eq 0 -or $output -notmatch 'AddressSanitizer: heap-buffer-overflow') {
        throw "ASan instrumentation check failed: exit=$exitCode $output"
    }
    Write-Output "$version ASan detected heap-buffer-overflow exit=$exitCode"
}
