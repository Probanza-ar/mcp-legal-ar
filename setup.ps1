# setup.ps1 - mcp-legal-ar installer para Windows
# Ejecutar desde la carpeta donde extrajiste el ZIP: clic derecho > "Ejecutar con PowerShell"

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "   mcp-legal-ar - Instalacion automatica" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# -------------------------------------------------------
# 1. Verificar Node.js
# -------------------------------------------------------
Write-Host "Verificando Node.js..." -ForegroundColor Yellow

$nodeExe = $null
$nodePaths = @(
    "C:\Program Files\nodejs\node.exe",
    "C:\Program Files (x86)\nodejs\node.exe"
)
foreach ($p in $nodePaths) {
    if (Test-Path $p) { $nodeExe = $p; break }
}
if (-not $nodeExe) {
    try {
        $nodeExe = (Get-Command node -ErrorAction Stop).Source
    } catch {
        Write-Host ""
        Write-Host "[ERROR] Node.js no esta instalado." -ForegroundColor Red
        Write-Host ""
        Write-Host "Por favor seguí estos pasos:" -ForegroundColor Yellow
        Write-Host "  1. Abrí el navegador y andá a: https://nodejs.org" -ForegroundColor White
        Write-Host "  2. Hacé clic en el boton verde 'Download Node.js (LTS)'" -ForegroundColor White
        Write-Host "  3. Instalá el programa descargado (siguiente, siguiente, instalar)" -ForegroundColor White
        Write-Host "  4. Reiniciá la computadora" -ForegroundColor White
        Write-Host "  5. Volvé a ejecutar este script" -ForegroundColor White
        Write-Host ""
        Read-Host "Presioná Enter para cerrar"
        exit 1
    }
}

$nodeVersion = & $nodeExe --version 2>&1
$major = ($nodeVersion -replace "v","").Split(".")[0]
if ([int]$major -lt 18) {
    Write-Host ""
    Write-Host "[ERROR] Node.js instalado ($nodeVersion) es muy antiguo. Se necesita la version 18 o superior." -ForegroundColor Red
    Write-Host ""
    Write-Host "Por favor:" -ForegroundColor Yellow
    Write-Host "  1. Andá a https://nodejs.org y descargá la version LTS actual" -ForegroundColor White
    Write-Host "  2. Instalá sobre la version existente" -ForegroundColor White
    Write-Host "  3. Reiniciá la computadora y volvé a ejecutar este script" -ForegroundColor White
    Write-Host ""
    Read-Host "Presioná Enter para cerrar"
    exit 1
}
Write-Host "[OK] Node.js $nodeVersion encontrado." -ForegroundColor Green

# -------------------------------------------------------
# 2. Detectar ubicacion del repo (donde esta este script)
# -------------------------------------------------------
$repoPath = $PSScriptRoot
$entryPoint = Join-Path $repoPath "build\index.js"

Write-Host "[OK] Repositorio encontrado en: $repoPath" -ForegroundColor Green

if (-not (Test-Path $entryPoint)) {
    Write-Host ""
    Write-Host "[ERROR] No se encontro el archivo principal del hub." -ForegroundColor Red
    Write-Host "        Archivo esperado: $entryPoint" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "Asegurate de haber extraido el ZIP completo sin mover ni borrar carpetas." -ForegroundColor Yellow
    Write-Host ""
    Read-Host "Presioná Enter para cerrar"
    exit 1
}

# -------------------------------------------------------
# 3. Instalar dependencias (npm install en ambos paquetes)
# -------------------------------------------------------
Write-Host ""
Write-Host "Instalando dependencias (puede tardar unos minutos)..." -ForegroundColor Yellow

# Root del hub
Push-Location $repoPath
try {
    Write-Host "  > npm install (hub raiz)..." -ForegroundColor Gray
    $env:PUPPETEER_SKIP_DOWNLOAD = "true"
    & $nodeExe (Join-Path (Split-Path $nodeExe) "node_modules\npm\bin\npm-cli.js") install --prefer-offline 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        npm install --prefer-offline 2>&1 | Out-Null
    }
} finally {
    Pop-Location
}

# legal-mcp
$legalMcpPath = Join-Path $repoPath "servers\legal-mcp"
Push-Location $legalMcpPath
try {
    Write-Host "  > npm install (legal-mcp)..." -ForegroundColor Gray
    $env:PUPPETEER_SKIP_DOWNLOAD = "true"
    npm install --prefer-offline 2>&1 | Out-Null
} finally {
    Pop-Location
}

Write-Host "[OK] Dependencias instaladas." -ForegroundColor Green

# -------------------------------------------------------
# 4. Leer / crear claude_desktop_config.json
# -------------------------------------------------------
Write-Host ""
Write-Host "Configurando Claude Desktop..." -ForegroundColor Yellow

$roamingClaude = Join-Path $env:APPDATA "Claude"

$configPath = $null
$candidates = @(
    # Instalacion clasica
    (Join-Path $env:APPDATA "Claude\claude_desktop_config.json"),
    # Instalacion Microsoft Store - buscar dinamicamente sin hardcodear el package name
    (Get-ChildItem "$env:LOCALAPPDATA\Packages" -Filter "Claude_*" -ErrorAction SilentlyContinue |
        Select-Object -First 1 |
        ForEach-Object { Join-Path $_.FullName "LocalCache\Roaming\Claude\claude_desktop_config.json" })
) | Where-Object { $_ }

foreach ($c in $candidates) {
    try {
        $dir = Split-Path $c
        if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        $testFile = Join-Path $dir ".setup-test"
        [System.IO.File]::WriteAllText($testFile, "test")
        Remove-Item $testFile -Force
        $configPath = $c
        Write-Host "[OK] Ruta de Claude Desktop: $dir" -ForegroundColor Green
        break
    } catch { continue }
}

if (-not $configPath) {
    $configPath = $candidates[0]
    $dir = Split-Path $configPath
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    Write-Host "[AVISO] Usando ruta por defecto: $dir" -ForegroundColor Yellow
}

$config = $null
if (Test-Path $configPath) {
    try {
        $raw = [System.IO.File]::ReadAllText($configPath)
        $config = $raw | ConvertFrom-Json
        Write-Host "[INFO] Config existente encontrado. Mergeando..." -ForegroundColor Cyan
    } catch {
        Write-Host "[AVISO] El config existente tiene errores de formato. Se creara uno nuevo." -ForegroundColor Yellow
        $config = [PSCustomObject]@{}
    }
} else {
    Write-Host "[INFO] No habia config previo. Creando uno nuevo." -ForegroundColor Cyan
    $config = [PSCustomObject]@{}
}

if (-not $config.PSObject.Properties["mcpServers"]) {
    $config | Add-Member -NotePropertyName "mcpServers" -NotePropertyValue ([PSCustomObject]@{})
}

$hubEntry = [PSCustomObject]@{
    command = $nodeExe
    args    = @($entryPoint)
    env     = [PSCustomObject]@{
        NODE_TLS_REJECT_UNAUTHORIZED = "0"
    }
}
$config.mcpServers | Add-Member -NotePropertyName "mcp-legal-ar" -NotePropertyValue $hubEntry -Force

$json = $config | ConvertTo-Json -Depth 10
[System.IO.File]::WriteAllText($configPath, $json, [System.Text.Encoding]::UTF8)

Write-Host "[OK] Claude Desktop configurado." -ForegroundColor Green
Write-Host "     Archivo: $configPath" -ForegroundColor Gray

# -------------------------------------------------------
# 5. Resumen final
# -------------------------------------------------------
Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "   Instalacion completada con exito!    " -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host ""
Write-Host "Proximo paso:" -ForegroundColor Yellow
Write-Host "  Cerrá Claude Desktop completamente (clic derecho en el icono de la" -ForegroundColor White
Write-Host "  bandeja del sistema, esquina inferior derecha, y seleccioná Salir)." -ForegroundColor White
Write-Host "  Volvé a abrirlo. El conector mcp-legal-ar aparecera con las herramientas disponibles." -ForegroundColor White
Write-Host ""
Read-Host "Presioná Enter para cerrar"
