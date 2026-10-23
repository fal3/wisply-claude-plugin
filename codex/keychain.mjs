// Reads the Wisply token for Codex from the macOS login Keychain.
//
// Codex has no masked option field for a plugin, and a token in Codex's
// environment would reach every command Codex runs. So the Codex server keeps
// the token in one login Keychain item (service ai.wisply.mcp, account token,
// label "Wisply MCP token") and reads it through /usr/bin/security each time
// a Wisply tool runs. Nothing is cached, written or logged, and a regenerated
// token works on the next call without a restart. Only codex/bridge.mjs
// imports this file; the Claude Code server never reads the Keychain.
import {execFile} from 'node:child_process';

export const SECURITY_BIN = '/usr/bin/security';
export const KEYCHAIN_SERVICE = 'ai.wisply.mcp';
export const KEYCHAIN_ACCOUNT = 'token';
export const KEYCHAIN_LABEL = 'Wisply MCP token';
/** A read that takes longer fails, so a locked Keychain or an unanswered dialog can't hang Codex. */
export const KEYCHAIN_TIMEOUT_MS = 2000;
/** A Wisply token is 69 characters; anything far longer is not one. */
export const MAX_KEYCHAIN_OUTPUT = 4096;

/**
 * Creates or replaces (-U) the item, trusting only /usr/bin/security (-T).
 * -w comes last and without a value, so `security` asks for the token twice,
 * with echo off, and it stays out of the shell history.
 */
export const KEYCHAIN_SAVE_COMMAND =
  `security add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${KEYCHAIN_ACCOUNT} -l "${KEYCHAIN_LABEL}" -T ${SECURITY_BIN} -w`;
export const KEYCHAIN_DELETE_COMMAND = `security delete-generic-password -s ${KEYCHAIN_SERVICE} -a ${KEYCHAIN_ACCOUNT}`;

/** The exact arguments of the read: no shell, nothing from the environment. */
export const KEYCHAIN_READ_ARGS = Object.freeze(['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-w']);

/**
 * The item's password as `security` prints it (the bridge trims and checks
 * it), or null when there is none: no item, a locked or denied Keychain, a
 * timeout, or no /usr/bin/security (not macOS). Never rejects.
 * @param {{run?: typeof execFile, timeoutMs?: number}} [options] `run` replaces execFile in tests
 * @returns {Promise<string | null>}
 */
export function readKeychainToken({run = execFile, timeoutMs = KEYCHAIN_TIMEOUT_MS} = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      resolve(value);
    };
    // execFile's own timeout kills a slow child; this answers even if it can't.
    const guard = setTimeout(() => settle(null), timeoutMs + 500);
    try {
      run(SECURITY_BIN, [...KEYCHAIN_READ_ARGS], {
        encoding: 'utf8',
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer: MAX_KEYCHAIN_OUTPUT,
        windowsHide: true,
      }, (failure, stdout) => settle(failure || typeof stdout !== 'string' ? null : stdout));
    } catch {
      settle(null);
    }
  });
}
