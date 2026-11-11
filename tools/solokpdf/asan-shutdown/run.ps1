param([ValidateSet('asan', 'plain')][string]$Mode = 'asan')

$ErrorActionPreference = 'Stop'
if (!$env:SOLOKPDF_HIDDEN_DESKTOP) { throw 'Run through tools/solokpdf/run-hidden.ts' }
$repoDir = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$outDir = Join-Path $repoDir '.work\e38-repro'
New-Item -ItemType Directory -Force $outDir | Out-Null
$source = Join-Path $PSScriptRoot 'repro.cpp'
$dll = Join-Path $outDir 'repro.dll'
$exe = Join-Path $outDir "repro-$Mode.exe"

& cl /nologo /Zi /Od /MT /LD /DREPRO_DLL $source "/Fe:$dll" "/Fo:$outDir\dll.obj" "/Fd:$outDir\dll.pdb" /link "/IMPLIB:$outDir\repro.lib"
if ($LASTEXITCODE) { throw 'DLL build failed' }
$flags = if ($Mode -eq 'asan') { @('/fsanitize=address', '/DREPRO_ASAN') } else { @() }
if ($Mode -eq 'asan') {
    $runtime = Join-Path (Split-Path (Get-Command cl -ErrorAction Stop).Source) 'clang_rt.asan_dynamic-x86_64.dll'
    Copy-Item -LiteralPath $runtime -Destination $outDir -Force
}
& cl /nologo /Zi /Od /MT @flags $source "/Fe:$exe" "/Fo:$outDir\$Mode.obj" "/Fd:$outDir\$Mode.pdb"
if ($LASTEXITCODE) { throw 'EXE build failed' }

# The caller runs this script through run-hidden.ts, including both children.
foreach ($phase in @('unload', 'shutdown')) {
    $arguments = @($dll)
    if ($phase -eq 'unload') { $arguments += 'unload' }
    $output = & $exe @arguments 2>&1 | Out-String
    $exitCode = $LASTEXITCODE
    Write-Output "$Mode $phase exit=$exitCode $($output.Trim())"
    if ($exitCode -ne 0 -or $output -notmatch 'realloc=ok') {
        throw "$Mode $phase reallocation failed"
    }
}
