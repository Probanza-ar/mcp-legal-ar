#!/usr/bin/env node
// Captura de red del Portal PJN autenticado (portalpjn.pjn.gov.ar).
// Abre un Chromium VISIBLE: el usuario se loguea en el SSO (las credenciales
// NUNCA pasan por el script ni se graban), navega sus causas, abre una con la
// lupa, mira los documentos y descarga un PDF. El script registra las llamadas
// XHR/fetch de la API (URL, metodo, body de request, respuesta truncada) y al
// apretar ENTER en esta consola guarda todo en ../mcp-legal-ar test/ (carpeta
// PRIVADA, fuera del repo: la captura contiene datos reales de causas).
//
// EXCLUIDO a proposito: todo lo que pasa por sso.pjn.gov.ar y cualquier
// request de auth/token/openid. No se graban headers (ni cookies ni
// Authorization), solo content-type.
//
// Uso: node scripts/capturar-portalpjn.mjs
import { createRequire } from "module";
import path from "path";
import fs from "fs";
import readline from "readline";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(ROOT, "servers", "legal-mcp", "package.json"));
const puppeteer = require("puppeteer");

const DESTINO = path.join(ROOT, "..", "mcp-legal-ar test");
const IGNORAR = /\.(png|jpe?g|gif|svg|woff2?|ttf|css|ico|map)(\?|$)|googletagmanager|google-analytics|gstatic|fonts\./i;
const SECRETOS = /sso\.pjn\.gov\.ar|\/auth\/|token|openid|password|credential/i;

const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: null,
    args: ["--start-maximized", "--disable-blink-features=AutomationControlled"],
});

const capturas = [];
// FIX v2 (11/06): la lupa del portal abre OTRA PESTAÑA (pjn-scw); la v1 solo
// escuchaba la primera y la navegacion del expediente no quedaba registrada.
// Ahora se engancha cada pestaña nueva del navegador.
function enganchar(p) {
    p.on("response", async (resp) => {
        const req = resp.request();
        const url = req.url();
        if (IGNORAR.test(url)) return;
        if (SECRETOS.test(url)) return; // jamas grabar el flujo de autenticacion
        const tipo = req.resourceType();
        if (!["xhr", "fetch", "document", "other"].includes(tipo)) return;
        let body = "";
        let contentType = "";
        try { contentType = resp.headers()["content-type"] || ""; } catch { }
        if (/json|text\/plain|text\/html/i.test(contentType) && tipo !== "document") {
            try { body = (await resp.text()).slice(0, 4000); } catch { }
        }
        capturas.push({
            ts: new Date().toISOString(),
            tipo,
            metodo: req.method(),
            status: resp.status(),
            url,
            requestBody: (req.postData() || "").slice(0, 2000),
            contentType,
            respuesta: body,
        });
        if (tipo !== "document") console.log(`  [${resp.status()}] ${req.method()} ${url.slice(0, 110)}`);
        else console.log(`  [pag] ${url.slice(0, 110)}`);
    });
}
const page = (await browser.pages())[0] || (await browser.newPage());
enganchar(page);
browser.on("targetcreated", async (t) => {
    if (t.type() !== "page") return;
    try { const p = await t.page(); if (p) enganchar(p); } catch { }
});

console.log("=".repeat(70));
console.log("CAPTURA PORTAL PJN - instrucciones:");
console.log("1. Logueate en el SSO en la ventana que se abre (yo no veo ni guardo");
console.log("   tus credenciales; el flujo de auth esta excluido de la captura).");
console.log("2. Anda a tus causas. Mira la lista (despachos D / notificaciones N).");
console.log("3. Abri una causa con la lupa. Abri tambien 'ver documentos'.");
console.log("4. Descarga un PDF de una actuacion.");
console.log("5. Volve a esta consola y apreta ENTER para guardar la captura.");
console.log("=".repeat(70));

await page.goto("https://portalpjn.pjn.gov.ar/inicio", { waitUntil: "domcontentloaded", timeout: 90000 });

await new Promise((res) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question("\n>> ENTER para guardar y cerrar... ", () => { rl.close(); res(); });
});

const archivo = path.join(DESTINO, `captura-portalpjn-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
fs.mkdirSync(DESTINO, { recursive: true });
fs.writeFileSync(archivo, JSON.stringify({ generado: new Date().toISOString(), total: capturas.length, capturas }, null, 2));
console.log(`\nGuardado: ${archivo} (${capturas.length} requests)`);
console.log("RECORDATORIO: el archivo contiene datos reales de tus causas; queda en la carpeta privada, no en el repo.");
await browser.close();
