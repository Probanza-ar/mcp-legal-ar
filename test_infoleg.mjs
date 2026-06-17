#!/usr/bin/env node
/**
 * Harness de regresión - conector InfoLeg (mcp-legal-ar)
 * Bitácora: BITACORA_INFOLEG_2026-06-16.md
 *
 * Conecta al server MCP por stdio y corre los 6 casos diagnosticados.
 * No depende del host: levanta el propio server.
 *
 * Uso:
 *   npm i @modelcontextprotocol/sdk
 *   MCP_LEGAL_CMD="node build/index.js" MCP_LEGAL_CWD="C:/Users/Ximena/mcp-legal-ar" \
 *     node test_infoleg.mjs
 *
 * Variables:
 *   MCP_LEGAL_CMD    comando que arranca el server (default: "node build/index.js")
 *   MCP_LEGAL_CWD    cwd del server (default: cwd actual)
 *   MCP_TOOL_PREFIX  prefijo de las tools del namespace (default: "infoleg__")
 *
 * Semántica:
 *   - Cada caso define assert() = expectativa POST-FIX.
 *   - knownFail:true marca los que hoy (16/6/2026) fallan a propósito.
 *   - Exit 0 si todos los no-knownFail pasan. Exit 1 si rompe alguno que hoy pasaba.
 *   - Cuando apliques un fix, sacá el knownFail del caso correspondiente.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Bitácora: BITACORA_INFOLEG_2026-06-16.md | Fixes 16/6: T5 (metadatos), T6 (códigos).
const CMD = process.env.MCP_LEGAL_CMD || "node build/index.js";
const CWD = process.env.MCP_LEGAL_CWD || process.cwd();
const PREFIX = process.env.MCP_TOOL_PREFIX ?? "infoleg__";

const [bin, ...binArgs] = CMD.split(" ");

function textOf(res) {
  if (!res) return "";
  if (res.isError) return "__ERROR__ " + JSON.stringify(res.content ?? res);
  const parts = Array.isArray(res.content) ? res.content : [];
  return parts.map((c) => (typeof c.text === "string" ? c.text : "")).join("\n");
}

// ---- Casos ----------------------------------------------------------------
const CASES = [
  {
    id: "T1",
    desc: "localizar_codigo Codigo Aduanero -> idNorma 16536",
    tool: "localizar_codigo",
    args: { codigo: "codigo aduanero" },
    assert: (t) => /16536/.test(t),
    knownFail: false,
  },
  {
    id: "T2",
    desc: "buscar_norma_por_tipo_numero_anio RG 4352/2018 -> resuelve 317312",
    tool: "buscar_norma_por_tipo_numero_anio",
    args: { tipoNorma: "Resolución General", numeroNorma: "4352", anioNorma: "2018" },
    assert: (t) => /317312/.test(t),
    knownFail: true, // hoy devuelve 0 resultados
  },
  {
    id: "T3",
    desc: "buscar_normativa filtro estructurado 4352/2018 -> incluye 317312",
    tool: "buscar_normativa",
    args: { criterio: "4352", tipoNorma: "Resolución General", anioNorma: "2018" },
    assert: (t) => /317312/.test(t),
    knownFail: true, // hoy ignora numero/anio y trae feed 2026
  },
  {
    id: "T3c",
    desc: "CONTROL buscar_normativa por texto exacto -> alcanza 317312",
    tool: "buscar_normativa",
    args: { criterio: "depósitos fiscales", fraseExacta: true },
    assert: (t) => /317312/.test(t),
    knownFail: false, // se espera que ya funcione por texto
  },
  {
    id: "T4",
    desc: "obtener_texto_norma 317312 -> cuerpo completo no vacío",
    tool: "obtener_texto_norma",
    args: { idNorma: "317312", tipoTexto: "actualizado" },
    assert: (t) => t.length > 5000 && /(DEP[ÓO]SITO|FISCAL)/i.test(t),
    knownFail: false,
  },
  {
    id: "T5",
    desc: "obtener_metadatos_norma 317312 -> ficha sin 500",
    tool: "obtener_metadatos_norma",
    args: { idNorma: "317312" },
    assert: (t) => !/__ERROR__|status code 500/i.test(t) && /4352/.test(t),
    knownFail: false, // FIXED 16/6: reencaminado a InfoLEG (metadatosDesdeInfoLeg)
  },
  {
    id: "T6",
    desc: "obtener_texto_norma 16536 (código) -> índice navegable con URLs absolutas",
    tool: "obtener_texto_norma",
    args: { idNorma: "16536", tipoTexto: "actualizado" },
    assert: (t) => /anexos\/15000-19999\/16536\/Ley22415/i.test(t) && /seccion=/.test(t),
    knownFail: false, // FIXED 16/6: detección de índice + resolución de sub-documentos
  },
  {
    id: "T6b",
    desc: "obtener_texto_norma 16536 seccion=Titulo_preliminar -> articulado (Artículo 1)",
    tool: "obtener_texto_norma",
    args: { idNorma: "16536", tipoTexto: "actualizado", seccion: "Titulo_preliminar" },
    assert: (t) => /ART[IÍ]CULO\s*1\b/i.test(t),
    knownFail: false, // FIXED 16/6
  },
];

// ---- Runner ---------------------------------------------------------------
async function main() {
  const transport = new StdioClientTransport({ command: bin, args: binArgs, cwd: CWD });
  const client = new Client({ name: "infoleg-regression", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);

  const rows = [];
  for (const c of CASES) {
    const name = PREFIX + c.tool;
    let ok = false;
    let note = "";
    let raw = "";
    try {
      const res = await client.callTool({ name, arguments: c.args });
      raw = textOf(res);
      ok = !!c.assert(raw);
    } catch (e) {
      raw = "__EXCEPTION__ " + (e?.message || String(e));
      ok = false;
    }
    // estado mostrado
    let status;
    if (ok) status = "PASS";
    else if (c.knownFail) status = "KNOWN-FAIL";
    else status = "FAIL";
    note = raw.replace(/\s+/g, " ").slice(0, 90);
    rows.push({ id: c.id, status, desc: c.desc, note });
  }

  await client.close();

  // Reporte
  const pad = (s, n) => (s + " ".repeat(n)).slice(0, n);
  console.log("\n== InfoLeg regression ==");
  for (const r of rows) {
    console.log(`${pad(r.id, 5)} ${pad(r.status, 11)} ${r.desc}`);
    console.log(`      └ ${r.note}`);
  }

  // Exit code: rompe si algún caso NO-knownFail dio FAIL
  const regressions = rows.filter((r) => r.status === "FAIL");
  const fixed = CASES.filter((c, i) => c.knownFail && rows[i].status === "PASS");
  if (fixed.length) {
    console.log(`\n✔ ${fixed.length} caso(s) marcado(s) knownFail ahora PASAN: ${fixed.map((c) => c.id).join(", ")}. Sacales el knownFail.`);
  }
  if (regressions.length) {
    console.error(`\n✘ Regresiones: ${regressions.map((r) => r.id).join(", ")}`);
    process.exit(1);
  }
  console.log("\nSin regresiones.");
  process.exit(0);
}

main().catch((e) => {
  console.error("Harness error:", e);
  process.exit(2);
});
