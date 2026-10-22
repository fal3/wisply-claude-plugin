// The connector's JSON-RPC handler: a stdio MCP server in front of the
// Wisply app on 127.0.0.1.
//
// initialize, ping and tools/list are answered here, from the contract,
// without contacting the port. tools/call resolves the token, refuses tools
// outside its scope, asks the listener to prove it holds the same token, and
// only then forwards the call with the token as a bearer header. Results
// pass through unchanged. Failures become fixed texts from lib/messages.mjs
// (tool errors, or a JSON-RPC error that keeps only Wisply's error code), so
// they never contain the token, Wisply's error messages or its response body.
import {
  CALL_TIMEOUT_MS, CLAUDE_SETUP_TOOL, KEYCHAIN_TIMEOUT_MS, LIVE_TIMEOUT_MS, PROTOCOL_VERSIONS, SERVER_KEY,
  TOOL_NOT_PERMITTED, VERSION,
} from './constants.mjs';
import * as messages from './messages.mjs';
import { scopeOfToken, toolsFor } from './scopes.mjs';

const error = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
const reply = (id, result) => ({ jsonrpc: '2.0', id, result });
const toolError = (id, text) => reply(id, { content: [{ type: 'text', text }], isError: true });
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const PROBLEMS = new Set(['missing', 'malformed', 'not-mac']);

/**
 * Runs `start()` but gives up after `ms`, resolving null. Never rejects.
 * @template T
 * @param {() => Promise<T>} start
 * @param {number} ms
 * @returns {Promise<T|null>}
 */
function within(start, ms) {
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(resolve, ms, null); });
  let work;
  try { work = Promise.resolve(start()).catch(() => null); } catch { work = Promise.resolve(null); }
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/**
 * @param {{
 *   contract: {tools: readonly string[], scopes: Record<string, {tools: readonly string[]}>,
 *              tool_descriptors: readonly {name: string}[], default_port: number},
 *   resolveToken: () => Promise<{token: string|null, problem: string|null}>,
 *   loopback: {port?: number,
 *              identity: (token: string, scope: string) => Promise<{outcome: string, status?: number, bytes?: number}>,
 *              call: (token: string, body: string, timeoutMs: number) => Promise<{status: number, text: string, bytes?: number}>},
 *   allowClaudeSetup?: boolean, readOnly?: boolean, port?: number,
 *   debug?: (fields: object) => void, keychainTimeoutMs?: number, platform?: string,
 * }} deps
 */
export function createBridge({
  contract, resolveToken, loopback, allowClaudeSetup = false, readOnly = false, port,
  debug = () => {}, keychainTimeoutMs = KEYCHAIN_TIMEOUT_MS, platform = process.platform,
}) {
  const wisplyPort = port ?? loopback.port ?? contract.default_port;
  const knownTools = new Set(contract.tools);
  const readableTools = new Set(contract.scopes.connector?.tools ?? []);
  const descriptors = new Map(contract.tool_descriptors.map((descriptor) => [descriptor.name, descriptor]));

  // The last token found, kept for the life of the process.
  /** @type {{token: string, scope: 'full'|'connector'|'recording'} | null} */
  let cached = null;
  let listResolved = false;

  /** One resolution, bounded by the Keychain timeout. Caches what it finds. */
  async function resolveNow() {
    const found = await within(resolveToken, keychainTimeoutMs);
    const token = isObject(found) && typeof found.token === 'string' ? found.token : null;
    const scope = scopeOfToken(token);
    if (token && scope) {
      cached = { token, scope };
      return cached;
    }
    return { problem: isObject(found) && PROBLEMS.has(found.problem) ? found.problem : 'missing' };
  }

  // tools/list never contacts the port. It uses the cached token's scope,
  // or resolves once per process; with no usable token it lists the
  // connector tools, so inspectors and catalogs see the read-only tools.
  async function listScope() {
    if (!cached && !listResolved) {
      listResolved = true;
      await resolveNow();
    }
    return cached ? cached.scope : 'connector';
  }

  const problemText = (problem) => {
    if (problem === 'malformed') return messages.MALFORMED;
    if (problem === 'not-mac') return messages.notMac(platform);
    return messages.SETUP;
  };

  /** Why `scope` can't call `name` here, or null. */
  function refusal(name, scope) {
    if (!toolsFor(contract, scope, { allowClaudeSetup: true }).includes(name)) {
      return { outcome: 'scope', text: messages.scope(name, scope) };
    }
    if (readOnly && !readableTools.has(name)) {
      return { outcome: 'scope', text: messages.scope(name, scope, { readOnly: true }) };
    }
    if (name === CLAUDE_SETUP_TOOL && !allowClaudeSetup) {
      return { outcome: 'claude-setup-hidden', text: messages.CLAUDE_SETUP_HIDDEN };
    }
    return null;
  }

  /** The identity check; a check that throws counts as nothing answering. */
  async function proven(held) {
    try {
      return await loopback.identity(held.token, held.scope);
    } catch {
      return { outcome: 'unavailable' };
    }
  }

  function initializeResult(params) {
    const requested = params?.protocolVersion;
    return {
      protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVER_KEY, title: 'Wisply', version: VERSION },
      instructions: messages.INSTRUCTIONS,
    };
  }

  /** @returns {Promise<{response: object, outcome: string, tool?: string, status?: number, bytes?: number}>} */
  async function callTool(id, params) {
    const name = params?.name;
    if (typeof name !== 'string' || !knownTools.has(name)) {
      return { response: error(id, -32602, messages.RPC.UNKNOWN_TOOL), outcome: 'unknown-tool' };
    }
    const done = (outcome, response, extra = {}) => ({ response, outcome, tool: name, ...extra });
    const args = params?.arguments ?? {};
    if (!isObject(args)) return done('bad-arguments', error(id, -32602, messages.RPC.BAD_ARGUMENTS));

    let held = cached ?? await resolveNow();
    if ('problem' in held) return done(held.problem === 'missing' ? 'setup' : held.problem, toolError(id, problemText(held.problem)));
    let refused = refusal(name, held.scope);
    if (refused) return done(refused.outcome, toolError(id, refused.text));

    let identity = await proven(held);
    if (identity.outcome === 'not-wisply') {
      // `setup` may have rotated the token since it was cached: resolve once
      // more and retry the check once, never more.
      cached = null;
      held = await resolveNow();
      if ('problem' in held) return done(held.problem === 'missing' ? 'setup' : held.problem, toolError(id, problemText(held.problem)));
      refused = refusal(name, held.scope);
      if (refused) return done(refused.outcome, toolError(id, refused.text));
      identity = await proven(held);
    }
    const status = identity.status;
    switch (identity.outcome) {
      case 'ok': break;
      case 'unavailable': return done('unavailable', toolError(id, messages.unavailable(wisplyPort)), { status });
      case 'old-wisply': return done('old-wisply', toolError(id, messages.UPDATE_WISPLY), { status });
      case 'missing-scope': return done('missing-scope', toolError(id, messages.UPDATE_WISPLY_SCOPE), { status });
      case 'keychain': return done('keychain', toolError(id, messages.keychainUnavailable(wisplyPort)), { status });
      default: return done('not-wisply', toolError(id, messages.notWisply(wisplyPort)), { status });
    }

    // The token goes only to a listener that has just proved it is Wisply.
    const body = JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
    let response;
    try {
      response = await loopback.call(held.token, body, name === 'get_live_transcript' ? LIVE_TIMEOUT_MS : CALL_TIMEOUT_MS);
    } catch {
      return done('unavailable', toolError(id, messages.unavailable(wisplyPort)));
    }
    const meta = { status: response?.status, bytes: response?.bytes };
    // Redirects (3xx) are never followed, and like any other non-2xx
    // status they end the call here.
    if (!(response?.status >= 200 && response.status < 300)) {
      return done('request-failed', toolError(id, messages.requestFailed(Number(response?.status) || 0)), meta);
    }
    let answer;
    try { answer = JSON.parse(response.text); } catch { return done('unavailable', toolError(id, messages.unavailable(wisplyPort)), meta); }
    if (!isObject(answer) || answer.jsonrpc !== '2.0' || answer.id !== id) {
      return done('unavailable', toolError(id, messages.unavailable(wisplyPort)), meta);
    }
    if (isObject(answer.error)) {
      if (answer.error.code === TOOL_NOT_PERMITTED) return done('scope', toolError(id, messages.scope(name, held.scope)), meta);
      // Wisply's code is kept; its message is replaced by a fixed text.
      if (Number.isSafeInteger(answer.error.code)) {
        return done('rpc-error', error(id, answer.error.code, messages.rpcFailed(answer.error.code, name)), meta);
      }
    }
    if (!isObject(answer.result) || !Array.isArray(answer.result.content)) {
      return done('unavailable', toolError(id, messages.unavailable(wisplyPort)), meta);
    }
    return done('ok', reply(id, answer.result), meta);
  }

  /**
   * Handles one JSON-RPC message from the MCP client.
   * @param {unknown} message
   * @returns {Promise<object|undefined>} the response, or undefined for a notification
   */
  async function handle(message) {
    const started = Date.now();
    const log = (method, outcome, extra = {}) => debug({ method, outcome, ms: Date.now() - started, ...extra });
    const hasID = Object.hasOwn(message ?? {}, 'id');
    const id = hasID ? message.id : null;
    if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string' ||
        (hasID && id !== null && typeof id !== 'string' && typeof id !== 'number')) {
      log(undefined, 'invalid-request');
      return error(null, -32600, messages.RPC.INVALID_REQUEST);
    }
    // Notifications (initialized, cancelled) need nothing and get no answer.
    if (!hasID) {
      log(message.method, 'notification');
      return undefined;
    }
    switch (message.method) {
      case 'initialize':
        log('initialize', 'local');
        return reply(id, initializeResult(message.params));
      case 'ping':
        log('ping', 'local');
        return reply(id, {});
      case 'tools/list': {
        const scope = await listScope();
        log('tools/list', 'local');
        return reply(id, {
          tools: toolsFor(contract, scope, { allowClaudeSetup, readOnly }).map((name) => descriptors.get(name)),
        });
      }
      case 'tools/call': {
        const { response, outcome, tool, status, bytes } = await callTool(id, message.params);
        log('tools/call', outcome, { tool, status, bytes });
        return response;
      }
      default:
        // Includes server/discover, the MCP 2026-07-28 probe: a dual-era
        // client falls back to initialize on this error.
        log(message.method, 'method-not-found');
        return error(id, -32601, messages.RPC.METHOD_NOT_FOUND);
    }
  }

  return { handle };
}
