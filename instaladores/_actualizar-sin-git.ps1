# ============================================================
#  Actualizar mcp-legal-ar SIN git - Windows
#  Lo lanza actualizar-sin-git.bat. Re-descarga el ZIP del repo,
#  lo copia encima de la carpeta, reinstala dependencias y avisa
#  de reiniciar Claude Desktop.
#
#  Copy-Item -Force sobrescribe lo del sistema pero NO borra lo que
#  no esta en el ZIP. La config de Claude Desktop vive aparte (en
#  AppData), asi que no se toca.
# ============================================================
$ErrorActionPreference = 'Stop'
$owner  = 'Probanza-ar'
$repo   = 'mcp-legal-ar'
$branch = 'main'

$dest = Split-Path -Parent $PSScriptRoot   # carpeta padre de \instaladores
$url  = "https://codeload.github.com/$owner/$repo/zip/refs/heads/$branch"
$zip  = Join-Path $env:TEMP 'mcar.zip'
$ext  = Join-Path $env:TEMP 'mcar_ext'

Write-Host "[1/3] Descargando la ultima version..." -ForegroundColor Yellow
Invoke-WebRequest -Uri $url -OutFile $zip
if (Test-Path $ext) { Remove-Item $ext -Recurse -Force }
Expand-Archive -Path $zip -DestinationPath $ext -Force
Copy-Item -Path (Join-Path $ext "$repo-$branch\*") -Destination $dest -Recurse -Force
Remove-Item $zip -Force
Remove-Item $ext -Recurse -Force

Write-Host "[2/3] Reinstalando dependencias..." -ForegroundColor Yellow
Push-Location $dest
try {
  npm install
  npm install --prefix servers\legal-mcp
} finally {
  Pop-Location
}

Write-Host "[3/3] Listo." -ForegroundColor Green
Write-Host ""
Write-Host "IMPORTANTE: reinicia Claude Desktop para que tome la version nueva." -ForegroundColor Cyan
Write-Host "Cerralo del todo (boton derecho en la bandeja, Salir) y volve a abrirlo."
