# Portal PJN (portalpjn.pjn.gov.ar) - API capturada

Captura en vivo del 11/06/2026 (sesión autenticada real, datos personales
excluidos de este documento). Base para el futuro conector `portalpjn`
("MEV nacional"), etapa 2 del roadmap.

## Arquitectura

- SPA en `portalpjn.pjn.gov.ar` que consume una **API REST en `api.pjn.gov.ar`**.
  No hace falta scraping del DOM para las novedades.
- Autenticación: SSO Keycloak (`sso.pjn.gov.ar/auth/realms/pjn`), flujo
  OIDC authorization code + PKCE, client_id `pjn-portal`. La API se consume
  con el Bearer token de esa sesión.
- REGLA HITL (inmodificable): el login lo hace SIEMPRE el humano en navegador
  visible; el conector usa la sesión ya abierta. Credenciales y tokens jamás
  se registran ni persisten.
- La lupa de cada evento NO abre el portal: deriva a **pjn-scw** (el SCW ya
  cubierto por el conector pjn) vía `/consultaNovedad.seam`. Abre pestaña
  nueva: cualquier captura debe enganchar todas las pestañas.

## Endpoints confirmados

### GET api.pjn.gov.ar/eventos/
El feed de novedades del estudio: los "D" (despacho) y "N" (notificación) de
la pantalla de inicio.

Query params:
- `page` (0-based), `pageSize` (20 en el portal)
- `categoria=judicial`
- `fechaHasta=<epoch ms>` (cursor de paginación: se fija en la fecha del
  primer resultado de page 0 para que las páginas siguientes sean estables)

Respuesta `{ items: [...] }`, cada item:

```json
{
  "id": 322055979,
  "fechaCreacion": 1781109166735,        // epoch ms
  "fechaAccion": 1781109120011,          // epoch ms (fecha de firma)
  "tipo": "despacho",                    // "despacho" (D) | "cedula" (N) - ambos confirmados en captura 2
  "categoria": "judicial",
  "link": {
    "app": "pjn-scw",
    "url": "/consultaNovedad.seam?identificacion=<CUIT>&idCamara=<n>&eid=<id>"
  },
  "hasDocument": true,
  "payload": {
    "id": 506140841,
    "caratulaExpediente": "ACTOR c/ DEMANDADO s/OBJETO",
    "claveExpediente": "CIV 36784/2022", // fuero + numero/año
    "tipoEvento": "despacho",
    "fechaFirma": 1781109120011
  }
}
```

### GET api.pjn.gov.ar/usuario/info-inicial
`{ verificarEmail, confirmarEmail, appsConfigurables: "Portal, Deox, Notificaciones, Escritos", haySugerencia }`

### GET api.pjn.gov.ar/usuario/apps
Catálogo de apps del usuario con sus URLs raíz. Confirmados: `pjn-portal`
(portalpjn), `pjn-scw` (scw.pjn.gov.ar/scw, home privado
`/homePrivado.seam`), y al menos una tercera app (Deox/Notificaciones/
Escritos, ids UUID).

### GET api.pjn.gov.ar/usuario/apps-config
`{}` en la captura.

## Confirmado en captura 2 (11/06/2026, multi-pestaña)

### GET api.pjn.gov.ar/eventos/{id}/pdf  ← LA PIEZA CLAVE
Devuelve `application/pdf` directo, con el Bearer de la sesión. `{id}` es el
`id` del item del feed (no el payload.id). Con feed + este endpoint, el parte
diario puede listar novedades Y bajar el PDF de cada despacho/cédula sin
tocar el DOM.

### Tipos de evento confirmados
`tipo: "despacho"` (la D del portal) y `tipo: "cedula"` (la N). El visor de
cédulas del SCW usa `viewer.seam?id=<token>&tipoDoc=cedula`.

### Detalle de expediente (lupa)
NO hay API: deriva al SCW (JSF/Seam) en pestaña nueva:
- `expediente.seam?cid=<conversationId>` con POSTs multipart que arrastran
  `javax.faces.ViewState` (estado de servidor; no reproducible sin navegador).
- `actuacionesHistoricas.seam?cid=...` para el historial.
Conclusión de diseño: el detalle se navega con el conector pjn (HITL browser)
ya existente; el conector portalpjn solo necesita la API (feed + PDF).

### Paginación del feed
Cursor estable: `page=N&pageSize=20&categoria=judicial&fechaHasta=<epoch ms
del primer item de page 0>`. Verificadas 9 páginas consecutivas.

## Pendiente (no bloquea el conector)
1. Lista "Mis causas" como tal (puede no existir: el portal vive del feed).
2. Subida de escritos: solo DOCUMENTAR el endpoint si aparece; el conector
   NUNCA va a presentar escritos automáticamente - decisión de diseño:
   presentar es acto procesal del abogado.
3. Apps Deox/Notificaciones/Escritos: alcance sin explorar.

## Implicancia para el roadmap
- El **agente parte diaria** (eje 6 del plan) se construye sobre
  GET /eventos/: una llamada por mañana con la sesión HITL viva alcanza para
  el parte de novedades de todas las causas.
- Script de captura: `scripts/capturar-portalpjn.mjs` (v2 multi-pestaña;
  salida en la carpeta privada de tests, nunca en el repo).
