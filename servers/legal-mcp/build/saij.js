#!/usr/bin/env node
/**
 * saij.js - Conector SAIJ para legal-hub
 * Wraps saij-mcp services usando McpServer + StdioServerTransport
 * para compatibilidad con el proxy de legal-hub.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// Importar servicios del saij-mcp original
import { searchService } from "../../saij-mcp/build/services/search-service.js";
import { documentService } from "../../saij-mcp/build/services/document-service.js";
import { graphService } from "../../saij-mcp/build/services/graph-service.js";

const server = new McpServer({
  name: "saij-mcp",
  version: "1.0.0",
});

// ─── Control de tamaño de respuesta (FIX auditoria 11/06/2026) ───────────────
// search_legislacion llego a devolver 95.807 caracteres en una sola respuesta
// (token overflow). Toda salida de busqueda pasa por fmtSearch: limite total
// de caracteres, truncado de abstracts y advertencia con instrucciones de
// paginacion cuando hay muchos resultados.
const LIMITE_CARACTERES_DEFAULT = 30000;
const ABSTRACT_MAX = 1500;

function fmtSearch(results, limiteCaracteres) {
  const limite = Math.max(2000, limiteCaracteres || LIMITE_CARACTERES_DEFAULT);
  const out = { ...results, advertencias: [] };
  if (out.total_results > 50) {
    out.advertencias.push(
      `Hay ${out.total_results} resultados en total; esta respuesta muestra la pagina solicitada ` +
      `(offset=${out.offset}, pageSize=${out.page_size}). Refina la busqueda o pagina con offset/pageSize.`
    );
  }
  let text = JSON.stringify(out, null, 2);
  if (text.length > limite) {
    out.results = (out.results || []).map((r) =>
      typeof r.document_abstract === "string" && r.document_abstract.length > ABSTRACT_MAX
        ? { ...r, document_abstract: r.document_abstract.slice(0, ABSTRACT_MAX) + " [ABSTRACT TRUNCADO: usar saij_get_document con el uuid para el documento completo]" }
        : r
    );
    out.advertencias.push("Abstracts truncados para no exceder el limite de caracteres de la respuesta.");
    text = JSON.stringify(out, null, 2);
  }
  if (text.length > limite) {
    const totalPagina = out.results.length;
    while (out.results.length > 1 && text.length > limite) {
      out.results.pop();
      text = JSON.stringify(out, null, 2);
    }
    out.advertencias.push(
      `Salida limitada a ${out.results.length} de ${totalPagina} resultados de la pagina por limite_caracteres=${limite}. ` +
      `Para ver el resto: subir limite_caracteres o paginar con offset.`
    );
    text = JSON.stringify(out, null, 2);
  }
  return text;
}

const limiteCaracteresParam = z.number().optional()
  .describe(`Limite maximo de caracteres de la respuesta (default ${LIMITE_CARACTERES_DEFAULT}). Si se excede, se truncan abstracts y resultados con advertencia.`);

// ─── search_jurisprudencia ────────────────────────────────────────────────────
server.tool(
  "saij_search_jurisprudencia",
  "Busca fallos y sentencias de jurisprudencia en el SAIJ.",
  {
    query: z.string().describe("Términos de búsqueda"),
    jurisdiccion: z.string().optional().describe("Jurisdicción (ej: 'Nacional', 'Buenos Aires')"),
    tribunal: z.string().optional().describe("Nombre del tribunal"),
    materia: z.string().optional().describe("Materia jurídica"),
    tipoDoc: z.string().optional().describe("Tipo de documento"),
    fechaDesde: z.string().optional().describe("Fecha desde (YYYYMMDD)"),
    fechaHasta: z.string().optional().describe("Fecha hasta (YYYYMMDD)"),
    offset: z.number().optional().default(0),
    pageSize: z.number().optional().default(10).describe("Resultados por pagina (default 10, recomendado <= 20)"),
    view: z.string().optional().default("colapsada"),
    limite_caracteres: limiteCaracteresParam,
  },
  async (args) => {
    try {
      const results = await searchService.searchJurisprudencia(args);
      return { content: [{ type: "text", text: fmtSearch(results, args.limite_caracteres) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  }
);

// ─── search_legislacion ───────────────────────────────────────────────────────
server.tool(
  "saij_search_legislacion",
  "Busca leyes, decretos y otras normas legislativas en el SAIJ.",
  {
    query: z.string().describe("Términos de búsqueda"),
    tipoNorma: z.string().optional().describe("Tipo de norma (ej: 'Ley', 'Decreto')"),
    jurisdiccion: z.string().optional().describe("Jurisdicción"),
    estadoVigencia: z.string().optional().describe("Estado de vigencia"),
    organismo: z.string().optional().describe("Organismo emisor"),
    tema: z.string().optional().describe("Tema o materia"),
    offset: z.number().optional().default(0),
    pageSize: z.number().optional().default(10).describe("Resultados por pagina (default 10, recomendado <= 20)"),
    view: z.string().optional().default("colapsada"),
    limite_caracteres: limiteCaracteresParam,
  },
  async (args) => {
    try {
      const results = await searchService.searchLegislacion(args);
      return { content: [{ type: "text", text: fmtSearch(results, args.limite_caracteres) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  }
);

// ─── search_doctrina ──────────────────────────────────────────────────────────
server.tool(
  "saij_search_doctrina",
  "Busca artículos de doctrina jurídica en el SAIJ.",
  {
    query: z.string().describe("Términos de búsqueda"),
    materia: z.string().optional().describe("Materia jurídica"),
    autor: z.string().optional().describe("Nombre del autor"),
    fechaDesde: z.string().optional().describe("Fecha desde (YYYYMMDD)"),
    fechaHasta: z.string().optional().describe("Fecha hasta (YYYYMMDD)"),
    offset: z.number().optional().default(0),
    pageSize: z.number().optional().default(10).describe("Resultados por pagina (default 10, recomendado <= 20)"),
    view: z.string().optional().default("colapsada"),
    limite_caracteres: limiteCaracteresParam,
  },
  async (args) => {
    try {
      const results = await searchService.searchDoctrina(args);
      return { content: [{ type: "text", text: fmtSearch(results, args.limite_caracteres) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  }
);

// ─── search_dictamenes ────────────────────────────────────────────────────────
server.tool(
  "saij_search_dictamenes",
  "Busca dictámenes de organismos públicos (PTN, MPF, etc.) en el SAIJ.",
  {
    query: z.string().describe("Términos de búsqueda"),
    organismo: z.string().optional().describe("Organismo (ej: 'PTN', 'MPF')"),
    tema: z.string().optional().describe("Tema o materia"),
    offset: z.number().optional().default(0),
    pageSize: z.number().optional().default(10).describe("Resultados por pagina (default 10, recomendado <= 20)"),
    view: z.string().optional().default("colapsada"),
    limite_caracteres: limiteCaracteresParam,
  },
  async (args) => {
    try {
      const results = await searchService.searchDictamenes(args);
      return { content: [{ type: "text", text: fmtSearch(results, args.limite_caracteres) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  }
);

// ─── search_biblioteca ────────────────────────────────────────────────────────
server.tool(
  "saij_search_biblioteca",
  "Busca libros, codigos comentados y revistas en la Biblioteca Digital de Ediciones SAIJ (bibliotecadigital.gob.ar: CCyC comentado, manuales, obras historicas). Devuelve titulo y enlace de lectura/descarga; el uuid omeka-item-* NO sirve para saij_get_document.",
  {
    query: z.string().optional().default("").describe("Términos de búsqueda. Vacio = recorrer el catalogo completo (~1400 obras, de a 10 por pagina), util combinado con coleccion/subcoleccion"),
    coleccion: z.string().optional().describe("Filtrar por coleccion: 'libros_saij' (codigos comentados y manuales), 'revistas_saij', 'patrimonio_historico', 'politica_criminal', 'en_buena_ley' (revista del Ministerio), o un ID numerico de coleccion Omeka"),
    subcoleccion: z.string().optional().describe("Solo revistas SAIJ - filtrar por rama: 'derecho_privado', 'derecho_penal', 'derecho_publico', 'derechos_humanos', 'derecho_del_trabajo', 'filosofia_del_derecho'. Combina con query (ej. query 'despido' + subcoleccion 'derecho_del_trabajo')"),
    offset: z.number().optional().default(0).describe("Desplazamiento en multiplos de 10 (la fuente pagina de a 10 fijo)"),
    pageSize: z.number().optional().default(10).describe("IGNORADO en esta tool: bibliotecadigital.gob.ar (Omeka) pagina de a 10 fijo server-side (per_page tambien se ignora, verificado 11/06/2026). Paginar con offset."),
    view: z.string().optional().default("colapsada"),
    limite_caracteres: limiteCaracteresParam,
  },
  async (args) => {
    try {
      const results = await searchService.searchBiblioteca(args);
      return { content: [{ type: "text", text: fmtSearch(results, args.limite_caracteres) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  }
);

// ─── get_biblioteca_item ──────────────────────────────────────────────────────
server.tool(
  "saij_get_biblioteca_item",
  "Obtiene la ficha completa de una obra de la Biblioteca Digital de Ediciones SAIJ (bibliotecadigital.gob.ar): resumen/sumario del tomo, director, editorial, año, número, ISSN, temas indexados y enlaces de DESCARGA DIRECTA del PDF/EPUB. Usar con el numero de item o el uuid omeka-item-<n> que devuelve saij_search_biblioteca.",
  {
    item: z.string().describe("Numero de item de la Biblioteca Digital (ej. '1430') o uuid omeka-item-<n> de search_biblioteca"),
  },
  async (args) => {
    try {
      const ficha = await searchService.getBibliotecaItem(args.item);
      return { content: [{ type: "text", text: JSON.stringify(ficha, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  }
);

// ─── get_document ─────────────────────────────────────────────────────────────
server.tool(
  "saij_get_document",
  "Obtiene el texto completo y los metadatos de un documento específico por su GUID.",
  {
    guid: z.string().describe("GUID del documento (ej: '12345678-90ab-cdef-1234-567890abcdef')"),
  },
  async ({ guid }) => {
    try {
      const doc = await documentService.getFullDocument(guid);
      return { content: [{ type: "text", text: JSON.stringify(doc, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  }
);

// ─── get_related_documents ────────────────────────────────────────────────────
server.tool(
  "saij_get_related_documents",
  "Obtiene documentos relacionados (normativa citada, fallos relacionados, etc.) para un documento dado.",
  {
    guid: z.string().describe("GUID del documento"),
  },
  async ({ guid }) => {
    try {
      const relations = await graphService.getRelatedDocuments(guid);
      return { content: [{ type: "text", text: JSON.stringify(relations, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  }
);

// ─── get_document_section ─────────────────────────────────────────────────────
server.tool(
  "saij_get_document_section",
  "Extrae una sección o artículo específico de un documento extenso para ahorrar tokens.",
  {
    guid: z.string().describe("GUID del documento"),
    article_number: z.string().optional().describe("Número de artículo específico (ej: '4')"),
    section_title: z.string().optional().describe("Título de la sección o palabra clave para búsqueda semántica"),
  },
  async ({ guid, article_number, section_title }) => {
    try {
      const section = await documentService.getDocumentSection(guid, {
        articleNumber: article_number,
        sectionTitle: section_title,
      });
      return { content: [{ type: "text", text: JSON.stringify(section, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  }
);

// ─── resolve_citation ─────────────────────────────────────────────────────────
server.tool(
  "saij_resolve_citation",
  "Resuelve una cita jurídica en texto libre y devuelve el documento o artículo correspondiente.",
  {
    citation_text: z.string().describe("Texto de la cita jurídica (ej: 'Ley 24.240', 'Código Civil')"),
  },
  async ({ citation_text }) => {
    try {
      const result = await searchService.resolveCitation(citation_text);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  }
);

// ─── suggest_terms ────────────────────────────────────────────────────────────
server.tool(
  "saij_suggest_terms",
  "Proporciona sugerencias de autocompletado para términos o temas jurídicos.",
  {
    term: z.string().describe("Término o palabra clave para autocompletar"),
    limit: z.number().optional().default(10).describe("Cantidad máxima de sugerencias"),
  },
  async ({ term, limit }) => {
    try {
      const suggestions = await searchService.suggestTerms(term, limit);
      return { content: [{ type: "text", text: JSON.stringify(suggestions, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  }
);

// ─── get_novedades ────────────────────────────────────────────────────────────
server.tool(
  "saij_get_novedades",
  "Recupera las últimas novedades jurídicas publicadas en el SAIJ, ordenadas de más reciente a más antigua.",
  {
    limit: z.number().optional().default(10).describe("Cantidad de novedades a recuperar"),
    limite_caracteres: limiteCaracteresParam,
  },
  async ({ limit, limite_caracteres }) => {
    try {
      const news = await searchService.getNovedades(limit);
      return { content: [{ type: "text", text: fmtSearch(news, limite_caracteres) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  }
);

// ─── Bootstrap ────────────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
