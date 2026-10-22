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
// Every setup starts npx with NPX_FLAGS (`-y --prefix /`) before the exact
// package version, so npx never picks up a copy of the package, or an .npmrc,
// from the project folder the app starts it in (lib/constants.mjs).
//
// print-config renders a template. install (lib/cli.mjs) either runs the
// app's own command or puts the rendered entry into the app's JSON settings
// file (applyJsonInstall below), changing the text of that one entry only.
// Nothing here reads a token, the environment's token or the Keychain.
import { chmod, lstat, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import data from '../clients/mcp-clients.mjs';
import { DEFAULT_PORT, MAX_PORT, MIN_PORT, NPX_FLAGS, PACKAGE_SPEC, SERVER_KEY } from './constants.mjs';

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
const TOKEN_EVERYWHERE = /wsp[cr]?_[0-9a-f]{64}/g;
/** What a token in a backup becomes (the same mask as lib/token.mjs redact). */
export const TOKEN_MASK = 'wsp...';
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value !== '';

/**
 * The connector's arguments in a snippet: ["-y", "--prefix", "/", spec],
 * plus ["--port", n] when the port isn't the default.
 * @param {{spec?: string, port?: number}} [options]
 * @returns {string[]}
 */
export function bridgeArgs({ spec = PACKAGE_SPEC, port = DEFAULT_PORT } = {}) {
  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
    throw new RangeError(`port must be a whole number from ${MIN_PORT} to ${MAX_PORT}`);
  }
  const args = [...NPX_FLAGS, spec, ...(port === DEFAULT_PORT ? [] : ['--port', String(port)])];
  for (const argument of args) {
    if (typeof argument !== 'string' || !SAFE_ARGUMENT.test(argument)) {
      throw new TypeError('a connector argument may hold only letters, digits and @ . _ / -');
    }
  }
  // The package comes right after npx's own flags; a "spec" that is a flag would change npx.
  if (spec.startsWith('-')) throw new TypeError('the package spec must not start with -');
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
 *   installTarget: string|null, alternatives: {id: string, label: string}[]}}
 */
export function render(id, { spec = PACKAGE_SPEC, port = DEFAULT_PORT } = {}) {
  const found = findClient(id);
  if (!found) return null;
  const { client, alternative } = found;
  const args = bridgeArgs({ spec, port });
  const install = alternative ? null : client.install ?? null;
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
    install: install?.type ?? null,
    /** What install changes, when that isn't the app itself (the Cline CLI's file, not the extension's). */
    installTarget: install ? install.target ?? client.name : null,
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
 *   | {kind: 'json-file', id: string, target: string, path: string, key: string, name: string, entry: object,
 *      hint: string|null}}
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
      kind: 'json-file', id: client.id, target: install.target ?? client.name, path: installPath(install, env, home),
      key: install.key, name: SERVER_KEY, entry: rendered[install.key][SERVER_KEY], hint: install.hint ?? null,
    };
  }
  throw new Error(`unknown install type ${String(install.type)}`);
}

// --- One entry of a JSON file, changed in place -----------------------------
//
// install changes the text of the app's "wisply" entry and nothing else: the
// rest of the file keeps its bytes (its layout, escapes, number spellings and
// other servers' values). A small scanner finds where the entry sits; the
// text is valid JSON by then (JSON.parse accepted it), and the result is
// parsed again and compared with what the change should give.

const SPACE = ' \t\n\r';

function skipSpace(text, index) {
  let i = index;
  while (i < text.length && SPACE.includes(text[i])) i += 1;
  return i;
}

function ensureInside(text, index) {
  if (index >= text.length) throw new SyntaxError('unexpected end of JSON');
  return index;
}

/** The index after the string that starts at `index` (a '"'). */
function skipString(text, index) {
  for (let i = index + 1; ; i += text[i] === '\\' ? 2 : 1) {
    if (text[ensureInside(text, i)] === '"') return i + 1;
  }
}

/** The index after the JSON value that starts at `index`. */
function skipValue(text, index) {
  const first = text[ensureInside(text, index)];
  if (first === '"') return skipString(text, index);
  if (first === '{') return objectAt(text, index).end;
  if (first === '[') {
    let i = skipSpace(text, index + 1);
    if (text[i] === ']') return i + 1;
    for (;;) {
      i = ensureInside(text, skipSpace(text, skipValue(text, i)));
      if (text[i] === ']') return i + 1;
      i = skipSpace(text, i + 1);
    }
  }
  let i = index;
  while (i < text.length && !',]}'.includes(text[i]) && !SPACE.includes(text[i])) i += 1;
  if (i === index) throw new SyntaxError('expected a JSON value');
  return i;
}

/**
 * The object that starts at `open` (a '{'): where it closes, and each member's
 * key and where its key and value sit.
 * @returns {{open: number, close: number, end: number,
 *   members: {key: string, keyStart: number, valueStart: number, valueEnd: number}[]}}
 */
function objectAt(text, open) {
  const members = [];
  let i = ensureInside(text, skipSpace(text, open + 1));
  if (text[i] === '}') return { open, close: i, end: i + 1, members };
  for (;;) {
    const keyStart = i;
    const keyEnd = skipString(text, keyStart);
    const valueStart = skipSpace(text, skipSpace(text, keyEnd) + 1);
    const valueEnd = skipValue(text, valueStart);
    members.push({ key: JSON.parse(text.slice(keyStart, keyEnd)), keyStart, valueStart, valueEnd });
    i = ensureInside(text, skipSpace(text, valueEnd));
    if (text[i] === '}') return { open, close: i, end: i + 1, members };
    i = skipSpace(text, i + 1);
  }
}

/** The spaces and tabs that start the line `index` is on. */
function indentAt(text, index) {
  const start = text.lastIndexOf('\n', index - 1) + 1;
  let end = start;
  while (text[end] === ' ' || text[end] === '\t') end += 1;
  return text.slice(start, end);
}

const spansLines = (text, object) => text.slice(object.open, object.close).includes('\n');

/** A value as JSON text: on one line, or over lines that start with `indent`. */
function formatValue(value, { multiline, indent, unit, eol }) {
  return multiline ? JSON.stringify(value, null, unit).split('\n').join(`${eol}${indent}`) : JSON.stringify(value);
}

/** The text with `"name": value` added as the last member of `object`. */
function insertMember(text, object, name, value, style) {
  const member = (indent, multiline) => `${JSON.stringify(name)}: ${formatValue(value, { ...style, multiline, indent })}`;
  if (object.members.length > 0) {
    const last = object.members[object.members.length - 1];
    const multiline = spansLines(text, object);
    const indent = indentAt(text, last.keyStart);
    const added = multiline ? `,${style.eol}${indent}${member(indent, true)}` : `, ${member('', false)}`;
    return text.slice(0, last.valueEnd) + added + text.slice(last.valueEnd);
  }
  // An empty object takes the layout of the file around it.
  const outer = indentAt(text, object.open);
  const inner = `${outer}${style.unit}`;
  const filled = style.multilineFile
    ? `{${style.eol}${inner}${member(inner, true)}${style.eol}${outer}}`
    : `{${member('', false)}}`;
  return text.slice(0, object.open) + filled + text.slice(object.end);
}

/**
 * `body` with `body[key][name]` set to `entry`, changing only that entry's
 * text (or adding it, and `key`, at the end of their objects). null when a
 * key the change needs appears twice: a reader that keeps the first copy
 * would then see something else.
 */
function spliceEntry(body, { key, name, entry }) {
  const top = objectAt(body, skipSpace(body, 0));
  const style = {
    eol: body.includes('\r\n') ? '\r\n' : '\n',
    unit: /\n(\t| +)"/.exec(body)?.[1] ?? '  ',
    multilineFile: spansLines(body, top),
  };
  const holders = top.members.filter((member) => member.key === key);
  if (holders.length > 1) return null;
  if (holders.length === 0) return insertMember(body, top, key, { [name]: entry }, style);
  const servers = objectAt(body, holders[0].valueStart);
  const named = servers.members.filter((member) => member.key === name);
  if (named.length > 1) return null;
  if (named.length === 0) return insertMember(body, servers, name, entry, style);
  const [member] = named;
  const value = formatValue(entry, { ...style, multiline: spansLines(body, servers), indent: indentAt(body, member.keyStart) });
  return body.slice(0, member.valueStart) + value + body.slice(member.valueEnd);
}

/**
 * Sets `obj[key][name] = entry` in a JSON text and returns the new text, or
 * why it can't. Only the text of that one entry changes (or is added, with
 * the file's own indentation and line endings); every other byte stays, a
 * leading byte-order mark included. A missing or empty file gets the entry
 * alone, indented by two spaces.
 * @param {string|null} text the file's contents; null when there's no file
 * @param {{key: string, name: string, entry: object}} change
 * @returns {{ok: true, text: string, unchanged: boolean, replaced: boolean, replacedHeldToken: boolean}
 *   | {ok: false, reason: 'invalid-json'|'not-object'|'not-plain'}}
 */
export function mergeEntry(text, { key, name, entry }) {
  const bom = typeof text === 'string' && text.startsWith('\uFEFF') ? '\uFEFF' : '';
  const body = typeof text === 'string' ? text.slice(bom.length) : '';
  if (body.trim() === '') {
    const fresh = `${bom}${JSON.stringify({ [key]: { [name]: entry } }, null, 2)}\n`;
    return { ok: true, text: fresh, unchanged: false, replaced: false, replacedHeldToken: false };
  }
  let config;
  try {
    config = JSON.parse(body);
  } catch {
    return { ok: false, reason: 'invalid-json' };
  }
  if (!isObject(config)) return { ok: false, reason: 'not-object' };
  if (Object.hasOwn(config, key) && !isObject(config[key])) return { ok: false, reason: 'not-object' };
  const previous = Object.hasOwn(config, key) && Object.hasOwn(config[key], name) ? config[key][name] : undefined;
  if (previous !== undefined && JSON.stringify(previous) === JSON.stringify(entry)) {
    return { ok: true, text: String(text), unchanged: true, replaced: false, replacedHeldToken: false };
  }
  if (!Object.hasOwn(config, key)) config[key] = {};
  config[key][name] = entry;

  let spliced = null;
  try {
    spliced = spliceEntry(body, { key, name, entry });
  } catch {
    spliced = null;
  }
  // The new text must read back as exactly the change: same keys, same order, same values.
  let readBack = null;
  try {
    readBack = spliced === null ? null : JSON.stringify(JSON.parse(spliced));
  } catch {
    readBack = null;
  }
  if (readBack === null || readBack !== JSON.stringify(config)) return { ok: false, reason: 'not-plain' };
  return {
    ok: true,
    text: `${bom}${spliced}`,
    unchanged: false,
    replaced: previous !== undefined,
    replacedHeldToken: previous !== undefined && TOKEN_ANYWHERE.test(JSON.stringify(previous)),
  };
}

const errorCode = (error) => (error && typeof error === 'object' ? error.code : undefined);
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** Whether the file still has exactly these bytes (null: still no file). */
async function stillThere(path, bytes) {
  try {
    const now = await readFile(path);
    return bytes !== null && now.equals(bytes);
  } catch (error) {
    return bytes === null && errorCode(error) === 'ENOENT' && !(await lstat(path).then(() => true, () => false));
  }
}

/**
 * Applies a json-file plan: reads and parses the file (a missing file
 * starts empty, but its folder must exist), refuses invalid JSON or UTF-8,
 * saves the original once as `<file>.wisply-backup` (mode 0600, every Wisply
 * token in it masked), writes the new text to a temporary file next to the
 * real file (symlinks are followed), checks that nobody changed the file in
 * the meantime, and renames it over, so the app never reads half a file.
 * @param {{path: string, key: string, name: string, entry: object}} plan
 * @returns {Promise<{outcome: 'written'|'unchanged'|'no-folder'|'invalid-json'|'not-object'|'not-plain'|'changed'
 *   |'read-failed'|'write-failed', path: string, created?: boolean, replaced?: boolean, replacedHeldToken?: boolean,
 *   backup?: string|null, backupMasked?: boolean}>}
 */
export async function applyJsonInstall({ path, key, name, entry }) {
  const folder = dirname(path);
  try {
    if (!(await stat(folder)).isDirectory()) return { outcome: 'no-folder', path };
  } catch {
    return { outcome: 'no-folder', path };
  }
  let bytes = null;
  try {
    bytes = await readFile(path);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') return { outcome: 'read-failed', path };
    // A symlink to a file that's gone (a dotfiles link): don't replace the link.
    if (await lstat(path).then(() => true, () => false)) return { outcome: 'read-failed', path };
  }
  let text = null;
  if (bytes !== null) {
    try {
      text = UTF8.decode(bytes);
    } catch {
      // Not UTF-8: writing it back as text would change bytes outside the entry.
      return { outcome: 'not-plain', path };
    }
  }
  const merged = mergeEntry(text, { key, name, entry });
  if (!merged.ok) return { outcome: merged.reason, path };
  if (merged.unchanged) return { outcome: 'unchanged', path };

  let backup = null;
  let backupMasked = false;
  if (text !== null) {
    // The backup is a new file, so it never holds a token: a token in the old
    // file (the old entry's, or anyone's) is masked, and only you can read it.
    const masked = text.replace(TOKEN_EVERYWHERE, TOKEN_MASK);
    try {
      await writeFile(`${path}${BACKUP_SUFFIX}`, masked, { mode: 0o600, flag: 'wx' });
      backup = `${path}${BACKUP_SUFFIX}`;
      backupMasked = masked !== text;
    } catch (error) {
      // An earlier install already saved the original: keep that one.
      if (errorCode(error) !== 'EEXIST') return { outcome: 'write-failed', path };
    }
  }
  let target = path;
  let mode = 0o600;
  let outcome = 'written';
  let temporary = null;
  try {
    if (text !== null) {
      target = await realpath(path);
      mode = (await stat(target)).mode & 0o777;
    }
    const candidate = `${target}.wisply-${process.pid}-${Date.now()}.tmp`;
    await writeFile(candidate, merged.text, { mode, flag: 'wx' });
    temporary = candidate;
    await chmod(temporary, mode);
    // The app (or anything else) wrote the file since it was read: its change wins.
    if (await stillThere(path, bytes)) await rename(temporary, target);
    else outcome = 'changed';
  } catch {
    outcome = 'write-failed';
  }
  if (outcome !== 'written') {
    // Nothing changed after all: a temporary file and a backup made just now go again.
    if (temporary) await unlink(temporary).catch(() => {});
    if (backup) await unlink(backup).catch(() => {});
    return { outcome, path };
  }
  return {
    outcome: 'written', path, created: text === null, replaced: merged.replaced,
    replacedHeldToken: merged.replacedHeldToken, backup, backupMasked,
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
  if (!isText(file.package) || !isText(file.package_spec) || !file.package_spec.startsWith(`${file.package}@`)) problems.push('package');
  // Until the package is on npm under this name, nothing may render the name: consumers check this first.
  if (typeof file.published !== 'boolean') problems.push('published');
  const entry = file.standard_entry;
  if (!isObject(entry) || entry.command !== 'npx' || !Array.isArray(entry.args)
    || JSON.stringify(entry.args.slice(0, NPX_FLAGS.length)) !== JSON.stringify(NPX_FLAGS)
    || entry.args[NPX_FLAGS.length] !== file.package_spec) {
    problems.push('standard_entry');
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
      // install edits plain JSON only: a JSONC file (VS Code's mcp.json, Zed's settings) has comments it would refuse.
      else if (install.type === 'json-file' && client.format !== 'json') problems.push(`${where}: install needs a json format`);
      for (const field of ['target', 'hint']) {
        if (isObject(install) && install[field] !== undefined && !isText(install[field])) problems.push(`${where}: install.${field}`);
      }
    }
  }
  return problems;
}
