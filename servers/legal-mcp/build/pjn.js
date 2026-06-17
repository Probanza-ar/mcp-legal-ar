#!/usr/bin/env node
/**
 * pjn.js - Conector PJN Consulta (scw.pjn.gov.ar) - REESCRITURA 10/06/2026
 *
 * Arquitectura: toda la interaccion corre DENTRO del navegador HITL (globalPage).
 * El portal es JSF/Seam (RichFaces 4.3 + PrimeFaces): ViewState, conversacion (cid)
 * y captcha propio (captcha.pjn.gov.ar, sitekey SCW) viven en el browser; no se
 * hace ningun POST cookieless. El captcha lo resuelve SIEMPRE el usuario (HITL).
 *
 * Estructura del portal (capturada en vivo el 10/06/2026, _capturas/pjn-capture-*.json):
 *   home.seam        form "formPublica": expedienteTab-value (porExpediente|porParte),
 *                    camaraNumAni / camaraPartes (28 jurisdicciones), numero, anio,
 *                    tipo (solo DEMANDADO en consulta publica), nomIntervParte,
 *                    buscarPorNumeroButton / buscarPorParteButton, captcha-response.
 *   consultaParte.seam  tabla resultados: Expediente|Dependencia|Caratula|Situacion|Ult.Act.
 *                       con link "ver" por fila (ids j_idt* dinamicos: NO hardcodear).
 *   expediente.seam     detalle + tablas (Fecha|Movimiento) y actuaciones
 *                       (OFICINA|FECHA|TIPO|DESCRIPCION/DETALLE|A FS.).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import crypto from "crypto";
import fs from "fs";
import path from "path";

const HOME_URL = "https://scw.pjn.gov.ar/scw/home.seam";
let globalBrowser = null;
let globalPage = null;

// Jurisdicciones (codigo -> texto verificado en el select del portal). El value
// numerico se resuelve en runtime matcheando el texto de la opcion, para tolerar
// reordenamientos del select.
const JURISDICCIONES = ["CSJ", "CIV", "CAF", "CCF", "CNE", "CSS", "CPE", "CNT", "CFP", "CCC", "COM", "CPF", "CPN", "FBB", "FCR", "FCB", "FCT", "FGR", "FLP", "FMP", "FMZ", "FPO", "FPA", "FRE", "FSA", "FRO", "FSM", "FTU"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const txt = (t) => ({ content: [{ type: "text", text: t }] });
const err = (t) => ({ content: [{ type: "text", text: t }], isError: true });

const AVISO_SIN_SESION = "No hay sesion HITL activa. Ejecuta iniciar_hitl_browser, resolve el captcha cuando aparezca y reintenta.";
const AVISO_CAPTCHA = "CAPTCHA PENDIENTE. Decile al usuario: 'Resolve el captcha en la ventana de Chromium y avisame cuando este (con un ok alcanza)'. Cuando confirme, llama a continuar_tras_captcha. Nota: el widget puede quedar visible diciendo 'Desafio aprobado'; eso ES resuelto. IMPORTANTE: NO relances la busqueda mientras el captcha este pendiente.";

function pageViva() {
    return globalBrowser && globalPage && !globalPage.isClosed();
}

async function getPage() {
    if (!pageViva()) throw new Error(AVISO_SIN_SESION);
    return globalPage;
}

/**
 * Estado del captcha: "no" | "pendiente" | "aprobado".
 * Clave (verificado en vivo): el widget del PJN QUEDA VISIBLE con "Desafio aprobado"
 * tras resolverlo; no se cierra solo. La senal confiable de aprobacion es el token
 * en el hidden #captcha-response (poblado por captcha.pjn.gov.ar al aprobar).
 */
async function estadoCaptcha(page) {
    try {
        return await page.evaluate(() => {
            const vis = (el) => {
                const st = getComputedStyle(el);
                return st.display !== "none" && st.visibility !== "hidden" && el.offsetHeight > 10;
            };
            const cont = [...document.querySelectorAll(".ui-dialog, .modal, [role='dialog'], .rf-pp-cntr, iframe[src*='captcha'], div[id*='captcha'], div[class*='captcha'], img[src*='captcha']")].filter(vis);
            if (!cont.length) return "no";
            const resp = document.getElementById("captcha-response") || document.querySelector("input[name='captcha-response']");
            if (resp && typeof resp.value === "string" && resp.value.length > 5) return "aprobado";
            const texto = cont.map((c) => { try { return c.tagName === "IFRAME" ? "" : (c.textContent || ""); } catch { return ""; } }).join(" ");
            if (/desaf[ií]o\s+aprobado|aprobad[oa]|verificad[oa]/i.test(texto)) return "aprobado";
            return "pendiente";
        });
    } catch { return "no"; } // contexto destruido = navegacion en curso
}

async function captchaVisible(page) {
    return (await estadoCaptcha(page)) === "pendiente";
}

/** Espera a que el click decante en: navegacion a alguna expectUrls | captcha | timeout. */
async function settle(page, { expectUrls = [], timeoutMs = 30000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        await sleep(600);
        let url = "";
        try { url = page.url(); } catch { continue; }
        if (expectUrls.some((u) => url.includes(u))) {
            try { await page.waitForFunction(() => document.readyState === "complete", { timeout: 8000 }); } catch { /* seguir */ }
            return { status: "ok", url };
        }
        if (await captchaVisible(page)) return { status: "captcha", url };
    }
    return { status: "timeout", url: (() => { try { return page.url(); } catch { return "?"; } })() };
}

/**
 * Lleva a la home publica SOLO si no estamos ya en ella, y espera el form.
 * No recargar si ya estamos en home: una recarga tira la verificacion captcha
 * que el usuario pueda haber resuelto recien (causa del circulo vicioso del re-test).
 */
async function irAHome(page) {
    if (!urlEs(page, "home.seam")) {
        await page.goto(HOME_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
    }
    await page.waitForSelector("#formPublica", { timeout: 20000 });
}

/**
 * Activa una solapa del tabPanel "formPublica:expedienteTab" por su nombre de item
 * (ids semanticos verificados en vivo: porExpediente | porParte | porRH).
 * Via 1: API RichFaces switchToItem. Via 2: click en el header inactivo.
 */
async function activarTab(page, itemTab, selectorCampo) {
    await page.evaluate((item) => {
        try {
            const rf = window.RichFaces;
            const comp = rf && rf.component ? rf.component("formPublica:expedienteTab") : null;
            if (comp && typeof comp.switchToItem === "function") { comp.switchToItem(item); return; }
        } catch { /* caer al click */ }
        const hdr = document.getElementById(`formPublica:${item}:header:inactive`);
        if (hdr) hdr.click();
    }, itemTab);
    await page.waitForFunction((sel) => {
        const el = document.querySelector(sel);
        return el && (el.offsetWidth || el.offsetHeight);
    }, { timeout: 15000 }, selectorCampo).catch(() => {
        throw new Error(`No pude activar la solapa "${itemTab}" (campo ${selectorCampo} no visible).`);
    });
}

/** Setea un select matcheando el codigo de jurisdiccion contra el texto de la opcion. */
async function setJurisdiccion(page, selectName, codigo) {
    const ok = await page.evaluate((name, cod) => {
        const sel = document.getElementById(name) || document.querySelector(`select[name="${name}"]`);
        if (!sel) return false;
        const opt = [...sel.options].find((o) => (o.textContent || "").trim().toUpperCase().startsWith(cod.toUpperCase() + " -"));
        if (!opt) return false;
        sel.value = opt.value;
        sel.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
    }, selectName, codigo);
    if (!ok) throw new Error(`Jurisdiccion "${codigo}" no encontrada en el select ${selectName}.`);
}

async function setCampo(page, name, valor) {
    const ok = await page.evaluate((n, v) => {
        const el = document.getElementById(n) || document.querySelector(`[name="${n}"]`);
        if (!el) return false;
        el.value = v;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
    }, name, valor);
    if (!ok) throw new Error(`Campo ${name} no encontrado.`);
}

async function clickPorId(page, id) {
    const ok = await page.evaluate((i) => {
        const el = document.getElementById(i) || document.querySelector(`[name="${i}"]`);
        if (!el) return false;
        el.click();
        return true;
    }, id);
    if (!ok) throw new Error(`Boton ${id} no encontrado.`);
}

/** Scrapea la tabla de resultados de consultaParte.seam. */
async function scrapeResultados(page) {
    return page.evaluate(() => {
        const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
        const tablas = [...document.querySelectorAll("table")].filter((t) =>
            [...t.querySelectorAll("th")].some((th) => /expediente/i.test(th.textContent || "")));
        const t = tablas[0];
        if (!t) {
            return { encontrada: false, avisoPortal: clean(document.body.innerText).slice(0, 1200), url: location.href };
        }
        const headers = [...t.querySelectorAll("th")].map((th) => clean(th.textContent)).filter(Boolean);
        const filas = [...t.querySelectorAll("tbody tr")].map((tr, i) => ({
            fila: i,
            celdas: [...tr.cells].map((c) => clean(c.textContent)),
            abrible: !!tr.querySelector("a"),
        })).filter((f) => f.celdas.some(Boolean));
        const scroller = document.querySelector(".rf-ds, .ui-paginator");
        return {
            encontrada: true, url: location.href, headers, filas,
            paginacion: scroller ? clean(scroller.textContent) : null,
        };
    });
}

function formatearResultados(res, contexto) {
    if (!res.encontrada) {
        return `# PJN - ${contexto}\n\nNo se encontro la tabla de resultados en ${res.url}.\n\n**Texto visible del portal (puede contener el motivo - ej. sin resultados, captcha, error):**\n\n${res.avisoPortal}`;
    }
    let out = `# PJN - ${contexto}\n\n**Origen:** ${res.url}\n**Resultados en pagina:** ${res.filas.length}${res.paginacion ? `\n**Paginacion:** ${res.paginacion}` : ""}\n\n`;
    out += `| fila | ${res.headers.join(" | ")} |\n|${"---|".repeat(res.headers.length + 1)}\n`;
    for (const f of res.filas) {
        out += `| ${f.fila} | ${f.celdas.slice(0, res.headers.length).join(" | ")} |\n`;
    }
    out += `\nPara ver un expediente: \`abrir_expediente\` con \`fila\` (0 a ${res.filas.length - 1}).`;
    return out;
}

/** Scrapea la pagina de detalle expediente.seam (generico, tolera cambios de ids).
 *  maxFilas: tope de filas por tabla para el render en chat (150). La exportacion
 *  a boveda (ronda 22) pasa un tope alto para no truncar expedientes largos. */
async function scrapeExpediente(page, { maxFilas = 150 } = {}) {
    return page.evaluate((maxFilas) => {
        const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
        const out = { url: location.href, titulo: document.title, encabezado: "", tablas: [] };
        const bodyText = document.body.innerText || "";
        const corte = bodyText.search(/OFICINA\s+FECHA|Fecha\s+Movimiento/i);
        out.encabezado = clean(corte > 0 ? bodyText.slice(0, corte) : bodyText.slice(0, 1500)).slice(0, 2000);
        for (const t of document.querySelectorAll("table")) {
            const headers = [...t.querySelectorAll("th")].map((th) => clean(th.textContent)).filter(Boolean);
            if (!headers.length) continue;
            const headerKey = headers.join("|").toLowerCase();
            const filas = [...t.querySelectorAll("tbody tr")].map((tr) => [...tr.cells].map((c) => clean(c.textContent)))
                .filter((f) => f.some(Boolean))
                // descarta filas que son solo el header repetido (tablas plantilla vacias)
                .filter((f) => f.join("|").toLowerCase() !== headerKey && f.join(" ").toLowerCase() !== headerKey.replace(/\|/g, " "));
            if (filas.length) out.tablas.push({ headers, filas: filas.slice(0, maxFilas), total: filas.length });
        }
        return out;
    }, maxFilas);
}

function formatearExpediente(det, { soloResoluciones = false } = {}) {
    let out = `# PJN - Expediente\n\n**Origen:** ${det.url}\n\n## Datos del expediente\n${det.encabezado}\n`;
    for (const t of det.tablas) {
        let filas = t.filas;
        if (soloResoluciones) {
            filas = filas.filter((f) => f.some((c) => /resoluci|sentencia|auto|interlocutori|despacho|fallo/i.test(c)));
            if (!filas.length) continue;
        }
        out += `\n## Tabla: ${t.headers.join(" | ")}\n\n| ${t.headers.join(" | ")} |\n|${"---|".repeat(t.headers.length)}\n`;
        for (const f of filas) out += `| ${f.slice(0, t.headers.length).join(" | ")} |\n`;
        if (t.total > t.filas.length) out += `\n*(${t.total} filas en total; se muestran ${t.filas.length})*\n`;
    }
    if (soloResoluciones) out += `\n> Filtrado heuristico por TIPO/DESCRIPCION (resolucion, sentencia, auto, interlocutorio, despacho, fallo). Para el listado completo usa obtener_actuaciones.`;
    return out;
}

// ---------------------------------------------------------------------------
// EXPORTACION A BOVEDA (eje 1.1 del plan de mejoras, ronda 22).
// Carpeta por causa, una nota MD por actuacion + nota indice (MOC), todas con
// frontmatter YAML para Obsidian. Destino default: env LEGAL_BOVEDA o
// D:\DERECHO\Cerebro Digital\Casos. Las notas contienen DATOS REALES: la
// anonimizacion (eje 2) es paso posterior y obligatorio antes de subir nada
// a servicios externos (NotebookLM incluido).
// ---------------------------------------------------------------------------
const BOVEDA_DEFAULT = process.env.LEGAL_BOVEDA || "D:\\DERECHO\\Cerebro Digital\\Casos";

const sinAcentos = (s) => String(s || "").normalize("NFD").replace(/\p{M}/gu, "");

/** Nombre seguro para archivo/carpeta Windows + Obsidian (sin \/:*?"<>|#^[]). */
function slugArchivo(s, max = 60) {
    const base = sinAcentos(s).replace(/[\\/:*?"<>|#^\[\]]/g, " ").replace(/\s+/g, "-")
        .replace(/-+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
    const cortado = base.slice(0, max).replace(/^[-.]+|[-.]+$/g, "");
    return cortado || "sin-dato";
}

const yamlVal = (s) => String(s ?? "").replace(/"/g, "'").replace(/\s+/g, " ").trim();

/** dd/mm/aaaa (o dd-mm-aa) -> aaaa-mm-dd; null si no parsea. */
function fechaAIso(s) {
    const m = /(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/.exec(String(s || ""));
    if (!m) return null;
    let [, d, mo, y] = m;
    if (y.length === 2) y = (Number(y) > 50 ? "19" : "20") + y;
    const iso = `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
    return /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(iso) ? iso : null;
}

/** Extrae un campo etiquetado del encabezado (texto con whitespace colapsado,
 *  sin saltos de linea). Corta en la siguiente etiqueta conocida del portal o
 *  en el menu de solapas (Actuaciones Intervinientes...). Verificado en vivo
 *  12/06/2026 con CIV 033004/2026. */
const ETIQUETAS_ENCABEZADO = String.raw`Expediente|Jurisdicci[oó]n|Dependencia|Sit\.?\s*Actual|Situaci[oó]n|Car[aá]tula|Actuaciones|Intervinientes|Vinculados|Recursos|Despachos|Notificaciones|informaci[oó]n`;
function campoEtiquetado(enc, etiqueta) {
    const re = new RegExp(`(?:${etiqueta})\\s*:?\\s*(.+?)(?=\\s+(?:${ETIQUETAS_ENCABEZADO})\\b\\s*:?|$)`, "i");
    const m = re.exec(enc);
    return m ? m[1].trim() : null;
}

/** Heuristicas tolerantes sobre el encabezado de expediente.seam. */
function parseDatosExpediente(det) {
    const enc = det.encabezado || "";
    const out = { fuero: null, numero: null, anio: null, caratula: null, dependencia: null, situacion: null };
    const reFueros = new RegExp(`\\b(${JURISDICCIONES.join("|")})\\s*0*(\\d{1,6})\\s*/\\s*(\\d{4})\\b`);
    const mExp = reFueros.exec(sinAcentos(enc));
    if (mExp) { out.fuero = mExp[1]; out.numero = mExp[2]; out.anio = mExp[3]; }
    out.caratula = campoEtiquetado(enc, "Car[aá]tula")
        || (/([^\n]{3,120}\s+c\/\s*[^\n]{3,160})/i.exec(enc) || [])[1] || null;
    if (out.caratula) out.caratula = out.caratula.trim();
    out.dependencia = campoEtiquetado(enc, "Dependencia")
        || ((/(JUZGADO|C[AÁ]MARA|TRIBUNAL|SECRETAR[IÍ]A)[^\n]{0,80}/i.exec(enc) || [])[0] || null);
    out.situacion = campoEtiquetado(enc, String.raw`Sit\.?\s*Actual|Situaci[oó]n`);
    return out;
}

/** Ubica la tabla de actuaciones (OFICINA|FECHA|TIPO|DESCRIPCION|A FS.) y mapea columnas por nombre de header (los ids j_idt* son dinamicos; los headers son estables). */
function extraerActuaciones(det) {
    const norm = (h) => sinAcentos(h).toLowerCase();
    let tabla = null;
    for (const t of det.tablas || []) {
        const hs = t.headers.map(norm);
        if (hs.some((h) => h.includes("tipo")) && hs.some((h) => h.includes("fecha"))) { tabla = t; break; }
    }
    if (!tabla) {
        for (const t of det.tablas || []) {
            const hs = t.headers.map(norm);
            if (hs.some((h) => h.includes("fecha")) && t.headers.length >= 3) { tabla = t; break; }
        }
    }
    if (!tabla) return { tabla: null, actuaciones: [] };
    const hs = tabla.headers.map(norm);
    const idx = (...claves) => hs.findIndex((h) => claves.some((k) => h.includes(k)));
    const iFecha = idx("fecha"), iTipo = idx("tipo"), iOficina = idx("oficina"), iDesc = idx("descripcion", "detalle"), iFs = idx("fs", "foja");
    // MAPEO POR ETIQUETA (preferido): el portal embebe la etiqueta en el texto
    // de cada celda ("Oficina: 058", "Fecha: 8/06/2026", "Tipo actuacion: X",
    // "Detalle: Y") y antepone una columna de enlaces "Descargar Ver" SIN
    // header propio, que corre todo el mapeo posicional un lugar (verificado
    // en vivo 12/06/2026). El posicional queda como fallback.
    const porEtiqueta = (f, re) => {
        for (const c of f) { const m = re.exec(String(c || "")); if (m) return m[1].trim(); }
        return null;
    };
    const actuaciones = tabla.filas.map((f, i) => {
        const eFecha = porEtiqueta(f, /^Fecha:\s*(.+)$/i);
        const eTipo = porEtiqueta(f, /^Tipo(?:\s+de)?\s*actuaci[oó]n:\s*(.+)$/i);
        const eOficina = porEtiqueta(f, /^Oficina:\s*(.+)$/i);
        const eDesc = porEtiqueta(f, /^Detalle:\s*(.+)$/i);
        const eFojas = porEtiqueta(f, /^(?:A\s*)?F(?:s\.?|ojas)\.?:?\s*(.+)$/i);
        // Si la fila viene etiquetada, NO usar fallback posicional para los
        // campos sin etiqueta propia (la columna de enlaces corre los indices;
        // verificado en vivo: fojas posicional devolvia el Detalle). La celda
        // de fojas real no trae etiqueta: se reconoce por forma ("119 / 119").
        const conEtiquetas = eFecha !== null || eTipo !== null || eDesc !== null;
        const fecha = eFecha ?? (iFecha >= 0 ? (f[iFecha] || "") : "");
        const tipo = eTipo ?? (conEtiquetas ? "" : (iTipo >= 0 ? (f[iTipo] || "") : ""));
        const oficina = eOficina ?? (conEtiquetas ? "" : (iOficina >= 0 ? (f[iOficina] || "") : ""));
        const descripcion = eDesc ?? (conEtiquetas ? "" : (iDesc >= 0 ? (f[iDesc] || "") : f.join(" | ")));
        const fojas = eFojas ?? (conEtiquetas
            ? ([...f].map((c) => String(c || "").trim()).reverse().find((c) => /^\d+(\s*\/\s*\d+)?$/.test(c)) || "")
            : (iFs >= 0 ? (f[iFs] || "") : ""));
        return {
            orden: i,
            fecha, fechaIso: fechaAIso(fecha), tipo, oficina, descripcion, fojas,
            // Enlace Descargar/Ver presente: insumo para pjn_descargar_documento_actuacion (pendiente eje 1.1.b)
            descargable: f.some((c) => /^(Descargar|Ver)(\s+(Descargar|Ver))*$/i.test(String(c || "").trim())),
            celdas: f,
        };
    });
    return { tabla, actuaciones };
}

/** Estamos en pagina de resultados? de expediente? */
function urlEs(page, fragmento) {
    try { return page.url().includes(fragmento); } catch { return false; }
}

/** Scrapea segun la pagina actual: lista de resultados o detalle de expediente. */
async function scrapeSegunPagina(page, contexto) {
    if (urlEs(page, "expediente.seam")) {
        const det = await scrapeExpediente(page);
        return txt(formatearExpediente(det));
    }
    if (urlEs(page, "consultaParte.seam")) {
        const res = await scrapeResultados(page);
        return txt(formatearResultados(res, contexto));
    }
    return null;
}

/**
 * Si hay captcha en pantalla, la busqueda no debe ejecutarse todavia.
 * Devuelve un mensaje informativo (no error) con la instruccion segun el contexto:
 * - captcha en la home (antes de buscar): el usuario resuelve y se RELANZA la
 *   misma busqueda (la pagina no se recarga, el formulario se conserva).
 * - captcha en medio de una busqueda en vuelo: continuar_tras_captcha.
 */
async function bloqueoPorCaptcha(page) {
    if (await captchaVisible(page)) {
        if (urlEs(page, "home.seam")) {
            return txt("CAPTCHA EN LA PAGINA DE BUSQUEDA. Decile al usuario: 'Resolve el captcha en la ventana de Chromium y avisame cuando este (con un ok alcanza)'. Cuando confirme, RELANZA esta misma busqueda con los mismos parametros (la pagina no se recarga; el formulario y la verificacion se conservan). Si el widget dice 'Desafio aprobado', ya esta resuelto: relanza directamente.");
        }
        return txt(AVISO_CAPTCHA);
    }
    return null;
}

async function ejecutarBusqueda(page, contexto, botonId) {
    // Con resultado unico el portal saltea la lista y va directo a expediente.seam
    // (verificado en vivo 10/6/26 con CIV 33004/2026).
    let r = await settle(page, { expectUrls: ["consultaParte.seam", "expediente.seam"] });
    // Caso "Desafio aprobado": el usuario resolvio el captcha antes/durante el click,
    // el token quedo en #captcha-response pero el submit original se perdio.
    // Auto-reenvio: re-click del boton (el form conserva datos y token).
    if (r.status === "timeout" && botonId && (await estadoCaptcha(page)) === "aprobado") {
        await clickPorId(page, botonId).catch(() => { /* si no esta, sigue el timeout */ });
        r = await settle(page, { expectUrls: ["consultaParte.seam", "expediente.seam"] });
    }
    if (r.status === "captcha") return txt(`# PJN - ${contexto}\n\n${AVISO_CAPTCHA}`);
    if (r.status === "timeout") {
        // Puede haber quedado en home con captcha no detectado o error de validacion
        const aviso = await page.evaluate(() => (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 800)).catch(() => "");
        return err(`# PJN - ${contexto}\n\nLa busqueda no llego a la pagina de resultados (timeout). URL actual: ${r.url}\n\n**Texto visible:** ${aviso}\n\n**Que hacer:** pregunta al usuario si en la ventana de Chromium hay un captcha o verificador visible. Si lo hay: que lo resuelva, avise 'listo', y entonces llama a continuar_tras_captcha (NO relances la busqueda).`);
    }
    if (r.url.includes("expediente.seam")) {
        const det = await scrapeExpediente(page);
        return txt(`> Resultado unico: el portal abrio el expediente directamente (sin lista intermedia).\n\n` + formatearExpediente(det));
    }
    const res = await scrapeResultados(page);
    return txt(formatearResultados(res, contexto));
}

export function registerAllTools(server) {
    // ---- Sesion HITL -------------------------------------------------------
    server.tool("iniciar_hitl_browser", "Abre el navegador interactivo (HITL) en la consulta publica del PJN. REGLA: el usuario tiene que enterarse ANTES de que se abra la ventana, no despues. Avisale en tu respuesta PREVIA: 'Se va a abrir una ventana de Chromium; si muestra un verificador (captcha), resolvelo y avisame'. Recien entonces llama esta tool con aviso_dado=true. La sesion queda viva y las demas tools operan dentro de ella.", {
        aviso_dado: z.boolean().optional().default(false).describe("OBLIGATORIO en true. Confirma que en tu mensaje ANTERIOR ya le avisaste al usuario que se abre una ventana de Chromium y que debe resolver el verificador (captcha) si aparece. Si no se lo dijiste todavia, NO llames esta tool: avisale primero."),
    }, async (args) => {
        if (!args.aviso_dado) {
            return err("NO se abrio la ventana. Primero avisale al usuario: 'Voy a abrir una ventana de Chromium para la consulta del PJN; si muestra un verificador (captcha), resolvelo y avisame'. Despues volve a llamar esta tool con aviso_dado=true.");
        }
        if (pageViva()) {
            return txt("El navegador ya esta abierto. La sesion HITL sigue viva; podes buscar directamente.");
        }
        try {
            const { default: puppeteer } = await import("puppeteer");
            globalBrowser = await puppeteer.launch({ headless: false, defaultViewport: null, args: ["--start-maximized"] });
            globalPage = (await globalBrowser.pages())[0] || (await globalBrowser.newPage());
            await irAHome(globalPage);
            await sleep(4000); // el modal de captcha inicial tarda en llegar (roundtrip a captcha.pjn.gov.ar)
            if (await captchaVisible(globalPage)) {
                return txt("Navegador abierto en " + HOME_URL + ". ATENCION: el portal ya esta mostrando el captcha. ANTES de buscar, decile al usuario: 'Se abrio una ventana de Chromium con un verificador (captcha): resolvelo y avisame cuando este (con un ok alcanza)'. Recien cuando confirme, ejecuta la busqueda. El widget puede quedar visible con 'Desafio aprobado': eso es resuelto.");
            }
            return txt("Navegador abierto en " + HOME_URL + ". La sesion queda viva: usa consultar_expediente o buscar_expediente_por_parte. Si el portal muestra captcha, frena, pedile al usuario que lo resuelva y espera su confirmacion.");
        }
        catch (error) {
            globalBrowser = null; globalPage = null;
            return err(`Error al iniciar el navegador: ${error instanceof Error ? error.message : String(error)}`);
        }
    });

    server.tool("estado_hitl", "Informa el estado de la sesion HITL: navegador abierto, URL actual y si hay un captcha/modal pendiente.", {}, async () => {
        if (!pageViva()) return txt("Sesion HITL: CERRADA. Ejecuta iniciar_hitl_browser.");
        const url = globalPage.url();
        const captcha = await captchaVisible(globalPage);
        return txt(`Sesion HITL: ABIERTA\nURL actual: ${url}\nModal/captcha visible: ${captcha ? "SI - debe resolverlo el usuario" : "no"}`);
    });

    server.tool("finalizar_hitl_browser", "Cierra el navegador HITL y termina la sesion. OJO: las busquedas dependen de la sesion viva; cerrar solo al terminar todas las consultas.", {}, async () => {
        if (!pageViva()) return txt("No habia navegador abierto.");
        try { await globalBrowser.close(); } catch { /* ignorar */ }
        globalBrowser = null; globalPage = null;
        return txt("Sesion HITL cerrada.");
    });

    // ---- Busquedas (corren dentro del browser) -----------------------------
    server.tool("consultar_expediente", "Busca un expediente por jurisdiccion + numero + anio en la consulta publica del PJN (scw.pjn.gov.ar). Requiere sesion HITL activa (iniciar_hitl_browser). Si el portal pide captcha, lo resuelve el usuario y luego se llama obtener_resultados.", {
        jurisdiccion: z.enum(JURISDICCIONES).describe("Codigo de camara/jurisdiccion (ej. CIV, CNT, COM, CSJ, FLP)"),
        numero: z.string().describe("Numero de expediente, sin el anio (ej. '33004')"),
        anio: z.string().describe("Anio del expediente (ej. '2026')"),
    }, async (args) => {
        try {
            const page = await getPage();
            const bloqueo = await bloqueoPorCaptcha(page);
            if (bloqueo) return bloqueo;
            await irAHome(page);
            await activarTab(page, "porExpediente", "#formPublica\\:numero");
            await setJurisdiccion(page, "formPublica:camaraNumAni", args.jurisdiccion);
            await setCampo(page, "formPublica:numero", args.numero.trim());
            await setCampo(page, "formPublica:anio", args.anio.trim());
            await clickPorId(page, "formPublica:buscarPorNumeroButton");
            return await ejecutarBusqueda(page, `Consulta por expediente ${args.jurisdiccion} ${args.numero}/${args.anio}`, "formPublica:buscarPorNumeroButton");
        }
        catch (error) {
            return err(`Error en consultar_expediente: ${error instanceof Error ? error.message : String(error)}`);
        }
    });

    server.tool("pjn_buscar_expediente_por_parte", "Busca expedientes por nombre de parte en la consulta publica del PJN. LIMITACION DEL PORTAL: la consulta publica anonima solo admite tipo de parte DEMANDADO. PRERREQUISITO: requiere sesion HITL activa; ejecutar antes iniciar_hitl_browser (una sola vez por sesion). Si el portal pide captcha, lo resuelve el usuario y luego se llama continuar_tras_captcha.", {
        jurisdiccion: z.enum(JURISDICCIONES).describe("Codigo de camara/jurisdiccion (ej. CIV, CNT, COM)"),
        nombre: z.string().describe("Apellido y nombre o razon social de la parte demandada (ej. 'gomez pablo')"),
    }, async (args) => {
        try {
            const page = await getPage();
            const bloqueo = await bloqueoPorCaptcha(page);
            if (bloqueo) return bloqueo;
            await irAHome(page);
            await activarTab(page, "porParte", "#formPublica\\:nomIntervParte");
            await setJurisdiccion(page, "formPublica:camaraPartes", args.jurisdiccion);
            await setCampo(page, "formPublica:tipo", "DEMANDADO").catch(() => { /* select puede venir fijo en DEMANDADO */ });
            await setCampo(page, "formPublica:nomIntervParte", args.nombre.trim());
            await clickPorId(page, "formPublica:buscarPorParteButton");
            return await ejecutarBusqueda(page, `Consulta por parte "${args.nombre}" (${args.jurisdiccion}, DEMANDADO)`, "formPublica:buscarPorParteButton");
        }
        catch (error) {
            return err(`Error en pjn_buscar_expediente_por_parte: ${error instanceof Error ? error.message : String(error)}`);
        }
    });

    server.tool("continuar_tras_captcha", "Continua la consulta DESPUES de que el usuario resolvio el captcha: espera la navegacion (sin tocar la pagina) y devuelve la lista de resultados o el expediente, segun donde haya caido el portal. Llamar SOLO cuando el usuario confirme que resolvio el captcha.", {
        espera_segundos: z.number().int().min(5).max(75).optional().default(45).describe("Cuanto esperar la navegacion post-captcha (default 45s)"),
    }, async (args) => {
        try {
            const page = await getPage();
            // Ya estamos en una pagina util? scrapear directo.
            const directo = await scrapeSegunPagina(page, "Resultados (post-captcha)");
            if (directo) return directo;
            const r = await settle(page, { expectUrls: ["consultaParte.seam", "expediente.seam"], timeoutMs: args.espera_segundos * 1000 });
            if (r.status === "captcha") {
                return err(`El captcha/modal sigue visible. El usuario debe terminar de resolverlo en la ventana de Chromium; despues volver a llamar continuar_tras_captcha. No relanzar la busqueda.`);
            }
            if (r.status === "timeout") {
                const estado = await estadoCaptcha(page);
                if (estado === "aprobado" && urlEs(page, "home.seam")) {
                    return txt(`Captcha APROBADO pero la busqueda no se envio (la pagina sigue en la home). RELANZA ahora la misma busqueda con los mismos parametros: la pagina no se recarga y el reenvio sale con la verificacion ya aprobada.`);
                }
                const aviso = await page.evaluate(() => (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 600)).catch(() => "");
                return err(`Tras el captcha no hubo navegacion a resultados ni a expediente (URL actual: ${r.url}). Puede que el portal haya rechazado la verificacion o que la busqueda no se haya enviado. Texto visible: ${aviso}\n\nSi la pagina volvio a la home, ahi si corresponde relanzar la busqueda.`);
            }
            const out = await scrapeSegunPagina(page, "Resultados (post-captcha)");
            return out || err(`Pagina inesperada: ${r.url}`);
        }
        catch (error) {
            return err(`Error en continuar_tras_captcha: ${error instanceof Error ? error.message : String(error)}`);
        }
    });

    server.tool("obtener_resultados", "Relee la pagina actual de la sesion HITL: lista de resultados (consultaParte.seam) o expediente abierto (expediente.seam). Para el flujo post-captcha usar continuar_tras_captcha.", {}, async () => {
        try {
            const page = await getPage();
            const out = await scrapeSegunPagina(page, "Resultados actuales");
            if (out) return out;
            return err(`No estamos en una pagina de resultados ni de expediente (URL actual: ${page.url()}). Ejecuta primero una busqueda.`);
        }
        catch (error) {
            return err(`Error en obtener_resultados: ${error instanceof Error ? error.message : String(error)}`);
        }
    });

    server.tool("abrir_expediente", "Abre el detalle de un expediente desde la pagina de resultados (click en la fila indicada) y devuelve datos + actuaciones.", {
        fila: z.number().int().min(0).describe("Indice de fila devuelto por la busqueda (columna 'fila')"),
    }, async (args) => {
        try {
            const page = await getPage();
            if (!urlEs(page, "consultaParte.seam")) {
                return err(`No estamos en la pagina de resultados (URL actual: ${page.url()}). Ejecuta primero una busqueda.`);
            }
            const ok = await page.evaluate((n) => {
                const tablas = [...document.querySelectorAll("table")].filter((t) =>
                    [...t.querySelectorAll("th")].some((th) => /expediente/i.test(th.textContent || "")));
                const tr = tablas[0] && tablas[0].querySelectorAll("tbody tr")[n];
                const a = tr && tr.querySelector("a");
                if (!a) return false;
                a.click();
                return true;
            }, args.fila);
            if (!ok) return err(`No encontre el link de la fila ${args.fila}.`);
            const r = await settle(page, { expectUrls: ["expediente.seam"] });
            if (r.status === "captcha") return txt(AVISO_CAPTCHA);
            if (r.status === "timeout") return err(`No se llego al detalle del expediente (URL actual: ${r.url}).`);
            const det = await scrapeExpediente(page);
            return txt(formatearExpediente(det));
        }
        catch (error) {
            return err(`Error en abrir_expediente: ${error instanceof Error ? error.message : String(error)}`);
        }
    });

    server.tool("obtener_actuaciones", "Devuelve las actuaciones del expediente actualmente abierto en la sesion HITL (expediente.seam). Si se pasa 'fila', primero abre ese expediente desde los resultados.", {
        fila: z.number().int().min(0).optional().describe("Opcional: fila de resultados a abrir antes de scrapear"),
    }, async (args) => {
        try {
            const page = await getPage();
            if (typeof args.fila === "number" && urlEs(page, "consultaParte.seam")) {
                const ok = await page.evaluate((n) => {
                    const tablas = [...document.querySelectorAll("table")].filter((t) =>
                        [...t.querySelectorAll("th")].some((th) => /expediente/i.test(th.textContent || "")));
                    const tr = tablas[0] && tablas[0].querySelectorAll("tbody tr")[n];
                    const a = tr && tr.querySelector("a");
                    if (!a) return false;
                    a.click();
                    return true;
                }, args.fila);
                if (!ok) return err(`No encontre el link de la fila ${args.fila}.`);
                const r = await settle(page, { expectUrls: ["expediente.seam"] });
                if (r.status === "captcha") return txt(AVISO_CAPTCHA);
                if (r.status === "timeout") return err(`No se llego al detalle (URL actual: ${r.url}).`);
            }
            if (!urlEs(page, "expediente.seam")) {
                return err(`No hay un expediente abierto (URL actual: ${page.url()}). Ejecuta una busqueda y abrir_expediente, o pasa 'fila'.`);
            }
            const det = await scrapeExpediente(page);
            return txt(formatearExpediente(det));
        }
        catch (error) {
            return err(`Error en obtener_actuaciones: ${error instanceof Error ? error.message : String(error)}`);
        }
    });

    server.tool("pjn_obtener_resoluciones_expediente", "Devuelve solo las actuaciones del expediente abierto que parecen resoluciones/autos/sentencias (filtro heuristico sobre TIPO y DESCRIPCION).", {
        fila: z.number().int().min(0).optional().describe("Opcional: fila de resultados a abrir antes de filtrar"),
    }, async (args) => {
        try {
            const page = await getPage();
            if (typeof args.fila === "number" && urlEs(page, "consultaParte.seam")) {
                const ok = await page.evaluate((n) => {
                    const tablas = [...document.querySelectorAll("table")].filter((t) =>
                        [...t.querySelectorAll("th")].some((th) => /expediente/i.test(th.textContent || "")));
                    const tr = tablas[0] && tablas[0].querySelectorAll("tbody tr")[n];
                    const a = tr && tr.querySelector("a");
                    if (!a) return false;
                    a.click();
                    return true;
                }, args.fila);
                if (!ok) return err(`No encontre el link de la fila ${args.fila}.`);
                const r = await settle(page, { expectUrls: ["expediente.seam"] });
                if (r.status !== "ok") return err(`No se llego al detalle (estado: ${r.status}).`);
            }
            if (!urlEs(page, "expediente.seam")) {
                return err(`No hay un expediente abierto (URL actual: ${page.url()}).`);
            }
            const det = await scrapeExpediente(page);
            return txt(formatearExpediente(det, { soloResoluciones: true }));
        }
        catch (error) {
            return err(`Error en pjn_obtener_resoluciones_expediente: ${error instanceof Error ? error.message : String(error)}`);
        }
    });

    server.tool("volver_a_resultados", "Vuelve de la pagina de expediente a la lista de resultados (history back). Si la conversacion Seam expiro, rehace la busqueda.", {}, async () => {
        try {
            const page = await getPage();
            await page.goBack({ waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => { });
            if (urlEs(page, "consultaParte.seam")) {
                const res = await scrapeResultados(page);
                return txt(formatearResultados(res, "Resultados (back)"));
            }
            return err(`El back no volvio a resultados (URL actual: ${page.url()}). La conversacion Seam pudo expirar: rehace la busqueda.`);
        }
        catch (error) {
            return err(`Error en volver_a_resultados: ${error instanceof Error ? error.message : String(error)}`);
        }
    });

    // ---- Utilitarias -------------------------------------------------------
    server.tool("exportar_expediente", "Exporta el expediente actualmente abierto a Markdown con frontmatter YAML (Obsidian/Notion).", {}, async () => {
        try {
            const page = await getPage();
            if (!urlEs(page, "expediente.seam")) return err(`No hay un expediente abierto (URL actual: ${page.url()}).`);
            const det = await scrapeExpediente(page);
            const fecha = new Date().toISOString();
            let out = `---\ntitle: "Expediente PJN"\nsource: "Poder Judicial de la Nacion - Consulta publica"\nsource_url: "${det.url}"\nexport_date: "${fecha}"\ntags:\n  - PJN\n  - expediente-judicial\n---\n\n`;
            out += formatearExpediente(det);
            out += `\n\n---\n*Exportado desde la consulta publica del PJN el ${fecha}. Verificar siempre en la fuente oficial.*`;
            return txt(out);
        }
        catch (error) {
            return err(`Error en exportar_expediente: ${error instanceof Error ? error.message : String(error)}`);
        }
    });

    server.tool("exportar_expediente_md", "Exporta el expediente abierto a la boveda como carpeta por causa: una nota Markdown por actuacion + nota indice (MOC) 00-INDICE.md, todas con frontmatter YAML (fuero, expediente, anio, fecha, tipo, tags) para Obsidian. Destino default: variable de entorno LEGAL_BOVEDA o D:\\DERECHO\\Cerebro Digital\\Casos. ATENCION: exporta datos REALES sin anonimizar; no subir a servicios externos (NotebookLM incluido) sin anonimizacion previa.", {
        carpeta_destino: z.string().optional().describe("Carpeta base de casos. Default: env LEGAL_BOVEDA o D:\\DERECHO\\Cerebro Digital\\Casos"),
        alias_causa: z.string().optional().describe("Nombre de la carpeta de la causa (se recomienda un alias opaco). Default: FUERO-NUMERO-ANIO"),
        sobrescribir: z.boolean().optional().describe("true reescribe las notas de actuacion existentes. Default false: las existentes se conservan (export incremental); el indice se regenera siempre."),
    }, async (args) => {
        try {
            const page = await getPage();
            if (!urlEs(page, "expediente.seam")) return err(`No hay un expediente abierto (URL actual: ${page.url()}). Abrilo con consultar_expediente / abrir_expediente y reintenta.`);
            const det = await scrapeExpediente(page, { maxFilas: 2000 });
            const datos = parseDatosExpediente(det);
            const { tabla, actuaciones } = extraerActuaciones(det);
            if (!actuaciones.length) return err(`No se encontro la tabla de actuaciones en la pagina. Tablas detectadas: ${(det.tablas || []).map((t) => t.headers.join("|")).join(" // ") || "ninguna"}.`);

            const base = (args.carpeta_destino || BOVEDA_DEFAULT).trim();
            const alias = slugArchivo(args.alias_causa || [datos.fuero || "PJN", datos.numero || "s-n", datos.anio || "s-a"].join("-"), 80);
            const dirCausa = path.join(base, alias);
            const dirAct = path.join(dirCausa, "actuaciones");
            fs.mkdirSync(dirAct, { recursive: true });

            // Orden cronologico ascendente solo si TODAS las fechas parsean
            // (numeracion NNN estable entre exportes incrementales); si alguna
            // falla, se respeta el orden del portal.
            const ordenadas = actuaciones.every((a) => a.fechaIso)
                ? [...actuaciones].sort((a, b) => (a.fechaIso === b.fechaIso ? a.orden - b.orden : (a.fechaIso < b.fechaIso ? -1 : 1)))
                : [...actuaciones];

            const fechaExp = new Date().toISOString();
            const fmCausa = (extra) => `---\n` +
                `causa: "${yamlVal(alias)}"\n` +
                `fuero: "${yamlVal(datos.fuero || "")}"\n` +
                `expediente: "${yamlVal(datos.numero || "")}"\n` +
                `anio: "${yamlVal(datos.anio || "")}"\n` +
                `caratula: "${yamlVal(datos.caratula || "")}"\n` +
                `dependencia: "${yamlVal(datos.dependencia || "")}"\n` +
                extra +
                `source: "Poder Judicial de la Nacion - Consulta publica"\n` +
                `source_url: "${yamlVal(det.url)}"\n` +
                `export_date: "${fechaExp}"\n`;

            let creadas = 0, conservadas = 0;
            const indiceFilas = [];
            ordenadas.forEach((a, i) => {
                const n = String(i + 1).padStart(3, "0");
                const nombre = `${n}-${a.fechaIso || "sin-fecha"}-${slugArchivo(a.tipo || "actuacion", 40)}.md`;
                indiceFilas.push({ n, nombre, a });
                const ruta = path.join(dirAct, nombre);
                if (!args.sobrescribir && fs.existsSync(ruta)) { conservadas++; return; }
                const nota = fmCausa(
                    `fecha_actuacion: "${yamlVal(a.fechaIso || a.fecha)}"\n` +
                    `tipo: "${yamlVal(a.tipo)}"\n` +
                    `oficina: "${yamlVal(a.oficina)}"\n` +
                    `fojas: "${yamlVal(a.fojas)}"\n` +
                    `documento_descargable: ${a.descargable ? "true" : "false"}\n`) +
                    `tags:\n  - PJN\n  - actuacion\n  - causa/${alias}\n---\n\n` +
                    `# ${a.fecha || "Sin fecha"} - ${a.tipo || "Actuacion"}\n\n` +
                    `${a.descripcion || "(sin descripcion)"}\n\n` +
                    `**Fila original del portal:** ${a.celdas.join(" | ")}\n\n` +
                    `---\n*Exportado desde la consulta publica del PJN el ${fechaExp}. Verificar siempre en la fuente oficial.*\n`;
                fs.writeFileSync(ruta, nota, "utf8");
                creadas++;
            });

            // Indice MOC: se regenera completo en cada exporte. El encabezado
            // se recorta desde "Datos Generales" (antes viene boilerplate de
            // accesibilidad y menu del portal, verificado en vivo).
            const encMoc = (det.encabezado || "").replace(/^.*?(?=Datos Generales|Expediente:)/, "");
            let moc = fmCausa(`tipo: "indice-causa"\nsituacion: "${yamlVal(datos.situacion || "")}"\ntotal_actuaciones: ${ordenadas.length}\n`) +
                `tags:\n  - PJN\n  - expediente-judicial\n  - MOC\n  - causa/${alias}\n---\n\n` +
                `# ${datos.caratula || alias}\n\n## Datos del expediente\n\n${encMoc}\n\n` +
                `## Actuaciones (${ordenadas.length})\n\n| # | Fecha | Tipo | Nota |\n|---|---|---|---|\n`;
            for (const { n, nombre, a } of indiceFilas) {
                moc += `| ${n} | ${a.fecha || "-"} | ${a.tipo || "-"} | [[actuaciones/${nombre.replace(/\.md$/, "")}]] |\n`;
            }
            for (const t of det.tablas || []) {
                if (t === tabla) continue;
                moc += `\n## Anexo - ${t.headers.join(" | ")}\n\n| ${t.headers.join(" | ")} |\n|${"---|".repeat(t.headers.length)}\n`;
                for (const f of t.filas) moc += `| ${f.slice(0, t.headers.length).join(" | ")} |\n`;
            }
            moc += `\n---\n*Exportado desde la consulta publica del PJN el ${fechaExp}. DATOS REALES sin anonimizar: pasar por anonimizacion antes de subir a cualquier servicio externo.*\n`;
            fs.writeFileSync(path.join(dirCausa, "00-INDICE.md"), moc, "utf8");

            return txt(`# Exportacion a boveda completada\n\n` +
                `**Carpeta de la causa:** ${dirCausa}\n` +
                `**Notas de actuacion:** ${creadas} creadas${conservadas ? `, ${conservadas} conservadas (ya existian; sobrescribir=true para regenerarlas)` : ""}\n` +
                `**Indice (MOC):** ${path.join(dirCausa, "00-INDICE.md")} (regenerado)\n` +
                `**Actuaciones detectadas:** ${ordenadas.length}${tabla.total > tabla.filas.length ? ` - ATENCION: la pagina reporta ${tabla.total}; se exporto lo visible` : ""}\n\n` +
                `> Las notas contienen DATOS REALES. Antes de subirlas a NotebookLM u otro servicio: anonimizar (eje 2 del plan).`);
        }
        catch (error) {
            return err(`Error en exportar_expediente_md: ${error instanceof Error ? error.message : String(error)}`);
        }
    });

    server.tool("generar_certificacion_forense", "Genera certificacion de trazabilidad de la pagina actualmente abierta en la sesion HITL: URL, timestamp UTC y hash SHA-256 del HTML descargado.", {}, async () => {
        try {
            const page = await getPage();
            const html = await page.content();
            const url = page.url();
            const timestamp = new Date().toISOString();
            const hash = crypto.createHash("sha256").update(html, "utf8").digest("hex");
            let out = `::: ACTA DE TRAZABILIDAD - Poder Judicial de la Nacion (consulta publica)\n\n`;
            out += `| Metadato | Valor |\n| :--- | :--- |\n`;
            out += `| URL de origen | ${url} |\n| Timestamp UTC | ${timestamp} |\n| Tamano HTML | ${Buffer.byteLength(html, "utf8")} bytes |\n| SHA-256 del HTML | ${hash} |\n\n`;
            out += `> Certifica que el HTML fue obtenido desde la fuente oficial en el momento indicado, dentro de una sesion validada por un humano (HITL). No constituye certificacion oficial del PJN.\n`;
            return txt(out);
        }
        catch (error) {
            return err(`Error en generar_certificacion_forense: ${error instanceof Error ? error.message : String(error)}`);
        }
    });

    server.tool("detector_plazos_judiciales", "Audita texto de actuaciones judiciales para detectar plazos, fechas limite e hitos temporales.", {
        texto_actuaciones: z.string().describe("Texto de las actuaciones judiciales a analizar"),
    }, async (args) => {
        try {
            const text = args.texto_actuaciones;
            // Set curado (mismos criterios que PTN/BOPBA, fix ronda 5): sin flag /g
            // en .test(), tildes cubiertas, plazos en letras y formatos forenses.
            const patterns = [
                { regex: /\b(\d+|un|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|quince|veinte|treinta)\s*(\(\d+\)\s*)?(d[ií]as?|meses|años?|horas?)(\s+(h[aá]biles|corridos|judiciales))?\b/i, name: "Plazo" },
                { regex: /\bdentro\s+de(l\s+plazo)?(\s+de)?(\s+los)?\s+\w+/i, name: "Plazo 'dentro de'" },
                { regex: /\bcontados?\s+(a\s+partir|desde)\b/i, name: "Computo del plazo" },
                { regex: /\bbajo\s+apercibimiento\b/i, name: "Apercibimiento" },
                { regex: /\b(perentori[oa]|improrrogable|fatal)\b/i, name: "Plazo perentorio" },
                { regex: /\b(pr[oó]rroga|prorrogar|suspensi[oó]n\s+de(l)?\s+plazo|interrupci[oó]n\s+de(l)?\s+plazo)\b/i, name: "Prorroga/suspension" },
                { regex: /\b(prescribe|prescripci[oó]n)\b/i, name: "Prescripcion" },
                { regex: /\b(caduca|caducidad)\b/i, name: "Caducidad" },
                { regex: /\b(vencimiento|vence|mora)\b/i, name: "Vencimiento/Mora" },
                { regex: /\b\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\b/, name: "Fecha especifica" },
                { regex: /\b\d{1,2}°?\s+de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)(\s+de\s+\d{4})?\b/i, name: "Fecha en letras" },
                { regex: /\b(hasta\s+el|a\s+m[aá]s\s+tardar)\b/i, name: "Fecha limite" },
                { regex: /\b(cita(r|ci[oó]n)|audiencia|comparendo|emplazamiento)\b/i, name: "Citacion/Audiencia" },
                { regex: /\b(notificaci[oó]n|notif[ií]quese|c[eé]dula)\b/i, name: "Notificacion" },
            ];
            const paragraphs = text.split(/\n\n+|\.\s+(?=[A-ZÁÉÍÓÚ])/);
            const results = [];
            for (const paragraph of paragraphs) {
                const trimmed = paragraph.trim();
                if (!trimmed || trimmed.length < 10) continue;
                const found = [...new Set(patterns.filter((p) => p.regex.test(trimmed)).map((p) => p.name))];
                if (found.length) results.push({ paragraph: trimmed.slice(0, 500) + (trimmed.length > 500 ? "..." : ""), matches: found });
            }
            let content = `# Auditoria de Plazos Judiciales\n\nSe identificaron **${results.length}** pasajes con indicadores temporales.\n\n`;
            if (!results.length) {
                content += `No se detectaron plazos ni hitos temporales en el texto analizado.\n`;
            } else {
                results.forEach((r, i) => { content += `### ${i + 1}. [${r.matches.join(", ")}]\n> ${r.paragraph}\n\n`; });
            }
            content += `\n> Herramienta de deteccion de patrones; no reemplaza la lectura del documento original.`;
            return txt(content);
        }
        catch (error) {
            return err(`Error al detectar plazos judiciales: ${error.message}`);
        }
    });

    server.tool("alcance_fuente", "Informa capacidades, flujo HITL, fuentes y limitaciones del conector pjn-consulta-mcp.", {}, async () => {
        const text = `# Alcance y Fuentes - PJN Consulta (scw.pjn.gov.ar)

## Arquitectura (reescritura 10/06/2026)
Todas las consultas corren DENTRO de un navegador interactivo (HITL). El captcha del PJN (servicio propio, captcha.pjn.gov.ar) lo resuelve SIEMPRE el usuario; el conector nunca lo automatiza.

## Flujo de uso
1. \`iniciar_hitl_browser\` - abre la sesion (una vez).
2. \`consultar_expediente\` (jurisdiccion+numero+anio) o \`pjn_buscar_expediente_por_parte\` (solo DEMANDADO, limite del portal publico).
3. Si aparece captcha: el usuario lo resuelve en la ventana y avisa "listo" -> \`continuar_tras_captcha\` (NUNCA relanzar la busqueda con captcha pendiente: lo anula).
4. \`abrir_expediente\` / \`obtener_actuaciones\` / \`pjn_obtener_resoluciones_expediente\`.
5. \`volver_a_resultados\` para iterar; \`exportar_expediente\` (Markdown al chat), \`exportar_expediente_md\` (carpeta por causa en la boveda: nota por actuacion + indice MOC) / \`generar_certificacion_forense\` para documentar.
6. \`finalizar_hitl_browser\` al terminar todo.

## Jurisdicciones
${JURISDICCIONES.join(", ")}

## Limitaciones conocidas
- Consulta publica anonima: por parte solo admite tipo DEMANDADO (regla del portal).
- Sin descarga de PDFs de actuaciones en la consulta publica anonima.
- Reparacion Historica y Gestion Documental: no implementadas en esta version.
- La conversacion Seam expira: si \`volver_a_resultados\` falla, rehacer la busqueda.

## Aviso
Conector de investigacion sobre el portal publico oficial. No constituye asesoramiento juridico ni certificacion oficial.`;
        return txt(text);
    });

    // ---- Stubs honestos (capacidades que el portal publico NO ofrece) ------
    const stub = (nombre, motivo) => server.tool(nombre, `NO DISPONIBLE: ${motivo}`, {}, async () =>
        err(`${nombre} no esta disponible: ${motivo}`));
    stub("buscar_por_semantica", "el portal publico del PJN solo busca por numero de expediente o por parte demandada; no existe busqueda tematica/semantica. Usar JUBA o PJN Jurisprudencia para busqueda por temas.");
    stub("relacionar_expedientes", "el portal publico no ofrece expedientes relacionados. Alternativa: pjn_buscar_expediente_por_parte con el nombre de la parte para listar todas sus causas como demandada.");
    stub("pjn_buscar_reparacion_historica", "la solapa existe en el portal pero no fue mapeada aun en esta version del conector.");
    stub("pjn_buscar_gestion_documental", "corresponde a otro sitio (www.pjn.gov.ar/gestion-documental) no cubierto por esta version.");
    stub("pjn_descargar_documento_actuacion", "no implementada aun en esta version. El portal SI muestra enlaces 'Descargar'/'Ver' por actuacion (verificado 10/6/26); el mapeo de esa descarga queda pendiente para una proxima iteracion.");
    stub("pjn_descargar_documento_gestion", "corresponde a Gestion Documental, no cubierto por esta version.");
}

export function registerAllPrompts(server) {
    server.prompt("auditar_expediente", "Auditoria del estado procesal de un expediente via sesion HITL.", {
        jurisdiccion: z.string().describe("Codigo de jurisdiccion (ej. CIV)"),
        numero: z.string().describe("Numero de expediente"),
        anio: z.string().describe("Anio"),
    }, (args) => ({
        messages: [{
            role: "user",
            content: {
                type: "text",
                text: `Audita el expediente ${args.jurisdiccion} ${args.numero}/${args.anio}:\n1. iniciar_hitl_browser (si no hay sesion).\n2. consultar_expediente con esos datos. Si aparece captcha, pedi al usuario que lo resuelva y segui con obtener_resultados.\n3. abrir_expediente sobre la fila correcta.\n4. detector_plazos_judiciales sobre el texto de las actuaciones.\n5. Elabora un reporte del estado procesal con plazos detectados.`
            }
        }]
    }));
}

export const server = new McpServer({
    name: "pjn-consulta-mcp",
    version: "2.0.0"
});
registerAllTools(server);
registerAllPrompts(server);

if (typeof process !== "undefined" && !process.env.VERCEL && !process.env.NEXT_RUNTIME) {
    const cleanupBrowser = async () => {
        if (globalBrowser) {
            try { await globalBrowser.close(); } catch { /* ignorar */ }
            globalBrowser = null;
            globalPage = null;
        }
    };
    process.on("SIGINT", async () => { await cleanupBrowser(); process.exit(0); });
    process.on("SIGTERM", async () => { await cleanupBrowser(); process.exit(0); });
    process.on("exit", () => { if (globalBrowser) { try { globalBrowser.process()?.kill(); } catch { /* ignorar */ } } });
    const transport = new StdioServerTransport();
    server.connect(transport).catch((err2) => {
        console.error("Server connection failed", err2);
        process.exit(1);
    });
    console.error("PJN Consulta MCP (HITL v2) corriendo via Stdio.");
}
//# sourceMappingURL=pjn.js.map
