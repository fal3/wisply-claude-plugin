// The connector's commands for people at a terminal: setup, status, forget,
// print-config and install.
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
//   Both use only --port, never WISPLY_MCP_PORT: a port exported for a test
//   Wisply must not end up in an app's settings unasked. Before the release
//   (SETUPS_RELEASED in lib/clients.mjs) both print and add nothing for an
//   app, because every setup runs the connector through npx, from an npm
//   name that isn't Wisply's yet.
//
// Exit codes: 0 done (setup: stored and confirmed; status: token found and
// confirmed; forget: no saved copy left, which off macOS is always true;
// install: added, or the JSON file already had this entry), 1 a problem (the
// message says which; for install also: not released yet, an app without an
// install, and an app's own command that refuses because a "wisply" entry
// exists, as `claude mcp add` does, since install can't tell whether that
// entry is this one), 2 a usage mistake.
// Output goes through the injected `out` and `err` writers (the bin passes
// stdout and stderr), so this file never writes to the process itself.
import { execFile as nodeExecFile } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import {
  CLIENT_IDS, SETUPS_RELEASED, applyJsonInstall as defaultApplyJsonInstall, clientsFile, findClient, installPlan, render,
} from './clients.mjs';
import contract from './contract.mjs';
import { DEFAULT_PORT } from './constants.mjs';
import { createLoopback as defaultCreateLoopback, parsePort } from './loopback.mjs';
import * as messages from './messages.mjs';
import { scopeOfToken, toolsFor } from './scopes.mjs';
import {
  defaultReadKeychain, deleteAllKeychain, deleteKeychain as defaultDeleteKeychain, envToken, redact,
  resolveToken as defaultResolveToken, writeKeychainInteractive,
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
 * Commands whose port may come from WISPLY_MCP_PORT, as for serving. Not
 * print-config and install: what they print or write stays in an app's
 * settings, so only an explicit --port changes it. forget takes no port.
 */
const ENV_PORT = Object.freeze(['setup', 'status']);

/**
 * @typedef {{command: 'setup'|'status'|'forget'|'print-config'|'install', port: number, fullAccess: boolean,
 *   readOnly: boolean, allowClaudeSetup: boolean, app: string|null}} CliOptions
 */

/**
 * Parses `<command> [flags]`. For setup and status the port comes from
 * --port, else WISPLY_MCP_PORT, else the contract's default, as for serving;
 * print-config and install take --port or the default. forget has no port,
 * so a stale WISPLY_MCP_PORT can't stop it.
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
  } else if (ENV_PORT.includes(command)) {
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
 * Whether WISPLY_MCP_PORT asks for another port than the one print-config
 * or install uses (they take only --port).
 * @param {Record<string, string|undefined>} env
 * @param {number} port
 */
function envPortIgnored(env, port) {
  const value = env?.WISPLY_MCP_PORT;
  return typeof value === 'string' && value.trim() !== '' && parsePort(value) !== port;
}

/**
 * `print-config [<app>]`: the snippet on stdout, where it goes on stderr.
 * Before the release, nothing for an app: stderr says why, exit 1.
 * @param {CliOptions} options
 * @param {Required<CliDeps>} io
 */
function printConfig({ app, port }, io) {
  if (app === null) {
    const rows = clientsFile.clients.map((client) => ({ id: client.id, name: client.name, install: Boolean(client.install) }));
    io.out(messages.appList(rows, { released: io.released }));
    return 0;
  }
  if (!findClient(app)) {
    io.err(`${messages.unknownApp(app, CLIENT_IDS)}\n`);
    return 2;
  }
  if (!io.released) {
    io.err(`${messages.SETUPS_NOT_RELEASED}\n`);
    return 1;
  }
  const rendered = render(app, { port, beforeRelease: true });
  io.out(`${rendered.text}\n`);
  if (envPortIgnored(io.env, port)) io.err(`${messages.envPortIgnored(port)}\n`);
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
  if (!findClient(app)) {
    io.err(`${messages.unknownApp(app, CLIENT_IDS)}\n`);
    return 2;
  }
  if (!io.released) {
    say(messages.SETUPS_NOT_RELEASED);
    return 1;
  }
  const rendered = render(app, { port, beforeRelease: true });
  if (io.platform !== 'darwin') {
    say(messages.notMac(io.platform));
    return 1;
  }
  if (envPortIgnored(io.env, port)) say(messages.envPortIgnored(port));
  const home = typeof io.env.HOME === 'string' && io.env.HOME !== '' ? io.env.HOME : homedir();
  const plan = installPlan(app, { port, env: io.env, home, beforeRelease: true });

  if (plan.kind === 'manual') {
    say(messages.installManual(rendered));
    say(rendered.text);
    return 1;
  }

  if (plan.kind === 'not-full-path') {
    say(messages.installNotFullPath(plan.variable, plan.target));
    say(rendered.text);
    if (plan.hint) say(plan.hint);
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
      // `claude mcp add` refuses a name that exists; codex and gemini replace the entry.
      const exists = /already exists/i.test(`${stdout}\n${stderr}`);
      const canRemove = plan.args[0] === 'mcp' && plan.args[1] === 'add';
      if (error.code === 'ENOENT') say(messages.programMissing(plan.file, rendered.name, plan.hint, plan.display));
      else if (exists) say(messages.commandEntryExists(plan.file, rendered.name, canRemove));
      else say(messages.programFailed(plan.file, rendered.name, { code: error.code, signal: error.signal, timedOut: error.killed === true }));
      return 1;
    }
    say(messages.installedByCommand(rendered.name));
    say(messages.installNextSteps(rendered.name));
    return 0;
  }

  // What install changes: the app, unless the clients file names a part of it (`target`).
  const target = plan.target;
  if (plan.pathFrom) say(messages.installPathFrom(plan.pathFrom, plan.path));
  let result;
  try {
    result = await io.applyJsonInstall(plan);
  } catch {
    result = { outcome: 'write-failed', path: plan.path };
  }
  if (result.outcome === 'unchanged') {
    say(messages.installUnchanged(target, plan.path, result.kept ?? []));
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
 *   env?: Record<string, string|undefined>, platform?: string, isTTY?: boolean, released?: boolean,
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
 * deleteKeychain is one run of delete-generic-password (the first copy in the
 * search list); setup and forget repeat it until no copy is left. released
 * (default SETUPS_RELEASED) lets tests run print-config and install as they
 * work after the release.
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
    released: SETUPS_RELEASED,
    out: () => {},
    err: () => {},
    // security gets io.env minus every WISPLY_MCP_* variable (lib/token.mjs securityEnv).
    readKeychain: () => defaultReadKeychain({ env: io.env }),
    writeKeychain: () => writeKeychainInteractive({ env: io.env }),
    deleteKeychain: () => defaultDeleteKeychain({ env: io.env }),
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
