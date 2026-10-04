// Wisply MCP identity check (bridge only; the mod never imports this file).
//
// Before the bridge sends a token, it asks whatever listens on the fixed
// loopback port to prove it holds the same token, without either side
// revealing it (Wisply Docs/MCP_SETUP.md, section 6):
//
//   key   = HMAC-SHA256(key: utf8(token), message: "wisply-mcp-identity-key-v1")
//   proof = hex(HMAC-SHA256(key: key, message: "wisply-mcp-identity-v1\n<port>\n<nonce>"))
//
// The port inside the MAC stops a relay to a Wisply on another port, and the
// client's own random nonce stops replays.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const IDENTITY_SCHEME = 'wisply-mcp-identity-v1';
const KEY_LABEL = 'wisply-mcp-identity-key-v1';

/**
 * Which proof a token is checked against: connector tokens ("wspc_") are
 * read-only; anything else that passed usableToken is a full-access "wsp_".
 * @param {string} token
 * @returns {'connector' | 'full'}
 */
export function tokenScope(token) {
  return token.startsWith('wspc_') ? 'connector' : 'full';
}

/** A fresh client nonce: 16 random bytes as 32 lowercase hex characters. */
export function newNonce() {
  return randomBytes(16).toString('hex');
}

/**
 * The proof Wisply should return for this token, port and nonce.
 * @param {string} token
 * @param {number} port
 * @param {string} nonce
 * @returns {Buffer}
 */
export function expectedProof(token, port, nonce) {
  const key = createHmac('sha256', token).update(KEY_LABEL).digest();
  return createHmac('sha256', key).update(`${IDENTITY_SCHEME}\n${port}\n${nonce}`).digest();
}

/**
 * Checks an identity response body against the token, port and nonce.
 * Constant-time on the proof; any other shape is a mismatch.
 * @param {unknown} body
 * @param {{ token: string, port: number, nonce: string }} expected
 * @returns {boolean}
 */
export function proofMatches(body, { token, port, nonce }) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return false;
  const answer = /** @type {Record<string, any>} */ (body);
  if (answer.server !== 'wisply' || answer.scheme !== IDENTITY_SCHEME || answer.port !== port) return false;
  if (answer.nonce !== undefined && answer.nonce !== nonce) return false;
  const hex = answer.proofs?.[tokenScope(token)];
  if (typeof hex !== 'string' || !/^[0-9a-f]{64}$/.test(hex)) return false;
  const proof = Buffer.from(hex, 'hex');
  const wanted = expectedProof(token, port, nonce);
  return proof.length === wanted.length && timingSafeEqual(proof, wanted);
}
