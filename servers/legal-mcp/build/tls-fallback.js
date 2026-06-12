import https from "https";

// ---------------------------------------------------------------------------
// Fallback TLS por conector. Replica el patron de ptn-http.js:
//   - Verificacion estricta por defecto.
//   - Reintento sin verificacion SOLO ante errores de cadena de certificado.
//   - Forzable desde el arranque via env var <PREFIX>_TLS_INSECURE=1.
//
// Reemplaza al antiguo NODE_TLS_REJECT_UNAUTHORIZED=0 global, que desactivaba
// la validacion TLS para todo el proceso y todos los conectores hijos.
// CWE-295: el riesgo queda acotado por conector y solo se activa ante un cert
// roto real, en trafico de lectura publica sin credenciales.
// ---------------------------------------------------------------------------

const strictAgent = new https.Agent({ rejectUnauthorized: true });
const insecureAgent = new https.Agent({ rejectUnauthorized: false });

function envForcesInsecure(prefix) {
    const v = process.env[`${prefix.toUpperCase()}_TLS_INSECURE`];
    return v === "1" || v === "true";
}

function isTlsVerificationError(error) {
    const code = error?.code ?? "";
    const message = error?.message ?? "";
    return (code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ||
        code === "UNABLE_TO_VERIFY_CERT_SIGNATURE" ||
        code === "SELF_SIGNED_CERT_IN_CHAIN" ||
        code === "CERT_HAS_EXPIRED" ||
        code === "DEPTH_ZERO_SELF_SIGNED_CERT" ||
        message.includes("unable to verify") ||
        message.includes("certificate"));
}

/**
 * Instala el comportamiento de fallback TLS sobre una instancia de axios.
 *
 * @param {import("axios").AxiosInstance} axiosInstance instancia a instrumentar
 * @param {string} prefix prefijo del conector (ej. "bopba", "tfn", "juba")
 * @returns el agente estricto inicial, para usar como httpsAgent por defecto
 *          en call-sites que lo pasan inline.
 */
export function installTlsFallback(axiosInstance, prefix) {
    const forced = envForcesInsecure(prefix);
    let warned = false;

    // Si la env var lo fuerza, arrancamos inseguros sin intentar estricto.
    axiosInstance.interceptors.request.use((config) => {
        if (forced) {
            config.httpsAgent = insecureAgent;
        } else if (!config.httpsAgent) {
            config.httpsAgent = strictAgent;
        }
        return config;
    });

    axiosInstance.interceptors.response.use(undefined, async (error) => {
        const config = error?.config;
        // Reintento solo: error de cert + no forzado + no reintentado aun.
        if (!forced && config && !config.__tlsRetried && isTlsVerificationError(error)) {
            config.__tlsRetried = true;
            config.httpsAgent = insecureAgent;
            if (!warned) {
                warned = true;
                process.stderr.write(`[${prefix}] verificacion TLS fallida; reintentando sin validacion de certificado. ` +
                    `Defina ${prefix.toUpperCase()}_TLS_INSECURE=1 para usar TLS inseguro desde el arranque.\n`);
            }
            return axiosInstance.request(config);
        }
        return Promise.reject(error);
    });

    return forced ? insecureAgent : strictAgent;
}
