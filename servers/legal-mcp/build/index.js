import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, } from "@modelcontextprotocol/sdk/types.js";
import { spawn, execSync } from "child_process";
import * as readline from "readline";
import * as path from "path";
import { fileURLToPath } from "url";

// ---------------------------------------------------------------------------
// FIX BUG 1: Rutas relativas al propio archivo, no a ~/legal-hub hardcodeado.
// Funciona independientemente de donde esté instalado el repo.
// ---------------------------------------------------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// index.js vive en <repo>/servers/legal-mcp/build/ -> subir 3 niveles
const ROOT = path.resolve(__dirname, "..", "..", "..");          // raiz del repo
const LEGAL_MCP = path.join(ROOT, "servers", "legal-mcp");
const SAIJ_DIR  = path.join(ROOT, "servers", "saij-mcp");
// process.execPath puede apuntar a una ruta inexistente en nvm/fnm;
// buscamos node en PATH como fallback seguro.
function resolveNode() {
    if (process.platform === "win32") {
        try { return execSync("where node", { encoding: "utf8" }).split("\n")[0].trim(); } catch {}
    } else {
        try { return execSync("which node", { encoding: "utf8" }).trim(); } catch {}
    }
    return process.execPath;
}
const NODE = resolveNode();

// ---------------------------------------------------------------------------
// Timeouts por conector (ms). SCBA y pjnjuris hacen scraping pesado.
// FIX BUG 4: timeouts diferenciados en lugar de 15 s fijo para todos.
// ---------------------------------------------------------------------------
const TIMEOUTS = {
    default:  20000,
    scba:     60000,
    pjnjuris: 90000, // HITL v2: arranque de Chromium + SPA + fetch en pagina
    // pjn HITL v2: irAHome + settle (hasta 30s) + scraping; ademas el primer
    // iniciar_hitl_browser paga el arranque de Chromium.
    pjn:      90000,
    saij:     30000,
    // infoleg tiene cadena de fallbacks con Puppeteer (render JS de
    // argentina.gob.ar) que no entra en 20s.
    infoleg:  90000,
    // portalpjn HITL: arranque de Chromium + login del usuario en SSO +
    // posible reload para renovar token.
    portalpjn: 90000,
};

// ---------------------------------------------------------------------------
// FIX BUG 7: Evitar nombres dobles como saij__saij_search_* 
// Si el tool interno ya tiene el prefix del conector como prefijo, lo eliminamos.
// ---------------------------------------------------------------------------
function stripInternalPrefix(prefix, toolName) {
    const candidates = [`${prefix}__`, `${prefix}_`];
    for (const c of candidates) {
        if (toolName.startsWith(c)) return toolName.slice(c.length);
    }
    return toolName;
}

const CONNECTORS = [
    { prefix: "bora",         command: NODE, args: [path.join(LEGAL_MCP, "build", "bora.js")],         cwd: LEGAL_MCP },
    { prefix: "bopba",        command: NODE, args: [path.join(LEGAL_MCP, "build", "bopba.js")],        cwd: LEGAL_MCP },
    { prefix: "infoleg",      command: NODE, args: [path.join(LEGAL_MCP, "build", "infoleg.js")],      cwd: LEGAL_MCP },
    { prefix: "normativapba", command: NODE, args: [path.join(LEGAL_MCP, "build", "normativapba.js")], cwd: LEGAL_MCP },
    { prefix: "juba",         command: NODE, args: [path.join(LEGAL_MCP, "build", "juba.js")],         cwd: LEGAL_MCP },
    // pjn REHABILITADO 10/6/26: reescritura HITL v2 (la busqueda corre dentro del
    // navegador vivo, globalPage; selectores capturados en _capturas/pjn-capture-*).
    // El captcha lo resuelve siempre el usuario. Ver REPORTE_FIXES_2026-06-10.md #11.
    { prefix: "pjn",          command: NODE, args: [path.join(LEGAL_MCP, "build", "pjn.js")],          cwd: LEGAL_MCP },
    // pjnjuris REHABILITADO 10/6/26: reescritura HITL v2 contra el portal real
    // sj.pjn.gov.ar (API REST capturada en vivo; el host del scaffold no existia).
    { prefix: "pjnjuris",     command: NODE, args: [path.join(LEGAL_MCP, "build", "pjnjuris.js")],     cwd: LEGAL_MCP },
    { prefix: "ptn",          command: NODE, args: [path.join(LEGAL_MCP, "build", "ptn.js")],          cwd: LEGAL_MCP },
    { prefix: "tfn",          command: NODE, args: [path.join(LEGAL_MCP, "build", "tfn.js")],          cwd: LEGAL_MCP },
    // saij REHABILITADO 10/6/26: el 403 anti-bot expiro (probe desde la maquina del
    // usuario: las 4 vias llegan al servidor). El 500 que quedaba era consulta
    // malformada: el termino va en `r`, no en `s` (fix en saij-mcp/build/services/).
    { prefix: "saij",         command: NODE, args: [path.join(LEGAL_MCP, "build", "saij.js")],         cwd: LEGAL_MCP },
    { prefix: "scba",         command: NODE, args: [path.join(LEGAL_MCP, "build", "scba.js")],         cwd: LEGAL_MCP }, // TLS manejado internamente via https.Agent aislado
    // portalpjn NUEVO 11/6/26 (conector 12): feed de novedades D/N del abogado
    // logueado + PDF por evento, via API REST api.pjn.gov.ar capturada en vivo
    // (docs/portalpjn-api.md). Login SIEMPRE del usuario (HITL, SSO Keycloak).
    { prefix: "portalpjn",    command: NODE, args: [path.join(LEGAL_MCP, "build", "portalpjn.js")],    cwd: LEGAL_MCP },
];

class ChildMcpClient {
    prefix;
    config;
    proc;
    rl;
    pending = new Map();
    idCounter = 1;
    tools = [];
    ready = false;
    dead = false;
    _respawnAttempts = 0;
    _respawnTimer = null;

    constructor(prefix, config) {
        this.prefix = prefix;
        this.config = config;
        this._spawn();
    }

    _spawn() {
        const env = { ...process.env, ...(this.config.env ?? {}) };
        this.proc = spawn(this.config.command, this.config.args, {
            cwd: this.config.cwd,
            env,
            stdio: ["pipe", "pipe", "pipe"],
        });
        this.dead = false;
        this.rl = readline.createInterface({ input: this.proc.stdout });
        this.rl.on("line", (line) => {
            line = line.trim();
            if (!line) return;
            try {
                const msg = JSON.parse(line);
                if (msg.id !== undefined) {
                    const pending = this.pending.get(msg.id);
                    if (pending) {
                        this.pending.delete(msg.id);
                        if (msg.error) {
                            pending.reject(new Error(`[${this.prefix}] ${msg.error.message} (code ${msg.error.code})`));
                        } else {
                            pending.resolve(msg.result);
                        }
                    }
                }
            } catch {
                // linea no JSON - ignorar
            }
        });
        this.proc.stderr?.on("data", (d) => {
            const txt = d.toString().trim();
            if (txt) process.stderr.write(`[${this.prefix}] ${txt}\n`);
        });
        this.proc.on("exit", (code) => {
            this.dead = true;
            this.ready = false;
            process.stderr.write(`[${this.prefix}] proceso terminado (code ${code})\n`);
            for (const [id, p] of this.pending) {
                p.reject(new Error(`[${this.prefix}] proceso terminado inesperadamente (code ${code})`));
            }
            this.pending.clear();
            // Respawn con backoff exponencial (max 5 intentos, max 60s)
            if (!globalThis._hubShuttingDown && this._respawnAttempts < 5) {
                const delay = Math.min(1000 * Math.pow(2, this._respawnAttempts), 60000);
                this._respawnAttempts++;
                process.stderr.write(`[${this.prefix}] respawn #${this._respawnAttempts} en ${delay}ms...\n`);
                this._respawnTimer = setTimeout(async () => {
                    try {
                        this._spawn();
                        await this.initialize();
                        this._respawnAttempts = 0;
                        process.stderr.write(`[${this.prefix}] respawn exitoso\n`);
                    } catch (e) {
                        process.stderr.write(`[${this.prefix}] respawn fallido: ${e.message}\n`);
                    }
                }, delay);
            } else if (this._respawnAttempts >= 5) {
                process.stderr.write(`[${this.prefix}] maximo de respawns alcanzado - conector deshabilitado\n`);
            }
        });
    }

    send(method, params, timeoutMs) {
        // FIX BUG 5: rechazar inmediatamente si el proceso ya murió
        if (this.dead) {
            return Promise.reject(new Error(`[${this.prefix}] conector no disponible (proceso terminado)`));
        }
        const ms = timeoutMs ?? TIMEOUTS.default;
        return new Promise((resolve, reject) => {
            const id = this.idCounter++;
            const req = { jsonrpc: "2.0", id, method, params: params ?? {} };
            this.pending.set(id, { resolve, reject });
            try {
                this.proc.stdin.write(JSON.stringify(req) + "\n");
            } catch (e) {
                this.pending.delete(id);
                reject(e);
                return;
            }
            // FIX BUG 4: usar el timeout configurado por conector
            setTimeout(() => {
                if (this.pending.has(id)) {
                    this.pending.delete(id);
                    reject(new Error(`[${this.prefix}] timeout (${ms}ms) en ${method}`));
                }
            }, ms);
        });
    }

    notify(method, params) {
        const msg = { jsonrpc: "2.0", method, params: params ?? {} };
        try {
            this.proc.stdin.write(JSON.stringify(msg) + "\n");
        } catch {
            // ignorar errores en notificaciones
        }
    }

    async initialize() {
        await this.send("initialize", {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            clientInfo: { name: "mcp-legal-ar-proxy", version: "2.1.0" },
        }, 20000);
        this.notify("notifications/initialized");
        const result = (await this.send("tools/list", {}, 15000));
        // FIX BUG 8: stripInternalPrefix es destructivo (juba_info -> juba__info)
        // y el slice posterior en callTool reenviaba "info" al hijo -> -32602.
        // Guardamos el mapeo nombre expuesto -> nombre original del hijo.
        this.toolNameMap = new Map();
        this.tools = (result.tools ?? []).map((t) => {
            const exposed = `${this.prefix}__${stripInternalPrefix(this.prefix, t.name)}`;
            this.toolNameMap.set(exposed, t.name);
            return { ...t, name: exposed };
        });
        this.ready = true;
        process.stderr.write(`[${this.prefix}] ok - ${this.tools.length} tools\n`);
    }

    async callTool(prefixedName, args) {
        // FIX BUG 5: verificar que el proceso siga vivo antes de intentar la llamada
        if (this.dead) {
            throw new Error(`[${this.prefix}] conector no disponible (proceso terminado)`);
        }
        // FIX BUG 8: resolver el nombre original via mapa (el slice rompía
        // tools cuyo nombre interno empieza con el prefijo, ej. juba_info).
        const originalName = this.toolNameMap?.get(prefixedName)
            ?? prefixedName.slice(`${this.prefix}__`.length);
        // FIX BUG 4: usar timeout específico para este conector
        const ms = TIMEOUTS[this.prefix] ?? TIMEOUTS.default;
        return this.send("tools/call", { name: originalName, arguments: args }, ms);
    }

    kill() {
        if (this._respawnTimer) clearTimeout(this._respawnTimer);
        this.proc.kill();
    }
}

// ---------------------------------------------------------------------------
// Servidor principal
// ---------------------------------------------------------------------------
async function main() {
    const server = new Server(
        { name: "mcp-legal-ar", version: "2.1.0" },
        { capabilities: { tools: {} } }
    );

    process.stderr.write("[mcp-legal-ar] iniciando conectores...\n");
    process.stderr.write(`[mcp-legal-ar] ROOT: ${ROOT}\n`);

    const clients = [];
    await Promise.allSettled(
        CONNECTORS.map(async (cfg) => {
            const client = new ChildMcpClient(cfg.prefix, cfg);
            try {
                await client.initialize();
                clients.push(client);
            } catch (e) {
                process.stderr.write(`[${cfg.prefix}] ERROR al inicializar: ${e.message}\n`);
            }
        })
    );

    const toolMap = new Map();
    const allTools = [];
    for (const client of clients) {
        for (const tool of client.tools) {
            toolMap.set(tool.name, client);
            allTools.push(tool);
        }
    }

    process.stderr.write(`[mcp-legal-ar] listo - ${clients.length} conectores, ${allTools.length} tools totales\n`);

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: allTools.map((t) => ({
            name: t.name,
            description: t.description ?? "",
            inputSchema: t.inputSchema ?? { type: "object", properties: {} },
        })),
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args = {} } = request.params;

        const client = toolMap.get(name);
        if (!client) {
            return {
                content: [{ type: "text", text: `Tool "${name}" no encontrada en mcp-legal-ar.` }],
                isError: true,
            };
        }

        // FIX BUG 5: verificar liveness antes de llamar
        if (client.dead) {
            return {
                content: [{ type: "text", text: `[${client.prefix}] conector no disponible. El proceso hijo terminó inesperadamente.` }],
                isError: true,
            };
        }

        try {
            const result = await client.callTool(name, args);
            if (result && typeof result === "object" && "content" in result) {
                return result;
            }
            return {
                content: [
                    {
                        type: "text",
                        text: typeof result === "string" ? result : JSON.stringify(result, null, 2),
                    },
                ],
            };
        } catch (e) {
            return {
                content: [{ type: "text", text: `Error: ${e.message}` }],
                isError: true,
            };
        }
    });

    process.on("SIGINT", () => {
        globalThis._hubShuttingDown = true;
        clients.forEach((c) => c.kill());
        process.exit(0);
    });
    process.on("SIGTERM", () => {
        globalThis._hubShuttingDown = true;
        clients.forEach((c) => c.kill());
        process.exit(0);
    });

    const transport = new StdioServerTransport();
    await server.connect(transport);
    process.stderr.write("[mcp-legal-ar] conectado y escuchando\n");
}

main().catch((e) => {
    process.stderr.write(`[mcp-legal-ar] error fatal: ${e.message}\n`);
    process.exit(1);
});
