// Optional request log, for WISPLY_MCP_DEBUG=1 only, to stderr only.
//
// MCP clients keep a server's stderr in their own log files, so a line may
// carry only fixed vocabulary and numbers: the method, the tool name, an
// outcome code, the HTTP status, a byte count and milliseconds. It takes no
// free text at all, so arguments, results, queries, transcript text and
// headers can't reach a log. Every line still goes through redact().
// This is the only file in lib/ that writes to stderr (tests/purity.test.mjs).
import { tools } from './contract.mjs';
import { redact } from './token.mjs';

const METHODS = new Set([
  'initialize', 'ping', 'tools/list', 'tools/call', 'server/discover',
  'notifications/initialized', 'notifications/cancelled',
]);
const TOOLS = new Set(tools);

/** Every outcome code the bridge reports. */
export const OUTCOMES = Object.freeze([
  'ok', 'local', 'notification', 'invalid-request', 'parse-error', 'method-not-found', 'unknown-tool',
  'bad-arguments', 'setup', 'malformed', 'not-mac', 'scope', 'claude-setup-hidden', 'unavailable',
  'not-wisply', 'old-wisply', 'missing-scope', 'keychain', 'request-failed', 'rpc-error', 'internal',
]);
const OUTCOME_SET = new Set(OUTCOMES);

const count = (value) => (Number.isFinite(value) && value >= 0 ? String(Math.round(value)) : null);

/**
 * Formats one debug line from fixed fields; anything outside the fixed
 * vocabulary becomes "other", and anything that isn't a count is dropped.
 * @param {{method?: unknown, tool?: unknown, outcome?: unknown, status?: unknown, bytes?: unknown, ms?: unknown}} fields
 * @returns {string}
 */
export function formatDebugLine({ method, tool, outcome, status, bytes, ms } = {}) {
  const parts = [`method=${METHODS.has(method) ? method : 'other'}`];
  if (tool !== undefined) parts.push(`tool=${TOOLS.has(tool) ? tool : 'other'}`);
  parts.push(`outcome=${OUTCOME_SET.has(outcome) ? outcome : 'other'}`);
  for (const [name, value] of [['status', status], ['bytes', bytes], ['ms', ms]]) {
    const text = count(value);
    if (text !== null) parts.push(`${name}=${text}`);
  }
  return redact(`wisply-mcp: ${parts.join(' ')}\n`);
}

/**
 * The debug logger for an environment: a no-op unless WISPLY_MCP_DEBUG=1.
 * @param {{env?: Record<string, string|undefined>, write?: (line: string) => void}} [options]
 * @returns {(fields: Parameters<typeof formatDebugLine>[0]) => void}
 */
export function createDebug({ env = process.env, write = (line) => process.stderr.write(line) } = {}) {
  if (env?.WISPLY_MCP_DEBUG !== '1') return () => {};
  return (fields) => {
    try { write(formatDebugLine(fields)); } catch { /* logging never breaks a request */ }
  };
}

/** The process's own logger. */
export const debugLine = createDebug();
