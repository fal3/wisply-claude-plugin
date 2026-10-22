// Token scopes and the scope-aware identity check.
//
// Wisply issues three kinds of loopback tokens, each "<prefix>_" followed by
// 64 lowercase hex characters: "wsp_" (full access), "wspc_" (read-only
// connector) and "wspr_" (recording control, from raycast PR 1). Wisply's
// identity answer carries one proof per scope it holds a token for. The
// vendored lib/identity.mjs computes the proof; its own proofMatches and
// tokenScope predate "wspr_" (they would check a recording token against the
// full-access proof), so nothing in lib/ imports them (tests/purity.test.mjs).
import { timingSafeEqual } from 'node:crypto';
import { IDENTITY_SCHEME, expectedProof } from './identity.mjs';
import { CLAUDE_SETUP_TOOL } from './constants.mjs';

export const TOKEN_RE = /^(wsp|wspc|wspr)_[0-9a-f]{64}$/;
const SCOPE_BY_PREFIX = Object.freeze({ wsp: 'full', wspc: 'connector', wspr: 'recording' });
const HEX_PROOF = /^[0-9a-f]{64}$/;

/** What each scope is called in messages. */
export const SCOPE_LABELS = Object.freeze({
  full: 'full-access',
  connector: 'read-only connector',
  recording: 'recording-control',
});

/**
 * The scope of a well-formed Wisply token, or null for anything else.
 * @param {unknown} token
 * @returns {'full'|'connector'|'recording'|null}
 */
export function scopeOfToken(token) {
  const m = typeof token === 'string' ? TOKEN_RE.exec(token) : null;
  return m ? SCOPE_BY_PREFIX[m[1]] : null;
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Checks Wisply's identity answer against the token, for the token's scope,
 * in constant time on the proof. 'missing-scope' means the answer is
 * otherwise well-formed but holds proofs for other scopes only (a Wisply
 * that doesn't know this kind of token yet). Any other shape is a mismatch.
 * @param {unknown} body
 * @param {{token: string, port: number, nonce: string, scope: 'full'|'connector'|'recording'}} expected
 * @returns {'ok'|'mismatch'|'missing-scope'}
 */
export function scopedProofMatches(body, { token, port, nonce, scope }) {
  if (!isObject(body)) return 'mismatch';
  const answer = /** @type {Record<string, any>} */ (body);
  if (answer.server !== 'wisply' || answer.scheme !== IDENTITY_SCHEME || answer.port !== port) return 'mismatch';
  if (answer.nonce !== undefined && answer.nonce !== nonce) return 'mismatch';
  if (!isObject(answer.proofs)) return 'mismatch';
  if (!Object.hasOwn(answer.proofs, scope)) {
    return Object.keys(answer.proofs).length > 0 ? 'missing-scope' : 'mismatch';
  }
  const hex = answer.proofs[scope];
  if (typeof hex !== 'string' || !HEX_PROOF.test(hex)) return 'mismatch';
  const proof = Buffer.from(hex, 'hex');
  const wanted = expectedProof(token, port, nonce);
  return proof.length === wanted.length && timingSafeEqual(proof, wanted) ? 'ok' : 'mismatch';
}

/**
 * The contract tools a scope reaches, in contract order. setup_claude is
 * left out unless allowClaudeSetup (spec D4), and readOnly limits any scope
 * to the connector scope's tools.
 * @param {{tools: readonly string[], scopes: Record<string, {tools: readonly string[]}>}} contract
 * @param {string|null|undefined} scope
 * @param {{allowClaudeSetup?: boolean, readOnly?: boolean}} [options]
 * @returns {string[]}
 */
export function toolsFor(contract, scope, { allowClaudeSetup = false, readOnly = false } = {}) {
  const entry = scope && Object.hasOwn(contract.scopes, scope) ? contract.scopes[scope] : null;
  if (!entry) return [];
  const allowed = new Set(entry.tools);
  const readable = new Set(contract.scopes.connector?.tools ?? []);
  return contract.tools.filter((tool) => allowed.has(tool) &&
    (allowClaudeSetup || tool !== CLAUDE_SETUP_TOOL) &&
    (!readOnly || readable.has(tool)));
}
