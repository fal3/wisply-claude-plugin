// Where the connector gets its token.
//
// 1. WISPLY_MCP_TOKEN, when it's set to a real value. A client's secret
//    store puts it there (VS Code SecretStorage, MCPB user_config, Gemini
//    settings). An empty value, or a ${...} placeholder the client left
//    unresolved, counts as unset.
// 2. Otherwise, on macOS, the Keychain item the connector manages
//    (service "ai.wisply.mcp", account "token"). Reading, writing and
//    deleting that item arrive with the setup command (DIST-M2); until then
//    the default reader finds nothing, so a missing env token is "missing".
//
// Nothing here throws, and no result ever carries the value except `token`.
import { TOKEN_RE } from './scopes.mjs';

/** A value a client left as written: ${user_config.x}, ${input:x}, ${env:X}. */
export const PLACEHOLDER_RE = /^\$\{[^}]+\}$/;

/**
 * Reads the connector's Keychain item. In this version there is no Keychain
 * support yet (DIST-M2 adds `security find-generic-password` behind this
 * same signature), so it always finds nothing.
 * @returns {Promise<string|null>}
 */
export async function defaultReadKeychain() {
  return null;
}

/**
 * @typedef {{token: string|null, source: 'env'|'keychain'|null,
 *   problem: null|'missing'|'malformed'|'not-mac', placeholderIgnored: boolean}} TokenResolution
 */

/**
 * Finds the token: the environment first, then the Keychain on macOS.
 * 'malformed' is a non-placeholder env value that isn't a Wisply token (no
 * Keychain fallback: the user set something wrong). 'not-mac' is no usable
 * env token on another platform. Never throws.
 * @param {{env?: Record<string, string|undefined>, platform?: string, readKeychain?: () => Promise<unknown>}} [deps]
 * @returns {Promise<TokenResolution>}
 */
export async function resolveToken({ env = process.env, platform = process.platform, readKeychain = defaultReadKeychain } = {}) {
  let placeholderIgnored = false;
  try {
    const raw = env?.WISPLY_MCP_TOKEN;
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (value !== '') {
      if (PLACEHOLDER_RE.test(value)) {
        placeholderIgnored = true;
      } else if (TOKEN_RE.test(value)) {
        return { token: value, source: 'env', problem: null, placeholderIgnored };
      } else {
        return { token: null, source: null, problem: 'malformed', placeholderIgnored };
      }
    }
    if (platform !== 'darwin') return { token: null, source: null, problem: 'not-mac', placeholderIgnored };
    const stored = await readKeychain();
    const candidate = typeof stored === 'string' ? stored.trim() : '';
    if (TOKEN_RE.test(candidate)) return { token: candidate, source: 'keychain', problem: null, placeholderIgnored };
  } catch {
    // A failed lookup is "no token"; the failure itself is never shown.
  }
  return { token: null, source: null, problem: 'missing', placeholderIgnored };
}

const TOKEN_ANYWHERE = /wsp[cr]?_[0-9a-f]{64}/g;

/**
 * Replaces anything shaped like a Wisply token. Runs on every debug line.
 * @param {unknown} text
 * @returns {string}
 */
export function redact(text) {
  return String(text).replace(TOKEN_ANYWHERE, 'wsp...');
}
