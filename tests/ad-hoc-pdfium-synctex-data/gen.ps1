Push-Location $PSScriptRoot
try {
    pdflatex -interaction=nonstopmode -halt-on-error -synctex=1 main.tex
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    Remove-Item main.aux, main.log
} finally {
    Pop-Location
}
