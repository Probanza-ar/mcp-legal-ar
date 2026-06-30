#!/usr/bin/env bash
# ============================================================
#  Actualizar mcp-legal-ar SIN git - Mac y Linux
#
#  Para consumidores que bajaron el tarball y no usan git.
#  Re-descarga la ultima version, la extrae encima de la carpeta,
#  reinstala dependencias y avisa de reiniciar Claude Desktop.
#
#  Uso:  bash instaladores/actualizar-sin-git.sh
#  Requiere repo publico (no pide credenciales). Usa curl + tar.
# ============================================================
set -euo pipefail
OWNER="Probanza-ar"
REPO="mcp-legal-ar"
BRANCH="main"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "[1/3] Descargando la ultima version..."
# tar sobrescribe lo del sistema pero NO borra lo que no esta en el tarball.
# La config de Claude Desktop vive aparte, asi que no se toca.
curl -fsSL "https://codeload.github.com/$OWNER/$REPO/tar.gz/refs/heads/$BRANCH" \
  | tar -xz -C "$DEST" --strip-components=1

echo "[2/3] Reinstalando dependencias..."
cd "$DEST"
npm install
npm install --prefix servers/legal-mcp

echo "[3/3] Listo."
echo
echo "IMPORTANTE: reinicia Claude Desktop para que tome la version nueva."
echo "Cerralo del todo (en Mac, boton derecho en el Dock y Salir) y volve a abrirlo."
