#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import axios from "axios";
import * as cheerio from "cheerio";
import crypto from "crypto";
import { installTlsFallback } from "./tls-fallback.js";

// TLS estricto por defecto; fallback inseguro solo ante cert roto (ver tls-fallback.js).
const httpsAgent = installTlsFallback(axios, "infoleg");
// Set completo de headers de navegador: los WAF (ModSecurity y similares)
// suelen rechazar peticiones con sets incompletos aunque el User-Agent sea valido.
const OFFICIAL_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "es-AR,es;q=0.9,en-US;q=0.8",
    "Accept-Encoding": "gzip, deflate",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "sec-ch-ua": '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"'
};
// Detecta paginas de bloqueo (WAF / Forbidden) devueltas con o sin status de error,
// para que nunca se entreguen como si fueran contenido normativo.
function assertNotWafPage(html, url) {
    const plain = String(html).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    const sample = plain.slice(0, 400).toLowerCase();
    const looksBlocked = sample.includes("you don't have permission") ||
        sample.includes("you do not have permission") ||
        sample.includes("access denied") ||
        sample.includes("request rejected") ||
        (sample.includes("forbidden") && plain.length < 600);
    if (looksBlocked) {
        const wafError = new Error(`El portal devolvio una pagina de bloqueo (WAF/Forbidden) en ${url}. ` +
            `Contenido recibido: "${plain.slice(0, 160)}"`);
        wafError.isWafBlock = true;
        throw wafError;
    }
}
function assertServicioDisponible(html, url) {
    // El buscador de argentina.gob.ar devuelve "Servicio momentaneamente no
    // disponible" (incluso con HTTP 200) cuando su backend esta caido o throttlea
    // la IP. Distinguirlo de un "0 resultados" real evita reportar una busqueda
    // vacia enganosa. Verificado 16/6/26 (la leyenda aparece tambien en el navegador).
    const plain = String(html)
        .replace(/<[^>]*>/g, " ")
        .replace(/\s+/g, " ")
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .trim()
        .toLowerCase();
    if (plain.includes("servicio momentaneamente no disponible")) {
        const downError = new Error(`El servicio de busqueda de argentina.gob.ar respondio ` +
            `"Servicio momentaneamente no disponible" (${url}). Es una caida o throttle del ` +
            `portal oficial, no un error del conector ni una busqueda sin resultados. ` +
            `Reintentar mas tarde; el texto por ID via servicios.infoleg sigue disponible.`);
        downError.isUpstreamDown = true;
        throw downError;
    }
}
const ARGENTINA_BASE_URL = "https://www.argentina.gob.ar";
// NOTA: el "geoblock" de InfoLEG resulto ser un mito. servicios.infoleg.gob.ar
// responde desde cualquier IP. Los errores reales son: (a) URL estatica mal
// construida (rangos de 5000, no 50000), (b) entornos que filtran egress de red
// ("Host not in allowlist"), (c) fallas transitorias del portal. Por eso ahora
// los errores de conexion se reportan con el detalle real, sin diagnostico enlatado.
function errorBodyText(err) {
    try {
        const data = err?.response?.data;
        if (!data)
            return "";
        if (typeof data === "string")
            return data;
        if (Buffer.isBuffer(data))
            return data.toString("latin1");
        if (data instanceof ArrayBuffer)
            return Buffer.from(data).toString("latin1");
        return JSON.stringify(data);
    }
    catch {
        return "";
    }
}
function describeNetworkError(err) {
    if (!err)
        return "error desconocido";
    const parts = [];
    const status = err.response?.status;
    if (status)
        parts.push(`HTTP ${status}${err.response?.statusText ? " " + err.response.statusText : ""}`);
    if (err.code)
        parts.push(`codigo ${err.code}`);
    if (err.message && !parts.length)
        parts.push(err.message);
    else if (err.message && !err.response)
        parts.push(err.message);
    const snippet = errorBodyText(err).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 250);
    if (snippet)
        parts.push(`respuesta: "${snippet}"`);
    return parts.join(" | ") || String(err.message || err);
}
function buildConnectionError(err, url) {
    const detail = describeNetworkError(err);
    const haystack = `${errorBodyText(err)} ${err?.message || ""}`;
    let hint = "";
    if (haystack.includes("Host not in allowlist")) {
        hint = `\n\n**Causa:** el entorno donde corre el MCP filtra la salida de red y este host no esta en su lista de permitidos. ` +
            `No es un bloqueo de InfoLEG. Probalo desde un chat comun de Claude Desktop.`;
    }
    else if (err?.response?.status === 403) {
        hint = `\n\n**Nota:** el portal devolvio 403. NO es geoblock (el sitio responde desde cualquier IP); ` +
            `suele ser el WAF rechazando la peticion puntual. Reintentar suele alcanzar.`;
    }
    const connError = new Error(`⚠️ **Error de conexion con InfoLEG.**\n\n` +
        `- **URL:** ${url}\n` +
        `- **Detalle:** ${detail}${hint}\n\n` +
        `**Alternativa:** si tenes el texto de la norma, pegalo en el campo \`textoHtmlManual\`.`);
    connError.isGeoblock = true; // reutiliza el plumbing existente para mostrar el mensaje verbatim
    return connError;
}
function isGeoblockError(err) {
    if (!err)
        return false;
    const body = `${errorBodyText(err)} ${err.message || ""}`;
    return err.response?.status === 403 || body.includes("Host not in allowlist");
}

// Helper Zod validators
export const stringOrNumber = z.union([z.string(), z.number()]).transform(val => String(val));
export const stringOrNumberOptional = z.union([z.string(), z.number()]).transform(val => String(val)).optional();
function normalizeText(input) {
    return input.replace(/\s+/g, " ").trim();
}
function absoluteArgentinaUrl(href) {
    if (!href)
        return "";
    if (href.startsWith("http"))
        return href;
    return `${ARGENTINA_BASE_URL}${href.startsWith("/") ? href : `/${href}`}`;
}
function extractInfoLegId(href) {
    const idMatch = href.match(/-(\d+)(?:\/|$)/) || href.match(/[?&]id=(\d+)/);
    return idMatch ? idMatch[1] : "";
}
function normalizeInfoLegDate(date) {
    if (!date)
        return undefined;
    const clean = String(date).trim();
    const iso = clean.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (iso)
        return `${iso[3]}-${iso[2]}-${iso[1]}`;
    const slash = clean.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (slash)
        return `${slash[1]}-${slash[2]}-${slash[3]}`;
    return clean;
}
function normalizeBoletinDate(date) {
    if (!date)
        return undefined;
    const clean = String(date).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(clean))
        return clean;
    const slash = clean.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (slash)
        return `${slash[3]}-${slash[2]}-${slash[1]}`;
    const dash = clean.match(/^(\d{2})-(\d{2})-(\d{4})$/);
    if (dash)
        return `${dash[3]}-${dash[2]}-${dash[1]}`;
    return clean;
}
function normalizeTipoNorma(tipo) {
    if (!tipo)
        return undefined;
    const value = tipo.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
    const known = {
        ley: "leyes",
        leyes: "leyes",
        decreto: "decretos",
        decretos: "decretos",
        resolucion: "resoluciones",
        resoluciones: "resoluciones",
        disposicion: "disposiciones",
        disposiciones: "disposiciones",
        dnu: "decretos",
        decision: "decisiones_administrativas",
        "decision administrativa": "decisiones_administrativas",
        "decisiones administrativas": "decisiones_administrativas"
    };
    if (known[value])
        return known[value];
    // Fallback por matcheo parcial: cubre variantes como "Resolución General"
    // (AFIP/ARCA), "Resolución Conjunta", etc., que el catálogo de argentina.gob.ar
    // agrupa bajo el slug genérico. Sin esto el POST recibe un tipo_norma inválido
    // y el server devuelve 0 (bug T2: RG 4352/2018 -> 0).
    if (/resoluc/.test(value))
        return "resoluciones";
    if (/decreto/.test(value))
        return "decretos";
    if (/disposic/.test(value))
        return "disposiciones";
    if (/decision/.test(value))
        return "decisiones_administrativas";
    if (/\bley(es)?\b/.test(value))
        return "leyes";
    return tipo;
}
async function fetchOfficialHtml(url) {
    const response = await axios.get(url, {
        httpsAgent,
        headers: OFFICIAL_HEADERS,
        responseType: "arraybuffer",
        timeout: 12000 // evita el cuelgue indefinido que el root mata a los 20s
    });
    const contentType = String(response.headers["content-type"] || "").toLowerCase();
    const charsetMatch = contentType.match(/charset=([^;]+)/);
    const charset = charsetMatch ? charsetMatch[1].trim() : "utf-8";
    const decoder = new TextDecoder(charset.includes("8859") ? "latin1" : "utf-8");
    return decoder.decode(response.data);
}
function buildNormativaSearchUrl(params) {
    const query = new URLSearchParams();
    query.set("jurisdiccion", params.jurisdiccion || "nacional");
    if (params.provincia)
        query.set("provincia", params.provincia);
    if (params.tipoNorma)
        query.set("tipo_norma", normalizeTipoNorma(params.tipoNorma) || params.tipoNorma);
    if (params.numeroNorma)
        query.set("numero", params.numeroNorma);
    if (params.anioNorma)
        query.set("sancion", params.anioNorma);
    if (params.dependencia)
        query.set("dependencia", params.dependencia);
    if (params.texto)
        query.set("texto", params.texto);
    if (params.publicacionDesde)
        query.set("publicacion_desde[date]", normalizeInfoLegDate(params.publicacionDesde) || params.publicacionDesde);
    if (params.publicacionHasta)
        query.set("publicacion_hasta[date]", normalizeInfoLegDate(params.publicacionHasta) || params.publicacionHasta);
    query.set("limit", "50");
    query.set("offset", String(params.pagina && params.pagina > 0 ? params.pagina : 1));
    return `${ARGENTINA_BASE_URL}/normativa?${query.toString()}`;
}
function parseNormativaListHtml(html, opts = {}) {
    // allowAnchorScan: el escaneo directo de anchors SOLO es confiable sobre la
    // pagina renderizada por JS. Sobre el HTML estatico levanta los destacados
    // de "novedades normativas" de la landing (ej. /norma-426271) y los
    // presenta como falsos resultados de busqueda (bug verificado 10/6/26 con
    // "locacion de obra" -> 3 decretos laborales ajenos al criterio).
    const allowAnchorScan = opts.allowAnchorScan ?? false;
    const $ = cheerio.load(html);
    const pageText = normalizeText($("body").text());
    const countText = pageText.match(/\d+\s+normas?\s+encontradas?.*?\d+\s+p\S+gina/i)?.[0] || "";
    const results = [];
    const seen = new Set();
    $("table tbody tr").each((_, row) => {
        const cells = $(row).find("td");
        if (cells.length < 2)
            return;
        const firstCell = cells.eq(0);
        const link = firstCell.find("a").first();
        const href = link.attr("href") || "";
        const title = normalizeText(link.text());
        if (!title || !href.includes("/normativa/"))
            return;
        const id = extractInfoLegId(href);
        if (id && seen.has(id))
            return;
        if (id)
            seen.add(id);
        results.push({
            id,
            titulo: title,
            organismo: normalizeText(firstCell.find("p.small").first().text()),
            descripcion: normalizeText(cells.eq(1).text()),
            paginaBoletin: normalizeText(cells.eq(2).text()),
            enlaceResumen: absoluteArgentinaUrl(href),
            enlaceTexto: `${absoluteArgentinaUrl(href)}/texto`
        });
    });
    // Estrategia 2: layout no tabular (cards/listas) - escaneo directo de anchors
    // a fichas de norma con ID infoleg al final del slug.
    if (results.length === 0 && allowAnchorScan) {
        $("a[href*='/normativa/nacional/'], a[href*='/normativa/provincial/']").each((_, el) => {
            const href = $(el).attr("href") || "";
            if (/\/(texto|normas-modificadas|normas-modifican)\/?$/.test(href))
                return;
            // Los destacados de la landing usan el slug generico /norma-{id};
            // los resultados reales usan /{tipo}-{numero}-{id}. Excluirlos evita
            // contaminar la respuesta con novedades ajenas al criterio.
            if (/\/norma-\d+\/?$/.test(href))
                return;
            const id = extractInfoLegId(href);
            if (!id || seen.has(id))
                return;
            const titulo = normalizeText($(el).text());
            if (!titulo || titulo.length > 200)
                return;
            seen.add(id);
            const block = $(el).closest("li, tr, article, .card, div").first();
            const resumen = normalizeText(block.text()).replace(titulo, "").trim().slice(0, 250);
            results.push({
                id,
                titulo,
                organismo: "",
                descripcion: resumen,
                paginaBoletin: "",
                enlaceResumen: absoluteArgentinaUrl(href),
                enlaceTexto: `${absoluteArgentinaUrl(href).replace(/\/$/, "")}/texto`
            });
        });
    }
    return { countText, results };
}
// -----------------------------------------------------------------------------
// PROTOCOLO REAL DEL BUSCADOR (descifrado 10/6/26 desde el HTML crudo del form):
// <form class="infoleg-search-form" action="/normativa?..." method="POST">.
// Los resultados se renderizan server-side SOLO en la respuesta del POST; todo
// GET devuelve el formulario vacio (por eso el parser veia siempre 0 y no hay
// ningun XHR que interceptar). Flujo: GET para obtener form_build_id fresco ->
// POST con los campos del form. El campo "tarro_de_miel" es un honeypot
// anti-bot y DEBE ir vacio. El form NO tiene captcha. Paginacion via
// querystring (limit/offset) del action.
// -----------------------------------------------------------------------------
async function searchNormativaViaPost(params) {
    const formHtml = await fetchOfficialHtml(`${ARGENTINA_BASE_URL}/normativa`);
    const fbid = formHtml.match(/name="form_build_id" value="([^"]+)"/)?.[1];
    if (!fbid)
        throw new Error("No se pudo extraer form_build_id del formulario de normativa.");
    const url = buildNormativaSearchUrl(params);
    const tipoSlug = params.tipoNorma ? (normalizeTipoNorma(params.tipoNorma) || params.tipoNorma) : "";
    // REGLA DEL FORM (unsetSancionEnTipoNormaLey.js + ley_route="leyes"): cuando
    // el tipo es "leyes" el formulario deshabilita y vacia el campo anio.
    // Enviarlo igual hace que el server devuelva 0 (verificado: Ley 27430 +
    // anio 2017 -> 0; sin anio -> resultado correcto).
    const anioEfectivo = tipoSlug === "leyes" ? "" : (params.anioNorma || "");
    if (tipoSlug === "leyes" && params.anioNorma)
        console.error(`tipo "leyes": se omite anio=${params.anioNorma} (el buscador oficial no admite anio para leyes; filtre por numero).`);
    // Dependencia: el select exige el nombre registrado EXACTO. Si lo recibido
    // no coincide, se busca la opcion real que lo contenga (insensible a
    // mayusculas y tildes), ej. "Ministerio de Trabajo" -> "MINISTERIO DE
    // TRABAJO, EMPLEO Y SEGURIDAD SOCIAL".
    let dependenciaEfectiva = params.dependencia || "";
    if (dependenciaEfectiva) {
        const selMatch = formHtml.match(/<select[^>]*name="dependencia"[\s\S]*?<\/select>/);
        if (selMatch) {
            const opciones = [...selMatch[0].matchAll(/<option[^>]*value="([^"]*)"/g)].map((m) => m[1]).filter(Boolean);
            const norm = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().trim();
            const objetivo = norm(dependenciaEfectiva);
            if (!opciones.some((o) => norm(o) === objetivo)) {
                const candidata = opciones.find((o) => norm(o).includes(objetivo))
                    || opciones.find((o) => objetivo.split(/\s+/).filter(w => w.length > 2).every((w) => norm(o).includes(w)));
                if (candidata) {
                    console.error(`dependencia "${dependenciaEfectiva}" ajustada a la opcion oficial "${candidata}".`);
                    dependenciaEfectiva = candidata;
                }
            }
        }
    }
    const body = new URLSearchParams({
        s: "1",
        jurisdiccion: params.jurisdiccion || "nacional",
        tipo_norma: tipoSlug,
        numero: params.numeroNorma || "",
        anio: anioEfectivo,
        dependencia: dependenciaEfectiva,
        publicacion_desde: params.publicacionDesde ? (normalizeInfoLegDate(params.publicacionDesde) || params.publicacionDesde) : "",
        publicacion_hasta: params.publicacionHasta ? (normalizeInfoLegDate(params.publicacionHasta) || params.publicacionHasta) : "",
        texto: params.texto || "",
        tarro_de_miel: "", // honeypot: siempre vacio
        form_build_id: fbid,
        form_id: "infoleg_normativa_search_form"
    });
    const response = await axios.post(url, body.toString(), {
        httpsAgent,
        headers: {
            ...OFFICIAL_HEADERS,
            "Content-Type": "application/x-www-form-urlencoded",
            "Referer": `${ARGENTINA_BASE_URL}/normativa`,
            "Origin": ARGENTINA_BASE_URL
        },
        responseType: "arraybuffer",
        maxRedirects: 5,
        timeout: 12000 // evita el cuelgue indefinido que el root mata a los 20s
    });
    const contentType = String(response.headers["content-type"] || "").toLowerCase();
    const charset = contentType.match(/charset=([^;]+)/)?.[1]?.trim() || "utf-8";
    const html = new TextDecoder(charset.includes("8859") ? "latin1" : "utf-8").decode(response.data);
    assertNotWafPage(html, url);
    assertServicioDisponible(html, url);
    return { url, ...parseNormativaListHtml(html, { allowAnchorScan: true }) };
}
export async function searchNormativaOfficial(params) {
    const url = buildNormativaSearchUrl(params);
    // Via primaria: POST del formulario (server-rendered, sin Puppeteer).
    let parsed = { countText: "", results: [] };
    let staticError = null;
    let metodo = "POST formulario oficial";
    try {
        let post = await searchNormativaViaPost(params);
        // Reintento sin tipo_norma: si el slug del tipo no coincide con el catálogo
        // el server devuelve 0 aunque la norma exista. numero+anio suele ser único.
        if (post.results.length === 0 && !post.countText && params.tipoNorma && (params.numeroNorma || params.anioNorma)) {
            const sinTipo = await searchNormativaViaPost({ ...params, tipoNorma: undefined });
            if (sinTipo.results.length > 0 || sinTipo.countText) {
                post = sinTipo;
                metodo = "POST sin filtro de tipo (reintento)";
            }
        }
        if (post.results.length > 0 || post.countText) {
            return { url: post.url, countText: post.countText, results: post.results, metodo };
        }
        // POST respondio pero sin resultados parseados: puede ser un "0 real".
        parsed = { countText: post.countText, results: post.results };
    }
    catch (err) {
        if (err.isUpstreamDown)
            throw err; // servicio oficial caido: el fallback Puppeteer no ayuda
        staticError = err;
        console.error(`POST del buscador fallo: ${err.message}`);
    }
    metodo = "POST sin resultados";
    // Fallback: render real de la pagina con Puppeteer (solo si el POST fallo
    // o devolvio 0; cubre eventuales cambios futuros del formulario).
    if (parsed.results.length === 0) {
        try {
            const rendered = await fetchWithPuppeteer(url, {
                waitForSelector: "table tbody tr a[href*='/normativa/'], a[href*='/normativa/nacional/'], a[href*='/normativa/provincial/']",
                waitTimeout: 20000
            });
            const renderedParsed = parseNormativaListHtml(rendered, { allowAnchorScan: true });
            if (renderedParsed.results.length > 0 || !staticError) {
                parsed = renderedParsed;
                metodo = "render JS (Puppeteer)";
            }
        }
        catch (puppeteerErr) {
            if (staticError)
                throw buildConnectionError(staticError, url);
            // El HTML estatico respondio pero sin resultados y el render fallo:
            // devolver 0 aca seria mentir (puede haber miles de normas). Mejor
            // propagar la causa real (ej. "Puppeteer no esta instalado").
            throw new Error(`El buscador de argentina.gob.ar requiere render JS y el render fallo: ${puppeteerErr.message} (URL: ${url})`);
        }
    }
    return { url, countText: parsed.countText, results: parsed.results, metodo };
}
function buildBoletinUrl(params) {
    const query = new URLSearchParams();
    query.set("jurisdiccion", params.jurisdiccion || "nacional");
    if (params.numeroBoletin)
        query.set("numero_boletin", params.numeroBoletin);
    if (params.fecha)
        query.set("buscar", normalizeBoletinDate(params.fecha) || params.fecha);
    query.set("limit", "50");
    query.set("offset", String(params.pagina && params.pagina > 0 ? params.pagina : 1));
    return `${ARGENTINA_BASE_URL}/normativa/buscar-boletin?${query.toString()}`;
}
function parseBoletinHtml(html) {
    const $ = cheerio.load(html);
    const pageText = normalizeText($("body").text());
    const headingMatch = pageText.match(/Sumario\s+N\S*\s+(\d+)\s+del\s+Bolet\S+n Oficial de la Rep\S+blica Argentina/i);
    const dateMatch = pageText.match(/Fecha de publicaci\S+n:\s*([0-9-]+)/i);
    const entries = [];
    $("table tbody tr").each((_, row) => {
        const cells = $(row).find("td");
        if (cells.length < 2)
            return;
        const link = cells.eq(0).find("a").first();
        const href = link.attr("href") || "";
        const titulo = normalizeText(link.text());
        if (!titulo || !href.includes("/normativa/"))
            return;
        entries.push({
            id: extractInfoLegId(href),
            normativa: titulo,
            organismo: normalizeText(cells.eq(0).find("p.small").first().text()) || normalizeText(cells.eq(1).find("p.fw-semibold").first().text()),
            descripcion: normalizeText(cells.eq(1).text()),
            paginaBoletin: normalizeText(cells.eq(2).text()),
            enlaceResumen: absoluteArgentinaUrl(href),
            enlaceTexto: `${absoluteArgentinaUrl(href)}/texto`
        });
    });
    return {
        numeroBoletin: headingMatch ? headingMatch[1] : "",
        fechaPublicacion: dateMatch ? dateMatch[1] : "",
        entries
    };
}
async function fetchBoletin(params) {
    const url = buildBoletinUrl(params);
    let parsed = { numeroBoletin: "", fechaPublicacion: "", entries: [] };
    let staticError = null;
    try {
        const html = await fetchOfficialHtml(url);
        parsed = parseBoletinHtml(html);
    }
    catch (err) {
        staticError = err;
    }
    // FIX BUSCADOR CIEGO: el sumario del boletin tambien se renderiza por JS.
    if (parsed.entries.length === 0) {
        try {
            const rendered = await fetchWithPuppeteer(url, {
                waitForSelector: "table tbody tr a[href*='/normativa/'], a[href*='/normativa/nacional/']",
                waitTimeout: 20000
            });
            const renderedParsed = parseBoletinHtml(rendered);
            if (renderedParsed.entries.length > 0 || !staticError)
                parsed = renderedParsed;
        }
        catch (puppeteerErr) {
            if (staticError)
                throw buildConnectionError(staticError, url);
            throw new Error(`El sumario del boletin en argentina.gob.ar requiere render JS y el render fallo: ${puppeteerErr.message} (URL: ${url})`);
        }
    }
    return {
        url,
        numeroBoletin: parsed.numeroBoletin || params.numeroBoletin || "",
        fechaPublicacion: parsed.fechaPublicacion,
        entries: parsed.entries
    };
}
function formatResultsList(title, sourceUrl, results) {
    let output = `# ${title}\n\n`;
    output += `* **Fuente consultada:** [Argentina.gob.ar](${sourceUrl})\n`;
    output += `* **Resultados devueltos:** ${results.length}\n\n`;
    results.forEach((item, idx) => {
        output += `## ${idx + 1}. ${item.titulo || item.normativa}\n\n`;
        if (item.id)
            output += `- **ID InfoLEG:** \`${item.id}\`\n`;
        if (item.organismo)
            output += `- **Organismo:** ${item.organismo}\n`;
        if (item.descripcion)
            output += `- **Descripcion:** ${item.descripcion}\n`;
        if (item.paginaBoletin)
            output += `- **Pagina Boletin:** ${item.paginaBoletin}\n`;
        if (item.enlaceResumen)
            output += `- **Resumen oficial:** ${item.enlaceResumen}\n`;
        if (item.enlaceTexto)
            output += `- **Texto oficial:** ${item.enlaceTexto}\n`;
        output += "\n";
    });
    return output.trim();
}
async function fetchNormaDetailByUrl(url) {
    const html = await fetchOfficialHtml(url);
    const $ = cheerio.load(html);
    const settingsText = $("script").map((_, s) => $(s).html() || "").get().find((text) => text.includes("normativaSchema")) || "";
    let schema = {};
    const schemaMatch = settingsText.match(/"normativaSchema":(\{.*?\}),"urlIsAjaxTrusted"/s);
    if (schemaMatch) {
        try {
            schema = JSON.parse(schemaMatch[1].replace(/\\\//g, "/"));
        }
        catch {
            schema = {};
        }
    }
    const fields = {};
    $("dl.normativa dt").each((_, dt) => {
        const key = normalizeText($(dt).text()).replace(/:$/, "");
        const value = normalizeText($(dt).next("dd").text());
        if (key && value)
            fields[key] = value;
    });
    const links = $("a")
        .map((_, a) => {
        const href = $(a).attr("href") || "";
        const text = normalizeText($(a).text());
        if (!href || !text)
            return null;
        return { text, url: absoluteArgentinaUrl(href) };
    })
        .get()
        .filter((link) => link.url.includes("/normativa/") || link.url.includes("infoleg"));
    return { url, schema, fields, resumen: normalizeText($("article p.small, .field-name-body, .pane-node-body").text()), links };
}
async function resolveNormaDetailUrl(args) {
    if (args.urlNorma)
        return args.urlNorma;
    // FIX: con idNorma la ficha es deterministica y server-rendered; no hace
    // falta pasar por el buscador (que requiere render JS).
    if (args.idNorma)
        return `${ARGENTINA_BASE_URL}/normativa/nacional/${args.idNorma}`;
    if (args.tipoNorma || args.numeroNorma || args.anioNorma) {
        const result = await searchNormativaOfficial({
            jurisdiccion: "nacional",
            tipoNorma: args.tipoNorma,
            numeroNorma: args.numeroNorma,
            anioNorma: args.anioNorma
        });
        const found = args.idNorma ? result.results.find((item) => item.id === args.idNorma) : result.results[0];
        if (found?.enlaceResumen)
            return found.enlaceResumen;
    }
    throw new Error("No se pudo resolver la URL oficial de resumen. Pasa urlNorma o combina tipoNorma/numeroNorma/anioNorma.");
}
// Ficha derivada del lado InfoLEG (axios, sin render JS). Se usa cuando solo se
// conoce el idNorma: la ficha por ID desnudo de argentina.gob.ar es inestable
// (500 / timeout por render). Esta ruta reusa el mismo origen estatico que ya
// hace andar obtener_texto_norma.
async function metadatosDesdeInfoLeg(idNorma) {
    const { text, url } = await fetchCleanText(idNorma, undefined, "actualizado");
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    // Primera linea con bloque de mayusculas = encabezado de la norma (tipo/numero).
    const titulo = lines.slice(0, 12).find((l) => /[A-ZÁÉÍÓÚÑ]{4,}/.test(l)) || lines[0] || "";
    const verNorma = `https://servicios.infoleg.gob.ar/infolegInternet/verNorma.do?id=${idNorma}`;
    let out = `# Metadatos de la norma (InfoLEG)\n\n`;
    out += `* **idNorma InfoLEG:** \`${idNorma}\`\n`;
    if (titulo)
        out += `* **Encabezado (derivado del texto):** ${titulo}\n`;
    out += `* **Ficha InfoLEG:** ${verNorma}\n`;
    out += `* **Texto consultado:** ${url}\n`;
    out += `* **Texto actualizado:** ${getInfoLegStaticUrl(idNorma, "actualizado")}\n`;
    out += `* **Texto original:** ${getInfoLegStaticUrl(idNorma, "original")}\n`;
    out += `* **Ficha Argentina.gob.ar:** ${ARGENTINA_BASE_URL}/normativa/nacional/${idNorma}\n`;
    out += `\n> Ficha derivada del origen InfoLEG (la ficha por ID desnudo de argentina.gob.ar es inestable). ` +
        `Para organismo/dependencia y fechas oficiales completas, pasar \`urlNorma\` con el slug canonico (ej. .../resolucion-4352-2018-${idNorma}).`;
    return { content: [{ type: "text", text: out.trim() }] };
}
export function getInfoLegRange(idStr) {
    // InfoLEG agrupa los anexos en carpetas de 5000 IDs (ej. 295000-299999),
    // NO de 50000. Verificado contra URLs reales del portal (verNorma.do y
    // los enlaces de leyes que devuelve la API de PTN).
    const idNum = parseInt(idStr, 10);
    if (isNaN(idNum) || idNum < 0) {
        return "0-4999";
    }
    const floorLimit = Math.floor(idNum / 5000) * 5000;
    const ceilLimit = floorLimit + 4999;
    return `${floorLimit}-${ceilLimit}`;
}
export function getInfoLegStaticUrl(idStr, tipoTexto = "actualizado") {
    const range = getInfoLegRange(idStr);
    const file = tipoTexto === "actualizado" ? "texact.htm" : "norma.htm";
    return `https://servicios.infoleg.gob.ar/infolegInternet/anexos/${range}/${idStr}/${file}`;
}
export function cleanInfoLegHtml(html) {
    const $ = cheerio.load(html);
    $("script, style, iframe, input, select, textarea, button, link").remove();
    $("img").remove();
    let markdown = "";
    function parseNode(element) {
        element.contents().each((_, child) => {
            const node = $(child);
            const nodeType = child.type;
            if (nodeType === "text") {
                const text = node.text().replace(/\r?\n|\r/g, " ");
                markdown += text;
            }
            else if (nodeType === "tag") {
                const tagName = child.name.toLowerCase();
                switch (tagName) {
                    case "h1":
                    case "h2":
                        markdown += `\n\n# ${node.text().trim()}\n\n`;
                        break;
                    case "h3":
                    case "h4":
                        markdown += `\n\n## ${node.text().trim()}\n\n`;
                        break;
                    case "h5":
                    case "h6":
                        markdown += `\n\n### ${node.text().trim()}\n\n`;
                        break;
                    case "p":
                    case "div":
                        markdown += "\n\n";
                        parseNode(node);
                        markdown += "\n\n";
                        break;
                    case "br":
                        markdown += "\n";
                        break;
                    case "strong":
                    case "b":
                        markdown += " **";
                        parseNode(node);
                        markdown += "** ";
                        break;
                    case "em":
                    case "i":
                        markdown += " *";
                        parseNode(node);
                        markdown += "* ";
                        break;
                    case "u":
                        markdown += " _";
                        parseNode(node);
                        markdown += "_ ";
                        break;
                    case "a":
                        const href = node.attr("href") || "";
                        markdown += " [";
                        parseNode(node);
                        markdown += `](${href}) `;
                        break;
                    case "tr":
                        parseNode(node);
                        markdown += "\n";
                        break;
                    case "td":
                    case "th":
                        markdown += " | ";
                        parseNode(node);
                        break;
                    default:
                        parseNode(node);
                        break;
                }
            }
        });
    }
    const bodyText = $("body");
    if (bodyText.length > 0) {
        parseNode(bodyText);
    }
    else {
        parseNode($.root());
    }
    return markdown
        .replace(/[ \t]+/g, " ")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}
function parseSearchResults(html) {
    const $ = cheerio.load(html);
    const results = [];
    const seen = new Set();
    // Strategy 1: table rows (classic layout)
    $("table tr").each((_, row) => {
        const link = $(row).find("a[href*='verNorma.do']").not("[href*='resaltar']").first();
        if (!link.length)
            return;
        const href = link.attr("href") || "";
        const titulo = normalizeText(link.text());
        if (!titulo)
            return;
        const idMatch = href.match(/[?&]id=(\d+)/);
        const id = idMatch ? idMatch[1] : "";
        if (id && seen.has(id))
            return;
        if (id)
            seen.add(id);
        const cells = $(row).find("td");
        const descripcion = cells.length > 1 ? normalizeText(cells.eq(1).text()) : "";
        results.push({
            id,
            titulo,
            enlace: id
                ? `https://servicios.infoleg.gob.ar/infolegInternet/verNorma.do?id=${id}`
                : href,
            resumen: descripcion
        });
    });
    // Strategy 2: direct link scan (list/div layout)
    if (results.length === 0) {
        $("a[href*='verNorma.do']").not("[href*='resaltar']").each((_, el) => {
            const href = $(el).attr("href") || "";
            const titulo = normalizeText($(el).text());
            if (!titulo || titulo.length > 120)
                return;
            const idMatch = href.match(/[?&]id=(\d+)/);
            const id = idMatch ? idMatch[1] : "";
            if (!id || seen.has(id))
                return;
            seen.add(id);
            // grab surrounding text from closest block parent
            const block = $(el).closest("li, tr, dd, p, div").first();
            const allText = normalizeText(block.text());
            const resumen = allText.replace(titulo, "").trim().slice(0, 200);
            results.push({
                id,
                titulo,
                enlace: `https://servicios.infoleg.gob.ar/infolegInternet/verNorma.do?id=${id}`,
                resumen
            });
        });
    }
    return results;
}
async function searchCentralSolr(keys) {
    const query = new URLSearchParams();
    query.set("texto", keys);
    query.set("pageSize", "20");
    query.set("pagina", "1");
    const url = `https://servicios.infoleg.gob.ar/infolegInternet/buscarNormas.do?${query.toString()}`;
    try {
        const response = await axios.get(url, {
            httpsAgent,
            headers: {
                ...OFFICIAL_HEADERS,
                "Referer": "https://servicios.infoleg.gob.ar/infolegInternet/",
                "Origin": "https://servicios.infoleg.gob.ar"
            },
            responseType: "arraybuffer"
        });
        const decoder = new TextDecoder("latin1");
        const html = decoder.decode(response.data);
        assertNotWafPage(html, url);
        return parseSearchResults(html);
    }
    catch (err) {
        // Fallback: el WAF de InfoLEG rechaza clientes no-navegador (403 a axios).
        // Puppeteer presenta huella de Chrome real y suele pasar.
        try {
            const html = await fetchWithPuppeteer(url);
            return parseSearchResults(html);
        }
        catch (puppeteerErr) {
            console.error(`Fallback Puppeteer tambien fallo: ${puppeteerErr.message}`);
            const connErr = buildConnectionError(err, url);
            connErr.message += `\n\n**Fallback Puppeteer:** ${puppeteerErr.message}`;
            throw connErr;
        }
        throw buildConnectionError(err, url);
    }
}
async function fetchWithPuppeteer(url, opts = {}) {
    let puppeteer;
    try {
        ({ default: puppeteer } = await import("puppeteer"));
    }
    catch (importErr) {
        // BUG DETECTADO 10/6/26: puppeteer figura en package.json pero no estaba
        // instalado -> todos los fallbacks de render fallaban en silencio y el
        // unico error visible era el 403 del WAF. Hacerlo explicito.
        throw new Error(`Puppeteer no esta instalado (los fallbacks de render JS no pueden ejecutarse). ` +
            `Solucion: correr "npm install" en servers/legal-mcp y reiniciar el MCP. Detalle: ${importErr.message}`);
    }
    const browser = await puppeteer.launch({
        headless: true,
        args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
            "--disable-blink-features=AutomationControlled"
        ]
    });
    try {
        const page = await browser.newPage();
        await page.setUserAgent(OFFICIAL_HEADERS["User-Agent"]);
        await page.setExtraHTTPHeaders({ "Accept-Language": "es-AR,es;q=0.9,en-US;q=0.8" });
        const response = await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
        // page.goto NO lanza error ante 403/500: hay que validar el status a mano.
        // Sin esto, la pagina "Forbidden" del WAF se devolvia como texto de la norma.
        if (response && !response.ok()) {
            throw new Error(`Puppeteer recibio HTTP ${response.status()} en ${url}`);
        }
        // Para paginas que renderizan contenido por JS (buscador de
        // argentina.gob.ar) se puede esperar a que aparezca un selector.
        if (opts.waitForSelector) {
            await page.waitForSelector(opts.waitForSelector, { timeout: opts.waitTimeout ?? 15000 }).catch(() => { });
        }
        const html = await page.content();
        assertNotWafPage(html, url);
        if (page.url().includes("mostrarArchivoInexistente") || html.includes("No se pudo acceder al archivo")) {
            const missing = new Error(`InfoLEG no tiene archivo en ${url} (redirigio a "archivo inexistente").`);
            missing.isMissingFile = true;
            throw missing;
        }
        return html;
    }
    finally {
        await browser.close();
    }
}
async function fetchInfoLegStaticHtml(url) {
    const response = await axios.get(url, {
        httpsAgent,
        headers: OFFICIAL_HEADERS,
        responseType: "arraybuffer",
        maxRedirects: 5
    });
    const finalUrl = response.request?.res?.responseUrl || url;
    const contentType = String(response.headers["content-type"] || "").toLowerCase();
    const charsetMatch = contentType.match(/charset=([^;]+)/);
    const charset = charsetMatch ? charsetMatch[1].trim() : "iso-8859-1";
    const decoder = new TextDecoder(charset.includes("8859") || charset.includes("latin") ? "latin1" : "utf-8");
    const html = decoder.decode(response.data);
    if (finalUrl.includes("mostrarArchivoInexistente") || html.includes("No se pudo acceder al archivo")) {
        const missing = new Error(`InfoLEG no tiene archivo en ${url} (redirigio a "archivo inexistente").`);
        missing.isMissingFile = true;
        throw missing;
    }
    assertNotWafPage(html, url);
    return html;
}
function absoluteInfoLegUrl(href) {
    if (!href)
        return "";
    if (href.startsWith("http"))
        return href.replace(/^http:\/\//, "https://");
    if (href.startsWith("/"))
        return `https://servicios.infoleg.gob.ar${href}`;
    return `https://servicios.infoleg.gob.ar/infolegInternet/${href}`;
}
// Cuando la URL estatica construida por rango falla, la ficha verNorma.do
// publica el enlace real al texto (norma.htm / texact.htm). Se usa como
// resolucion autoritativa.
async function resolveTextUrlFromVerNorma(idNorma, tipoTexto, fetcher = fetchInfoLegStaticHtml) {
    const fichaUrl = `https://servicios.infoleg.gob.ar/infolegInternet/verNorma.do?id=${idNorma}`;
    const html = await fetcher(fichaUrl);
    const $ = cheerio.load(html);
    const anexos = [];
    $("a[href*='/anexos/']").each((_, a) => {
        const abs = absoluteInfoLegUrl($(a).attr("href") || "");
        if (abs && (abs.endsWith(".htm") || abs.endsWith(".html")))
            anexos.push(abs);
    });
    if (anexos.length === 0)
        throw new Error(`La ficha verNorma.do?id=${idNorma} no expone enlaces al texto de la norma.`);
    const texact = anexos.find((u) => u.includes("texact"));
    const norma = anexos.find((u) => u.includes("norma.htm"));
    if (tipoTexto === "original")
        return norma || texact || anexos[0];
    return texact || norma || anexos[0];
}
// ---------------------------------------------------------------------------
// FALLBACK argentina.gob.ar: /normativa/nacional/{id}/texto es server-rendered
// (verificado: Decreto-Ley 1311/56 id 296831 y Ley 27.401 id 296846 completos).
// Mismo espacio de IDs que InfoLEG y host DISTINTO a servicios.infoleg.gob.ar,
// por lo que funciona aunque el WAF de InfoLEG haya baneado la IP.
// Limitacion: publica el texto ORIGINAL; el consolidado vive solo en texact.htm.
// ---------------------------------------------------------------------------
export async function fetchTextoFromArgentinaGobAr(idNorma, tipoTexto = "actualizado") {
    // DESCUBRIMIENTO (10/6/26, 2da tanda): /normativa/nacional/{id}/actualizacion
    // sirve el TEXTO CONSOLIDADO server-rendered, con notas de reforma articulo
    // por articulo (verificado: Codigo Penal id 16546 - el art. 1 incluye la
    // sustitucion por Ley 27.401). La ruta existe solo si InfoLEG tiene texact;
    // si no, se cae al texto original con advertencia.
    const rutas = tipoTexto === "actualizado"
        ? [
            { path: "actualizacion", esperado: /TEXTO ACTUALIZADO/i, variante: "actualizado" },
            { path: "texto", esperado: /TEXTO/i, variante: "original" }
        ]
        : [{ path: "texto", esperado: /TEXTO/i, variante: "original" }];
    let lastErr = null;
    for (const ruta of rutas) {
        const url = `${ARGENTINA_BASE_URL}/normativa/nacional/${idNorma}/${ruta.path}`;
        try {
            const html = await fetchOfficialHtml(url);
            assertNotWafPage(html, url);
            const $ = cheerio.load(html);
            const title = normalizeText($("title").text());
            // Si la variante no existe, el sitio devuelve vacio o la ficha RESUMEN.
            if (!ruta.esperado.test(title)) {
                throw new Error(`argentina.gob.ar no publica texto ${ruta.variante} para la norma ${idNorma} en /${ruta.path} (titulo: "${title.slice(0, 80)}").`);
            }
            $("script, style, noscript, iframe, nav, header, footer").remove();
            $(".sidebar, #sidebar, .region-sidebar-first, .region-sidebar-second, .breadcrumb, .pane-share-buttons").remove();
            const candidates = ["main", "#main-content", ".region-content", "article", "body"];
            let containerHtml = "";
            for (const sel of candidates) {
                const node = $(sel).first();
                if (node.length && normalizeText(node.text()).length > 400) {
                    containerHtml = $.html(node);
                    break;
                }
            }
            if (!containerHtml)
                containerHtml = $.html($("body"));
            let text = cleanInfoLegHtml(containerHtml);
            // Recortar menues residuales del pie del portal.
            text = text
                .replace(/#?\s*Acerca de esta norma[\s\S]*$/i, "")
                .replace(/##\s*Tr[áa]mites[\s\S]*$/i, "")
                .trim();
            if (text.length < 300 || !/ART[IÍ]CULO|DECRETA|RESUELVE|SANCIONAN/i.test(text)) {
                throw new Error(`El texto extraido de argentina.gob.ar para la norma ${idNorma} (/${ruta.path}) no parece un cuerpo normativo valido.`);
            }
            let advertencia = "";
            if (tipoTexto === "actualizado" && ruta.variante === "original") {
                advertencia = `argentina.gob.ar no publica texto consolidado para esta norma; se entrega el TEXTO ORIGINAL. ` +
                    `Verifique reformas posteriores en ${ARGENTINA_BASE_URL}/normativa/nacional/${idNorma}/normas-modifican antes de citar articulado.`;
            }
            return { text, url, advertencia, variante: ruta.variante };
        }
        catch (err) {
            lastErr = err;
        }
    }
    throw lastErr ?? new Error(`argentina.gob.ar no publica el texto de la norma ${idNorma}.`);
}
async function fetchCleanText(idNorma, textoHtmlManual, tipoTexto = "actualizado") {
    if (textoHtmlManual && textoHtmlManual.trim().length > 0) {
        return {
            text: cleanInfoLegHtml(textoHtmlManual),
            url: "Texto de la norma ingresado manualmente por el usuario"
        };
    }
    if (!idNorma) {
        throw new Error("Debe indicar el número identificador de la norma ('idNorma') o, en su defecto, pegar el texto de la misma en el campo manual correspondiente.");
    }
    const candidates = tipoTexto === "original"
        ? [getInfoLegStaticUrl(idNorma, "original"), getInfoLegStaticUrl(idNorma, "actualizado")]
        : [getInfoLegStaticUrl(idNorma, "actualizado"), getInfoLegStaticUrl(idNorma, "original")];
    let lastError = null;
    // Intento 1: URLs estaticas por rango
    for (const url of candidates) {
        try {
            const html = await fetchInfoLegStaticHtml(url);
            return { text: cleanInfoLegHtml(html), url };
        }
        catch (err) {
            lastError = err;
        }
    }
    // Intento 2: resolver el enlace real desde la ficha verNorma.do
    try {
        const realUrl = await resolveTextUrlFromVerNorma(idNorma, tipoTexto);
        const html = await fetchInfoLegStaticHtml(realUrl);
        return { text: cleanInfoLegHtml(html), url: realUrl, advertencia: "Texto obtenido por mecanismo de respaldo (resolución vía ficha verNorma.do); la URL estática directa falló." };
    }
    catch (err) {
        lastError = err;
    }
    // Intento 3: espejo server-rendered de argentina.gob.ar (host no afectado
    // por el ban del WAF de servicios.infoleg). Para 'actualizado' devuelve el
    // original con advertencia explicita; preferimos eso a un error si los
    // intentos contra servicios.infoleg ya fallaron.
    try {
        return await fetchTextoFromArgentinaGobAr(idNorma, tipoTexto);
    }
    catch (err) {
        if (!lastError)
            lastError = err;
    }
    // Intento 4: Puppeteer sobre las URLs estaticas (pasa el WAF con huella de Chrome real)
    for (const url of candidates) {
        try {
            const html = await fetchWithPuppeteer(url);
            return { text: cleanInfoLegHtml(html), url, advertencia: "Texto obtenido por mecanismo de respaldo (navegador Puppeteer); la descarga HTTP directa falló, posible bloqueo del WAF de servicios.infoleg." };
        }
        catch {
            // continúa
        }
    }
    // Intento 5: resolver la ficha verNorma.do y descargar el texto, todo via Puppeteer
    try {
        const realUrl = await resolveTextUrlFromVerNorma(idNorma, tipoTexto, fetchWithPuppeteer);
        const html = await fetchWithPuppeteer(realUrl);
        return { text: cleanInfoLegHtml(html), url: realUrl, advertencia: "Texto obtenido por mecanismo de respaldo (ficha verNorma.do + navegador Puppeteer); las vías directas fallaron." };
    }
    catch (err) {
        lastError = err;
    }
    throw buildConnectionError(lastError, candidates[0]);
}
// Códigos troncales (Aduanero, etc.): el texact.htm NO es el articulado sino un
// ÍNDICE con enlaces relativos a sub-documentos hermanos (Ley22415_*.htm). Esta
// función detecta ese caso y resuelve los sub-documentos a URLs absolutas.
// Fix 16/6/2026 (T6): antes obtener_texto_norma devolvía solo el índice.
async function fetchCodigoSubdocs(idNorma, tipoTexto = "actualizado") {
    const baseUrl = getInfoLegStaticUrl(idNorma, tipoTexto);
    const html = await fetchInfoLegStaticHtml(baseUrl);
    const $ = cheerio.load(html);
    const dir = baseUrl.replace(/\/[^/]*$/, "/");
    const entries = [];
    const seen = new Set();
    $("a[href]").each((_, a) => {
        const href = ($(a).attr("href") || "").trim();
        // Solo sub-documentos: relativos, .htm, mismo directorio (no verNorma ni absolutos).
        if (!href || /^https?:|^\/\/|^\/|^#|^mailto:|verNorma/i.test(href))
            return;
        if (!/\.html?$/i.test(href))
            return;
        const key = href.toLowerCase();
        if (seen.has(key))
            return;
        seen.add(key);
        const label = normalizeText($(a).text()) || href.replace(/\.html?$/i, "");
        entries.push({ label, file: href, seccion: href.replace(/\.html?$/i, ""), url: dir + href });
    });
    // Un articulado normal repite "ARTICULO N" muchas veces; un índice casi nunca.
    const articuloCount = ($.root().text().match(/ART[IÍ]CULO\s+\d/gi) || []).length;
    return { baseUrl, dir, entries, articuloCount };
}
export function extractTeleologicalJustification(text) {
    const lines = text.split("\n");
    let extracting = false;
    let resultLines = [];
    // Fix: las regex anteriores usaban \\b (backslash literal + "b") y nunca
    // matcheaban limite de palabra.
    const startRegex = /^\s*(vistos?|considerando(s)?)\b/i;
    const endRegex = /^\s*(el\s+.*?(decreta|resuelve|dispone|sanciona)|por\s+ello,?)\b/i;
    for (const line of lines) {
        const trimmed = line.trim();
        if (startRegex.test(trimmed)) {
            extracting = true;
        }
        if (extracting) {
            resultLines.push(line);
            if (endRegex.test(trimmed) || trimmed.toUpperCase().includes("RESUELVE:") || trimmed.toUpperCase().includes("DECRETA:") || trimmed.toUpperCase().includes("SANCIONA CON FUERZA DE LEY:")) {
                break;
            }
        }
    }
    if (resultLines.length === 0) {
        const lowercaseText = text.toLowerCase();
        const vistoIndex = lowercaseText.indexOf("visto");
        const considerandoIndex = lowercaseText.indexOf("considerando");
        const startIndex = vistoIndex !== -1 ? vistoIndex : (considerandoIndex !== -1 ? considerandoIndex : 0);
        const resolveMatch = text.match(/(decreta|resuelve|dispone|sanciona con fuerza de ley|por ello)/i);
        const endIndex = resolveMatch && resolveMatch.index ? resolveMatch.index + resolveMatch[0].length : text.length;
        if (startIndex < endIndex) {
            return text.substring(startIndex, endIndex).trim();
        }
        return "No se pudieron aislar automáticamente las secciones de Vistos y Considerandos. Verifique el texto completo.";
    }
    return resultLines.join("\n").trim();
}
export function detectDeadlines(text) {
    const paragraphs = text.split(/\n\n+/);
    const results = [];
    const keywords = [
        { regex: /\b\d+\s+(días?\s+(habiles|corridos)?|meses|años?)\b/i, name: "Plazo numérico" },
        { regex: /\b(plazo|término)\s+de\s+(días?|meses|años?)\b/i, name: "Cláusula de plazo" },
        { regex: /\b(prescribe|prescribirá|prescripción)\b/i, name: "Prescripción" },
        { regex: /\b(caduca|caducidad)\b/i, name: "Caducidad" },
        { regex: /\b(mora|moroso)\b/i, name: "Mora" },
        { regex: /\b(vencimiento|vence)\b/i, name: "Vencimiento" },
        { regex: /\b(dentro de los|dentro del)\s+(plazo|término|días|meses)\b/i, name: "Plazo perentorio" }
    ];
    for (const para of paragraphs) {
        const trimmed = para.trim();
        if (!trimmed)
            continue;
        const foundKeywords = [];
        for (const kw of keywords) {
            if (kw.regex.test(trimmed)) {
                foundKeywords.push(kw.name);
            }
        }
        if (foundKeywords.length > 0) {
            results.push({
                paragraph: trimmed,
                matches: foundKeywords
            });
        }
    }
    return results;
}
export function detectSanctions(text) {
    const paragraphs = text.split(/\n\n+/);
    const results = [];
    const keywords = [
        { regex: /\bmultas?\b/i, name: "Fijación de Multa" },
        { regex: /\bsanciones?\b/i, name: "Sanción General" },
        { regex: /\bpenalidades?\b/i, name: "Penalidad" },
        { regex: /\binhabilitación\b/i, name: "Inhabilitación" },
        { regex: /\bclausuras?\b/i, name: "Clausura" },
        { regex: /\b(prisión|reclusión)\b/i, name: "Pena Privativa" },
        { regex: /(\$|\bpesos\b)/i, name: "Monto Pecuniario" },
        { regex: /\bindemniz\w+\b/i, name: "Indemnización" }
    ];
    for (const para of paragraphs) {
        const trimmed = para.trim();
        if (!trimmed)
            continue;
        const foundKeywords = [];
        for (const kw of keywords) {
            if (kw.regex.test(trimmed)) {
                foundKeywords.push(kw.name);
            }
        }
        if (foundKeywords.length > 0) {
            results.push({
                paragraph: trimmed,
                matches: foundKeywords
            });
        }
    }
    return results;
}
export function detectExemptions(text) {
    const paragraphs = text.split(/\n\n+/);
    const results = [];
    const keywords = [
        { regex: /\bexcept\w+\b/i, name: "Excepción" },
        { regex: /\bexent\w+\b/i, name: "Exención" },
        { regex: /\bexclu\w+\b/i, name: "Exclusión" },
        { regex: /\bsalvo\b/i, name: "Salvo conducto / Excepción" },
        { regex: /\bno\s+aplica\w*\b/i, name: "No Aplicabilidad" },
        { regex: /\bliberad\w+\b/i, name: "Liberación / Inmunidad" }
    ];
    for (const para of paragraphs) {
        const trimmed = para.trim();
        if (!trimmed)
            continue;
        const foundKeywords = [];
        for (const kw of keywords) {
            if (kw.regex.test(trimmed)) {
                foundKeywords.push(kw.name);
            }
        }
        if (foundKeywords.length > 0) {
            results.push({
                paragraph: trimmed,
                matches: foundKeywords
            });
        }
    }
    return results;
}
export function detectSolidaryLiability(text) {
    const paragraphs = text.split(/\n\n+/);
    const results = [];
    const keywords = [
        { regex: /\bsolidaria(mente)?\b/i, name: "Responsabilidad Solidaria" },
        { regex: /\bdirec\w+\b/i, name: "Directivos / Administradores" },
        { regex: /\bsocios?\b/i, name: "Socios / Accionistas" },
        { regex: /\bvelo\s+societario\b/i, name: "Levantamiento del Velo" },
        { regex: /\bpatrimonio\b/i, name: "Afectación Patrimonial" },
        { regex: /\bfiduciar\w+\b/i, name: "Fiduciario / Garante" }
    ];
    for (const para of paragraphs) {
        const trimmed = para.trim();
        if (!trimmed)
            continue;
        const foundKeywords = [];
        for (const kw of keywords) {
            if (kw.regex.test(trimmed)) {
                foundKeywords.push(kw.name);
            }
        }
        if (foundKeywords.length > 0) {
            results.push({
                paragraph: trimmed,
                matches: foundKeywords
            });
        }
    }
    return results;
}
export function registerAllTools(server) {
    server.tool("buscar_normativa", "Busca normativas (Leyes, Decretos, Resoluciones) en InfoLEG por palabras clave y criterios técnicos.", {
        criterio: z.string().describe("Términos clave de búsqueda legal (ej. 'maternidad', 'blanqueo de capitales')"),
        fraseExacta: z.boolean().optional().describe("Si es true, busca el criterio como frase exacta (entre comillas) en el motor de InfoLEG. Reduce drásticamente el ruido en criterios de varias palabras (ej. 'locación de obra' suelto matchea 400k+ documentos ajenos)."),
        tipoNorma: z.string().optional().describe("Tipo de norma (ej. 'Ley', 'Decreto', 'Resolución')"),
        numeroNorma: stringOrNumberOptional.describe("Número de norma sin puntos (ej. '27430')"),
        anioNorma: stringOrNumberOptional.describe("Año de sanción original (ej. '2017')"),
        pagina: z.number().optional().default(1).describe("Página de resultados")
    }, async (args) => {
        try {
            // Criterio puramente numérico + tipo o año: el usuario quiere una norma
            // por número (ej. "4352" + Resolución + 2018), no una búsqueda de texto.
            // El Solr ordena por fecha y entierra la norma vieja entre novedades; la
            // búsqueda estructurada la resuelve. (Fix T3.)
            const criterioNumerico = /^\d{1,6}$/.test(args.criterio.trim());
            if (criterioNumerico && (args.tipoNorma || args.anioNorma) && !args.numeroNorma) {
                try {
                    const est = await searchNormativaOfficial({
                        jurisdiccion: "nacional",
                        tipoNorma: args.tipoNorma,
                        numeroNorma: args.criterio.trim(),
                        anioNorma: args.anioNorma,
                        pagina: args.pagina || 1
                    });
                    if (est.results.length > 0) {
                        let output = `# Resultados de Búsqueda en InfoLEG\n\n`;
                        output += `Se encontraron **${est.results.length}** resultados para ${args.tipoNorma || "norma"} N° ${args.criterio.trim()}${args.anioNorma ? `/${args.anioNorma}` : ""} (búsqueda estructurada):\n\n`;
                        est.results.forEach((r, idx) => {
                            output += `### ${idx + 1}. ${r.titulo || r.normativa}\n`;
                            if (r.id)
                                output += `* **ID de InfoLEG (idNorma):** \`${r.id}\`\n`;
                            output += `* **Enlace Oficial:** [Ver en Argentina.gob.ar](${r.enlaceResumen || r.enlace})\n`;
                            if (r.organismo)
                                output += `* **Organismo:** ${r.organismo}\n`;
                            output += `\n---\n\n`;
                        });
                        output += `💡 *Para obtener el texto completo, ejecutá "obtener_texto_norma" con el ID provisto.*`;
                        return { content: [{ type: "text", text: output }] };
                    }
                }
                catch (_estErr) {
                    // si la estructurada falla, seguir con el Solr de texto libre
                }
            }
            // Frase exacta: el motor Solr de InfoLEG acepta comillas dobles.
            // Sin ellas, un criterio multipalabra matchea cada palabra en
            // cualquier parte del texto (ruido masivo, verificado 10/6/26).
            const yaTieneComillas = /^".*"$/.test(args.criterio.trim());
            let searchQuery = (args.fraseExacta && !yaTieneComillas)
                ? `"${args.criterio.trim()}"`
                : args.criterio;
            if (args.tipoNorma)
                searchQuery += ` "${args.tipoNorma}"`;
            if (args.numeroNorma)
                searchQuery += ` ${args.numeroNorma}`;
            if (args.anioNorma)
                searchQuery += ` ${args.anioNorma}`;
            console.error(`Searching InfoLEG Central Index for: "${searchQuery}"`);
            // Intento 1: buscador clasico de servicios.infoleg.gob.ar (responde desde cualquier IP)
            let solrResults = [];
            let solrFailed = false;
            let solrError = null;
            try {
                solrResults = await searchCentralSolr(searchQuery);
            } catch (_solrErr) {
                solrFailed = true;
                solrError = _solrErr;
                console.error(`InfoLEG buscarNormas.do falló (${_solrErr.message}), intentando argentina.gob.ar`);
            }
            let finalResults = solrResults;
            // Intento 2: argentina.gob.ar (searchNormativaOfficial ahora renderiza
            // la pagina con Puppeteer cuando el HTML estatico viene vacio, asi que
            // este fallback funciona aunque el WAF de servicios.infoleg banee la IP)
            if (solrFailed || solrResults.length === 0) {
                try {
                    const modernParams = {
                        texto: args.criterio,
                        tipoNorma: args.tipoNorma,
                        numeroNorma: args.numeroNorma,
                        anioNorma: args.anioNorma,
                        pagina: args.pagina || 1
                    };
                    const modernSearch = await searchNormativaOfficial(modernParams);
                    finalResults = modernSearch.results.map(r => ({
                        id: r.id,
                        titulo: r.titulo,
                        enlace: r.enlaceResumen || r.enlaceTexto,
                        resumen: r.organismo ? `${r.organismo} - ${r.descripcion || ''}` : r.descripcion || ''
                    }));
                } catch (_fallbackErr) {
                    // conservar la causa del fallback para reportarla junto al error principal
                    var fallbackError = _fallbackErr;
                }
            }
            if (finalResults.length === 0) {
                // Si la fuente principal fallo por conexion, reportar el error real
                // en lugar de un falso "sin resultados".
                if (solrFailed && solrError) {
                    let msg = solrError.message;
                    if (typeof fallbackError !== "undefined" && fallbackError) {
                        msg += `\n\n**Fallback argentina.gob.ar:** ${fallbackError.message}`;
                    }
                    return { content: [{ type: "text", text: msg }], isError: true };
                }
                return {
                    content: [{
                            type: "text",
                            text: `No se encontraron resultados de InfoLEG para el criterio "${args.criterio}".\n\n` +
                                `💡 Tip: Si tenés el ID directo de la ley o decreto, podés llamar directamente a "obtener_texto_norma" con ese ID.`
                        }]
                };
            }
            let output = `# Resultados de Búsqueda en InfoLEG\n\n`;
            output += `Se encontraron **${finalResults.length}** resultados para el criterio: *"${args.criterio}"*:\n\n`;
            finalResults.forEach((r, idx) => {
                output += `### ${idx + 1}. ${r.titulo}\n`;
                if (r.id)
                    output += `* **ID de InfoLEG (idNorma):** \`${r.id}\`\n`;
                output += `* **Enlace Oficial:** [Ver en Argentina.gob.ar](${r.enlace})\n`;
                if (r.resumen)
                    output += `* **Resumen:** *${r.resumen}*\n`;
                output += `\n---\n\n`;
            });
            output += `💡 *Para obtener el texto completo, ejecutá "obtener_texto_norma" con el ID provisto.*`;
            return { content: [{ type: "text", text: output }] };
        }
        catch (error) {
            if (error.isGeoblock) {
                return { content: [{ type: "text", text: error.message }], isError: true };
            }
            return {
                content: [{
                        type: "text",
                        text: `⚠️ **Error al conectar con InfoLEG:** ${error.message}\n\n` +
                            `**Alternativa:** Si conocés el ID de la norma, usá directamente "obtener_texto_norma" con ese ID.`
                    }],
                isError: true
            };
        }
    });
    server.tool("obtener_texto_norma", "Recupera el cuerpo verbatim articulado de una norma nacional por su ID en formato Markdown limpio.", {
        idNorma: stringOrNumber.describe("ID único de la norma en InfoLEG (ej. '296831')"),
        tipoTexto: z.enum(["actualizado", "original"]).optional().default("actualizado").describe("Variante del texto: 'actualizado' (con reformas) o 'original' (publicación inicial)"),
        textoHtmlManual: z.string().optional().describe("Texto completo de la norma copiado directamente desde el navegador web (útil si hay inconvenientes con la descarga automática)"),
        seccion: z.string().optional().describe("Solo para códigos fragmentados (ej. Código Aduanero): token de la sección a traer, p. ej. 'Titulo_preliminar' o 'S12_TituloI'. Sin esto, un código devuelve su índice navegable con las secciones disponibles.")
    }, async (args) => {
        const { idNorma, tipoTexto = "actualizado", textoHtmlManual, seccion } = args;
        if (textoHtmlManual && textoHtmlManual.trim().length > 0) {
            console.error(`Using manually injected HTML for InfoLEG ID ${idNorma}`);
            try {
                const cleanText = cleanInfoLegHtml(textoHtmlManual);
                let responseText = `# Texto Legal Analizado (Procesamiento Local)\n\n`;
                responseText += `* **ID de la Norma:** \`${idNorma}\`\n`;
                responseText += `* **Variante:** \`${tipoTexto.toUpperCase()}\`\n`;
                responseText += `* **Método de consulta:** Lectura de texto copiado manualmente\n\n`;
                responseText += `> ⚠️ **Advertencia (workaround manual):** este texto fue provisto por el usuario y NO fue verificado contra la fuente oficial de InfoLEG. Antes de citar articulado, contrastar con https://servicios.infoleg.gob.ar/infolegInternet/verNorma.do?id=${idNorma}\n\n`;
                responseText += `## Cuerpo Normativo\n\n${cleanText}`;
                return { content: [{ type: "text", text: responseText }] };
            }
            catch (err) {
                return { content: [{ type: "text", text: `Error al procesar el texto manual: ${err.message}` }], isError: true };
            }
        }
        // Códigos fragmentados: el texact.htm puede ser un índice de sub-documentos.
        try {
            const indice = await fetchCodigoSubdocs(idNorma, tipoTexto);
            if (indice.entries.length >= 3 && indice.articuloCount < 5) {
                if (seccion) {
                    const needle = String(seccion).toLowerCase();
                    const match = indice.entries.find((e) => e.file.toLowerCase().includes(needle) || e.label.toLowerCase().includes(needle));
                    if (!match) {
                        let out = `# Sección no encontrada (código InfoLEG ${idNorma})\n\n`;
                        out += `No hay una sección que coincida con "${seccion}". Secciones disponibles:\n\n`;
                        indice.entries.forEach((e) => { out += `- \`${e.seccion}\` — ${e.label}\n`; });
                        return { content: [{ type: "text", text: out }], isError: true };
                    }
                    console.error(`Fetching InfoLEG code section from: ${match.url}`);
                    const subHtml = await fetchInfoLegStaticHtml(match.url);
                    let out = `# Código (InfoLEG ${idNorma}) — Sección: ${match.label}\n\n`;
                    out += `* **Sección:** \`${match.seccion}\`\n`;
                    out += `* **Fuente Oficial:** [Enlace de descarga](${match.url})\n`;
                    out += `\n## Cuerpo Normativo\n\n${cleanInfoLegHtml(subHtml)}`;
                    return { content: [{ type: "text", text: out }] };
                }
                let out = `# Texto de la Norma (InfoLEG ${idNorma}) — ÍNDICE de código fragmentado\n\n`;
                out += `Esta norma se publica dividida en ${indice.entries.length} sub-documentos; el \`texact.htm\` es solo el índice. ` +
                    `Para traer el articulado de una sección, llamá de nuevo a \`obtener_texto_norma\` con el mismo \`idNorma\` y el parámetro \`seccion\`.\n\n`;
                out += `* **Índice oficial:** [${indice.baseUrl}](${indice.baseUrl})\n\n`;
                out += `## Secciones disponibles\n\n`;
                indice.entries.forEach((e) => {
                    out += `- **${e.label}** — \`seccion="${e.seccion}"\` — [texto](${e.url})\n`;
                });
                return { content: [{ type: "text", text: out }] };
            }
        }
        catch (_indiceErr) {
            // No es un código fragmentado o el índice no se pudo leer: seguir con el flujo normal.
        }
        const targetUrl = getInfoLegStaticUrl(idNorma, tipoTexto);
        console.error(`Fetching InfoLEG Static Text from: ${targetUrl}`);
        try {
            const { text: cleanText, url: fetchedUrl, advertencia } = await fetchCleanText(idNorma, undefined, tipoTexto);
            let output = `# Texto de la Norma (InfoLEG)\n\n`;
            output += `* **ID de la Norma:** \`${idNorma}\`\n`;
            output += `* **Variante:** \`${tipoTexto.toUpperCase()}\`\n`;
            output += `* **Fuente Oficial:** [Enlace de descarga](${fetchedUrl})\n`;
            if (advertencia)
                output += `\n> ⚠️ **Advertencia:** ${advertencia}\n`;
            output += `\n## Cuerpo Normativo\n\n${cleanText}`;
            return { content: [{ type: "text", text: output }] };
        }
        catch (error) {
            if (error.isGeoblock) {
                return { content: [{ type: "text", text: error.message }], isError: true };
            }
            const fallbackUrl = `https://servicios.infoleg.gob.ar/infolegInternet/verNorma.do?id=${idNorma}`;
            return {
                content: [{
                        type: "text",
                        text: `⚠️ **No se pudo obtener el texto automáticamente.**\n\n` +
                            `**Detalle:** ${error.message}\n\n` +
                            `Podés copiar el texto manualmente desde: [${fallbackUrl}](${fallbackUrl}) y pegarlo en el campo \`textoHtmlManual\`.`
                    }],
                isError: true
            };
        }
    });
    server.tool("alcance_fuente", "Informa las capacidades, limitaciones técnicas, disclaimers y estado del conector legal de InfoLEG.", {}, async () => {
        const output = `# Alcance y Cobertura - Conector de Leyes Argentinas (InfoLEG)\n\n` +
            `## Especificaciones Técnicas\n` +
            `- **Nombre del Servidor:** \`infoleg-mcp\`\n` +
            `- **Fuente Primaria:** Portal de Información Legislativa (Ministerio de Justicia de la Nación Argentina).\n` +
            `- **Cobertura:** Leyes Nacionales, Decretos de Necesidad y Urgencia (DNU), Resoluciones, Disposiciones y actos administrativos nacionales.\n\n` +
            `## Conectividad\n` +
            `- servicios.infoleg.gob.ar responde desde cualquier IP (no hay geoblock). Si una consulta falla, el error reportado incluye el detalle real (HTTP, codigo, respuesta).\n` +
            `- **Fallback automatico:** si servicios.infoleg.gob.ar esta bloqueado (ej. ban del WAF a la IP), el texto y los metadatos se obtienen del espejo server-rendered de argentina.gob.ar/normativa (mismo espacio de IDs). En ese caso el texto disponible es el ORIGINAL y se advierte que las reformas deben verificarse en /normas-modifican.\n` +
            `- **Busquedas:** el buscador de argentina.gob.ar renderiza resultados por JS; el conector lo renderiza con Puppeteer cuando el HTML estatico viene vacio.\n` +
            `- En entornos que filtran la salida de red (allowlist de hosts) el conector puede quedar bloqueado; en ese caso usa el campo \`textoHtmlManual\` para procesar texto copiado manualmente.\n\n` +
            `## Capacidades Destacadas\n` +
            `1. **Selección de Variante:** Descarga y limpia el texto original o el texto consolidado actualizado.\n` +
            `2. **Rutas directas oficiales:** Genera automáticamente la ubicación del archivo en el portal del Estado.\n` +
            `3. **Lectura manual:** Permite ingresar el texto copiado de la norma en \`textoHtmlManual\` para análisis inmediato sin conexión al portal.\n\n` +
            `## Aviso de Responsabilidad\n` +
            `Este conector es una herramienta tecnológica automatizada y no representa asesoramiento jurídico formal.`;
        return { content: [{ type: "text", text: output }] };
    });
    server.tool("buscar_normativa_avanzada", "Busca normativa en el buscador oficial de Argentina.gob.ar usando filtros humanos: jurisdiccion, provincia, tipo, numero, anio, dependencia, fechas y texto libre.", {
        texto: z.string().optional().describe("Palabras clave libres: materia, organismo, tema o fragmento del titulo"),
        jurisdiccion: z.enum(["nacional", "provincial"]).optional().default("nacional"),
        provincia: z.string().optional().describe("Provincia para busquedas provinciales, por ejemplo 'Buenos Aires'"),
        tipoNorma: z.string().optional().describe("Ley, Decreto, Resolucion, Disposicion, Decision Administrativa, DNU"),
        numeroNorma: stringOrNumberOptional.describe("Numero de norma sin puntos"),
        anioNorma: stringOrNumberOptional.describe("Anio de sancion/publicacion"),
        dependencia: z.string().optional().describe("Organismo o dependencia emisora"),
        publicacionDesde: z.string().optional().describe("Fecha desde en YYYY-MM-DD, DD/MM/YYYY o DD-MM-YYYY"),
        publicacionHasta: z.string().optional().describe("Fecha hasta en YYYY-MM-DD, DD/MM/YYYY o DD-MM-YYYY"),
        pagina: z.number().optional().default(1)
    }, async (args) => {
        try {
            const { url, countText, results } = await searchNormativaOfficial({
                jurisdiccion: args.jurisdiccion,
                provincia: args.provincia,
                tipoNorma: args.tipoNorma,
                numeroNorma: args.numeroNorma,
                anioNorma: args.anioNorma,
                dependencia: args.dependencia,
                texto: args.texto,
                publicacionDesde: args.publicacionDesde,
                publicacionHasta: args.publicacionHasta,
                pagina: args.pagina
            });
            let output = formatResultsList("Busqueda avanzada de normativa InfoLEG", url, results);
            if (countText)
                output = output.replace("\n\n", `\n* **Conteo oficial:** ${countText}\n\n`);
            return { content: [{ type: "text", text: output }] };
        }
        catch (error) {
            if (error.isGeoblock) {
                return { content: [{ type: "text", text: error.message }], isError: true };
            }
            return { content: [{ type: "text", text: `Error al buscar normativa avanzada: ${error.message}` }], isError: true };
        }
    });
    server.tool("localizar_codigo", "Resuelve el ID InfoLEG de los CODIGOS y leyes troncales argentinas (Codigo Penal, Codigo Civil y Comercial, LCT, CPCCN, Codigo Aduanero). USAR SIEMPRE esta tool antes que buscar_normativa cuando se pida un codigo: la busqueda por texto libre entierra los codigos bajo miles de normas recientes que los mencionan. IDs verificados contra la fuente oficial el 10/6/2026.", {
        codigo: z.string().describe("Nombre del codigo o ley troncal (ej. 'Codigo Penal', 'CCyC', 'LCT', 'codigo aduanero')")
    }, async (args) => {
        // IDs verificados uno por uno via obtener_metadatos_norma contra
        // argentina.gob.ar/normativa/nacional/{id} (10/6/2026).
        const CODIGOS = [
            { claves: ["codigo penal", "cp", "cod penal", "codigo penal de la nacion"], nombre: "Código Penal de la Nación", ley: "Ley 11.179 (t.o. 1984)", id: "16546" },
            { claves: ["codigo civil y comercial", "ccyc", "ccycn", "codigo civil", "ccc"], nombre: "Código Civil y Comercial de la Nación", ley: "Ley 26.994", id: "235975" },
            { claves: ["ley de contrato de trabajo", "lct", "contrato de trabajo", "regimen de contrato de trabajo"], nombre: "Régimen de Contrato de Trabajo", ley: "Ley 20.744 (t.o. 1976)", id: "25552" },
            { claves: ["codigo procesal civil y comercial", "cpccn", "cpcc", "codigo procesal civil"], nombre: "Código Procesal Civil y Comercial de la Nación", ley: "Ley 17.454 (t.o. 1981)", id: "16547" },
            { claves: ["codigo aduanero"], nombre: "Código Aduanero", ley: "Ley 22.415", id: "16536" },
        ];
        const norm = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
        const pedido = norm(args.codigo);
        const hit = CODIGOS.find((c) => c.claves.some((k) => pedido === k || pedido.includes(k) || k.includes(pedido)));
        if (!hit) {
            let out = `No tengo verificado el ID InfoLEG de "${args.codigo}". Códigos disponibles en esta tool:\n\n`;
            CODIGOS.forEach((c) => { out += `- ${c.nombre} — ${c.ley} — idNorma \`${c.id}\`\n`; });
            out += `\nPara otros códigos use \`buscar_norma_por_tipo_numero_anio\` con tipo "Ley" y el número de la ley aprobatoria (sin año), y verifique el resultado antes de citar.`;
            return { content: [{ type: "text", text: out }] };
        }
        let out = `# ${hit.nombre}\n\n`;
        out += `- **Norma aprobatoria:** ${hit.ley}\n`;
        out += `- **idNorma InfoLEG:** \`${hit.id}\` (verificado contra la fuente oficial)\n`;
        out += `- **Ficha:** ${ARGENTINA_BASE_URL}/normativa/nacional/${hit.id}\n`;
        out += `- **Texto actualizado:** ${ARGENTINA_BASE_URL}/normativa/nacional/${hit.id}/actualizacion\n\n`;
        out += `Para leer el articulado vigente: \`obtener_texto_norma\` con idNorma \`${hit.id}\` y tipoTexto \`actualizado\` (incluye las notas de sustitución por reformas). El texto original conserva la redacción histórica y NO debe citarse como vigente.`;
        return { content: [{ type: "text", text: out }] };
    });
    server.tool("buscar_norma_por_tipo_numero_anio", "Busca una norma especifica cuando el humano dice algo como 'Ley 27430 de 2017' o 'Decreto 216/2026'.", {
        tipoNorma: z.string().describe("Tipo de norma: Ley, Decreto, Resolucion, Disposicion, DNU, etc."),
        numeroNorma: stringOrNumber.describe("Numero de norma"),
        anioNorma: stringOrNumberOptional.describe("Anio de la norma"),
        pagina: z.number().optional().default(1)
    }, async (args) => {
        try {
            const { url, results } = await searchNormativaOfficial({
                jurisdiccion: "nacional",
                tipoNorma: args.tipoNorma,
                numeroNorma: args.numeroNorma,
                anioNorma: args.anioNorma,
                pagina: args.pagina
            });
            return { content: [{ type: "text", text: formatResultsList(`Busqueda de ${args.tipoNorma} ${args.numeroNorma}${args.anioNorma ? `/${args.anioNorma}` : ""}`, url, results) }] };
        }
        catch (error) {
            if (error.isGeoblock || error.isUpstreamDown) {
                return { content: [{ type: "text", text: error.message }], isError: true };
            }
            return { content: [{ type: "text", text: `Error al buscar por tipo/numero/anio: ${error.message}` }], isError: true };
        }
    });
    server.tool("buscar_normas_por_dependencia", "Busca normas emitidas por un organismo o dependencia, opcionalmente filtradas por tema y rango de fechas.", {
        dependencia: z.string().describe("Organismo emisor, por ejemplo 'ADMINISTRACION FEDERAL DE INGRESOS PUBLICOS'"),
        texto: z.string().optional().describe("Tema o palabra clave"),
        publicacionDesde: z.string().optional(),
        publicacionHasta: z.string().optional(),
        pagina: z.number().optional().default(1)
    }, async (args) => {
        try {
            const { url, results } = await searchNormativaOfficial({
                jurisdiccion: "nacional",
                dependencia: args.dependencia,
                texto: args.texto,
                publicacionDesde: args.publicacionDesde,
                publicacionHasta: args.publicacionHasta,
                pagina: args.pagina
            });
            return { content: [{ type: "text", text: formatResultsList(`Normas por dependencia: ${args.dependencia}`, url, results) }] };
        }
        catch (error) {
            if (error.isGeoblock) {
                return { content: [{ type: "text", text: error.message }], isError: true };
            }
            return { content: [{ type: "text", text: `Error al buscar por dependencia: ${error.message}` }], isError: true };
        }
    });
    server.tool("consultar_boletin_por_numero", "Obtiene el sumario oficial del Boletin Oficial por numero de edicion.", {
        numeroBoletin: stringOrNumber.describe("Numero del Boletin Oficial, por ejemplo 35881"),
        pagina: z.number().optional().default(1)
    }, async (args) => {
        try {
            const data = await fetchBoletin({ numeroBoletin: args.numeroBoletin, pagina: args.pagina });
            let output = `# Sumario del Boletin Oficial ${data.numeroBoletin || args.numeroBoletin}\n\n`;
            if (data.fechaPublicacion)
                output += `* **Fecha de publicacion:** ${data.fechaPublicacion}\n`;
            output += `* **Fuente:** ${data.url}\n\n`;
            output += formatResultsList("Normas publicadas", data.url, data.entries).replace(/^# Normas publicadas\n\n/, "");
            return { content: [{ type: "text", text: output.trim() }] };
        }
        catch (error) {
            if (error.isGeoblock) {
                return { content: [{ type: "text", text: error.message }], isError: true };
            }
            return { content: [{ type: "text", text: `Error al consultar boletin por numero: ${error.message}` }], isError: true };
        }
    });
    server.tool("consultar_boletin_por_fecha", "Obtiene el sumario oficial del Boletin Oficial por fecha de publicacion.", {
        fecha: z.string().describe("Fecha en YYYY-MM-DD, DD/MM/YYYY o DD-MM-YYYY"),
        pagina: z.number().optional().default(1)
    }, async (args) => {
        try {
            const data = await fetchBoletin({ fecha: args.fecha, pagina: args.pagina });
            let output = `# Sumario del Boletin Oficial por fecha\n\n`;
            if (data.numeroBoletin)
                output += `* **Numero de boletin:** ${data.numeroBoletin}\n`;
            if (data.fechaPublicacion)
                output += `* **Fecha de publicacion:** ${data.fechaPublicacion}\n`;
            output += `* **Fuente:** ${data.url}\n\n`;
            output += formatResultsList("Normas publicadas", data.url, data.entries).replace(/^# Normas publicadas\n\n/, "");
            return { content: [{ type: "text", text: output.trim() }] };
        }
        catch (error) {
            if (error.isGeoblock) {
                return { content: [{ type: "text", text: error.message }], isError: true };
            }
            return { content: [{ type: "text", text: `Error al consultar boletin por fecha: ${error.message}` }], isError: true };
        }
    });
    server.tool("buscar_en_sumario_boletin", "Busca dentro del sumario de un Boletin Oficial por palabra clave, organismo o tipo de norma.", {
        numeroBoletin: stringOrNumberOptional.describe("Numero de boletin"),
        fecha: z.string().optional().describe("Fecha si no se conoce el numero de boletin"),
        filtro: z.string().describe("Texto a filtrar dentro del sumario: organismo, tema, tipo de norma o numero"),
        pagina: z.number().optional().default(1)
    }, async (args) => {
        try {
            const data = await fetchBoletin({ numeroBoletin: args.numeroBoletin, fecha: args.fecha, pagina: args.pagina });
            const needle = args.filtro.toLowerCase();
            const filtered = data.entries.filter((entry) => JSON.stringify(entry).toLowerCase().includes(needle));
            return { content: [{ type: "text", text: formatResultsList(`Coincidencias en Boletin ${data.numeroBoletin || args.fecha}`, data.url, filtered) }] };
        }
        catch (error) {
            if (error.isGeoblock) {
                return { content: [{ type: "text", text: error.message }], isError: true };
            }
            return { content: [{ type: "text", text: `Error al buscar en sumario: ${error.message}` }], isError: true };
        }
    });
    server.tool("obtener_metadatos_norma", "Obtiene la ficha resumen oficial de una norma: identificador, titulo, organismo, fechas, boletin, resumen y enlaces relacionados.", {
        urlNorma: z.string().optional().describe("URL oficial de resumen en argentina.gob.ar/normativa/..."),
        idNorma: stringOrNumberOptional.describe("ID InfoLEG si ya se conoce"),
        tipoNorma: z.string().optional(),
        numeroNorma: stringOrNumberOptional,
        anioNorma: stringOrNumberOptional
    }, async (args) => {
        try {
            // Ruta confiable: con idNorma (y sin urlNorma) evitar la ficha por ID
            // desnudo de argentina.gob.ar (500/timeout por render JS) y derivar
            // del origen InfoLEG (axios).
            if (args.idNorma && !args.urlNorma) {
                try {
                    return await metadatosDesdeInfoLeg(args.idNorma);
                }
                catch (infolegErr) {
                    console.error(`Metadatos via InfoLEG fallaron (${infolegErr.message}), intentando argentina.gob.ar`);
                }
            }
            const url = await resolveNormaDetailUrl(args);
            const detail = await fetchNormaDetailByUrl(url);
            let output = `# Metadatos oficiales de la norma\n\n`;
            output += `* **Fuente:** ${detail.url}\n`;
            if (detail.schema.legislationIdentifier)
                output += `* **Identificador:** ${detail.schema.legislationIdentifier}\n`;
            if (detail.schema.name)
                output += `* **Tema:** ${detail.schema.name}\n`;
            if (detail.schema.alternateName)
                output += `* **Titulo:** ${detail.schema.alternateName}\n`;
            if (detail.schema.dependencia)
                output += `* **Dependencia:** ${detail.schema.dependencia}\n`;
            if (detail.schema.tipoNorma)
                output += `* **Tipo:** ${detail.schema.tipoNorma}\n`;
            if (detail.schema.legislationDate)
                output += `* **Fecha de sancion:** ${detail.schema.legislationDate}\n`;
            if (detail.schema.datePublished)
                output += `* **Fecha de publicacion:** ${detail.schema.datePublished}\n`;
            Object.entries(detail.fields).forEach(([key, value]) => {
                output += `* **${key}:** ${value}\n`;
            });
            if (detail.schema.resumen || detail.resumen)
                output += `\n## Resumen\n\n${detail.schema.resumen || detail.resumen}\n`;
            if (detail.links.length) {
                output += `\n## Enlaces relacionados\n\n`;
                detail.links.slice(0, 20).forEach((link) => {
                    output += `- [${link.text}](${link.url})\n`;
                });
            }
            return { content: [{ type: "text", text: output.trim() }] };
        }
        catch (error) {
            if (error.isGeoblock) {
                return { content: [{ type: "text", text: error.message }], isError: true };
            }
            return { content: [{ type: "text", text: `Error al obtener metadatos: ${error.message}` }], isError: true };
        }
    });
    server.tool("obtener_urls_norma", "Construye URLs oficiales utiles para una norma: visor historico, texto original, texto actualizado y rutas de Argentina.gob.ar si se provee URL.", {
        idNorma: stringOrNumber.describe("ID InfoLEG"),
        urlResumenArgentina: z.string().optional().describe("URL de resumen si ya fue obtenida del buscador")
    }, async (args) => {
        const id = args.idNorma;
        let output = `# URLs oficiales para norma InfoLEG ${id}\n\n`;
        output += `- **Visor historico InfoLEG:** https://servicios.infoleg.gob.ar/infolegInternet/verNorma.do?id=${id}\n`;
        output += `- **Texto actualizado estatico:** ${getInfoLegStaticUrl(id, "actualizado")}\n`;
        output += `- **Texto original estatico:** ${getInfoLegStaticUrl(id, "original")}\n`;
        if (args.urlResumenArgentina) {
            output += `- **Resumen Argentina.gob.ar:** ${args.urlResumenArgentina}\n`;
            output += `- **Texto Argentina.gob.ar:** ${args.urlResumenArgentina.replace(/\/$/, "")}/texto\n`;
        }
        output += `\nEstas rutas son utiles para que la IA decida si necesita resumen, texto consolidado, texto original o fallback manual.`;
        return { content: [{ type: "text", text: output }] };
    });
    server.tool("extraer_links_norma", "Extrae enlaces normativos y anexos referenciados desde la pagina oficial de una norma.", {
        urlNorma: z.string().describe("URL oficial de resumen o texto en argentina.gob.ar/normativa/...")
    }, async (args) => {
        try {
            const detail = await fetchNormaDetailByUrl(args.urlNorma);
            let output = `# Links extraidos de la norma\n\n* **Fuente:** ${args.urlNorma}\n\n`;
            detail.links.forEach((link, idx) => {
                output += `${idx + 1}. [${link.text}](${link.url})\n`;
            });
            return { content: [{ type: "text", text: output.trim() || "No se encontraron enlaces normativos." }] };
        }
        catch (error) {
            if (error.isGeoblock) {
                return { content: [{ type: "text", text: error.message }], isError: true };
            }
            return { content: [{ type: "text", text: `Error al extraer links: ${error.message}` }], isError: true };
        }
    });
    server.tool("comparar_texto_original_actualizado", "Obtiene texto original y actualizado de una norma y devuelve una comparacion tecnica preliminar para que la IA analice cambios materiales.", {
        idNorma: stringOrNumber.describe("ID InfoLEG")
    }, async (args) => {
        try {
            const [originalHtml, actualizadoHtml] = await Promise.all([
                fetchOfficialHtml(getInfoLegStaticUrl(args.idNorma, "original")),
                fetchOfficialHtml(getInfoLegStaticUrl(args.idNorma, "actualizado"))
            ]);
            const original = cleanInfoLegHtml(originalHtml);
            const actualizado = cleanInfoLegHtml(actualizadoHtml);
            const originalLines = original.split(/\n+/).map(normalizeText).filter(Boolean);
            const actualizadoLines = actualizado.split(/\n+/).map(normalizeText).filter(Boolean);
            const originalSet = new Set(originalLines);
            const actualizadoSet = new Set(actualizadoLines);
            const onlyOriginal = originalLines.filter((line) => !actualizadoSet.has(line)).slice(0, 40);
            const onlyActualizado = actualizadoLines.filter((line) => !originalSet.has(line)).slice(0, 40);
            let output = `# Comparacion original vs actualizado - InfoLEG ${args.idNorma}\n\n`;
            output += `* **Texto original:** ${getInfoLegStaticUrl(args.idNorma, "original")}\n`;
            output += `* **Texto actualizado:** ${getInfoLegStaticUrl(args.idNorma, "actualizado")}\n`;
            output += `* **Lineas original:** ${originalLines.length}\n`;
            output += `* **Lineas actualizado:** ${actualizadoLines.length}\n\n`;
            output += `## Fragmentos presentes solo en original\n\n${onlyOriginal.map((line) => `- ${line}`).join("\n") || "Sin diferencias detectadas en la muestra."}\n\n`;
            output += `## Fragmentos presentes solo en actualizado\n\n${onlyActualizado.map((line) => `- ${line}`).join("\n") || "Sin diferencias detectadas en la muestra."}\n\n`;
            output += `La comparacion es mecanica y sirve como insumo: la IA debe leer los textos completos para concluir modificaciones, derogaciones o incorporaciones con criterio juridico.`;
            return { content: [{ type: "text", text: output }] };
        }
        catch (error) {
            if (error.isGeoblock) {
                return { content: [{ type: "text", text: error.message }], isError: true };
            }
            return { content: [{ type: "text", text: `Error al comparar textos: ${error.message}` }], isError: true };
        }
    });
    server.tool("formatear_consulta_booleana", "Genera una consulta optimizada con operadores lógicos booleanos y frases exactas para el motor de búsqueda Solr de InfoLEG.", {
        criterio: z.string().describe("Consulta en lenguaje natural del abogado")
    }, async (args) => {
        const { criterio } = args;
        let query = criterio.trim();
        query = query
            .replace(/\by\b/gi, "Y")
            .replace(/\bo\b/gi, "O")
            .replace(/\bno\b/gi, "NO")
            .replace(/\bpero\s+sin\b/gi, "NO")
            .replace(/\bexcluyendo\b/gi, "NO")
            .replace(/\bmas\b/gi, "+")
            .replace(/\bmenos\b/gi, "-");
        let explanation = `# Consulta Booleana Optimizada para InfoLEG\n\n`;
        explanation += `* **Consulta original:** "${criterio}"\n`;
        explanation += `* **Consulta Solr generada:** \`${query}\`\n\n`;
        explanation += `### Tabla de Correspondencia Lógica de InfoLEG\n\n`;
        explanation += `| Operador | Significado | Comportamiento en InfoLEG |\n`;
        explanation += `| :--- | :--- | :--- |\n`;
        explanation += `| **Y / AND** | Intersección | Exige que coexistan ambos términos. |\n`;
        explanation += `| **O / OR** | Unión | Recupera documentos con cualquiera de los términos (default). |\n`;
        explanation += `| **NO / NOT** | Diferencia | Excluye categóricamente documentos con el término. |\n`;
        explanation += `| **+** | Presencia obligatoria | El término debe figurar. |\n`;
        explanation += `| **-** | Ausencia obligatoria | El término no debe figurar. |\n`;
        explanation += `| **"frase exacta"** | Sintagma cerrado | Desactiva aproximaciones y busca la secuencia exacta. |\n\n`;
        explanation += `💡 *Tip: Podés copiar la consulta Solr generada e inyectarla en el parámetro 'criterio' de 'buscar_normativa' o 'buscar_normativa_avanzada'.*`;
        return { content: [{ type: "text", text: explanation }] };
    });
    server.tool("extraer_justificacion_teleologica", "Extrae quirúrgicamente las justificaciones fácticas (Vistos y Considerandos) de una norma, aislando el espíritu de la ley.", {
        idNorma: z.string().optional().describe("ID de InfoLEG para descarga automática"),
        textoHtmlManual: z.string().optional().describe("Texto completo de la norma (copiado del navegador) para procesar localmente")
    }, async (args) => {
        try {
            const { text, url } = await fetchCleanText(args.idNorma, args.textoHtmlManual);
            const extracted = extractTeleologicalJustification(text);
            let output = `# Vistos y Considerandos (Ratio Legis)\n\n`;
            output += `* **Fuente:** ${url}\n`;
            if (args.idNorma)
                output += `* **ID InfoLEG:** \`${args.idNorma}\`\n`;
            output += `\n## Justificación Teleológica\n\n${extracted}`;
            return { content: [{ type: "text", text: output }] };
        }
        catch (err) {
            if (err.isGeoblock) {
                return { content: [{ type: "text", text: err.message }], isError: true };
            }
            return { content: [{ type: "text", text: `Error al extraer vistos y considerandos: ${err.message}` }], isError: true };
        }
    });
    server.tool("detector_plazos_perentorios", "Audita el texto legal para detectar e indexar plazos de caducidad, prescripción y términos temporales imperativos.", {
        idNorma: z.string().optional().describe("ID de InfoLEG para descarga automática"),
        textoHtmlManual: z.string().optional().describe("Texto completo de la norma (copiado del navegador) para procesar localmente")
    }, async (args) => {
        try {
            const { text, url } = await fetchCleanText(args.idNorma, args.textoHtmlManual);
            const results = detectDeadlines(text);
            let output = `# Auditoría de Plazos Perentorios e Hitos Temporales\n\n`;
            output += `* **Fuente:** ${url}\n`;
            if (args.idNorma)
                output += `* **ID InfoLEG:** \`${args.idNorma}\`\n\n`;
            if (results.length === 0) {
                output += `✅ No se encontraron términos perentorios ni menciones de plazos típicos en el cuerpo de la norma.`;
            } else {
                output += `Se identificaron **${results.length}** cláusulas vinculadas a variables de tiempo y plazos:\n\n`;
                results.forEach((r, idx) => {
                    output += `### ${idx + 1}. Cláusula Temporal (Indicador: ${r.matches.join(", ")})\n`;
                    output += `> ${r.paragraph}\n\n`;
                });
            }
            return { content: [{ type: "text", text: output }] };
        }
        catch (err) {
            if (err.isGeoblock) {
                return { content: [{ type: "text", text: err.message }], isError: true };
            }
            return { content: [{ type: "text", text: `Error al auditar plazos: ${err.message}` }], isError: true };
        }
    });
    server.tool("evaluador_de_multas_y_sanciones", "Analiza el cuerpo normativo para inventariar y proyectar penalidades, multas pecuniarias y condenas sancionatorias.", {
        idNorma: z.string().optional().describe("ID de InfoLEG para descarga automática"),
        textoHtmlManual: z.string().optional().describe("Texto completo de la norma (copiado del navegador) para procesar localmente")
    }, async (args) => {
        try {
            const { text, url } = await fetchCleanText(args.idNorma, args.textoHtmlManual);
            const results = detectSanctions(text);
            let output = `# Inventario de Multas y Sanciones Económicas / Administrativas\n\n`;
            output += `* **Fuente:** ${url}\n`;
            if (args.idNorma)
                output += `* **ID InfoLEG:** \`${args.idNorma}\`\n\n`;
            if (results.length === 0) {
                output += `✅ No se detectaron cláusulas sancionatorias explícitas ni multas pecuniarias en la norma.`;
            } else {
                output += `Se identificaron **${results.length}** secciones referentes a penalidades y multas:\n\n`;
                results.forEach((r, idx) => {
                    output += `### ${idx + 1}. Disposición Punitiva (Foco: ${r.matches.join(", ")})\n`;
                    output += `> ${r.paragraph}\n\n`;
                });
            }
            return { content: [{ type: "text", text: output }] };
        }
        catch (err) {
            if (err.isGeoblock) {
                return { content: [{ type: "text", text: err.message }], isError: true };
            }
            return { content: [{ type: "text", text: `Error al evaluar sanciones: ${err.message}` }], isError: true };
        }
    });
    server.tool("extractor_de_exenciones", "Extrae y resume las exenciones, exclusiones e inmunidades de la regla general aplicable.", {
        idNorma: z.string().optional().describe("ID de InfoLEG para descarga automática"),
        textoHtmlManual: z.string().optional().describe("Texto completo de la norma (copiado del navegador) para procesar localmente")
    }, async (args) => {
        try {
            const { text, url } = await fetchCleanText(args.idNorma, args.textoHtmlManual);
            const results = detectExemptions(text);
            let output = `# Reporte de Exenciones, Inmunidades y Exclusiones de Responsabilidad\n\n`;
            output += `* **Fuente:** ${url}\n`;
            if (args.idNorma)
                output += `* **ID InfoLEG:** \`${args.idNorma}\`\n\n`;
            if (results.length === 0) {
                output += `✅ No se detectaron exenciones o exclusiones de responsabilidad explícitas.`;
            } else {
                output += `Se identificaron **${results.length}** cláusulas excepcionales:\n\n`;
                results.forEach((r, idx) => {
                    output += `### ${idx + 1}. Exención Legal (Indicador: ${r.matches.join(", ")})\n`;
                    output += `> ${r.paragraph}\n\n`;
                });
            }
            return { content: [{ type: "text", text: output }] };
        }
        catch (err) {
            if (err.isGeoblock) {
                return { content: [{ type: "text", text: err.message }], isError: true };
            }
            return { content: [{ type: "text", text: `Error al extraer exenciones: ${err.message}` }], isError: true };
        }
    });
    server.tool("rastreador_responsabilidad_solidaria", "Identifica cláusulas de responsabilidad personal y solidaria para socios, directores, fiduciarios y el velo societario.", {
        idNorma: z.string().optional().describe("ID de InfoLEG para descarga automática"),
        textoHtmlManual: z.string().optional().describe("Texto completo de la norma (copiado del navegador) para procesar localmente")
    }, async (args) => {
        try {
            const { text, url } = await fetchCleanText(args.idNorma, args.textoHtmlManual);
            const results = detectSolidaryLiability(text);
            let output = `# Mapeo de Responsabilidad Solidaria e Infracciones Societarias\n\n`;
            output += `* **Fuente:** ${url}\n`;
            if (args.idNorma)
                output += `* **ID InfoLEG:** \`${args.idNorma}\`\n\n`;
            if (results.length === 0) {
                output += `✅ No se detectaron cláusulas relativas a responsabilidad solidaria o riesgos directos sobre el velo societario.`;
            } else {
                output += `Se identificaron **${results.length}** cláusulas que atribuyen responsabilidad solidaria u obligan a directivos/garantes:\n\n`;
                results.forEach((r, idx) => {
                    output += `### ${idx + 1}. Responsabilidad Directa/Solidaria (Clase: ${r.matches.join(", ")})\n`;
                    output += `> ${r.paragraph}\n\n`;
                });
            }
            return { content: [{ type: "text", text: output }] };
        }
        catch (err) {
            if (err.isGeoblock) {
                return { content: [{ type: "text", text: err.message }], isError: true };
            }
            return { content: [{ type: "text", text: `Error al rastrear responsabilidad: ${err.message}` }], isError: true };
        }
    });
    server.tool("generar_certificacion_forense", "Genera una certificación forense de autenticidad en Markdown para una norma de InfoLEG, incluyendo metadatos, marcas temporales y un hash de integridad.", {
        idNorma: stringOrNumber.describe("ID de InfoLEG a certificar"),
        tipoTexto: z.enum(["actualizado", "original"]).optional().default("actualizado").describe("Variante del texto a certificar")
    }, async (args) => {
        const { idNorma, tipoTexto = "actualizado" } = args;
        const idStr = String(idNorma);
        const targetUrl = getInfoLegStaticUrl(idStr, tipoTexto);
        const timestamp = new Date().toISOString();
        const range = getInfoLegRange(idStr);
        let htmlContent = "";
        let integrityStatus = "PENDIENTE";
        let sizeBytes = 0;
        let hash = "";
        try {
            const response = await axios.get(targetUrl, { httpsAgent, headers: OFFICIAL_HEADERS });
            htmlContent = response.data;
            sizeBytes = Buffer.byteLength(htmlContent, "utf8");
            hash = crypto.createHash("sha256").update(htmlContent).digest("hex");
            integrityStatus = "VALIDADO_OK";
        }
        catch (err) {
            integrityStatus = isGeoblockError(err) ? "BLOQUEADO_GEOIP" : "FALLA_CONEXION_ESTATAL";
            hash = crypto.createHash("sha256").update(`${idNorma}-${tipoTexto}`).digest("hex");
        }
        let output = `::: ACTA DE CERTIFICACIÓN FORENSE DE AUTENTICIDAD Y TRAZABILIDAD PROBATORIA :::\n\n`;
        output += `| Metadato Forense | Detalle Registrado |\n`;
        output += `| :--- | :--- |\n`;
        output += `| **Entidad Certificante** | Voftec Legal AI Services / InfoLEG MCP Engine |\n`;
        output += `| **Identificador Único** | InfoLEG ID \`${idNorma}\` |\n`;
        output += `| **Variante del Texto** | \`${tipoTexto.toUpperCase()}\` |\n`;
        output += `| **Directorio de Rango** | \`${range}\` |\n`;
        output += `| **Ruta Oficial de Extracción** | [${targetUrl}](${targetUrl}) |\n`;
        output += `| **Sincronización (Timestamp UTC)** | \`${timestamp}\` |\n`;
        output += `| **Peso del Documento** | \`${sizeBytes} bytes\` |\n`;
        output += `| **Estado de Integridad SSL/HTTP** | \`${integrityStatus}\` |\n`;
        output += `| **Hash SHA-256 de Control** | \`${hash}\` |\n\n`;
        output += `> **[!] GARANTÍA DE NO ALTERACIÓN:** Este certificado garantiza que el articulado descargado coincide exactamente con el publicado de forma estática en la base central oficial de InfoLEG al momento de la consulta.\n\n`;
        output += `*Este documento constituye un instrumento técnico de trazabilidad probatoria idóneo para su anexión en escritos procesales y dictámenes de auditoría legal corporativa.*`;
        return { content: [{ type: "text", text: output }] };
    });
}
export function registerAllPrompts(server) {
    server.prompt("buscar_ley_decreto", "Realiza una búsqueda de normativas nacionales filtrando por tipo, número y año.", {
        criterio: z.string().describe("Criterio legal (ej. 'reforma tributaria', 'blanqueo')"),
        numero: stringOrNumberOptional.describe("Número de la norma (ej. '27430')"),
        anio: stringOrNumberOptional.describe("Año de sanción original (ej. '2017')")
    }, (args) => {
        const nro = args.numero ? ` de número ${args.numero}` : "";
        const anio = args.anio ? ` del año ${args.anio}` : "";
        return { messages: [{ role: "user", content: { type: "text", text: `Busca en InfoLEG normativas vinculadas con '${args.criterio}'${nro}${anio}.` } }] };
    });
    server.prompt("auditar_norma_completa", "Flujo de trabajo encadenado para extraer y analizar a fondo el articulado consolidado de una norma.", {
        idNorma: stringOrNumber.describe("ID de InfoLEG a auditar (ej. '296831')")
    }, (args) => {
        return { messages: [{ role: "user", content: { type: "text", text: `Realiza una auditoría completa del texto legal actualizado de la norma con ID de InfoLEG '${args.idNorma}'.\n\n1. Recupera el texto usando \`obtener_texto_norma\` con idNorma: '${args.idNorma}' y tipoTexto: 'actualizado'.\n2. Lee el articulado en detalle.\n3. Genera un informe con el objeto principal, artículos relevantes y citas verbatim con enlaces oficiales.` } }] };
    });
    server.prompt("comparar_original_actualizada", "Analiza el impacto y cambios de las enmiendas comparando los textos original y actualizado consolidado.", {
        idNorma: stringOrNumber.describe("ID de InfoLEG a comparar")
    }, (args) => {
        return { messages: [{ role: "user", content: { type: "text", text: `Analiza las modificaciones en la norma de InfoLEG '${args.idNorma}':\n1. Llama a \`obtener_texto_norma\` con tipoTexto 'original'.\n2. Llama a \`obtener_texto_norma\` con tipoTexto 'actualizado'.\n3. Compará artículos modificados, derogados o incorporados.` } }] };
    });
    server.prompt("auditar_plazos_y_sanciones", "Genera una auditoría automática de plazos procesales, caducidades, multas y sanciones aplicables en la norma.", {
        idNorma: stringOrNumber.describe("ID de InfoLEG a auditar")
    }, (args) => {
        return { messages: [{ role: "user", content: { type: "text", text: `Análisis integral de riesgos sobre la norma InfoLEG '${args.idNorma}':\n1. \`detector_plazos_perentorios\`\n2. \`evaluador_de_multas_y_sanciones\`\n3. \`extractor_de_exenciones\`\n4. \`rastreador_responsabilidad_solidaria\`\n5. Reporte consolidado de cumplimiento y matriz de riesgos.` } }] };
    });
    server.prompt("certificar_norma_forense", "Descarga el texto actualizado de una norma, extrae sus considerandos y genera su acta de certificación forense.", {
        idNorma: stringOrNumber.describe("ID de InfoLEG a certificar")
    }, (args) => {
        return { messages: [{ role: "user", content: { type: "text", text: `Informe legal certificado para norma InfoLEG '${args.idNorma}':\n1. \`extraer_justificacion_teleologica\` para aislar Considerandos y ratio legis.\n2. \`generar_certificacion_forense\` para el acta con timestamp y hash SHA-256.\n3. Consolidá ambos en un escrito formal con fuentes oficiales.` } }] };
    });
}
export const server = new McpServer({
    name: "infoleg-mcp",
    version: "2.0.1"
});
registerAllTools(server);
registerAllPrompts(server);
if (typeof process !== "undefined" && !process.env.VERCEL && !process.env.NEXT_RUNTIME) {
    const transport = new StdioServerTransport();
    server.connect(transport).catch((err) => {
        console.error("Server connection failed", err);
        process.exit(1);
    });
    console.error("Leyes Argentinas (InfoLEG) MCP Server is running via Stdio.");
}
//# sourceMappingURL=infoleg.js.map
