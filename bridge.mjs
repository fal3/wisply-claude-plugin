// Read-only stdio MCP server for the local Wisply app.
//
// The bridge answers the MCP handshake (initialize, ping, tools/list) itself,
// from fixed text in lib/shared.mjs, without the token and without contacting
// Wisply. Only tools/call for one of the four read-only tools is forwarded,
// with the token as a bearer header, to the fixed loopback endpoint.
import http from 'node:http';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import {
  BRIDGE_INSTRUCTIONS,
  BRIDGE_NAME,
  BRIDGE_VERSION,
  MAX_RESPONSE_BYTES,
  PROTOCOL_VERSIONS,
  READ_ONLY_TOOLS,
  REQUEST_FAILED_MESSAGE,
  SETUP_MESSAGE,
  TOOL_DESCRIPTORS,
  UNAVAILABLE_MESSAGE,
  WISPLY_ENDPOINT,
  requestTimeoutMs,
  usableToken,
} from './lib/shared.mjs';

export const allowedTools = new Set(READ_ONLY_TOOLS);
const error = (id, code, message) => ({jsonrpc:'2.0', id, error:{code, message}});
const reply = (id, result) => ({jsonrpc:'2.0', id, result});
const toolError = (id, text) => reply(id, {content:[{type:'text', text}], isError:true});
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

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
  return ({body, headers, timeoutMs}) => new Promise((resolve, reject) => {
    const request = http.request({
      host: target.hostname,
      port: Number(target.port),
      path: target.pathname,
      method: 'POST',
      agent,
      signal: AbortSignal.timeout(timeoutMs),
      headers: {...headers, 'Content-Length': String(Buffer.byteLength(body))},
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) {
          response.destroy();
          request.destroy();
          reject(new Error('Response too large'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => resolve({status:response.statusCode ?? 0, text:Buffer.concat(chunks).toString('utf8')}));
      response.on('error', reject);
    });
    request.on('error', reject);
    request.end(body);
  });
}

const defaultTransport = createHttpTransport(WISPLY_ENDPOINT);

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
 * @param {{token?: unknown, transport?: ReturnType<typeof createHttpTransport>}} [options]
 */
export async function handle(message, {token, transport = defaultTransport} = {}) {
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
