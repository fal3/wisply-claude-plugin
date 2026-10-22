// The connector's commands for people at a terminal: setup, status, forget.
//
//   wisply-mcp setup [--full-access] [--port <n>]
//     First removes every item saved before (so the new one gets exactly the
//     documented access list), then /usr/bin/security asks for the token in
//     the terminal and stores it in the login keychain (lib/token.mjs); the
//     token never passes through this process's arguments or output. setup
//     then reads the item back once, through a pipe, and removes it again if
//     it isn't a Wisply token (SETUP_MALFORMED) or is the full-access token
//     without --full-access (FULL_ACCESS_REFUSED). A kept token gets the
//     identity check.
//   wisply-mcp status [--port <n>] [--read-only] [--allow-claude-setup]
//     Where the token comes from, its scope, whether Wisply answered and
//     proved it holds the token, and the tools an AI app would see with the
//     same options. Never prints the token: the lines take a scope and a
//     source, never the value.
//   wisply-mcp forget
//     Removes the Keychain item, every copy of it in the search list. Off
//     macOS there is none (setup refuses there), so it says so and exits 0.
//
// Exit codes: 0 done (setup: stored and confirmed; status: token found and
// confirmed; forget: no saved copy left, which off macOS is always true), 1 a
// problem (the message says which), 2 a usage mistake.
// Output goes through the injected `out` and `err` writers (the bin passes
// stdout and stderr), so this file never writes to the process itself.
import contract from './contract.mjs';
import { DEFAULT_PORT } from './constants.mjs';
import { createLoopback as defaultCreateLoopback, parsePort } from './loopback.mjs';
import * as messages from './messages.mjs';
import { scopeOfToken, toolsFor } from './scopes.mjs';
import {
  defaultReadKeychain, deleteAllKeychain, deleteKeychain as defaultDeleteKeychain, envToken,
  resolveToken as defaultResolveToken, writeKeychainInteractive,
} from './token.mjs';

/** The commands this file runs; the bin hands it argv when argv[0] is one of them. */
export const CLI_COMMANDS = Object.freeze(['setup', 'status', 'forget']);

/** Flags each command takes. */
const FLAGS = Object.freeze({
  setup: Object.freeze(['--full-access', '--port']),
  status: Object.freeze(['--port', '--read-only', '--allow-claude-setup']),
  forget: Object.freeze([]),
});

/**
 * @typedef {{command: 'setup'|'status'|'forget', port: number, fullAccess: boolean,
 *   readOnly: boolean, allowClaudeSetup: boolean}} CliOptions
 */

/**
 * Parses `<command> [flags]`. For the commands that take --port, the port
 * comes from --port, else WISPLY_MCP_PORT, else the contract's default, as
 * for serving. forget has no port, so a stale WISPLY_MCP_PORT can't stop it.
 * @param {readonly string[]} argv
 * @param {Record<string, string|undefined>} [env]
 * @returns {{options: CliOptions} | {help: true} | {error: string}}
 */
export function parseCliArgs(argv, env = {}) {
  const [command, ...rest] = argv;
  if (!CLI_COMMANDS.includes(command)) return { error: messages.unknownArgument(String(command ?? '')) };
  const allowed = FLAGS[command];
  /** @type {CliOptions} */
  const options = {
    command, port: DEFAULT_PORT, fullAccess: false, readOnly: false,
    allowClaudeSetup: command === 'status' && env?.WISPLY_MCP_ALLOW_CLAUDE_SETUP === '1',
  };
  let portFlag;
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === '--help' || argument === '-h') return { help: true };
    const flag = typeof argument === 'string' && argument.startsWith('--port=') ? '--port' : argument;
    if (!allowed.includes(flag)) return { error: messages.unknownArgument(String(argument)) };
    if (flag === '--port') {
      const value = argument === '--port' ? rest[(index += 1)] : argument.slice('--port='.length);
      portFlag = parsePort(value);
      if (portFlag === null) return { error: messages.badPort(value ?? '') };
    } else if (flag === '--full-access') {
      options.fullAccess = true;
    } else if (flag === '--read-only') {
      options.readOnly = true;
    } else if (flag === '--allow-claude-setup') {
      options.allowClaudeSetup = true;
    }
  }
  if (portFlag !== undefined) {
    options.port = portFlag;
  } else if (allowed.includes('--port')) {
    const fromEnv = env?.WISPLY_MCP_PORT;
    if (typeof fromEnv === 'string' && fromEnv.trim() !== '') {
      const port = parsePort(fromEnv);
      if (port === null) return { error: messages.badPort(fromEnv) };
      options.port = port;
    }
  }
  return { options };
}

/**
 * The identity check for a command; a check that throws counts as nothing answering.
 * @returns {Promise<string>} the outcome code
 */
async function identityOutcome(createLoopback, port, token, scope) {
  try {
    const answer = await createLoopback({ port }).identity(token, scope);
    return typeof answer?.outcome === 'string' ? answer.outcome : 'unavailable';
  } catch {
    return 'unavailable';
  }
}

/**
 * Removes every copy of the item; a failure counts as nothing complete.
 * @param {Required<CliDeps>} io
 */
async function removeAll(io) {
  return deleteAllKeychain({ deleteOnce: () => io.deleteKeychain() });
}

/**
 * `setup`: store the token in the login keychain, check it, report.
 * @param {CliOptions} options
 * @param {Required<CliDeps>} io
 */
async function setup({ fullAccess, port }, io) {
  const say = (text) => io.out(`${text}\n`);
  if (io.platform !== 'darwin') {
    say(messages.notMac(io.platform));
    return 1;
  }
  if (!io.isTTY) {
    say(messages.SETUP_NEEDS_TERMINAL);
    return 1;
  }
  io.out(messages.setupIntro({ fullAccess }));

  // Every item saved before goes first, so the one security creates next is
  // the only one and carries exactly the documented access list (no -U).
  const before = await removeAll(io);
  if (!before.complete) {
    say(messages.REPLACE_FAILED);
    return 1;
  }

  const written = await io.writeKeychain();
  if (written !== 'written') {
    if (written === 'cancelled') say(before.removed > 0 ? messages.SETUP_CANCELLED_AFTER_REMOVAL : messages.SETUP_CANCELLED);
    else say(messages.KEYCHAIN_NOT_STORED);
    if (before.removed > 0) say(messages.PREVIOUS_REMOVED);
    return 1;
  }

  // One read-back, through a pipe. Whatever can't be kept is removed again.
  let value = null;
  try { value = await io.readKeychain(); } catch { value = null; }
  const token = typeof value === 'string' ? value.trim() : '';
  const scope = scopeOfToken(token);
  /** @type {'unreadable'|'malformed'|'full-access'|null} */
  let refusal = null;
  if (typeof value !== 'string') refusal = 'unreadable';
  else if (scope === null) refusal = 'malformed';
  else if (scope === 'full' && !fullAccess) refusal = 'full-access';
  if (refusal) {
    const after = await removeAll(io);
    if (!after.complete) {
      say(messages.removeFailed(refusal));
      return 1;
    }
    say(refusal === 'full-access' ? messages.FULL_ACCESS_REFUSED
      : refusal === 'malformed' ? messages.SETUP_MALFORMED : messages.READ_BACK_FAILED);
    say(messages.NO_ITEM_NOW);
    return 1;
  }

  const outcome = await identityOutcome(io.createLoopback, port, token, scope);
  if (outcome === 'ok') {
    say(messages.stored(port, scope, toolsFor(contract, scope).length));
  } else {
    say(messages.STORED_UNCHECKED);
    say(messages.identityProblem(outcome, port, { terminal: true }));
  }
  if (scope === 'full') say(messages.FULL_ACCESS_SHARED);
  say(messages.RESTART_NOTE);
  if (envToken(io.env).kind === 'token') say(messages.ENV_WINS);
  return outcome === 'ok' ? 0 : 1;
}

/**
 * `status`: what an AI app starting the connector here would get.
 * @param {CliOptions} options
 * @param {Required<CliDeps>} io
 */
async function status({ port, readOnly, allowClaudeSetup }, io) {
  const lines = [messages.STATUS.header];
  let resolved;
  try {
    resolved = await io.resolveToken({ env: io.env, platform: io.platform, readKeychain: io.readKeychain });
  } catch {
    resolved = null;
  }
  const token = typeof resolved?.token === 'string' ? resolved.token : null;
  const scope = scopeOfToken(token);
  const placeholderNote = resolved?.placeholderIgnored === true ? [messages.STATUS.placeholder] : [];

  if (!scope) {
    const problem = ['malformed', 'not-mac'].includes(resolved?.problem) ? resolved.problem : 'missing';
    lines.push(messages.STATUS.noToken(problem), ...placeholderNote);
    lines.push(messages.STATUS.wisply(null, port));
    lines.push(messages.STATUS.tools(toolsFor(contract, 'connector', { allowClaudeSetup, readOnly }), { withoutToken: true }));
    lines.push(problem === 'malformed' ? messages.TERMINAL_TEXTS.MALFORMED
      : problem === 'not-mac' ? messages.notMac(io.platform) : messages.TERMINAL_TEXTS.SETUP);
    io.out(`${lines.join('\n')}\n`);
    return 1;
  }

  const outcome = await identityOutcome(io.createLoopback, port, token, scope);
  const source = resolved.source === 'env' ? 'env' : 'keychain';
  lines.push(messages.STATUS.token(scope, source), ...placeholderNote);
  lines.push(messages.STATUS.wisply(outcome, port));
  lines.push(messages.STATUS.tools(toolsFor(contract, scope, { allowClaudeSetup, readOnly })));
  if (scope === 'full' && source === 'keychain') lines.push(messages.STATUS.fullAccessShared);
  if (outcome !== 'ok') lines.push(messages.identityProblem(outcome, port, { terminal: true }));
  lines.push(messages.RESTART_NOTE);
  io.out(`${lines.join('\n')}\n`);
  return outcome === 'ok' ? 0 : 1;
}

/**
 * `forget`: remove the Keychain item, every copy in the search list.
 * @param {CliOptions} _options
 * @param {Required<CliDeps>} io
 */
async function forget(_options, io) {
  const say = (text) => io.out(`${text}\n`);
  if (io.platform !== 'darwin') {
    // setup refuses off macOS, so no copy can exist: forget's job is done.
    say(messages.nothingSavedOffMac(io.platform));
    if (envToken(io.env).kind === 'token') say(messages.ENV_UNCHANGED);
    return 0;
  }
  const { removed, complete } = await removeAll(io);
  if (!complete) say(messages.FORGET_FAILED);
  else if (removed > 0) say(messages.forgotten(removed));
  else say(messages.NOTHING_TO_FORGET);
  if (envToken(io.env).kind === 'token') say(messages.ENV_UNCHANGED);
  return complete ? 0 : 1;
}

/**
 * @typedef {{
 *   env?: Record<string, string|undefined>, platform?: string, isTTY?: boolean,
 *   out?: (text: string) => void, err?: (text: string) => void,
 *   readKeychain?: () => Promise<string|null>,
 *   writeKeychain?: () => Promise<'written'|'cancelled'|'failed'>,
 *   deleteKeychain?: () => Promise<'deleted'|'not-found'|'failed'>,
 *   resolveToken?: typeof defaultResolveToken,
 *   createLoopback?: typeof defaultCreateLoopback,
 * }} CliDeps
 * deleteKeychain is one run of delete-generic-password (the first copy in the
 * search list); setup and forget repeat it until no copy is left.
 */

/**
 * Runs one command. `argv[0]` is the command; the rest are its flags.
 * Every dependency is injectable; the defaults are the real Keychain and
 * loopback. `isTTY` defaults to false, so setup refuses unless the caller
 * says stdin is a terminal.
 * @param {readonly string[]} argv
 * @param {CliDeps} [deps]
 * @returns {Promise<number>} the exit code
 */
export async function runCli(argv, deps = {}) {
  /** @type {Required<CliDeps>} */
  const io = {
    env: process.env,
    platform: process.platform,
    isTTY: false,
    out: () => {},
    err: () => {},
    // security gets io.env minus every WISPLY_MCP_* variable (lib/token.mjs securityEnv).
    readKeychain: () => defaultReadKeychain({ env: io.env }),
    writeKeychain: () => writeKeychainInteractive({ env: io.env }),
    deleteKeychain: () => defaultDeleteKeychain({ env: io.env }),
    resolveToken: defaultResolveToken,
    createLoopback: defaultCreateLoopback,
    ...Object.fromEntries(Object.entries(deps).filter(([, value]) => value !== undefined)),
  };
  const parsed = parseCliArgs(argv, io.env);
  if ('help' in parsed) {
    io.out(messages.HELP);
    return 0;
  }
  if ('error' in parsed) {
    io.err(`${parsed.error}\n`);
    return 2;
  }
  const { options } = parsed;
  if (options.command === 'setup') return setup(options, io);
  if (options.command === 'status') return status(options, io);
  return forget(options, io);
}
