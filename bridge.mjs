// Read-only stdio MCP server for the local Wisply app.
//
// The bridge answers the MCP handshake (initialize, ping, tools/list) itself,
// from fixed text in lib/shared.mjs, without the token and without contacting
// Wisply. Only tools/call for one of the four read-only tools is forwarded,
// with the token as a bearer header, to the fixed loopback endpoint, and only
// after whatever listens there has proved it is Wisply: before every forwarded
// call the bridge sends a fresh identity challenge, without the token, and
// checks the answer (lib/identity.mjs).
import http from 'node:http';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { newNonce, proofMatches } from './lib/identity.mjs';
import {
  BRIDGE_INSTRUCTIONS,
  BRIDGE_NAME,
  BRIDGE_VERSION,
  MAX_RESPONSE_BYTES,
  NOT_WISPLY_MESSAGE,
  PROTOCOL_VERSIONS,
  READ_ONLY_TOOLS,
  REQUEST_FAILED_MESSAGE,
  SCOPE_MESSAGE,
  SETUP_MESSAGE,
  TOOL_DESCRIPTORS,
  UNAVAILABLE_MESSAGE,
  UPDATE_WISPLY_MESSAGE,
  WISPLY_ENDPOINT,
  WISPLY_IDENTITY_ENDPOINT,
  requestTimeoutMs,
  usableToken,
} from './lib/shared.mjs';

export const allowedTools = new Set(READ_ONLY_TOOLS);

/** The identity answer is small and computed in memory, so its budget is too. */
export const IDENTITY_TIMEOUT_MS = 3000;
export const MAX_IDENTITY_BYTES = 8 * 1024;

/** JSON-RPC error code Wisply returns when a token's scope does not allow a tool. */
export const TOOL_NOT_PERMITTED = -32003;

/** The port the proof is bound to: the one the bridge connects to. */
const WISPLY_PORT = Number(new URL(WISPLY_ENDPOINT).port);
const TOO_LARGE = 'WISPLY_RESPONSE_TOO_LARGE';

const error = (id, code, message) => ({jsonrpc:'2.0', id, error:{code, message}});
const reply = (id, result) => ({jsonrpc:'2.0', id, result});
const toolError = (id, text) => reply(id, {content:[{type:'text', text}], isError:true});
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// One HTTP exchange through node:http with the caller's own agent; see
// createHttpTransport for why. An oversized body rejects with TOO_LARGE.
function exchange(agent, target, {method, path, headers, body, timeoutMs, maxBytes}) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: target.hostname,
      port: Number(target.port),
      path,
      method,
      agent,
      signal: AbortSignal.timeout(timeoutMs),
      headers: body === undefined ? headers : {...headers, 'Content-Length': String(Buffer.byteLength(body))},
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          response.destroy();
          request.destroy();
          reject(Object.assign(new Error('Response too large'), {code:TOO_LARGE}));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        text: Buffer.concat(chunks).toString('utf8'),
      }));
      response.on('error', reject);
    });
    request.on('error', reject);
    request.end(body);
  });
}

/**
 * Makes the HTTP transport for one fixed URL. It uses node:http with an agent
 * of its own, so proxy settings in the environment (HTTP_PROXY together with
 * NODE_USE_ENV_PROXY or --use-env-proxy) can't send the request, and the
 * token in it, anywhere else. It never follows redirects, aborts at the
 * timeout, and stops reading past MAX_RESPONSE_BYTES.
 * @param {string} url
 * @returns {(request: {body: string, headers: Record<string,string>, timeoutMs: number}) => Promise<{status: number, text: string}>}
 */
export function createHttpTransport(url) {
  const target = new URL(url);
  const agent = new http.Agent({keepAlive:false});
  return async ({body, headers, timeoutMs}) => {
    const {status, text} = await exchange(agent, target, {
      method:'POST', path:target.pathname, headers, body, timeoutMs, maxBytes:MAX_RESPONSE_BYTES,
    });
    return {status, text};
  };
}

/**
 * Makes the transport for Wisply's identity challenge at one fixed URL:
 * GET <url>?nonce=<nonce> with no Authorization header (it never sees the
 * token), through an agent of its own, never following redirects, aborting
 * at the timeout and reading at most MAX_IDENTITY_BYTES.
 * @param {string} url
 * @returns {(request: {nonce: string, timeoutMs?: number}) => Promise<{status: number, text: string, headers?: Record<string, unknown>}>}
 */
export function createIdentityTransport(url) {
  const target = new URL(url);
  const agent = new http.Agent({keepAlive:false});
  return async ({nonce, timeoutMs = IDENTITY_TIMEOUT_MS}) => {
    if (typeof nonce !== 'string' || !/^[0-9a-f]{32,128}$/.test(nonce)) throw new Error('Invalid nonce');
    return exchange(agent, target, {
      method:'GET', path:`${target.pathname}?nonce=${nonce}`, headers:{Accept:'application/json'},
      body:undefined, timeoutMs, maxBytes:MAX_IDENTITY_BYTES,
    });
  };
}

const defaultTransport = createHttpTransport(WISPLY_ENDPOINT);
const defaultIdentityTransport = createIdentityTransport(WISPLY_IDENTITY_ENDPOINT);

// Wisply versions without the identity check have no /mcp/identity. Their
// bearer check runs before routing, so a challenge without a token is
// turned away with Wisply's own realm (401); one that routes first answers
// 404. Either way the token stays here.
const WISPLY_REALM = /\bBearer\s+realm="wisply-mcp"/i;
const isOldWisply = (response) => response.status === 404 ||
  (response.status === 401 && WISPLY_REALM.test(String(response.headers?.['www-authenticate'] ?? '')));

// An oversized body or bytes that are not HTTP mean something answered that
// is not Wisply. Anything else that stopped the challenge (refused, reset,
// timed out) means nothing usable is listening.
const isWrongAnswer = (failure) => failure?.code === TOO_LARGE || /^HPE_/.test(String(failure?.code ?? ''));

/**
 * Asks whatever listens on the port to prove, for a fresh nonce, that it
 * holds `token`, without sending the token. Returns null when it did, or the
 * tool error to answer with; the token must not be sent in that case.
 * @param {ReturnType<typeof createIdentityTransport>} identityTransport
 * @param {string} token
 * @returns {Promise<string | null>}
 */
async function identityProblem(identityTransport, token) {
  const nonce = newNonce();
  let response;
  try {
    response = await identityTransport({nonce, timeoutMs:IDENTITY_TIMEOUT_MS});
  } catch (failure) {
    return isWrongAnswer(failure) ? NOT_WISPLY_MESSAGE : UNAVAILABLE_MESSAGE;
  }
  if (!isObject(response)) return NOT_WISPLY_MESSAGE;
  if (isOldWisply(response)) return UPDATE_WISPLY_MESSAGE;
  if (response.status !== 200 || typeof response.text !== 'string') return NOT_WISPLY_MESSAGE;
  let body;
  try { body = JSON.parse(response.text); } catch { return NOT_WISPLY_MESSAGE; }
  return proofMatches(body, {token, port:WISPLY_PORT, nonce}) ? null : NOT_WISPLY_MESSAGE;
}

function initializeResult(params) {
  const requested = params?.protocolVersion;
  return {
    protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
    capabilities: {tools:{listChanged:false}},
    serverInfo: {name:BRIDGE_NAME, title:'Wisply (read-only)', version:BRIDGE_VERSION},
    instructions: BRIDGE_INSTRUCTIONS,
  };
}

/**
 * Handles one JSON-RPC message from the MCP client.
 * @param {unknown} message
 * @param {{token?: unknown, transport?: ReturnType<typeof createHttpTransport>,
 *   identityTransport?: ReturnType<typeof createIdentityTransport>}} [options]
 */
export async function handle(message, {token, transport = defaultTransport, identityTransport = defaultIdentityTransport} = {}) {
  const hasID = Object.hasOwn(message ?? {}, 'id');
  const id = hasID ? message.id : null;
  if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string' ||
      (hasID && id !== null && typeof id !== 'string' && typeof id !== 'number')) {
    return error(null, -32600, 'Invalid JSON-RPC request');
  }
  // Notifications (initialized, cancelled) need nothing and get no answer.
  if (!hasID) return undefined;
  switch (message.method) {
    case 'initialize': return reply(id, initializeResult(message.params));
    case 'ping': return reply(id, {});
    case 'tools/list': return reply(id, {tools:TOOL_DESCRIPTORS});
    case 'tools/call': break;
    default: return error(id, -32601, 'Method not available');
  }
  const name = message.params?.name;
  if (!allowedTools.has(name)) return error(id, -32602, 'Only read-only Wisply tools are available');
  const args = message.params?.arguments ?? {};
  if (!isObject(args)) return error(id, -32602, 'Tool arguments must be an object');

  // Missing, unresolved ${...} placeholders, CR/LF injection and anything not
  // shaped like a Wisply token are refused before any request is made.
  const bearer = usableToken(token);
  if (!bearer) return toolError(id, SETUP_MESSAGE);

  // The token goes only to a listener that has just proved it is Wisply.
  const problem = await identityProblem(identityTransport, bearer);
  if (problem) return toolError(id, problem);

  let response;
  try {
    response = await transport({
      body: JSON.stringify({jsonrpc:'2.0', id, method:'tools/call', params:{name, arguments:args}}),
      headers: {'Content-Type':'application/json', Accept:'application/json', Authorization:`Bearer ${bearer}`},
      timeoutMs: requestTimeoutMs(message),
    });
  } catch {
    return toolError(id, UNAVAILABLE_MESSAGE);
  }
  // Redirects (3xx) are never followed, and like any other non-2xx status
  // they end the call here.
  if (!(response.status >= 200 && response.status < 300)) return toolError(id, REQUEST_FAILED_MESSAGE);
  let answer;
  try { answer = JSON.parse(response.text); } catch { return toolError(id, UNAVAILABLE_MESSAGE); }
  if (answer?.jsonrpc !== '2.0' || answer.id !== id) return toolError(id, UNAVAILABLE_MESSAGE);
  if (isObject(answer.error) && answer.error.code === TOOL_NOT_PERMITTED) return toolError(id, SCOPE_MESSAGE);
  if (isObject(answer.error) && Number.isInteger(answer.error.code) && typeof answer.error.message === 'string') {
    return error(id, answer.error.code, answer.error.message);
  }
  if (!isObject(answer.result) || !Array.isArray(answer.result.content)) return toolError(id, UNAVAILABLE_MESSAGE);
  return reply(id, answer.result);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Serial processing preserves request order; stdout carries JSON-RPC only.
  // The token comes only from WISPLY_PLUGIN_TOKEN, which this plugin's
  // .mcp.json sets from its own "Wisply MCP token" option.
  for await (const line of createInterface({input:process.stdin, crlfDelay:Infinity})) {
    if (!line.trim()) continue;
    let result;
    try { result = await handle(JSON.parse(line), {token:process.env.WISPLY_PLUGIN_TOKEN}); }
    catch { result = error(null, -32700, 'Invalid JSON'); }
    if (result) process.stdout.write(JSON.stringify(result)+'\n');
  }
}
