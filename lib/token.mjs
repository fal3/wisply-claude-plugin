// Where the connector gets its token, and the Keychain item it manages.
//
// 1. WISPLY_MCP_TOKEN, when it's set to a real value. A client's secret
//    store puts it there (VS Code SecretStorage, MCPB user_config, Gemini
//    settings). An empty value, or a ${...} placeholder the client left
//    unresolved, counts as unset.
// 2. Otherwise, on macOS, the login Keychain item the connector manages:
//    service "ai.wisply.mcp", account "token", label "Wisply MCP token",
//    written by `wisply-mcp setup` and removed by `wisply-mcp forget`.
//
// The Keychain is reached only through /usr/bin/security, by absolute path,
// with fixed arguments. The token never appears in an argument list: setup
// lets `security` prompt for it in the terminal (-w last), and reads come
// back through a stdout pipe. A read or a delete that takes longer than
// KEYCHAIN_TIMEOUT_MS (2 s) counts as a failure, so a locked keychain or an
// unanswered macOS dialog can't hang an AI app. `security` runs with this
// process's environment minus every WISPLY_MCP_* variable, so a token set in
// WISPLY_MCP_TOKEN never reaches a child that doesn't need it.
//
// No command names a keychain: `add-generic-password` with -w last can't take
// one (the path would become the password), so the item goes to the default
// keychain, normally the login keychain, and reads and deletes search the
// keychain search list. delete-generic-password removes only the first match,
// so deleteAllKeychain repeats it until none is left; setup uses it before
// adding, so the item it creates is the only one, with the documented access.
//
// Nothing here throws, and no result ever carries the value except `token`
// (and the read itself, which only resolveToken and setup's read-back see).
import { execFile as nodeExecFile, spawn as nodeSpawn } from 'node:child_process';
import {
  KEYCHAIN_ACCOUNT, KEYCHAIN_LABEL, KEYCHAIN_MAX_COPIES, KEYCHAIN_SERVICE, KEYCHAIN_TIMEOUT_MS, SECURITY_BIN,
} from './constants.mjs';
import { TOKEN_RE } from './scopes.mjs';

/** A value a client left as written: ${user_config.x}, ${input:x}, ${env:X}. */
export const PLACEHOLDER_RE = /^\$\{[^}]+\}$/;

/** `security` exits with errSecItemNotFound (-25300) truncated to 8 bits when there is no item. */
export const ITEM_NOT_FOUND_EXIT = 44;

/** Reads the item's password to stdout (followed by a newline). */
export const READ_ARGS = Object.freeze([
  'find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-w',
]);

/**
 * Creates the item, trusting only /usr/bin/security (-T). No -U: updating an
 * existing item would merge -T into whatever access list it already has (and
 * may ask macOS to confirm the change), so setup removes every earlier copy
 * first (deleteAllKeychain) and always creates a new one. -w comes last and
 * without a value, so `security` itself asks for the token twice in the
 * terminal, with echo off.
 */
export const WRITE_ARGS = Object.freeze([
  'add-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-l', KEYCHAIN_LABEL,
  '-T', SECURITY_BIN, '-w',
]);

/** Removes the item. `security` prints its attributes (never the password); they're discarded. */
export const DELETE_ARGS = Object.freeze([
  'delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT,
]);

/**
 * The environment for `security`: this process's, without any WISPLY_MCP_*
 * variable (the token above all). Nothing else is changed, so PATH, HOME and
 * the locale reach `security` as before.
 * @param {Record<string, string|undefined>} [env]
 * @returns {Record<string, string>}
 */
export function securityEnv(env = process.env) {
  const result = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    if (typeof value === 'string' && !key.toUpperCase().startsWith('WISPLY_MCP_')) result[key] = value;
  }
  return result;
}

/** A token is 69 characters; `security` prints hex for non-printable data. Anything longer is not ours. */
const MAX_READ_BYTES = 4 * 1024;
/** delete-generic-password prints the item's attributes, a few hundred bytes. */
const MAX_DELETE_BYTES = 64 * 1024;

/**
 * Runs /usr/bin/security once with fixed arguments and a pipe for stdout.
 * Resolves {ok, code, stdout}; never rejects. execFile's own timeout kills a
 * slow child, and a guard timer answers even if the child can't be killed or
 * an injected runner never calls back.
 * @param {readonly string[]} args
 * @param {{execFile?: typeof nodeExecFile, timeoutMs?: number, maxBuffer?: number,
 *   env?: Record<string, string|undefined>}} options env: filtered through securityEnv
 * @returns {Promise<{ok: boolean, code: number|null, stdout: string}>}
 */
function runSecurity(args, {
  execFile = nodeExecFile, timeoutMs = KEYCHAIN_TIMEOUT_MS, maxBuffer = MAX_READ_BYTES, env = process.env,
} = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let child;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      resolve(result);
    };
    const guard = setTimeout(() => {
      try { child?.kill?.('SIGKILL'); } catch { /* already gone */ }
      finish({ ok: false, code: null, stdout: '' });
    }, timeoutMs);
    try {
      child = execFile(SECURITY_BIN, [...args], {
        encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer, windowsHide: true, env: securityEnv(env),
      }, (failure, stdout) => {
        if (!failure) {
          finish({ ok: true, code: 0, stdout: typeof stdout === 'string' ? stdout : String(stdout ?? '') });
        } else {
          finish({ ok: false, code: Number.isInteger(failure?.code) ? failure.code : null, stdout: '' });
        }
      });
      // `security` never needs input here; a closed stdin means it can't wait for any.
      child?.stdin?.end?.();
    } catch {
      finish({ ok: false, code: null, stdout: '' });
    }
  });
}

/**
 * Reads the connector's Keychain item through a pipe:
 * `security find-generic-password -s ai.wisply.mcp -a token -w`.
 * Null when there is no item, on any failure, and after the timeout.
 * The caller validates the value (resolveToken trims it and checks TOKEN_RE).
 * @param {{execFile?: typeof nodeExecFile, timeoutMs?: number, env?: Record<string, string|undefined>}} [options]
 * @returns {Promise<string|null>}
 */
export async function defaultReadKeychain({ execFile, timeoutMs, env } = {}) {
  const { ok, stdout } = await runSecurity(READ_ARGS, { execFile, timeoutMs, maxBuffer: MAX_READ_BYTES, env });
  return ok ? stdout : null;
}

/**
 * Lets `security add-generic-password ... -w` ask for the token in the
 * user's terminal (stdio inherited), so the token never passes through this
 * process, its arguments or its output. There is no timeout: a person is
 * typing. While it runs, Ctrl-C is left to `security` (which restores the
 * terminal and stops) instead of ending this process first.
 * 'written' means only that `security` exited 0; setup reads the item back
 * to check what was stored.
 * @param {{spawn?: typeof nodeSpawn, signals?: {on?: Function, off?: Function},
 *   env?: Record<string, string|undefined>}} [options] env: filtered through securityEnv
 * @returns {Promise<'written'|'cancelled'|'failed'>}
 */
export function writeKeychainInteractive({ spawn = nodeSpawn, signals = process, env = process.env } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const leaveToSecurity = () => {};
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      try { signals?.off?.('SIGINT', leaveToSecurity); } catch { /* nothing to undo */ }
      resolve(outcome);
    };
    try { signals?.on?.('SIGINT', leaveToSecurity); } catch { /* best effort */ }
    let child;
    try {
      child = spawn(SECURITY_BIN, [...WRITE_ARGS], { stdio: 'inherit', windowsHide: true, env: securityEnv(env) });
    } catch {
      finish('failed');
      return;
    }
    if (!child || typeof child.once !== 'function') {
      finish('failed');
      return;
    }
    child.once('error', () => finish('failed'));
    child.once('exit', (code, signal) => {
      if (code === 0) finish('written');
      else finish(signal ? 'cancelled' : 'failed');
    });
  });
}

/**
 * Removes the first copy of the connector's Keychain item in the search list.
 * @param {{execFile?: typeof nodeExecFile, timeoutMs?: number, env?: Record<string, string|undefined>}} [options]
 * @returns {Promise<'deleted'|'not-found'|'failed'>}
 */
export async function deleteKeychain({ execFile, timeoutMs, env } = {}) {
  const { ok, code } = await runSecurity(DELETE_ARGS, { execFile, timeoutMs, maxBuffer: MAX_DELETE_BYTES, env });
  if (ok) return 'deleted';
  return code === ITEM_NOT_FOUND_EXIT ? 'not-found' : 'failed';
}

/**
 * Removes every copy of the item: deletes until `security` finds none, for up
 * to KEYCHAIN_MAX_COPIES copies plus the run that has to find none. complete
 * is true only when a run answered "not found", so a copy left behind (or one
 * nobody confirmed gone) is never reported as removed.
 * @param {{deleteOnce?: () => Promise<unknown>, maxCopies?: number}} [options]
 * @returns {Promise<{removed: number, complete: boolean}>}
 */
export async function deleteAllKeychain({ deleteOnce = () => deleteKeychain(), maxCopies = KEYCHAIN_MAX_COPIES } = {}) {
  let removed = 0;
  for (let run = 0; run <= maxCopies; run += 1) {
    let outcome;
    try { outcome = await deleteOnce(); } catch { outcome = 'failed'; }
    if (outcome === 'not-found') return { removed, complete: true };
    if (outcome !== 'deleted') break;
    removed += 1;
  }
  return { removed, complete: false };
}

/**
 * @typedef {{token: string|null, source: 'env'|'keychain'|null,
 *   problem: null|'missing'|'malformed'|'not-mac', placeholderIgnored: boolean}} TokenResolution
 */

/**
 * The env value, classified: a token, a placeholder, unset, or something else.
 * @param {Record<string, string|undefined>|undefined} env
 * @returns {{kind: 'token', token: string} | {kind: 'placeholder'|'unset'|'malformed'}}
 */
export function envToken(env) {
  const raw = env?.WISPLY_MCP_TOKEN;
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (value === '') return { kind: 'unset' };
  if (PLACEHOLDER_RE.test(value)) return { kind: 'placeholder' };
  if (TOKEN_RE.test(value)) return { kind: 'token', token: value };
  return { kind: 'malformed' };
}

/**
 * Finds the token: the environment first, then the Keychain on macOS.
 * 'malformed' is a non-placeholder env value that isn't a Wisply token (no
 * Keychain fallback: the user set something wrong). 'not-mac' is no usable
 * env token on another platform. A Keychain value that isn't a Wisply token
 * counts as missing. Never throws.
 * @param {{env?: Record<string, string|undefined>, platform?: string, readKeychain?: () => Promise<unknown>}} [deps]
 * @returns {Promise<TokenResolution>}
 */
export async function resolveToken({ env = process.env, platform = process.platform, readKeychain = defaultReadKeychain } = {}) {
  let placeholderIgnored = false;
  try {
    const fromEnv = envToken(env);
    if (fromEnv.kind === 'token') return { token: fromEnv.token, source: 'env', problem: null, placeholderIgnored };
    if (fromEnv.kind === 'malformed') return { token: null, source: null, problem: 'malformed', placeholderIgnored };
    placeholderIgnored = fromEnv.kind === 'placeholder';
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
