// The connector's commands for people at a terminal: setup, status, forget,
// print-config and install.
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
//   wisply-mcp print-config [<app>] [--port <n>]
//     The app's token-free setup (lib/clients.mjs) on stdout, and where it
//     goes on stderr, so `print-config cursor | pbcopy` copies only the
//     snippet. With no app, the list of apps.
//   wisply-mcp install <app> [--port <n>]
//     Adds the same token-free entry to the app. Apps with their own command
//     (claude, codex, gemini, code --add-mcp) get it run with execFile and a
//     fixed argv, no shell, by the absolute path found in PATH's absolute
//     folders (never `.` or another relative entry); apps with a JSON
//     settings file get only the text of their "wisply" entry changed, after
//     a one-time backup with any token masked, with an atomic write. It never
//     reads the token, never writes one, and starts the app's command without
//     WISPLY_MCP_TOKEN, anything token-shaped or a relative PATH entry in its
//     environment. Other apps get the snippet to paste.
//
// Exit codes: 0 done (setup: stored and confirmed; status: token found and
// confirmed; install: added or already there), 1 a problem (the message says
// which), 2 a usage mistake.
// Output goes through the injected `out` and `err` writers (the bin passes
// stdout and stderr), so this file never writes to the process itself.
import { execFile as nodeExecFile } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import {
  CLIENT_IDS, applyJsonInstall as defaultApplyJsonInstall, clientsFile, installPlan, render,
} from './clients.mjs';
import contract from './contract.mjs';
import { DEFAULT_PORT } from './constants.mjs';
import { createLoopback as defaultCreateLoopback, parsePort } from './loopback.mjs';
import * as messages from './messages.mjs';
import { scopeOfToken, toolsFor } from './scopes.mjs';
import {
  defaultReadKeychain, deleteKeychain as defaultDeleteKeychain, envToken, redact, resolveToken as defaultResolveToken,
  writeKeychainInteractive,
} from './token.mjs';

/** The commands this file runs; the bin hands it argv when argv[0] is one of them. */
export const CLI_COMMANDS = Object.freeze(['setup', 'status', 'forget', 'print-config', 'install']);

/** How long install lets an app's own command run. */
export const INSTALL_TIMEOUT_MS = 60000;

/** Flags each command takes. */
const FLAGS = Object.freeze({
  setup: Object.freeze(['--full-access', '--port']),
  status: Object.freeze(['--port', '--read-only', '--allow-claude-setup']),
  forget: Object.freeze([]),
  'print-config': Object.freeze(['--port']),
  install: Object.freeze(['--port']),
});
/** Commands that take an app id (lib/clients.mjs) as their one argument. */
const TAKES_APP = Object.freeze(['print-config', 'install']);

/**
 * @typedef {{command: 'setup'|'status'|'forget'|'print-config'|'install', port: number, fullAccess: boolean,
 *   readOnly: boolean, allowClaudeSetup: boolean, app: string|null}} CliOptions
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
    app: null,
  };
  let portFlag;
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === '--help' || argument === '-h') return { help: true };
    if (TAKES_APP.includes(command) && options.app === null && typeof argument === 'string' && !argument.startsWith('-')) {
      options.app = argument.toLowerCase();
      continue;
    }
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
 * `print-config [<app>]`: the snippet on stdout, where it goes on stderr.
 * @param {CliOptions} options
 * @param {Required<CliDeps>} io
 */
function printConfig({ app, port }, io) {
  if (app === null) {
    io.out(messages.appList(clientsFile.clients.map((client) => ({ id: client.id, name: client.name, install: Boolean(client.install) }))));
    return 0;
  }
  const rendered = render(app, { port });
  if (!rendered) {
    io.err(`${messages.unknownApp(app, CLIENT_IDS)}\n`);
    return 2;
  }
  io.out(`${rendered.text}\n`);
  io.err(messages.printConfigHint(rendered));
  return 0;
}

const TOKEN_SHAPED = /wsp[cr]?_[0-9a-f]{64}/;

/**
 * PATH's absolute folders, in order. An empty or relative entry (`.`, `::`,
 * `bin`) would find programs in whatever folder install runs in, such as a
 * cloned project, so it never counts.
 * @param {unknown} path a PATH value
 * @returns {string[]}
 */
export function absolutePathFolders(path) {
  return typeof path === 'string' ? path.split(delimiter).filter((folder) => folder !== '' && isAbsolute(folder)) : [];
}

/**
 * The absolute path of an app's own command, from PATH's absolute folders:
 * the first regular file there that is executable. null when there's none.
 * @param {string} program a bare name such as "claude"
 * @param {Record<string, string|undefined>} env
 * @returns {Promise<string|null>}
 */
export async function findProgram(program, env) {
  if (typeof program !== 'string' || !/^[a-z][a-z0-9-]*$/.test(program)) return null;
  for (const folder of absolutePathFolders(env?.PATH)) {
    const candidate = join(folder, program);
    try {
      if (!(await stat(candidate)).isFile()) continue;
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Not here: try the next folder.
    }
  }
  return null;
}

/**
 * The environment for an app's own command: this one, minus WISPLY_MCP_TOKEN
 * and any variable whose value holds something token-shaped, so the token
 * can't reach the app's command or end up in the config it writes. PATH
 * keeps only its absolute folders, so the command (a node script, say)
 * doesn't find its own helpers in the folder install runs in either.
 * @param {Record<string, string|undefined>} env
 * @returns {Record<string, string>}
 */
export function commandEnv(env) {
  /** @type {Record<string, string>} */
  const clean = {};
  for (const [name, value] of Object.entries(env ?? {})) {
    if (typeof value !== 'string' || name === 'WISPLY_MCP_TOKEN' || TOKEN_SHAPED.test(value)) continue;
    clean[name] = name === 'PATH' ? absolutePathFolders(value).join(delimiter) : value;
  }
  return clean;
}

/**
 * Runs a program with execFile (no shell) and settles with what happened.
 * @returns {Promise<{error: any, stdout: string, stderr: string}>}
 */
function runProgram(execFile, file, args, env) {
  return new Promise((settle) => {
    try {
      execFile(file, args, { env, encoding: 'utf8', timeout: INSTALL_TIMEOUT_MS, maxBuffer: 1024 * 1024, windowsHide: true },
        (error, stdout, stderr) => settle({ error, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }));
    } catch (error) {
      settle({ error, stdout: '', stderr: '' });
    }
  });
}

/**
 * `install <app>`: add the token-free entry to the app.
 * @param {CliOptions} options
 * @param {Required<CliDeps>} io
 */
async function install({ app, port }, io) {
  const say = (text) => io.out(`${text}\n`);
  if (app === null) {
    io.err(`${messages.missingApp('install', CLIENT_IDS)}\n`);
    return 2;
  }
  const rendered = render(app, { port });
  if (!rendered) {
    io.err(`${messages.unknownApp(app, CLIENT_IDS)}\n`);
    return 2;
  }
  if (io.platform !== 'darwin') {
    say(messages.notMac(io.platform));
    return 1;
  }
  const home = typeof io.env.HOME === 'string' && io.env.HOME !== '' ? io.env.HOME : homedir();
  const plan = installPlan(app, { port, env: io.env, home });

  if (plan.kind === 'manual') {
    say(messages.installManual(rendered));
    say(rendered.text);
    return 1;
  }

  if (plan.kind === 'command') {
    let program = null;
    try { program = await io.findProgram(plan.file, io.env); } catch { program = null; }
    if (typeof program !== 'string' || !isAbsolute(program)) {
      say(messages.programMissing(plan.file, rendered.name, plan.hint, plan.display));
      return 1;
    }
    say(messages.installRunning(`${program}${plan.display.slice(plan.file.length)}`));
    const { error, stdout, stderr } = await runProgram(io.execFile, program, plan.args, commandEnv(io.env));
    if (stdout) io.out(redact(stdout.endsWith('\n') ? stdout : `${stdout}\n`));
    if (stderr) io.err(redact(stderr.endsWith('\n') ? stderr : `${stderr}\n`));
    if (error) {
      if (error.code === 'ENOENT') say(messages.programMissing(plan.file, rendered.name, plan.hint, plan.display));
      else say(messages.programFailed(plan.file, rendered.name, { code: error.code, signal: error.signal, timedOut: error.killed === true }));
      return 1;
    }
    say(messages.installedByCommand(rendered.name));
    say(messages.installNextSteps(rendered.name));
    return 0;
  }

  // What install changes: the app, or a part of it (the Cline CLI's file, not the extension's).
  const target = plan.target;
  let result;
  try {
    result = await io.applyJsonInstall(plan);
  } catch {
    result = { outcome: 'write-failed', path: plan.path };
  }
  if (result.outcome === 'unchanged') {
    say(messages.installUnchanged(target, plan.path));
    if (plan.hint) say(plan.hint);
    say(messages.installNextSteps(target));
    return 0;
  }
  if (result.outcome !== 'written') {
    say(messages.installFileProblem(result.outcome, target, plan.path, dirname(plan.path)));
    say(rendered.text);
    if (plan.hint) say(plan.hint);
    return 1;
  }
  say(messages.installedFile(target, result));
  if (result.replacedHeldToken) say(messages.replacedTokenWarning(plan.path));
  if (plan.hint) say(plan.hint);
  say(messages.installNextSteps(target));
  return 0;
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
 *   execFile?: typeof nodeExecFile,
 *   findProgram?: typeof findProgram,
 *   applyJsonInstall?: typeof defaultApplyJsonInstall,
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
    execFile: nodeExecFile,
    findProgram,
    applyJsonInstall: defaultApplyJsonInstall,
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
  if (options.command === 'print-config') return printConfig(options, io);
  if (options.command === 'install') return install(options, io);
  return forget(options, io);
}
