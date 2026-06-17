# Bitácora InfoLeg - Diagnóstico, fixes y matriz de tests

Fecha: 2026-06-16
Conector: mcp-legal-ar / servers/legal-mcp/build/infoleg.js (JS plano, sin TS; el server
ejecuta este archivo directo - root build/index.js lo spawnea, línea 64. No hay paso de build).
Harness: test_infoleg.mjs (raíz del repo).

## Estado actual: 7/9 casos en PASS

PASS: T1, T3c, T4, T5, T6, T6b  |  KNOWN-FAIL: T2, T3  |  Sin regresiones.

## Conclusión del diagnóstico

InfoLeg no está caído. Conectividad y recuperación de texto por ID están sanas. El defecto
raíz era la resolución de ID para normas no-troncales y dos endpoints inestables. La RG
4352/2018 estuvo indexada todo el tiempo en id=317312 (AFIP-DGA, Depósitos Fiscales).

IDs verificados: Código Aduanero (Ley 22.415) = 16536; RG 4352/2018 (AFIP-DGA) = 317312.

## Fixes aplicados (16/6)

T5 - obtener_metadatos_norma - RESUELTO.
  Nueva función metadatosDesdeInfoLeg(idNorma). Cuando hay idNorma sin urlNorma, deriva la
  ficha del origen InfoLEG (axios, via fetchCleanText) en vez de la ficha por ID desnudo de
  argentina.gob.ar (daba 500 en el host / timeout 20s en la máquina del usuario por render JS).
  Verificado: KNOWN-FAIL -> PASS.

T6 - obtener_texto_norma para códigos fragmentados - RESUELTO.
  Nueva función fetchCodigoSubdocs(idNorma, tipoTexto): detecta cuando el texact.htm es un
  índice (>=3 sub-documentos relativos .htm y <5 "ARTICULO N" en la página) y resuelve los
  sub-documentos a URLs absolutas. Nuevo parámetro 'seccion' en obtener_texto_norma:
  sin él, un código devuelve índice navegable; con él, trae el articulado de esa sección.
  Verificado: T6 (índice) y T6b (seccion=Titulo_preliminar -> Artículo 1) en PASS.
  Pendiente menor: el label de la sección toma el primer anchor del índice (puede mostrar
  "SANCION LEY N° 22.415" en vez de "Título Preliminar"). Cosmético, no afecta el articulado.

T2/T3 - búsqueda estructurada por tipo+número+año - CÓDIGO CORREGIDO (no validable por red).
  - normalizeTipoNorma: matcheo parcial de slugs (resoluc->resoluciones, decreto->decretos,
    etc.). Antes "Resolución General" caía al return crudo -> tipo_norma inválido -> 0.
  - searchNormativaOfficial: reintento del POST sin tipo_norma cuando da 0 (numero+anio
    suele ser único); corta el fallback Puppeteer si el servicio está caído (isUpstreamDown).
  - buscar_normativa: criterio puramente numérico + tipo/año se rutea a búsqueda estructurada
    (antes el Solr ordenado por fecha enterraba la norma vieja).
  - timeout 12s en las llamadas a argentina.gob.ar (fetchOfficialHtml + POST): falla rápido
    en vez de colgar hasta que el root mata a los 20s.
  - assertServicioDisponible: detecta "Servicio momentáneamente no disponible" y lo reporta
    como caída del upstream (no como "0 resultados"). Aplica cuando el sitio responde el cartel;
    si corta por timeout, se ve como timeout.
  Estado: T2/T3 siguen KNOWN-FAIL SOLO porque www.argentina.gob.ar no responde desde la máquina
  del usuario (POST timeout 12s). El sitio está arriba (web_fetch desde otra red: form 78 KB) y
  el buscador, probado en el navegador de la máquina, devuelve "Servicio momentáneamente no
  disponible". => caída/throttle del portal o bloqueo de IP, no código. Reintentar más tarde o
  desde otra red. Build re-verificado: carga limpio, 7/9 PASS, sin regresiones.

## Pendientes: T2 y T3 (resolución por tipo+número+año)

Ambos dependen de argentina.gob.ar (searchNormativaOfficial, render con Puppeteer).

T2 buscar_norma_por_tipo_numero_anio: en la máquina del usuario cae a timeout 20s (Puppeteer
  no instalado o render que cuelga). En el host devolvía 0 con la query estructurada -> indica
  que ADEMÁS del problema de render, el filtro tipo_norma+numero+sancion de argentina.gob.ar
  no matchea esta RG de AFIP-DGA aunque la norma exista en /resolucion-4352-2018-317312.
T3 buscar_normativa con numero+anio: el Solr (searchCentralSolr, solo param 'texto') corre
  primero y devuelve 50 normas recientes que no incluyen 317312; el fallback estructurado
  nunca se ejecuta porque Solr devolvió >0.

CAUSA RAÍZ CONFIRMADA (16/6, segunda tanda):
  - Puppeteer NO es el problema y NO hay que instalarlo. Los informes del 10-12/06
    (REPORTE_FIXES_2026-06-10.md, líneas 112 y 1111) lo sacaron del circuito: el buscador
    nacional es un form Drupal POST server-side (searchNormativaViaPost ya implementado).
  - Bug de código encontrado y CORREGIDO: normalizeTipoNorma("Resolución General") caía al
    return crudo -> el POST mandaba tipo_norma inválido -> 0. Fix: matcheo parcial de slugs
    (resoluc->resoluciones, etc.) + reintento sin tipo_norma + ruteo de criterio numérico en
    buscar_normativa (T3) + timeout 12s en las llamadas a argentina.gob.ar.
  - CAUSA RAÍZ REAL de que T2/T3 sigan en KNOWN-FAIL: el POST a www.argentina.gob.ar TIMEA a
    los 12s desde la máquina del usuario ("POST del buscador fallo: timeout of 12000ms").
    El sitio está arriba (verificado por web_fetch desde otra red: devolvió el form, 78 KB).
    servicios.infoleg.gob.ar sí responde desde la máquina; www.argentina.gob.ar no.
    => Es CONECTIVIDAD LOCAL a argentina.gob.ar, no código.

Diagnóstico pendiente del lado del usuario:
  Abrir https://www.argentina.gob.ar/normativa en el navegador de la máquina afectada.
  - No carga / muy lento  -> bloqueo de red/firewall/ISP/VPN/proxy a argentina.gob.ar.
  - Carga normal en browser pero el MCP timea -> el WAF descarta el cliente axios de Node
    (huella TLS/headers); fix del lado cliente (headers o Puppeteer solo para ese host).

## Matriz de tests (test_infoleg.mjs)

T1  localizar_codigo "codigo aduanero" -> 16536 ......................... PASS
T2  buscar_norma_por_tipo_numero_anio RG 4352/2018 -> 317312 ............ KNOWN-FAIL (timeout)
T3  buscar_normativa filtro estructurado 4352/2018 -> incluye 317312 .... KNOWN-FAIL (Solr noise)
T3c CONTROL buscar_normativa "depósitos fiscales" exacto -> 317312 ...... PASS
T4  obtener_texto_norma 317312 -> cuerpo completo ....................... PASS
T5  obtener_metadatos_norma 317312 -> ficha sin 500 .................... PASS (fix 16/6)
T6  obtener_texto_norma 16536 (código) -> índice navegable absoluto .... PASS (fix 16/6)
T6b obtener_texto_norma 16536 seccion=Titulo_preliminar -> Artículo 1 ... PASS (fix 16/6)

Convención del harness: cada caso tiene assert (expectativa post-fix) y knownFail (true = falla
esperada hoy). Exit 1 solo si rompe un caso no-knownFail. Cuando un knownFail pasa, el harness
avisa para retirar el flag.

## Notas técnicas

- Seguridad: el subproceso infoleg arranca con NODE_TLS_REJECT_UNAUTHORIZED=0 (root build/index.js
  línea 64, env TLS_ENV). Acotar la validación TLS a servicios.infoleg.gob.ar en vez de
  desactivarla para todo el proceso.

## Fuentes

- argentina.gob.ar/normativa/nacional/resolucion-4352-2018-317312
- servicios.infoleg.gob.ar/infolegInternet/verNorma.do?id=317312
- biblioteca.afip.gob.ar/dcp/REAG01004352_2018_12_07
