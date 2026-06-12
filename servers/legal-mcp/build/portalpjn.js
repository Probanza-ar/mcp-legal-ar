#!/usr/bin/env node
/**
 * portalpjn.js - Conector Portal PJN autenticado (portalpjn.pjn.gov.ar) - 11/06/2026
 *
 * La "MEV nacional": feed de novedades (despachos D / cedulas N) de las causas
 * del abogado logueado, con descarga del PDF de cada evento.
 *
 * API capturada en vivo (11/06/2026, docs/portalpjn-api.md):
 *   GET api.pjn.gov.ar/eventos/?page=N&pageSize=20&categoria=judicial[&fechaHasta=epochMs]
 *       -> { items: [{ id, fechaAccion, tipo: "despacho"|"cedula", hasDocument,
 *            payload: { caratulaExpediente, claveExpediente, fechaFirma }, link }] }
 *   GET api.pjn.gov.ar/eventos/{id}/pdf   -> application/pdf (Bearer de la sesion)
 *   El detalle del expediente NO tiene API (deriva a pjn-scw, JSF+ViewState):
 *   para eso esta el conector `pjn` (HITL sobre scw).
 *
 * REGLA INMODIFICABLE (HITL): el login en el SSO (sso.pjn.gov.ar, OIDC+PKCE) lo
 * hace SIEMPRE el usuario en un navegador visible. El conector jamas ve, pide
 * ni persiste credenciales; solo reusa el Bearer que la propia SPA emite, leido
 * de los requests que la pagina ya hace. El token no se escribe a disco.
 *
 * PRESENTACION DE ESCRITOS: fuera de alcance POR DISEÑO. Presentar es acto
 * procesal del abogado; este conector es de lectura.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const HOME_URL = "https://portalpjn.pjn.gov.ar/inicio";
const API = "https://api.pjn.gov.ar";
const TOKEN_FRESCO_MS = 4 * 60 * 1000; // OIDC: renovar si tiene mas de 4 min

// Perfil PERSISTENTE del Chromium HITL (FIX 11/06, feedback del usuario):
// con perfil limpio habia que tipear la clave en cada sesion. El perfil
// persistente conserva cookies del SSO (suele entrar solo) y permite que el
// propio Chromium guarde la clave la primera vez. Vive en data/ (gitignored);
// las credenciales siguen siendo del usuario: el conector no las ve.
const __dirname_pp = path.dirname(fileURLToPath(import.meta.url));
const PROFILE_DIR = path.resolve(__dirname_pp, "..", "data", "hitl-portalpjn");

let globalBrowser = null;
let globalPage = null;
let auth = { token: null, ts: 0 }; // Bearer capturado de la propia SPA (solo en memoria)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const txt = (t) => ({ content: [{ type: "text", text: t }] });
const err = (t) => ({ content: [{ type: "text", text: t }], isError: true });

const AVISO_SIN_SESION = "No hay sesion HITL activa. Ejecuta iniciar_hitl_browser (con aviso_dado=true tras avisar al usuario) y que el usuario se loguee en el SSO.";

function pageViva() {
    return globalBrowser && globalPage && !globalPage.isClosed();
}

function instalarCapturaToken(page) {
    // La SPA manda Authorization: Bearer <jwt> en cada llamada a api.pjn.gov.ar.
    // Guardamos el ultimo (la SPA lo renueva sola). Nunca va a disco.
    page.on("request", (req) => {
        try {
            if (!req.url().startsWith(API)) return;
            const h = req.headers();
            const a = h["authorization"] || h["Authorization"];
            if (a && /^Bearer .{20,}/.test(a)) {
                auth = { token: a.slice(7), ts: Date.now() };
            }
        } catch { /* nunca romper la pagina */ }
    });
}

async function asegurarToken() {
    if (!pageViva()) throw new Error(AVISO_SIN_SESION);
    if (auth.token && Date.now() - auth.ts < TOKEN_FRESCO_MS) return auth.token;
    // Token ausente o viejo: recargar la pagina dispara las llamadas de la SPA
    // (con token renovado por Keycloak) y la captura lo levanta.
    try {
        await globalPage.reload({ waitUntil: "domcontentloaded", timeout: 45000 });
    } catch { /* puede estar en el SSO */ }
    for (let i = 0; i < 20; i++) {
        await sleep(500);
        if (auth.token && Date.now() - auth.ts < TOKEN_FRESCO_MS) return auth.token;
    }
    const url = pageViva() ? globalPage.url() : "(sin pagina)";
    throw new Error(
        `No pude capturar el token de sesion (pagina actual: ${url}). ` +
        `Si la ventana muestra el login del SSO, decile al usuario: 'Logueate en la ventana del Portal PJN y avisame con un ok'; despues reintenta esta tool.`
    );
}

async function apiGet(ruta, { binario = false } = {}) {
    const token = await asegurarToken();
    const r = await fetch(API + ruta, {
        headers: {
            "Authorization": `Bearer ${token}`,
            "Accept": binario ? "application/pdf, */*" : "application/json, text/plain, */*",
        },
    });
    if (r.status === 401 || r.status === 403) {
        // token vencido en el medio: forzar renovacion una vez
        auth = { token: null, ts: 0 };
        const token2 = await asegurarToken();
        const r2 = await fetch(API + ruta, {
            headers: { "Authorization": `Bearer ${token2}`, "Accept": binario ? "application/pdf, */*" : "application/json, */*" },
        });
        return r2;
    }
    return r;
}

const fmtFecha = (epochMs) => {
    if (!epochMs) return "s/f";
    return new Intl.DateTimeFormat("es-AR", {
        timeZone: "America/Argentina/Buenos_Aires",
        day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
    }).format(new Date(epochMs));
};
const letraTipo = (tipo) => tipo === "despacho" ? "D" : (tipo === "cedula" ? "N" : (tipo || "?"));

async function traerEventos({ paginas = 1, pageSize = 20, tipo = null }) {
    const items = [];
    let fechaHasta = null;
    for (let p = 0; p < paginas; p++) {
        let ruta = `/eventos/?page=${p}&pageSize=${pageSize}&categoria=judicial`;
        if (fechaHasta) ruta += `&fechaHasta=${fechaHasta}`;
        const r = await apiGet(ruta);
        if (!r.ok) throw new Error(`API /eventos/ respondio HTTP ${r.status} en page ${p}`);
        const j = await r.json();
        const lote = j.items || [];
        if (p === 0 && lote.length) fechaHasta = lote[0].fechaCreacion; // cursor estable (asi pagina el portal)
        items.push(...lote);
        if (lote.length < pageSize) break;
    }
    return tipo ? items.filter((i) => i.tipo === tipo) : items;
}

function lineaEvento(it) {
    const pl = it.payload || {};
    const doc = it.hasDocument ? ` [PDF: evento_id ${it.id}]` : "";
    return `- [${letraTipo(it.tipo)}] ${fmtFecha(it.fechaAccion)} | ${pl.claveExpediente || "s/clave"} | ${(pl.caratulaExpediente || "").slice(0, 110)}${doc}`;
}

const server = new McpServer({ name: "portalpjn-mcp", version: "1.0.0" });

// ─── iniciar_hitl_browser ────────────────────────────────────────────────────
server.tool(
    "iniciar_hitl_browser",
    "Abre el navegador interactivo (HITL) en el Portal PJN (portalpjn.pjn.gov.ar). REGLA: el usuario tiene que enterarse ANTES de que se abra la ventana. Avisale en tu respuesta PREVIA: 'Se va a abrir una ventana de Chromium; logueate en el SSO del PJN con tu usuario y clave (yo no los veo) y avisame con un ok'. Recien entonces llama esta tool con aviso_dado=true.",
    {
        aviso_dado: z.boolean().optional().default(false).describe("OBLIGATORIO en true. Confirma que en tu mensaje ANTERIOR ya le avisaste al usuario que se abre una ventana y que debe loguearse en el SSO. Si no se lo dijiste, NO llames esta tool."),
    },
    async (args) => {
        if (!args.aviso_dado) {
            return err("NO se abrio la ventana. Primero avisale al usuario: 'Voy a abrir una ventana de Chromium para el Portal PJN; logueate con tu usuario y clave del SSO (no los veo ni los guardo) y avisame con un ok'. Despues volve a llamar con aviso_dado=true.");
        }
        if (pageViva()) return txt("El navegador ya esta abierto; la sesion sigue viva.");
        try {
            const { default: puppeteer } = await import("puppeteer");
            fs.mkdirSync(PROFILE_DIR, { recursive: true });
            globalBrowser = await puppeteer.launch({
                headless: false,
                defaultViewport: null,
                userDataDir: PROFILE_DIR, // perfil persistente: SSO + clave guardada
                args: ["--start-maximized"],
            });
            globalPage = (await globalBrowser.pages())[0] || (await globalBrowser.newPage());
            instalarCapturaToken(globalPage);
            await globalPage.goto(HOME_URL, { waitUntil: "domcontentloaded", timeout: 90000 });
            // El SSO con cookie valida redirige solo al portal: esperar un poco
            // y ver si el token ya cayo sin intervencion del usuario.
            for (let i = 0; i < 12 && !auth.token; i++) await sleep(1000);
            if (auth.token) {
                return txt("Navegador abierto y SESION RECUPERADA del perfil persistente: el usuario ya esta logueado, no hace falta clave. Podes llamar directo a obtener_novedades o parte_diario.");
            }
            const enSSO = globalPage.url().includes("sso.pjn.gov.ar");
            return txt(
                `Navegador abierto en el Portal PJN.${enSSO ? " La pagina esta en el LOGIN del SSO." : ""}\n\n` +
                `Decile al usuario: 'Logueate con tu usuario y clave del PJN en la ventana. Si Chromium te ofrece GUARDAR la clave, aceptale: la proxima vez entra solo (el perfil es persistente y local). Avisame con un ok'. ` +
                `Cuando confirme, llama a obtener_novedades o parte_diario. El token se captura solo; las credenciales nunca pasan por el conector.`
            );
        } catch (error) {
            globalBrowser = null; globalPage = null;
            return err(`Error al iniciar el navegador: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
);

// ─── estado_hitl ─────────────────────────────────────────────────────────────
server.tool("estado_hitl", "Estado de la sesion HITL del Portal PJN: navegador, URL actual y si hay token de sesion capturado (y su edad).", {}, async () => {
    if (!pageViva()) return txt("Sin sesion: navegador cerrado. Usar iniciar_hitl_browser.");
    const edad = auth.token ? Math.round((Date.now() - auth.ts) / 1000) : null;
    return txt(
        `Navegador abierto.\nURL: ${globalPage.url()}\n` +
        (auth.token ? `Token de sesion: capturado hace ${edad}s (${edad < 240 ? "fresco" : "viejo; se renueva solo al usarlo"}).` :
            "Token de sesion: TODAVIA NO capturado. Si la ventana muestra el login, el usuario debe loguearse; si ya esta logueado, cualquier tool lo captura recargando.")
    );
});

// ─── obtener_novedades ───────────────────────────────────────────────────────
server.tool(
    "obtener_novedades",
    "Lista las novedades del estudio en el Portal PJN: despachos (D) y cedulas de notificacion (N) de todas las causas del abogado logueado, mas recientes primero. Requiere sesion HITL con login hecho (iniciar_hitl_browser).",
    {
        paginas: z.number().int().min(1).max(10).optional().default(1).describe("Cuantas paginas del feed traer (20 eventos por pagina)"),
        tipo: z.enum(["despacho", "cedula"]).optional().describe("Filtrar: 'despacho' (D) o 'cedula' (N). Sin filtro trae ambos."),
    },
    async (args) => {
        try {
            const items = await traerEventos({ paginas: args.paginas, tipo: args.tipo || null });
            if (!items.length) return txt("El feed no devolvio eventos (con ese filtro).");
            let out = `# Portal PJN - Novedades (${items.length} eventos${args.tipo ? `, solo ${args.tipo}` : ""})\n\n`;
            out += items.map(lineaEvento).join("\n");
            out += `\n\nPara el PDF de un evento: descargar_pdf_evento con su evento_id. Para el expediente completo: conector pjn (consultar_expediente con la clave, ej. "CIV 36784/2022").`;
            return txt(out);
        } catch (error) {
            return err(`Error en obtener_novedades: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
);

// ─── descargar_pdf_evento ────────────────────────────────────────────────────
server.tool(
    "descargar_pdf_evento",
    "Descarga el PDF de un despacho o cedula del feed del Portal PJN (GET /eventos/{id}/pdf) y lo guarda en disco. El evento_id sale de obtener_novedades/parte_diario.",
    {
        evento_id: z.number().int().describe("id del evento en el feed (campo evento_id de obtener_novedades)"),
        carpeta_destino: z.string().optional().describe("Carpeta donde guardar el PDF. Default: Descargas del usuario. Para el pipeline de la boveda usar la carpeta del caso (ej. D:\\DERECHO\\Cerebro Digital\\Casos\\<caso>\\originales)"),
        nombre_archivo: z.string().optional().describe("Nombre del archivo (default: portalpjn-evento-<id>.pdf)"),
    },
    async (args) => {
        try {
            const r = await apiGet(`/eventos/${args.evento_id}/pdf`, { binario: true });
            if (!r.ok) return err(`La API respondio HTTP ${r.status} para el PDF del evento ${args.evento_id}. Si es 404, el evento no tiene documento (hasDocument=false).`);
            const ct = r.headers.get("content-type") || "";
            if (!/pdf/i.test(ct)) return err(`La respuesta no es un PDF (content-type: ${ct}).`);
            const buf = Buffer.from(await r.arrayBuffer());
            const carpeta = args.carpeta_destino || path.join(os.homedir(), "Downloads");
            fs.mkdirSync(carpeta, { recursive: true });
            const nombre = (args.nombre_archivo || `portalpjn-evento-${args.evento_id}.pdf`).replace(/[^\w.\-]+/g, "_");
            const destino = path.join(carpeta, nombre);
            fs.writeFileSync(destino, buf);
            return txt(`PDF guardado: ${destino} (${(buf.length / 1024).toFixed(1)} KB).\nSiguiente paso sugerido del pipeline: extraer texto a MD en actuaciones/ del caso y generar la version anonimizada (ver ficha-anonimizacion del caso).`);
        } catch (error) {
            return err(`Error en descargar_pdf_evento: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
);

// ─── parte_diario ────────────────────────────────────────────────────────────
server.tool(
    "parte_diario",
    "Parte de novedades del Portal PJN: agrupa por expediente los despachos (D) y cedulas (N) de los ultimos N dias, en Markdown listo para la boveda. Requiere sesion HITL con login hecho.",
    {
        dias: z.number().int().min(1).max(30).optional().default(1).describe("Ventana hacia atras en dias (default 1: desde ayer a esta hora)"),
        paginas: z.number().int().min(1).max(10).optional().default(5).describe("Paginas del feed a revisar (20 eventos c/u; subir si el estudio mueve mucho)"),
        guardar_en: z.string().optional().describe("Ruta de archivo .md donde guardar el parte (opcional; ej. en la boveda). Si se omite, solo se devuelve el texto."),
        descargar_pdfs: z.boolean().optional().default(false).describe("Si es true, descarga ademas el PDF de cada evento nuevo que tenga documento, en la misma pasada."),
        carpeta_pdfs: z.string().optional().describe("Carpeta para los PDFs (default: subcarpeta pdfs\\<fecha> junto al .md de guardar_en; si no hay guardar_en, Descargas del usuario)"),
    },
    async (args) => {
        try {
            const items = await traerEventos({ paginas: args.paginas });
            const desde = Date.now() - args.dias * 24 * 60 * 60 * 1000;
            const recientes = items.filter((i) => (i.fechaAccion || i.fechaCreacion || 0) >= desde);
            const porExp = new Map();
            for (const it of recientes) {
                const clave = it.payload?.claveExpediente || "s/clave";
                if (!porExp.has(clave)) porExp.set(clave, { caratula: it.payload?.caratulaExpediente || "", eventos: [] });
                porExp.get(clave).eventos.push(it);
            }
            // Descarga opcional de los PDFs de todo lo nuevo (FIX 11/06 v2,
            // pedido del usuario: el parte sin los PDFs quedaba a mitad de camino)
            const descargados = [];
            const fallidos = [];
            if (args.descargar_pdfs && recientes.length) {
                const fechaISO = new Date().toISOString().slice(0, 10);
                const base = args.carpeta_pdfs
                    || (args.guardar_en ? path.join(path.dirname(args.guardar_en), "pdfs", fechaISO)
                        : path.join(os.homedir(), "Downloads", `parte-pjn-${fechaISO}`));
                fs.mkdirSync(base, { recursive: true });
                for (const it of recientes) {
                    if (!it.hasDocument) continue;
                    try {
                        const r = await apiGet(`/eventos/${it.id}/pdf`, { binario: true });
                        const ct = r.headers.get("content-type") || "";
                        if (!r.ok || !/pdf/i.test(ct)) { fallidos.push(`evento ${it.id} (HTTP ${r.status})`); continue; }
                        const buf = Buffer.from(await r.arrayBuffer());
                        const clave = (it.payload?.claveExpediente || "sin-clave").replace(/[^\w]+/g, "-");
                        const f = path.join(base, `${clave}-${letraTipo(it.tipo)}-evento-${it.id}.pdf`);
                        fs.writeFileSync(f, buf);
                        descargados.push(f);
                    } catch (e) {
                        fallidos.push(`evento ${it.id} (${e instanceof Error ? e.message : String(e)})`);
                    }
                }
            }
            const hoy = fmtFecha(Date.now());
            let out = `# Parte diario Portal PJN - ${hoy}\n\n`;
            if (!porExp.size) {
                out += `Sin novedades en los ultimos ${args.dias} dia(s) (revisadas ${args.paginas} paginas del feed).\n`;
            } else {
                out += `${recientes.length} evento(s) en ${porExp.size} causa(s), ultimos ${args.dias} dia(s):\n\n`;
                for (const [clave, info] of porExp) {
                    out += `## ${clave}\n${info.caratula.slice(0, 140)}\n\n`;
                    for (const it of info.eventos) out += lineaEvento(it) + "\n";
                    out += "\n";
                }
                if (args.descargar_pdfs) {
                    out += `## PDFs descargados (${descargados.length})\n\n`;
                    for (const f of descargados) out += `- ${f}\n`;
                    if (fallidos.length) out += `\nFallidos: ${fallidos.join("; ")}\n`;
                    out += "\n";
                } else {
                    out += `PDFs: descargar_pdf_evento con el evento_id indicado, o parte_diario con descargar_pdfs=true. Detalle de expediente: conector pjn.\n`;
                }
            }
            if (args.guardar_en) {
                fs.mkdirSync(path.dirname(args.guardar_en), { recursive: true });
                fs.writeFileSync(args.guardar_en, out, "utf-8");
                return txt(`Parte guardado en ${args.guardar_en}\n\n${out}`);
            }
            return txt(out);
        } catch (error) {
            return err(`Error en parte_diario: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
);

// ─── alcance_fuente ──────────────────────────────────────────────────────────
server.tool("alcance_fuente", "Capacidades, flujo HITL y limitaciones del conector Portal PJN.", {}, async () => txt(
    `# Alcance y Fuentes - Portal PJN (portalpjn.pjn.gov.ar)

## Que hace
Feed de novedades del abogado logueado (despachos D y cedulas N de TODAS sus
causas, via API REST api.pjn.gov.ar) y descarga del PDF de cada evento.

## Flujo
1. iniciar_hitl_browser (avisar al usuario ANTES; aviso_dado=true).
2. El usuario se loguea en el SSO (sus credenciales, nunca del conector).
3. obtener_novedades / parte_diario / descargar_pdf_evento.
4. finalizar_hitl_browser al terminar.

## Limitaciones (por diseño y del portal)
- Sin sesion del usuario no hay datos: el token Bearer se captura de la propia
  SPA, vive solo en memoria y se renueva recargando la pagina.
- El DETALLE del expediente no tiene API (deriva a pjn-scw/JSF): usar el
  conector pjn (consultar_expediente) con la clave del feed.
- NO presenta escritos ni lo hara: acto procesal del abogado.
- API documentada en docs/portalpjn-api.md (captura en vivo 11/06/2026).

Conector de lectura sobre el portal oficial. No constituye asesoramiento juridico.`
));

// ─── finalizar_hitl_browser ──────────────────────────────────────────────────
server.tool("finalizar_hitl_browser", "Cierra el navegador HITL del Portal PJN y descarta el token de sesion de memoria.", {}, async () => {
    try {
        if (globalBrowser) await globalBrowser.close().catch(() => { });
    } finally {
        globalBrowser = null; globalPage = null; auth = { token: null, ts: 0 };
    }
    return txt("Sesion HITL cerrada; token descartado de memoria.");
});

// ─── Bootstrap ───────────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
