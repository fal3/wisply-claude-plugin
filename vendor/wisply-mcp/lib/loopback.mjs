// The connector's only network code: HTTP to the Wisply app on 127.0.0.1.
//
// Generalized from the Wisply Local Connector plugin's bridge.mjs (the
// transports and identityProblem): the port is a parameter, the proof is
// checked for the token's own scope, and the identity check reports an
// outcome code instead of a message.
//
// Every request uses node:http with an agent of its own (keepAlive off), so
// proxy settings in the environment (HTTP_PROXY with NODE_USE_ENV_PROXY or
// --use-env-proxy) can't send the request, and the token in it, anywhere
// else. The host is fixed. Redirects are never followed. Each request has a
// time budget and a size budget.
import http from 'node:http';
import { newNonce } from './identity.mjs';
import {
  CALL_TIMEOUT_MS, HOST, IDENTITY_TIMEOUT_MS, MAX_IDENTITY_BYTES, MAX_PORT, MAX_RESPONSE_BYTES, MIN_PORT,
} from './constants.mjs';
import { scopeOfToken, scopedProofMatches } from './scopes.mjs';

export const IDENTITY_PATH = '/mcp/identity';
export const MCP_PATH = '/mcp';
const TOO_LARGE = 'WISPLY_RESPONSE_TOO_LARGE';

/**
 * A port from a flag or variable: a whole number from 1024 to 65535, or null.
 * @param {unknown} value
 * @returns {number|null}
 */
export function parsePort(value) {
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
  if (!/^[0-9]{1,5}$/.test(text)) return null;
  const port = Number(text);
  return port >= MIN_PORT && port <= MAX_PORT ? port : null;
}

// One HTTP exchange. An oversized body rejects with TOO_LARGE; a connection
// that closes before the body ends rejects too. Whatever ends the exchange
// early also destroys the request and its socket, so nothing lingers.
function exchange(agent, port, { method, path, headers, body, timeoutMs, maxBytes }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (failure) => {
      if (settled) return;
      settled = true;
      request.destroy();
      reject(failure);
    };
    const request = http.request({
      host: HOST,
      port,
      path,
      method,
      agent,
      signal: AbortSignal.timeout(timeoutMs),
      headers: body === undefined ? headers : { ...headers, 'Content-Length': String(Buffer.byteLength(body)) },
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          response.destroy();
          fail(Object.assign(new Error('Response too large'), { code: TOO_LARGE }));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        if (settled) return;
        settled = true;
        resolve({ status: response.statusCode ?? 0, headers: response.headers, text: Buffer.concat(chunks).toString('utf8'), bytes: size });
      });
      response.on('error', fail);
      response.on('close', () => fail(new Error('Connection closed early')));
    });
    request.on('error', fail);
    request.end(body);
  });
}

// Wisply versions without the identity check have no /mcp/identity. Their
// bearer check runs before routing, so a challenge without a token is turned
// away with Wisply's own realm (401); one that routes first answers 404.
// Either way the token stays here.
const WISPLY_REALM = /\bBearer\s+realm="wisply-mcp"/i;
const isOldWisply = (response) => response.status === 404 ||
  (response.status === 401 && WISPLY_REALM.test(String(response.headers?.['www-authenticate'] ?? '')));

// An oversized body or bytes that aren't HTTP mean something answered that
// isn't Wisply. Anything else that stopped the challenge (refused, reset,
// timed out) means nothing usable is listening.
const isWrongAnswer = (failure) => failure?.code === TOO_LARGE || /^HPE_/.test(String(failure?.code ?? ''));

/**
 * @typedef {'ok'|'unavailable'|'not-wisply'|'old-wisply'|'missing-scope'} IdentityOutcome
 */

/**
 * The loopback client for one port on 127.0.0.1. There is no host option.
 * @param {{port: number, identityTimeoutMs?: number}} options
 */
export function createLoopback({ port, identityTimeoutMs = IDENTITY_TIMEOUT_MS }) {
  if (parsePort(port) !== port) throw new RangeError('Invalid Wisply port');
  const agent = new http.Agent({ keepAlive: false });

  return {
    port,

    /**
     * Asks whatever listens on the port to prove, for a fresh nonce, that it
     * holds `token`, without sending the token: no Authorization header, at
     * most MAX_IDENTITY_BYTES, within the identity time budget. The proof is
     * checked for `scope` only. A missing proof for the recording scope means
     * a Wisply from before recording tokens; for the other scopes it is a
     * failed check.
     * @param {string} token
     * @param {'full'|'connector'|'recording'} scope
     * @returns {Promise<{outcome: IdentityOutcome, status?: number, bytes?: number}>}
     */
    async identity(token, scope) {
      const nonce = newNonce();
      let response;
      try {
        response = await exchange(agent, port, {
          method: 'GET', path: `${IDENTITY_PATH}?nonce=${nonce}`, headers: { Accept: 'application/json' },
          body: undefined, timeoutMs: identityTimeoutMs, maxBytes: MAX_IDENTITY_BYTES,
        });
      } catch (failure) {
        return { outcome: isWrongAnswer(failure) ? 'not-wisply' : 'unavailable' };
      }
      const { status, bytes } = response;
      if (isOldWisply(response)) return { outcome: 'old-wisply', status, bytes };
      if (status !== 200) return { outcome: 'not-wisply', status, bytes };
      let body;
      try { body = JSON.parse(response.text); } catch { return { outcome: 'not-wisply', status, bytes }; }
      const verdict = scopedProofMatches(body, { token, port, nonce, scope });
      if (verdict === 'ok') return { outcome: 'ok', status, bytes };
      if (verdict === 'missing-scope' && scope === 'recording') return { outcome: 'missing-scope', status, bytes };
      return { outcome: 'not-wisply', status, bytes };
    },

    /**
     * POSTs one JSON-RPC body to /mcp with the token as a bearer header.
     * Rejects on a network failure, a timeout or more than MAX_RESPONSE_BYTES.
     * @param {string} token
     * @param {string} body
     * @param {number} [timeoutMs]
     * @returns {Promise<{status: number, text: string, bytes: number}>}
     */
    async call(token, body, timeoutMs = CALL_TIMEOUT_MS) {
      // Only a well-formed token ever becomes a header (no CR/LF injection).
      if (scopeOfToken(token) === null) throw new TypeError('Not a Wisply token');
      const { status, text, bytes } = await exchange(agent, port, {
        method: 'POST',
        path: MCP_PATH,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${token}` },
        body,
        timeoutMs,
        maxBytes: MAX_RESPONSE_BYTES,
      });
      return { status, text, bytes };
    },
  };
}
