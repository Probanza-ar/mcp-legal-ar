# mcp-legal-ar

Servidor MCP unificado de herramientas jurídicas argentinas para Claude Desktop.

Integra las principales fuentes legales en un único conector. En lugar de configurar cada servidor por separado, el abogado instala uno solo y accede a todo.

Este repositorio no crea ninguna fuente nueva. Unifica en un solo conector los servidores MCP desarrollados por la comunidad argentina de legal tech.

---

## ¿Qué es esto y para qué sirve?

Claude Desktop puede conectarse a fuentes de información externas a través de conectores llamados MCP. Este repositorio instala un único conector que le da acceso a Claude a las principales bases de datos jurídicas argentinas al mismo tiempo:

- Buscar jurisprudencia en JUBA y SCBA
- Leer el Boletín Oficial nacional y de la Provincia de Buenos Aires
- Buscar legislación en InfoLEG y Normativa PBA
- Consultar dictámenes de la PTN y fallos del TFN

Sin este hub, instalar cada conector por separado requeriría configurar múltiples servidores distintos. Con este hub, se instala uno solo.

---

## Fuentes disponibles

### ✅ Operativos

| # | Nombre | Descripción | Herramientas | Crédito |
|---|--------|-------------|--------------|---------|
| 1 | **BORA** | Boletín Oficial de la República Argentina | 14 | [voftec/bora-mcp](https://github.com/voftec/bora-mcp) |
| 2 | **BOPBA** | Boletín Oficial de la Provincia de Buenos Aires | 15 | [voftec/bopba-mcp](https://github.com/voftec/bopba-mcp) |
| 3 | **InfoLeg** | Legislación nacional | 20 | [voftec/InfoLeg-MCP](https://github.com/voftec/InfoLeg-MCP) |
| 4 | **Normativa PBA** | Legislación provincial de Buenos Aires | 9 | [voftec/normativapba-mcp](https://github.com/voftec/normativapba-mcp) |
| 5 | **JUBA** | Jurisprudencia SCBA y cámaras PBA | 21 | [voftec/juba-mcp](https://github.com/voftec/juba-mcp) |
| 6 | **PTN** | Dictámenes de la Procuración del Tesoro | 22 | [voftec/ptn-mcp](https://github.com/voftec/ptn-mcp) |
| 7 | **TFN** | Tribunal Fiscal de la Nación | 16 | [voftec/tfn-mcp](https://github.com/voftec/tfn-mcp) |
| 8 | **SCBA** | Sentencias y resoluciones de la Suprema Corte de Buenos Aires | 4 | [FacundoEmanuel/scba-mcp-server](https://github.com/FacundoEmanuel/scba-mcp-server) |

### 🔧 En desarrollo

| # | Nombre | Descripción | Estado |
|---|--------|-------------|--------|
| 9 | **SAIJ** | Sistema Argentino de Información Jurídica (330.000+ documentos) | Requiere autenticación de sesión |
| 10 | **PJN Expedientes** | Estado procesal de causas federales | Requiere resolución de CAPTCHA |
| 11 | **PJN Jurisprudencia** | Fallos y sentencias federales | Requiere resolución de CAPTCHA |

---

## Requisitos

Antes de instalar, necesitás tener en tu computadora:

1. **Claude Desktop** - Descargar desde [claude.ai/download](https://claude.ai/download)
2. **Node.js** - Descargar desde [nodejs.org](https://nodejs.org) (elegir la versión LTS)

Para verificar si Node.js ya está instalado, abrir el símbolo del sistema (CMD) y ejecutar:

```
node --version
```

Si aparece un número de versión (por ejemplo `v20.11.0`), ya está instalado.

---

## Instalación (opción recomendada - automática)

1. Hacer clic en el botón verde **Code** arriba a la derecha y seleccionar **Download ZIP**
2. Extraer el ZIP en cualquier carpeta. GitHub crea una carpeta `mcp-legal-ar-main` al extraerlo - podés dejarla así o renombrarla
3. Dentro de esa carpeta, hacer clic derecho en `setup.ps1` y seleccionar **"Ejecutar con PowerShell"**

El script detecta automáticamente la ubicación del repositorio y configura Claude Desktop.

---

## Instalación manual (paso a paso)

### Paso 1 - Descargar el repositorio

Hacer clic en el botón verde **Code** arriba a la derecha y seleccionar **Download ZIP**. Extraer el ZIP en una carpeta. GitHub descarga el ZIP con el nombre `mcp-legal-ar-main.zip` y crea una carpeta `mcp-legal-ar-main` al extraerlo - renombrala a `mcp-legal-ar` o al nombre que prefieras. En los pasos siguientes usamos `C:\mcp-legal-ar` como ejemplo; reemplazálo por la ruta real donde extrajiste el ZIP.

### Paso 2 - Instalar dependencias

Abrir el símbolo del sistema (CMD) y ejecutar:

```
cd C:\mcp-legal-ar
npm install
npm install --prefix servers\legal-mcp
```


### Paso 3 - Configurar Claude Desktop

Abrir el archivo de configuración de Claude Desktop. La ruta depende de cómo instalaste Claude:

**Instalación clásica:**
```
C:\Users\TU_USUARIO\AppData\Roaming\Claude\claude_desktop_config.json
```

**Instalación Microsoft Store:**

Abrí PowerShell y ejecutá:
```
Get-ChildItem "$env:LOCALAPPDATA\Packages" -Filter "Claude_*" | Select-Object FullName
```
Eso te muestra la carpeta exacta. El config está en `LocalCache\Roaming\Claude\claude_desktop_config.json` dentro de esa carpeta.

Si no sabés cuál es la tuya, abrí el Explorador de archivos, pegá `%APPDATA%\Claude` en la barra de dirección y presioná Enter. Si abre una carpeta, es la instalación clásica. Si da error, es la instalación Microsoft Store.

Reemplazar `TU_USUARIO` con el nombre de usuario de Windows. Abrir ese archivo con el Bloc de notas y agregar dentro de `"mcpServers"`:

```json
"mcp-legal-ar": {
  "command": "node",
  "args": ["C:\\mcp-legal-ar\\build\\index.js"],
  "env": {
    "NODE_TLS_REJECT_UNAUTHORIZED": "0"
  }
}
```

El archivo completo debería quedar así:

```json
{
  "mcpServers": {
    "mcp-legal-ar": {
      "command": "node",
      "args": ["C:\\mcp-legal-ar\\build\\index.js"],
      "env": {
        "NODE_TLS_REJECT_UNAUTHORIZED": "0"
      }
    }
  }
}
```

> **Importante:** usar doble barra invertida `\\` en todas las rutas del JSON. La carpeta puede llamarse como quieras; lo que importa es que la ruta en `args` apunte al `build\index.js` de donde extrajiste el repositorio.

### Paso 4 - Reiniciar Claude Desktop

Cerrar Claude Desktop completamente: click derecho en el ícono de la bandeja del sistema (esquina inferior derecha) y seleccionar **Salir**. Volver a abrirlo. El conector `mcp-legal-ar` debería aparecer en la lista de herramientas disponibles.

---

## Solución de problemas

**El conector no aparece en Claude Desktop**

Verificar que el archivo `claude_desktop_config.json` tenga el formato correcto (sin comas de más ni llaves faltantes). Cerrar Claude Desktop completamente desde la bandeja del sistema antes de reiniciarlo.

**Error al ejecutar `npm install`**

Verificar que Node.js esté instalado correctamente ejecutando `node --version` en CMD. Si da error, reinstalar Node.js desde [nodejs.org](https://nodejs.org).

**Algún conector aparece como desconectado**

Algunos conectores dependen de que las webs oficiales estén disponibles. Si una fuente está caída, el resto sigue funcionando normalmente.

---

## Seguridad y privacidad

**El hub corre en tu máquina y solo en tu máquina.**

El hub corre en tu propia computadora mediante transporte stdio - comunicación directa entre Claude Desktop y el servidor sin pasar por ningún servidor intermediario. Las consultas nunca salen de tu máquina hacia un servidor de terceros. Los conectores consultan únicamente las webs jurídicas oficiales públicas (boletines oficiales, bases de jurisprudencia) y devuelven la respuesta directamente a Claude.

El hub no registra consultas, no las envía a terceros, no tiene capacidad de accionar sobre sistemas externos más allá de consultar las fuentes jurídicas públicas para las que fue diseñado.

**Certificados TLS:** el hub desactiva la verificación de certificados SSL (`NODE_TLS_REJECT_UNAUTHORIZED=0`). Esto es necesario porque varias fuentes jurídicas oficiales argentinas presentan certificados con cadenas incompletas. Al correr enteramente en la máquina local y consultar solo sitios públicos conocidos, el riesgo práctico es mínimo.

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
           └── scba__*         → proceso hijo Node
```

---

## Créditos

Este repositorio únicamente unifica servidores MCP desarrollados por otros. Todo el mérito de cada conector corresponde a sus autores originales:

- BORA, BOPBA, InfoLeg, Normativa PBA, JUBA, PTN, TFN - [Voftec](https://github.com/voftec)
- SCBA MCP Server - [FacundoEmanuel](https://github.com/FacundoEmanuel)

Ensamblado por [@abogadoaboitiz](https://x.com/abogadoaboitiz)

---

## Licencia

Apache 2.0
