# mcp-legal-ar

14 conectores jurídicos argentinos integrados en uno solo. Sin servidores externos de terceros. 100% local. Código abierto y auditable.

---

## ¿Qué es esto y para qué sirve?

Claude Desktop puede conectarse a bases de datos externas a través de conectores llamados MCP. Este repositorio instala un único conector que le da acceso simultáneo a las principales fuentes jurídicas argentinas:

- **JUBA** - Jurisprudencia de la Suprema Corte de Buenos Aires y cámaras departamentales de la Provincia, con búsqueda por texto libre, tribunal, carátula y período.
- **SCBA** - Sentencias y resoluciones completas de la Suprema Corte de Buenos Aires, acceso directo al texto del fallo.
- **CSJN** - Sumarios de jurisprudencia de la Corte Suprema de Justicia de la Nación (Secretaría de Jurisprudencia, 1863-2026), con búsqueda por texto libre, carátula, fecha y tomo de Fallos, análisis documental del fallo y enlace al PDF.
- **SAIJ** - Sistema Argentino de Información Jurídica del Ministerio de Justicia de la Nación: más de 330.000 documentos entre jurisprudencia federal, nacional y provincial, legislación, doctrina y dictámenes.
- **PJN Jurisprudencia** - Sumarios de fallos de cámaras nacionales y federales del sistema del Consejo de la Magistratura (sj.pjn.gov.ar), con filtros por materia, sala y período.
- **BORA** - Boletín Oficial de la República Argentina: normas nacionales, actos administrativos, edictos y avisos oficiales publicados desde 1938.
- **BOPBA** - Boletín Oficial de la Provincia de Buenos Aires: legislación y actos administrativos provinciales.
- **InfoLEG** - Base normativa del Ministerio de Justicia de la Nación con el texto actualizado de leyes nacionales, decretos y resoluciones, incluyendo histórico de modificaciones.
- **Normativa PBA** - Legislación de la Provincia de Buenos Aires: leyes, decretos y resoluciones provinciales con texto vigente.
- **PTN** - Dictámenes de la Procuración del Tesoro de la Nación, fuente principal de doctrina en derecho administrativo federal.
- **TFN** - Jurisprudencia del Tribunal Fiscal de la Nación en materia impositiva y aduanera.
- **PJN Consulta** - Estado procesal de expedientes ante el fuero federal, con búsqueda por parte demandada vía sesión de navegador (captcha resuelto por el usuario).
- **Portal PJN** - Feed de novedades del abogado logueado (despachos y cédulas de todas sus causas) y descarga del PDF de cada evento, vía API del Poder Judicial de la Nación. Requiere login del usuario (sesión HITL por SSO).
- **JusCABA** - Expediente Judicial Electrónico (EJE) de la Justicia de la Ciudad de Buenos Aires: consulta de causas por parte, número o CUIJ, con encabezado, ficha, partes, actuaciones, verificación de sentencia y descarga de PDF. Acceso público, sin login ni captcha.

Sin este hub, cada fuente requeriría instalar y configurar un conector por separado. Con este hub, se instala uno solo y las 14 fuentes quedan disponibles al mismo tiempo.

Este repositorio no crea ninguna fuente nueva. Unifica conectores desarrollados por la comunidad argentina de legal tech; el mérito de cada uno corresponde a sus autores originales.

---

## Arquitectura

`mcp-legal-ar` es un servidor proxy MCP. Al iniciarse, levanta cada conector como proceso hijo, registra todas sus herramientas y las expone como un único servidor. Claude Desktop ve un solo conector con todas las herramientas disponibles.

```
Claude Desktop
     └── mcp-legal-ar (proxy)
           ├── bora__*         → proceso hijo Node
           ├── bopba__*        → proceso hijo Node
           ├── infoleg__*      → proceso hijo Node
           ├── normativapba__* → proceso hijo Node
           ├── juba__*         → proceso hijo Node
           ├── ptn__*          → proceso hijo Node
           ├── tfn__*          → proceso hijo Node
           ├── scba__*         → proceso hijo Node
           ├── saij__*         → proceso hijo Node
           ├── pjn__*          → proceso hijo Node (búsqueda dentro del navegador HITL)
           ├── pjnjuris__*     → proceso hijo Node (API REST + captcha HITL)
           ├── portalpjn__*    → proceso hijo Node (feed de novedades, HITL + SSO)
           ├── juscaba__*      → proceso hijo Node (API REST pública del EJE CABA)
           └── csjn__*         → proceso hijo Node (sumarios CSJN, fetch directo con sesión)
```

---

## Seguridad y privacidad

**Transporte local (stdio).** El hub se comunica con Claude Desktop directamente en tu máquina, sin pasar por ningún servidor intermediario. Las consultas no salen hacia infraestructura de terceros.

**Solo lectura.** El hub no escribe archivos, no ejecuta comandos y no actúa sobre ningún endpoint. No registra consultas ni las envía a ningún destino externo.

**CAPTCHA resuelto por vos, no por el agente.** El portal del Poder Judicial de la Nación (PJN) está protegido por un captcha propio (captcha.pjn.gov.ar). El diseño es human-in-the-loop: `iniciar_hitl_browser` abre una ventana de navegador real y todas las consultas corren dentro de esa sesión; cuando el portal pide el captcha, lo completás **vos** a mano y la consulta continúa. El hub no intenta resolverlo ni evadirlo automáticamente: no hay OCR ni técnicas de bypass.

**Auditable.** El código fuente completo está en GitHub. Cualquier abogado o profesional de seguridad puede verificar exactamente qué hace cada conector antes de instalarlo.

**Certificados TLS:** cada conector usa validación TLS estándar. La única excepción es SCBA (`sentencias.scba.gov.ar`), cuyo servidor oficial presenta un certificado con cadena de confianza incompleta. Para ese conector la verificación está desactivada de forma aislada dentro de su propio cliente HTTP, sin afectar al resto del stack. El tráfico involucrado es exclusivamente de lectura de jurisprudencia pública, sin credenciales ni datos del usuario.

**Control profesional del output.** El hub acerca fuentes jurídicas argentinas auditables, pero no reemplaza la revisión del abogado. Para flujos de informe diario, PDF a Markdown, anonimización y resumen estructurado, ver la guía de [flujos de accesibilidad y verificación profesional](docs/flujos-accesibilidad-verificacion.md).

---

## Requisitos

Antes de instalar, necesitás tener en tu computadora:

1. **Claude Desktop** - Descargar desde [claude.ai/download](https://claude.ai/download)
2. **Node.js** - Descargar desde [nodejs.org](https://nodejs.org) (elegir la versión LTS)

Para verificar si Node.js ya está instalado, abrir el símbolo del sistema (CMD en Windows, Terminal en Mac/Linux) y ejecutar:

```
node --version
```

Si aparece un número de versión (por ejemplo `v20.11.0`), ya está instalado.

---

## Instalación (opción recomendada - automática)

1. Hacer clic en el botón verde **Code** arriba a la derecha y seleccionar **Download ZIP**
2. Extraer el ZIP en cualquier carpeta. GitHub crea una carpeta `mcp-legal-ar-main` al extraerlo - podés dejarla así o renombrarla
3. Ejecutar el script de instalación según tu sistema operativo:

**Windows:** hacer clic derecho en `setup.ps1` y seleccionar **"Ejecutar con PowerShell"**

**Mac / Linux:** abrir la Terminal, navegar a la carpeta extraída y ejecutar:

```bash
bash setup.sh
```

El script detecta automáticamente la ubicación del repositorio y configura Claude Desktop.

---

## Instalación manual (paso a paso)

### Paso 1 - Descargar el repositorio

Hacer clic en el botón verde **Code** arriba a la derecha y seleccionar **Download ZIP**. Extraer el ZIP en una carpeta. GitHub descarga el ZIP con el nombre `mcp-legal-ar-main.zip` y crea una carpeta `mcp-legal-ar-main` al extraerlo - renombrala a `mcp-legal-ar` o al nombre que prefieras. En los pasos siguientes usamos `C:\mcp-legal-ar` (Windows) o `~/mcp-legal-ar` (Mac/Linux) como ejemplo; reemplazálo por la ruta real donde extrajiste el ZIP.

### Paso 2 - Instalar dependencias

**Windows** - Abrir CMD y ejecutar:

```
cd C:\mcp-legal-ar
npm install
npm install --prefix servers\legal-mcp
```

**Mac / Linux** - Abrir Terminal y ejecutar:

```bash
cd ~/mcp-legal-ar
npm install
npm install --prefix servers/legal-mcp
```

### Paso 3 - Configurar Claude Desktop

Abrir el archivo de configuración de Claude Desktop. La ruta depende del sistema operativo y de cómo instalaste Claude:

**Windows - Instalación clásica:**
```
C:\Users\TU_USUARIO\AppData\Roaming\Claude\claude_desktop_config.json
```

**Windows - Instalación Microsoft Store:**

Abrí PowerShell y ejecutá:
```
Get-ChildItem "$env:LOCALAPPDATA\Packages" -Filter "Claude_*" | Select-Object FullName
```
Eso te muestra la carpeta exacta. El config está en `LocalCache\Roaming\Claude\claude_desktop_config.json` dentro de esa carpeta.

Si no sabés cuál es la tuya, abrí el Explorador de archivos, pegá `%APPDATA%\Claude` en la barra de dirección y presioná Enter. Si abre una carpeta, es la instalación clásica. Si da error, es la instalación Microsoft Store.

**Mac:**
```
~/Library/Application Support/Claude/claude_desktop_config.json
```

**Linux:**
```
~/.config/Claude/claude_desktop_config.json
```

Reemplazar `TU_USUARIO` (Windows) con el nombre de usuario real. Abrir el archivo con cualquier editor de texto y agregar dentro de `"mcpServers"`:

**Windows:**
```json
"mcp-legal-ar": {
  "command": "node",
  "args": ["C:\\mcp-legal-ar\\build\\index.js"]
}
```

**Mac / Linux:**
```json
"mcp-legal-ar": {
  "command": "node",
  "args": ["/Users/TU_USUARIO/mcp-legal-ar/build/index.js"]
}
```

El archivo completo debería quedar así (ejemplo Windows):

```json
{
  "mcpServers": {
    "mcp-legal-ar": {
      "command": "node",
      "args": ["C:\\mcp-legal-ar\\build\\index.js"]
    }
  }
}
```

> **Windows:** usar doble barra invertida `\\` en todas las rutas del JSON. **Mac/Linux:** usar barra simple `/`. La carpeta puede llamarse como quieras; lo que importa es que la ruta en `args` apunte al `build/index.js` de donde extrajiste el repositorio.

### Paso 4 - Reiniciar Claude Desktop

**Windows:** hacer clic derecho en el ícono de la bandeja del sistema (esquina inferior derecha) y seleccionar **Salir**. Volver a abrir Claude Desktop.

**Mac:** hacer clic derecho en el ícono del Dock y seleccionar **Salir**. Volver a abrir Claude Desktop.

El conector `mcp-legal-ar` debería aparecer en la lista de herramientas disponibles.

---

## Actualización

Si ya tenías una versión anterior instalada, no hace falta desinstalar nada. El proceso es el mismo que la instalación inicial: reemplaza los archivos y regenera la configuración.

### Opción A - Con Git instalado (recomendada)

Lo más simple: doble clic en `instaladores/actualizar.bat` (Windows) o `bash instaladores/actualizar.sh` (Mac/Linux). Hace los tres pasos de abajo solo y te recuerda reiniciar Claude Desktop.

Si preferís a mano, abrir CMD o Terminal en la carpeta del repositorio y ejecutar:

```
git pull
npm install
npm install --prefix servers/legal-mcp
```

Luego reiniciar Claude Desktop desde la bandeja del sistema.

### Opción B - Sin Git (descarga manual)

Lo más simple: doble clic en `instaladores/actualizar-sin-git.bat` (Windows) o `bash instaladores/actualizar-sin-git.sh` (Mac/Linux). Re-descarga la última versión, reinstala dependencias y te recuerda reiniciar. Si preferís hacerlo paso a paso:

1. Descargar el ZIP desde el botón verde **Code → Download ZIP**
2. Extraer el ZIP sobreescribiendo la carpeta existente (o borrar la carpeta anterior y extraer de cero en el mismo lugar)
3. Ejecutar el script de instalación según tu sistema:

**Windows:** clic derecho en `setup.ps1` → **"Ejecutar con PowerShell"**

**Mac / Linux:**
```bash
bash setup.sh
```

El script reinstala las dependencias y actualiza la configuración de Claude Desktop. Reiniciar Claude Desktop al terminar.

> **Nota:** si en Windows el doble clic sobre `setup.ps1` abre el Bloc de notas en lugar de ejecutarlo, usá siempre clic derecho → "Ejecutar con PowerShell". Si PowerShell bloquea la ejecución por política, abrir PowerShell como administrador y ejecutar primero: `Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser`

---

## Solución de problemas

**El conector no aparece en Claude Desktop**

Verificar que el archivo `claude_desktop_config.json` tenga el formato correcto (sin comas de más ni llaves faltantes). Cerrar Claude Desktop completamente desde la bandeja del sistema antes de reiniciarlo.

**Error al ejecutar `npm install`**

Verificar que Node.js esté instalado correctamente ejecutando `node --version` en CMD (Windows) o Terminal (Mac/Linux). Si da error, reinstalar Node.js desde [nodejs.org](https://nodejs.org).

**Algún conector aparece como desconectado**

Algunos conectores dependen de que las webs oficiales estén disponibles. Si una fuente está caída, el resto sigue funcionando normalmente.

---

## Flujos de uso profesional

Además de las consultas directas desde Claude Desktop, el hub puede integrarse en flujos locales de trabajo. Dos casos frecuentes:

- informe diario de causas con fuentes y fecha de consulta visibles;
- PDF local a Markdown, anonimización y resumen estructurado revisable.

La guía completa está en [`docs/flujos-accesibilidad-verificacion.md`](docs/flujos-accesibilidad-verificacion.md). Incluye controles de omisiones, estados de confianza (`VERIFICADO`, `INFERIDO`, `NO VERIFICADO`, `CONFLICTO`, `URGENTE`) y plantillas en:

- [`templates/informe-diario-causas.md`](templates/informe-diario-causas.md)
- [`templates/resumen-pdf-anonimizado.md`](templates/resumen-pdf-anonimizado.md)

---

## Fuentes disponibles

### ✅ Operativos

| # | Nombre | Descripción | Herramientas | Crédito |
|---|--------|-------------|--------------|---------|
| 1 | **BORA** | Boletín Oficial de la República Argentina | 14 | [voftec/bora-mcp](https://github.com/voftec/bora-mcp) |
| 2 | **BOPBA** | Boletín Oficial de la Provincia de Buenos Aires | 15 | [voftec/bopba-mcp](https://github.com/voftec/bopba-mcp) |
| 3 | **InfoLeg** | Legislación nacional | 21 | [voftec/InfoLeg-MCP](https://github.com/voftec/InfoLeg-MCP) |
| 4 | **Normativa PBA** | Legislación provincial de Buenos Aires | 9 | [voftec/normativapba-mcp](https://github.com/voftec/normativapba-mcp) |
| 5 | **JUBA** | Jurisprudencia SCBA y cámaras PBA | 21 | [voftec/juba-mcp](https://github.com/voftec/juba-mcp) |
| 6 | **PTN** | Dictámenes de la Procuración del Tesoro | 22 | [voftec/ptn-mcp](https://github.com/voftec/ptn-mcp) |
| 7 | **TFN** | Tribunal Fiscal de la Nación | 15 | [voftec/tfn-mcp](https://github.com/voftec/tfn-mcp) |
| 8 | **SCBA** | Sentencias y resoluciones de la Suprema Corte de Buenos Aires | 4 | [FacundoEmanuel/scba-mcp-server](https://github.com/FacundoEmanuel/scba-mcp-server) |
| 9 | **PJN Consulta** | Estado procesal de expedientes federales (reescrito 10/6/26: las consultas corren dentro del navegador HITL; captcha resuelto por el usuario; por parte solo DEMANDADO, límite del portal público) | 22 | reescritura propia (estructura original: [voftec](https://github.com/voftec)) |
| 10 | **SAIJ** | Sistema Argentino de Información Jurídica (jurisprudencia, legislación, doctrina y dictámenes; 330.000+ documentos) | 12 | [Joaquin Escalante](https://github.com/) (reparado 10/6/26: el término de búsqueda va en `r`, no en `s`) |
| 11 | **PJN Jurisprudencia** | Sumarios de fallos de cámaras nacionales y federales (Sistema de Jurisprudencia del Consejo de la Magistratura, sj.pjn.gov.ar) | 26 | reescritura propia 10/6/26 (API REST + captcha inyectado vía HITL) |
| 12 | **Portal PJN** | Feed de novedades del abogado logueado (despachos D y cédulas N de todas sus causas) + descarga del PDF de cada evento, vía API REST de api.pjn.gov.ar. Login siempre del usuario (HITL, SSO). No presenta escritos por diseño. Ver `docs/portalpjn-api.md` | 7 | desarrollo propio 11/6/26 (API capturada en vivo) |
| 13 | **JusCABA** | Expediente Judicial Electrónico (EJE) de la Justicia de la Ciudad de Buenos Aires: consulta de causas por parte/número/CUIJ, encabezado, ficha, fuero, partes, actuaciones, verificación de sentencia y descarga de PDF. Acceso público sin login ni captcha | 12 | desarrollo propio 22/6/26 (API del EJE capturada por reconocimiento) |
| 14 | **CSJN** | Sumarios de jurisprudencia de la Corte Suprema de Justicia de la Nación (Secretaría de Jurisprudencia, 1863-2026): búsqueda por texto/carátula/fecha/tomo de Fallos, análisis documental del fallo (competencia, recurso, sentido, remisión, voces, normas, ministros) y enlace al PDF. Acceso público sin login | 3 | desarrollo propio 24/6/26 (API de sjconsulta.csjn.gov.ar capturada por reconocimiento) |

---

## Repo: actualización y reportes de tests

- Los reportes de tests y auditorías NO se versionan: viven en la carpeta
  hermana `..\mcp-legal-ar test` y están en `.gitignore`
  (`REPORTE_*.md`, `RESUMEN_*.md`, `AUDITORIA_*.md`, `RETEST_*.md`, `_capturas/`).
- Para actualizar el repo con las mejoras: doble click en `actualizar-repo.bat`
  (mueve reportes sueltos a la carpeta de tests, commitea todo con fecha y pushea).
- Para que corra solo (semanal, viernes 18:00), ejecutar una vez en CMD:

```
schtasks /create /tn "mcp-legal-ar actualizar repo" /tr "\"C:\Users\Ximena\mcp-legal-ar\actualizar-repo.bat\"" /sc weekly /d FRI /st 18:00
```

---

## Créditos

La mayoría de los conectores son servidores MCP de terceros; el mérito de cada uno corresponde a sus autores originales:

- BORA, BOPBA, InfoLeg, Normativa PBA, JUBA, PTN, TFN, PJN Consulta, PJN Jurisprudencia - [Voftec](https://github.com/voftec) *(repositorios originales bajo licencia MIT; ya no disponibles públicamente — ver nota de licencias abajo)*
- SCBA MCP Server - [FacundoEmanuel](https://github.com/FacundoEmanuel)
- Portal PJN, JusCABA y CSJN - desarrollo propio de [@abogadoaboitiz](https://x.com/abogadoaboitiz), sin derivar de código de terceros: Portal PJN sobre la API REST de api.pjn.gov.ar; JusCABA sobre la API pública del EJE (eje.juscaba.gob.ar); CSJN sobre la API de la Secretaría de Jurisprudencia (sjconsulta.csjn.gov.ar). Las reescrituras de PJN Consulta y PJN Jurisprudencia, sobre la estructura original de Voftec, también son propias.

Ensamblado por [@abogadoaboitiz](https://x.com/abogadoaboitiz)

---

## Licencias

Este repositorio combina código bajo dos licencias:

- **El hub/proxy** (`servers/legal-mcp/build/index.js` y scripts de ensamblado): Apache 2.0.
- **Los conectores de Voftec** (BORA, BOPBA, InfoLeg, Normativa PBA, JUBA, PTN, TFN, PJN): publicados originalmente bajo licencia **MIT**.

Los repositorios originales de Voftec ya no están disponibles públicamente. La licencia MIT es un permiso irrevocable sobre las copias ya obtenidas: que el autor haya despublicado los repos no retira la concesión sobre el código que ya estaba distribuido bajo MIT. La MIT permite uso y redistribución **siempre que se conserve el aviso de copyright y el texto de la licencia** en las copias.

Las licencias y atribuciones de todos los conectores de terceros están reunidas en **[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)**, conforme exige MIT (inclusión del texto de licencia en las redistribuciones).

> **Nota sobre los `LICENSE` de Voftec:** el archivo `LICENSE` que Voftec distribuía en cada repo contenía el texto MIT **sin** la línea "Copyright (c) año titular". Se preserva tal cual en `THIRD_PARTY_NOTICES.md`, con la autoría atribuida a Voftec por nombre. SAIJ es de **Joaquin Escalante** (MIT con copyright 2026), no de Voftec. SCBA no tiene archivo `LICENSE`; la declaración de licencia consta en el README del repo de FacundoEmanuel ("MIT - libre para usar, modificar y distribuir"); el texto estándar MIT con atribución al autor figura en `THIRD_PARTY_NOTICES.md`.

El crédito a los autores originales se mantiene en la sección "Créditos" y en "Fuentes disponibles".
