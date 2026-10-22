// The connector's commands for people at a terminal: setup, status, forget.
//
//   wisply-mcp setup [--full-access] [--port <n>]
//     /usr/bin/security asks for the token in the terminal and stores it in
//     the login keychain (lib/token.mjs); the token never passes through
//     this process's arguments or output. setup then reads the item back
//     once, through a pipe, and removes it again if it isn't a Wisply token
//     (SETUP_MALFORMED) or is the full-access token without --full-access
//     (FULL_ACCESS_REFUSED). A kept token gets the identity check.
//   wisply-mcp status [--port <n>] [--read-only] [--allow-claude-setup]
//     Where the token comes from, its scope, whether Wisply answered and
//     proved it holds the token, and the tools an AI app would see with the
//     same options. Never prints the token: the lines take a scope and a
//     source, never the value.
//   wisply-mcp forget
//     Removes the Keychain item.
//
// Exit codes: 0 done (setup: stored and confirmed; status: token found and
// confirmed), 1 a problem (the message says which), 2 a usage mistake.
// Output goes through the injected `out` and `err` writers (the bin passes
// stdout and stderr), so this file never writes to the process itself.
import contract from './contract.mjs';
import { DEFAULT_PORT } from './constants.mjs';
import { createLoopback as defaultCreateLoopback, parsePort } from './loopback.mjs';
import * as messages from './messages.mjs';
import { scopeOfToken, toolsFor } from './scopes.mjs';
import {
  defaultReadKeychain, deleteKeychain as defaultDeleteKeychain, envToken, resolveToken as defaultResolveToken,
  writeKeychainInteractive,
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
 * Parses `<command> [flags]`. The port comes from --port, else
 * WISPLY_MCP_PORT, else the contract's default, as for serving.
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
  } else {
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

  const written = await io.writeKeychain();
  if (written === 'cancelled') {
    say(messages.SETUP_CANCELLED);
    return 1;
  }
  if (written !== 'written') {
    say(messages.KEYCHAIN_NOT_STORED);
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
    let removed;
    try { removed = await io.deleteKeychain(); } catch { removed = 'failed'; }
    if (removed !== 'deleted' && removed !== 'not-found') {
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
    say(messages.identityProblem(outcome, port));
  }
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
    lines.push(problem === 'malformed' ? messages.MALFORMED
      : problem === 'not-mac' ? messages.notMac(io.platform) : messages.SETUP);
    io.out(`${lines.join('\n')}\n`);
    return 1;
  }

  const outcome = await identityOutcome(io.createLoopback, port, token, scope);
  lines.push(messages.STATUS.token(scope, resolved.source === 'env' ? 'env' : 'keychain'), ...placeholderNote);
  lines.push(messages.STATUS.wisply(outcome, port));
  lines.push(messages.STATUS.tools(toolsFor(contract, scope, { allowClaudeSetup, readOnly })));
  if (outcome !== 'ok') lines.push(messages.identityProblem(outcome, port));
  lines.push(messages.RESTART_NOTE);
  io.out(`${lines.join('\n')}\n`);
  return outcome === 'ok' ? 0 : 1;
}

/**
 * `forget`: remove the Keychain item.
 * @param {CliOptions} _options
 * @param {Required<CliDeps>} io
 */
async function forget(_options, io) {
  const say = (text) => io.out(`${text}\n`);
  if (io.platform !== 'darwin') {
    say(messages.notMac(io.platform));
    return 1;
  }
  let removed;
  try { removed = await io.deleteKeychain(); } catch { removed = 'failed'; }
  if (removed === 'deleted') say(messages.FORGOTTEN);
  else if (removed === 'not-found') say(messages.NOTHING_TO_FORGET);
  else say(messages.FORGET_FAILED);
  if (envToken(io.env).kind === 'token') say(messages.ENV_UNCHANGED);
  return removed === 'deleted' || removed === 'not-found' ? 0 : 1;
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
    readKeychain: () => defaultReadKeychain(),
    writeKeychain: () => writeKeychainInteractive(),
    deleteKeychain: () => defaultDeleteKeychain(),
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
