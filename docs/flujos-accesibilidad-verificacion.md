# Flujos de accesibilidad y verificacion profesional

Esta guia propone controles para usar `mcp-legal-ar` en flujos locales con abogados no tecnicos, sin delegacion ciega a la IA.

El objetivo es que el hub funcione como capa de fuentes juridicas argentinas auditables, mientras el profesional conserva el control sobre:

- fuente consultada;
- fecha de consulta;
- vigencia o estado procesal;
- incertidumbre;
- omisiones;
- uso profesional del resultado.

## Principios

1. **Fuente visible antes de confianza.** Todo informe debe indicar fuente, fecha/hora de consulta y enlace o identificador cuando exista.
2. **Separar extraccion de inferencia.** Distinguir datos extraidos del documento o fuente oficial de conclusiones generadas por IA.
3. **Controlar omisiones.** Un resumen util puede ser peligroso si deja afuera fundamento, prueba, plazo, tribunal, estado procesal o excepciones.
4. **Anonimizar antes de resumir.** Si el flujo usa PDFs de causas o documentos sensibles, anonimizar nombres, DNI/CUIT, domicilios, correos, telefonos y datos de terceros antes de pedir resumen.
5. **Revision humana obligatoria.** El output no se presenta, firma, contesta, notifica ni usa profesionalmente sin revision del abogado.
6. **Accesibilidad por defecto.** La salida debe ser legible para abogados no tecnicos: secciones fijas, lenguaje claro, alertas destacadas y checklist final.

## Flujo 1: informe diario de causas

Uso previsto: revisar novedades procesales y dejar un informe diario en una boveda local, por ejemplo Obsidian.

### Entrada

- Fuente: PJN Consulta o Portal PJN cuando corresponda.
- Rango temporal: dia actual o ultimas 24/48 horas.
- Causas o partes consultadas.

### Salida recomendada

Usar la plantilla `templates/informe-diario-causas.md`.

Campos minimos:

- fecha y hora de consulta;
- fuente consultada;
- causa;
- tribunal o fuero si surge de la fuente;
- novedad detectada;
- documento asociado si existe;
- plazo aparente si surge de la fuente;
- puntos pendientes de revision;
- estado: `SIN NOVEDAD`, `REVISAR`, `URGENTE`, `NO VERIFICADO`.

### Controles

- No asumir vencimientos si la fuente no los muestra expresamente.
- No mezclar causas con nombres parecidos.
- Si hay CAPTCHA o sesion HITL, dejar constancia de que la consulta fue hecha por el usuario.
- Si se descarga PDF, conservar referencia al PDF original.
- Si la fuente no responde, marcar `NO VERIFICADO`; no inferir que no hay novedad.

## Flujo 2: PDF a Markdown, anonimizacion y resumen estructurado

Uso previsto: transformar un PDF local en Markdown, anonimizarlo y generar un resumen revisable.

### Etapas

1. Extraer texto del PDF.
2. Guardar el texto bruto en ubicacion local controlada.
3. Crear una version anonimizada.
4. Generar resumen estructurado sobre la version anonimizada.
5. Revisar contra el PDF o texto original antes de usar.

### Datos a anonimizar

- nombres de personas fisicas;
- DNI, CUIT/CUIL, pasaportes;
- domicilios;
- telefonos;
- emails;
- matriculas, patentes o identificadores sensibles;
- nombres de menores;
- datos de salud, bancarios o familiares;
- cualquier dato cuya exposicion no sea necesaria para la tarea.

### Salida recomendada

Usar la plantilla `templates/resumen-pdf-anonimizado.md`.

El resumen debe separar:

- datos extraidos;
- hechos relevantes;
- fundamentos o normas mencionadas;
- prueba o documentos citados;
- decisiones, pedidos o providencias;
- plazos o fechas;
- omisiones o dudas;
- revision humana pendiente.

## Checklist de control de omisiones

Antes de usar un resumen, verificar si falta alguno de estos puntos:

- tribunal, sala, juzgado o autoridad;
- caratula o identificador anonimizado;
- fecha de resolucion, notificacion o publicacion;
- pretension, defensa o cuestion juridica;
- fundamento juridico central;
- respuesta al tribunal inferior o a argumentos de partes;
- prueba relevante;
- norma, precedente o fuente citada;
- plazo, vencimiento o carga procesal;
- disidencias, excepciones, condicionamientos o limitaciones;
- nivel de incertidumbre.

Si falta algo material, el estado del output debe ser `REVISAR` o `NO VERIFICADO`.

## Plantilla de prompt seguro

```text
Trabaja solo con el texto y las fuentes que te proporciono.
No agregues datos externos salvo que indique una fuente consultada por el MCP.
Separa datos extraidos de inferencias.
Marca toda duda como NO VERIFICADO.
Identifica posibles omisiones materiales.
No redactes una conclusion profesional final: prepara un borrador revisable.
```

## Estados de confianza

- `VERIFICADO`: coincide con fuente o documento consultado.
- `INFERIDO`: razonamiento probable a partir de la fuente, requiere revision.
- `NO VERIFICADO`: no surge de la fuente o la fuente no estuvo disponible.
- `CONFLICTO`: hay datos inconsistentes entre fuentes o documentos.
- `URGENTE`: puede existir plazo, vencimiento o carga procesal que requiere revision inmediata.

## Nota de alcance

Esta guia no modifica el comportamiento del MCP ni automatiza actos procesales. Es una capa de uso profesional responsable para flujos locales, auditables y revisables.
