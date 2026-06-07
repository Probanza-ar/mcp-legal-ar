# Legal Hub MCP - Argentina
 
Servidor MCP unificado de herramientas jurídicas argentinas para Claude Desktop.
 
Integra 11 fuentes legales en un único conector. En lugar de configurar cada servidor por separado, el abogado instala uno solo y accede a todo.
 
Este repositorio no crea ninguna fuente nueva. Unifica en un solo conector los servidores MCP desarrollados por la comunidad argentina de legal tech.
 
---
 
## ¿Qué es esto y para qué sirve?
 
Claude Desktop puede conectarse a fuentes de información externas a través de conectores llamados MCP. Este repositorio instala un único conector que le da acceso a Claude a 11 bases de datos jurídicas argentinas al mismo tiempo:
 
- Buscar jurisprudencia en JUBA, PJN y SCBA
- Consultar el estado de expedientes federales
- Leer el Boletín Oficial nacional y de la Provincia de Buenos Aires
- Buscar legislación en InfoLEG, SAIJ y Normativa PBA
- Consultar dictámenes de la PTN y fallos del TFN
Sin este hub, instalar cada conector por separado requeriría configurar 11 servidores distintos. Con este hub, se instala uno solo.
 
---
 
## Fuentes incluidas (168 herramientas)
 
| # | Nombre | Descripción | Herramientas | Crédito |
|---|--------|-------------|--------------|---------|
| 1 | **BORA** | Boletín Oficial de la República Argentina | 14 | [voftec/bora-mcp](https://github.com/voftec/bora-mcp) |
| 2 | **BOPBA** | Boletín Oficial de la Provincia de Buenos Aires | 15 | [voftec/bopba-mcp](https://github.com/voftec/bopba-mcp) |
| 3 | **InfoLeg** | Legislación nacional | 20 | [voftec/InfoLeg-MCP](https://github.com/voftec/InfoLeg-MCP) |
| 4 | **Normativa PBA** | Legislación provincial de Buenos Aires | 9 | [voftec/normativapba-mcp](https://github.com/voftec/normativapba-mcp) |
| 5 | **JUBA** | Jurisprudencia SCBA y cámaras PBA | 21 | [voftec/juba-mcp](https://github.com/voftec/juba-mcp) |
| 6 | **PJN Expedientes** | Estado procesal de causas federales | 16 | [voftec/pjn-consulta-mcp](https://github.com/voftec/pjn-consulta-mcp) |
| 7 | **PJN Jurisprudencia** | Fallos y sentencias federales | 20 | [voftec/pjn-juris-mcp](https://github.com/voftec/pjn-juris-mcp) |
| 8 | **PTN** | Dictámenes de la Procuración del Tesoro | 22 | [voftec/ptn-mcp](https://github.com/voftec/ptn-mcp) |
| 9 | **TFN** | Tribunal Fiscal de la Nación | 16 | [voftec/tfn-mcp](https://github.com/voftec/tfn-mcp) |
| 10 | **SCBA** | Sentencias y resoluciones de la Suprema Corte de Buenos Aires | 4 | [FacundoEmanuel/scba-mcp-server](https://github.com/FacundoEmanuel/scba-mcp-server) |
| 11 | **SAIJ** | Sistema Argentino de Información Jurídica (330.000+ documentos) | 11 | [joaquinescalante23/saij-mcp](https://github.com/joaquinescalante23/saij-mcp) |
 
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
 
## Instalación paso a paso
 
### Paso 1 - Descargar el repositorio
 
Hacer clic en el botón verde **Code** arriba a la derecha y seleccionar **Download ZIP**. Extraer el ZIP en una carpeta, por ejemplo `C:\legal-hub`.
 
### Paso 2 - Instalar dependencias
 
Abrir el símbolo del sistema (CMD) y ejecutar los siguientes comandos uno por uno (reemplazar `C:\legal-hub` con la ruta donde extrajiste el ZIP):
 
```
cd C:\legal-hub
npm install
cd servers\legal-mcp
npm install
cd ..\saij-mcp
npm install
cd ..\..
```
 
### Paso 3 - Configurar Claude Desktop
 
Abrir el archivo de configuración de Claude Desktop. Se encuentra en:
 
```
C:\Users\TU_USUARIO\AppData\Roaming\Claude\claude_desktop_config.json
```
 
Reemplazar `TU_USUARIO` con el nombre de usuario de Windows. Abrir ese archivo con el Bloc de notas y agregar dentro de `"mcpServers"`:
 
```json
"legal-hub": {
  "command": "node",
  "args": ["C:\\legal-hub\\build\\index.js"],
  "cwd": "C:\\legal-hub"
}
```
 
La carpeta puede llamarse como quieras (`C:\legal-hub`, `C:\legal-hub-mcp`, etc.). Lo importante es usar esa misma ruta en `cwd` y en `args`. Usar doble barra invertida `\\` en todas las rutas del JSON.
 
El archivo completo debería quedar así:
 
```json
{
  "mcpServers": {
    "legal-hub": {
      "command": "node",
      "args": ["C:\\legal-hub\\build\\index.js"],
      "cwd": "C:\\legal-hub"
    }
  }
}
```
 
### Paso 4 - Reiniciar Claude Desktop
 
Cerrar Claude Desktop completamente: click derecho en el ícono de la bandeja del sistema (esquina inferior derecha) y seleccionar **Salir**. Volver a abrirlo. El conector `legal-hub` debería aparecer en la lista de herramientas con 168 herramientas disponibles.
 
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
 
Una preocupación legítima al conectar cualquier servidor MCP es saber qué hace con las consultas que recibe.
 
Este hub fue diseñado desde el principio para correr localmente en la computadora del usuario, sin ningún servidor en el medio. 
 
**El hub corre en tu máquina y solo en tu máquina.**
 
**Cómo funciona:** el hub corre en tu propia computadora mediante transporte stdio, que es comunicación directa entre Claude Desktop y el servidor sin pasar por ninguna red externa. Las consultas nunca salen de tu máquina hacia un servidor intermediario. Los conectores consultan únicamente las webs jurídicas oficiales públicas (boletines oficiales, bases de jurisprudencia) y devuelven la respuesta directamente a Claude.
 
**Qué no hace este hub:** no registra consultas, no las envía a terceros, no tiene capacidad de accionar sobre sistemas externos más allá de consultar las fuentes jurídicas públicas para las que fue diseñado.
 
**Auditoría:** al ser open source, cualquier abogado o su equipo técnico puede leer el código antes de instalarlo y verificar exactamente qué hace. Todo el código está disponible en este repositorio y en los repositorios originales de cada conector listados en la tabla de fuentes.
 
---
 
## Arquitectura
 
`legal-hub` es un servidor proxy MCP. Al iniciarse, levanta cada conector como proceso hijo, registra todas sus herramientas y las expone como un único servidor. Claude Desktop ve un solo conector con todas las herramientas disponibles.
 
```
Claude Desktop
     └── legal-hub (proxy)
           ├── bora__*         → proceso hijo Node
           ├── bopba__*        → proceso hijo Node
           ├── infoleg__*      → proceso hijo Node
           ├── normativapba__* → proceso hijo Node
           ├── juba__*         → proceso hijo Node
           ├── pjn__*          → proceso hijo Node
           ├── pjnjuris__*     → proceso hijo Node
           ├── ptn__*          → proceso hijo Node
           ├── tfn__*          → proceso hijo Node
           ├── saij__*         → proceso hijo Node
           └── scba__*         → proceso hijo Node
```
 
---
 
## Créditos
 
Este repositorio únicamente unifica servidores MCP desarrollados por otros. Todo el mérito de cada conector corresponde a sus autores originales:
 
- BORA, BOPBA, InfoLeg, Normativa PBA, JUBA, PJN Expedientes, PJN Jurisprudencia, PTN, TFN - [Voftec](https://github.com/voftec)
- SAIJ MCP - [Joaquín Escalante](https://github.com/joaquinescalante23)
- SCBA MCP Server - [FacundoEmanuel](https://github.com/FacundoEmanuel)
Ensamblado por [@abogadoaboitiz](https://x.com/abogadoaboitiz)
 
---
 
## Licencia
 
Apache 2.0
