// The AI apps the connector knows how to set up, from clients/mcp-clients.json.
// That file is the source of the setup templates; wisply-ai (Docs/) and
// wisply-web vendor byte-identical copies, and render the same way.
//
// A template holds no token, and can't: its only placeholders are the
// connector's arguments, {{args_list}} (each argument double-quoted, joined
// by ", ") and {{args_cli}} (joined by single spaces). The arguments are
// checked to be plain ASCII without quotes, spaces, backslashes or shell
// characters, so neither placeholder needs escaping in JSON, JSONC, TOML, a
// YAML flow sequence or a shell command.
//
// print-config renders a template. install (lib/cli.mjs) either runs the
// app's own command or merges the rendered entry into the app's JSON
// settings file (applyJsonInstall below). Nothing here reads a token, the
// environment's token or the Keychain.
import { constants as fsConstants } from 'node:fs';
import { chmod, copyFile, lstat, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import data from '../clients/mcp-clients.mjs';
import { DEFAULT_PORT, MAX_PORT, MIN_PORT, PACKAGE_SPEC, SERVER_KEY } from './constants.mjs';

export const CLIENTS_SCHEMA = 'wisply-mcp-clients-v1';
export const ARGS_LIST = '{{args_list}}';
export const ARGS_CLI = '{{args_cli}}';
export const FORMATS = Object.freeze(['json', 'jsonc', 'toml', 'yaml', 'command']);
export const INSTALL_TYPES = Object.freeze(['command', 'add-mcp', 'json-file']);
/** install writes the app's file as it was, before the first change, next to it. */
export const BACKUP_SUFFIX = '.wisply-backup';
/** What an argument may contain: no quotes, spaces, backslashes, $, `, ~, ^, globs or braces. */
export const SAFE_ARGUMENT = /^[A-Za-z0-9@._/-]+$/;

/** The clients file (the generated module of clients/mcp-clients.json). Its server_key and
 * default_port equal SERVER_KEY and DEFAULT_PORT (tests/clients.test.mjs). */
export const clientsFile = data;
/** Every app id, in the file's order. */
export const CLIENT_IDS = Object.freeze(data.clients.map((client) => client.id));

const TOKEN_ANYWHERE = /wsp[cr]?_[0-9a-f]{64}/;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value !== '';

/**
 * The connector's arguments in a snippet: ["-y", spec], plus ["--port", n]
 * when the port isn't the default.
 * @param {{spec?: string, port?: number}} [options]
 * @returns {string[]}
 */
export function bridgeArgs({ spec = PACKAGE_SPEC, port = DEFAULT_PORT } = {}) {
  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
    throw new RangeError(`port must be a whole number from ${MIN_PORT} to ${MAX_PORT}`);
  }
  const args = ['-y', spec, ...(port === DEFAULT_PORT ? [] : ['--port', String(port)])];
  for (const argument of args) {
    if (typeof argument !== 'string' || !SAFE_ARGUMENT.test(argument)) {
      throw new TypeError('a connector argument may hold only letters, digits and @ . _ / -');
    }
  }
  return args;
}

/**
 * Fills a template's placeholders with the connector's arguments.
 * @param {string} template
 * @param {readonly string[]} args from bridgeArgs()
 * @returns {string}
 */
export function renderTemplate(template, args) {
  const list = args.map((argument) => `"${argument}"`).join(', ');
  const text = template.split(ARGS_LIST).join(list).split(ARGS_CLI).join(args.join(' '));
  if (text.includes('{{')) throw new Error('template has an unknown placeholder');
  return text;
}

/**
 * Finds an app, or one of its alternatives (vscode-inputs), by id.
 * @param {unknown} id
 * @returns {{client: object, alternative: object|null} | null}
 */
export function findClient(id) {
  if (typeof id !== 'string') return null;
  for (const client of data.clients) {
    if (client.id === id) return { client, alternative: null };
    const alternative = (client.alternatives ?? []).find((entry) => entry.id === id);
    if (alternative) return { client, alternative };
  }
  return null;
}

/**
 * The token-free setup for an app.
 * @param {string} id an app id or an alternative's id
 * @param {{spec?: string, port?: number}} [options]
 * @returns {null | {id: string, client: string, name: string, label: string|null, format: string,
 *   destination: string, docs: string, note: string|null, text: string, install: string|null,
 *   alternatives: {id: string, label: string}[]}}
 */
export function render(id, { spec = PACKAGE_SPEC, port = DEFAULT_PORT } = {}) {
  const found = findClient(id);
  if (!found) return null;
  const { client, alternative } = found;
  const args = bridgeArgs({ spec, port });
  return {
    id: alternative ? alternative.id : client.id,
    client: client.id,
    name: client.name,
    label: alternative ? alternative.label : null,
    format: alternative?.format ?? client.format,
    destination: client.destination,
    docs: client.docs,
    note: (alternative ? alternative.note : client.note) ?? null,
    text: renderTemplate(alternative ? alternative.text : client.stdio, args),
    install: alternative ? null : client.install?.type ?? null,
    alternatives: alternative ? [] : (client.alternatives ?? []).map(({ id: altId, label }) => ({ id: altId, label })),
  };
}

const expandHome = (path, home) => (path === '~' ? home : path.startsWith('~/') ? join(home, path.slice(2)) : path);

/**
 * Where install writes an app's JSON file: the app's own override variable
 * when it's set (path_env names a file, dir_env a folder), else the default.
 */
function installPath(install, env, home) {
  const fileOverride = install.path_env ? env?.[install.path_env] : undefined;
  if (typeof fileOverride === 'string' && fileOverride.trim() !== '') return resolve(expandHome(fileOverride.trim(), home));
  const dirOverride = install.dir_env ? env?.[install.dir_env] : undefined;
  if (typeof dirOverride === 'string' && dirOverride.trim() !== '') {
    return join(resolve(expandHome(dirOverride.trim(), home)), basename(install.path));
  }
  return expandHome(install.path, home);
}

/**
 * What `install <id>` does, without doing it. Commands are fixed argv
 * (execFile, no shell); JSON files get exactly the entry print-config shows.
 * @param {string} id
 * @param {{spec?: string, port?: number, env?: Record<string, string|undefined>, home?: string}} [options]
 * @returns {null
 *   | {kind: 'manual', id: string}
 *   | {kind: 'command', id: string, file: string, args: string[], display: string, hint: string|null}
 *   | {kind: 'json-file', id: string, path: string, key: string, name: string, entry: object}}
 */
export function installPlan(id, { spec = PACKAGE_SPEC, port = DEFAULT_PORT, env = {}, home = homedir() } = {}) {
  const found = findClient(id);
  if (!found) return null;
  const { client, alternative } = found;
  const install = client.install;
  if (alternative || !install) return { kind: 'manual', id: alternative ? alternative.id : client.id };
  const args = bridgeArgs({ spec, port });
  if (install.type === 'command') {
    const display = renderTemplate(install.command, args);
    const [file, ...argv] = display.split(' ');
    return { kind: 'command', id: client.id, file, args: argv, display, hint: install.hint ?? null };
  }
  const rendered = JSON.parse(renderTemplate(client.stdio, args));
  if (install.type === 'add-mcp') {
    const json = JSON.stringify({ name: SERVER_KEY, ...rendered.servers[SERVER_KEY] });
    return {
      kind: 'command', id: client.id, file: install.program, args: ['--add-mcp', json],
      display: `${install.program} --add-mcp '${json}'`, hint: install.hint ?? null,
    };
  }
  if (install.type === 'json-file') {
    return {
      kind: 'json-file', id: client.id, path: installPath(install, env, home), key: install.key, name: SERVER_KEY,
      entry: rendered[install.key][SERVER_KEY],
    };
  }
  throw new Error(`unknown install type ${String(install.type)}`);
}

/**
 * Sets `obj[key][name] = entry` in a JSON text and returns the new text, or
 * why it can't. Only that one entry changes; the rest is kept, in order, with
 * the file's own indentation and a leading byte-order mark if it had one.
 * @param {string|null} text the file's contents; null when there's no file
 * @param {{key: string, name: string, entry: object}} change
 * @returns {{ok: true, text: string, unchanged: boolean, replaced: boolean, replacedHeldToken: boolean}
 *   | {ok: false, reason: 'invalid-json'|'not-object'}}
 */
export function mergeEntry(text, { key, name, entry }) {
  const bom = typeof text === 'string' && text.startsWith('\uFEFF') ? '\uFEFF' : '';
  const body = typeof text === 'string' ? text.slice(bom.length) : '';
  let config = {};
  if (body.trim() !== '') {
    try {
      config = JSON.parse(body);
    } catch {
      return { ok: false, reason: 'invalid-json' };
    }
  }
  if (!isObject(config)) return { ok: false, reason: 'not-object' };
  if (config[key] === undefined) config[key] = {};
  if (!isObject(config[key])) return { ok: false, reason: 'not-object' };
  const previous = config[key][name];
  if (previous !== undefined && JSON.stringify(previous) === JSON.stringify(entry)) {
    return { ok: true, text: String(text), unchanged: true, replaced: false, replacedHeldToken: false };
  }
  config[key][name] = entry;
  const indent = /\n(\t| +)"/.exec(body)?.[1] ?? '  ';
  return {
    ok: true,
    text: `${bom}${JSON.stringify(config, null, indent)}\n`,
    unchanged: false,
    replaced: previous !== undefined,
    replacedHeldToken: previous !== undefined && TOKEN_ANYWHERE.test(JSON.stringify(previous)),
  };
}

const errorCode = (error) => (error && typeof error === 'object' ? error.code : undefined);

/**
 * Applies a json-file plan: reads and parses the file (a missing file
 * starts empty, but its folder must exist), refuses invalid JSON, saves the
 * original once as `<file>.wisply-backup`, and writes the new text to a
 * temporary file next to the real file (symlinks are followed) before
 * renaming it over, so the app never reads half a file.
 * @param {{path: string, key: string, name: string, entry: object}} plan
 * @returns {Promise<{outcome: 'written'|'unchanged'|'no-folder'|'invalid-json'|'not-object'|'read-failed'|'write-failed',
 *   path: string, created?: boolean, replaced?: boolean, replacedHeldToken?: boolean, backup?: string|null}>}
 */
export async function applyJsonInstall({ path, key, name, entry }) {
  const folder = dirname(path);
  try {
    if (!(await stat(folder)).isDirectory()) return { outcome: 'no-folder', path };
  } catch {
    return { outcome: 'no-folder', path };
  }
  let text = null;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') return { outcome: 'read-failed', path };
    // A symlink to a file that's gone (a dotfiles link): don't replace the link.
    if (await lstat(path).then(() => true, () => false)) return { outcome: 'read-failed', path };
  }
  const merged = mergeEntry(text, { key, name, entry });
  if (!merged.ok) return { outcome: merged.reason, path };
  if (merged.unchanged) return { outcome: 'unchanged', path };

  let backup = null;
  let target = path;
  let mode = 0o600;
  if (text !== null) {
    try {
      await copyFile(path, `${path}${BACKUP_SUFFIX}`, fsConstants.COPYFILE_EXCL);
      backup = `${path}${BACKUP_SUFFIX}`;
    } catch (error) {
      // An earlier install already saved the original: keep that one.
      if (errorCode(error) !== 'EEXIST') return { outcome: 'write-failed', path };
    }
  }
  // Nothing changed after all: a backup made just now goes again.
  const failed = async () => {
    if (backup) await unlink(backup).catch(() => {});
    return { outcome: 'write-failed', path };
  };
  if (text !== null) {
    try {
      target = await realpath(path);
      mode = (await stat(target)).mode & 0o777;
    } catch {
      return failed();
    }
  }
  const temporary = `${target}.wisply-${process.pid}-${Date.now()}.tmp`;
  try {
    await writeFile(temporary, merged.text, { mode, flag: 'wx' });
    await chmod(temporary, mode);
    await rename(temporary, target);
  } catch {
    await unlink(temporary).catch(() => {});
    return failed();
  }
  return {
    outcome: 'written', path, created: text === null, replaced: merged.replaced,
    replacedHeldToken: merged.replacedHeldToken, backup,
  };
}

/**
 * Problems with a clients file's shape, as short strings; empty when usable.
 * The tests run it on clients/mcp-clients.json.
 * @param {unknown} file
 * @returns {string[]}
 */
export function clientsProblems(file) {
  if (!isObject(file)) return ['not an object'];
  const problems = [];
  if (file.schema !== CLIENTS_SCHEMA) problems.push('schema');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(file.verified_on))) problems.push('verified_on');
  if (!isText(file.server_key)) problems.push('server_key');
  if (!Number.isInteger(file.default_port) || file.default_port < MIN_PORT || file.default_port > MAX_PORT) {
    problems.push('default_port');
  }
  if (JSON.stringify(file.placeholders) !== JSON.stringify([ARGS_LIST, ARGS_CLI])) problems.push('placeholders');
  if (!Array.isArray(file.clients) || file.clients.length === 0) return [...problems, 'clients'];
  const ids = new Set();
  for (const client of file.clients) {
    const where = `client ${String(client?.id)}`;
    if (!isObject(client)) { problems.push('client is not an object'); continue; }
    for (const field of ['id', 'name', 'docs', 'format', 'destination', 'stdio']) {
      if (!isText(client[field])) problems.push(`${where}: ${field}`);
    }
    if (!FORMATS.includes(client.format)) problems.push(`${where}: format`);
    if (!/^https:\/\//.test(String(client.docs))) problems.push(`${where}: docs`);
    for (const id of [client.id, ...(client.alternatives ?? []).map((alternative) => alternative?.id)]) {
      if (typeof id !== 'string' || !/^[a-z0-9-]+$/.test(id) || ids.has(id)) problems.push(`${where}: id ${String(id)}`);
      ids.add(id);
    }
    for (const alternative of client.alternatives ?? []) {
      for (const field of ['id', 'label', 'text']) {
        if (!isText(alternative?.[field])) problems.push(`${where}: alternative ${field}`);
      }
      if (alternative?.format !== undefined && !FORMATS.includes(alternative.format)) problems.push(`${where}: alternative format`);
    }
    const install = client.install;
    if (install !== undefined) {
      if (!isObject(install) || !INSTALL_TYPES.includes(install.type)) problems.push(`${where}: install`);
      else if (install.type === 'command' && !isText(install.command)) problems.push(`${where}: install.command`);
      else if (install.type === 'add-mcp' && !isText(install.program)) problems.push(`${where}: install.program`);
      else if (install.type === 'json-file' && !(isText(install.path) && isText(install.key))) problems.push(`${where}: install.path`);
    }
  }
  return problems;
}
