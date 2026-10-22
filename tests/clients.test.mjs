// The client setup templates (clients/mcp-clients.json), their renderer
// (lib/clients.mjs), and print-config and install (lib/cli.mjs).
//
// install runs against a temporary HOME with an execFile spy standing in for
// every app's own command (found as a stub in a temporary PATH folder), a
// token in the environment and a Keychain that would hand out another one if
// anything asked. Nothing asks: no argv, no child environment and no written
// file may hold a token.
//
// Until the release, render() and installPlan() refuse (SETUPS_RELEASED) and
// so do print-config and install. Most tests here check what they do after
// the release: they render with `beforeRelease: true` and run the CLI with
// `released: true`; the gate itself has its own tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  chmodSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import contract from '../lib/contract.mjs';
import {
  DEFAULT_PORT, NPX_COMMAND, NPX_FLAGS, PACKAGE_NAME, PACKAGE_NAME_FINAL, PACKAGE_RANGE, PACKAGE_SPEC, SERVER_KEY,
  STANDARD_ENTRY, VERSION,
} from '../lib/constants.mjs';
import {
  ARGS_CLI, ARGS_LIST, BACKUP_SUFFIX, CLIENT_IDS, FORMATS, KEPT_FIELDS, NotReleasedError, SETUPS_RELEASED, TOKEN_MASK,
  applyJsonInstall, bridgeArgs, clientsFile, clientsProblems, findClient, installPath, installPlan as installPlanGated,
  mergeEntry, render as renderGated, renderTemplate, writeTemporary,
} from '../lib/clients.mjs';
import { CLI_COMMANDS, absolutePathFolders, commandEnv, findProgram, parseCliArgs, runCli } from '../lib/cli.mjs';
import * as messages from '../lib/messages.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BIN = join(ROOT, 'bin/wisply-mcp.mjs');
const RAW = readFileSync(join(ROOT, 'clients/mcp-clients.json'), 'utf8');
const FILE = JSON.parse(RAW);
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const TOKEN_SHAPE = /wsp[cr]?_[0-9a-f]{64}/;
const ENV_TOKEN = `wspc_${'9e'.repeat(32)}`;
const KEYCHAIN_TOKEN = `wsp_${'8d'.repeat(32)}`;
const OLD_TOKEN = `wsp_${'4f'.repeat(32)}`;
const ARGS = ['-y', '--prefix', '/', PACKAGE_SPEC];

/** render() and installPlan() as they work after the release. */
const render = (id, options = {}) => renderGated(id, { beforeRelease: true, ...options });
const installPlan = (id, options = {}) => installPlanGated(id, { beforeRelease: true, ...options });

/** The apps of the spec's per-client table, in its order. */
const SPEC_IDS = ['claude-code', 'claude-desktop', 'cursor', 'vscode', 'windsurf', 'zed', 'jetbrains', 'codex', 'gemini-cli',
  'copilot-cli', 'warp', 'cline', 'roo-code', 'goose', 'lm-studio', 'kiro', 'opencode', 'amp', 'factory', 'grok-cli'];
/** The apps Wisply's own Settings copy setups for (wisply-ai MCPClientSnippets.Client). */
const APP_IDS = ['cursor', 'claude-desktop', 'claude-code', 'vscode', 'codex', 'gemini-cli', 'windsurf', 'zed', 'jetbrains',
  'warp', 'cline', 'copilot-cli', 'goose'];
/** What install does per app: the spec's list (no JSONC file, so neither VS Code's mcp.json nor Zed's settings). */
const INSTALLS = {
  'claude-code': 'command', codex: 'command', 'gemini-cli': 'command', vscode: 'add-mcp',
  cursor: 'json-file', windsurf: 'json-file', 'claude-desktop': 'json-file', cline: 'json-file', 'copilot-cli': 'json-file',
};

/** Every template string in the file: client snippets, alternatives and install commands. */
function templates() {
  const all = [];
  for (const client of FILE.clients) {
    all.push({ id: client.id, format: client.format, text: client.stdio });
    for (const alternative of client.alternatives ?? []) {
      all.push({ id: alternative.id, format: alternative.format ?? client.format, text: alternative.text });
    }
    if (client.install?.type === 'command') all.push({ id: `${client.id} install`, format: 'command', text: client.install.command });
  }
  return all;
}

// --- The file ------------------------------------------------------------

test('the file is well-formed, canonical and ASCII', () => {
  assert.deepEqual(clientsProblems(FILE), []);
  assert.deepEqual(clientsFile, FILE, 'clients/mcp-clients.mjs is out of date: npm run gen-data');
  // Byte-stable formatting, so the vendored copies in wisply-ai and wisply-web hash the same.
  assert.equal(RAW, `${JSON.stringify(FILE, null, 2)}\n`);
  assert.equal(RAW.search(/[^\x00-\x7f]/), -1, 'ASCII only');
  assert.equal(FILE.schema, 'wisply-mcp-clients-v1');
  assert.match(FILE.verified_on, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(!Number.isNaN(Date.parse(FILE.verified_on)));
  assert.deepEqual(FILE.placeholders, [ARGS_LIST, ARGS_CLI]);
  for (const client of FILE.clients) {
    assert.ok(FORMATS.includes(client.format), client.id);
    assert.match(client.docs, /^https:\/\/[a-z0-9.-]+\.[a-z]{2,}\//, client.id);
  }
});

test('the file agrees with the package constants and the contract', () => {
  assert.equal(FILE.server_key, SERVER_KEY);
  assert.equal(FILE.package, PACKAGE_NAME);
  assert.equal(FILE.package_spec, PACKAGE_SPEC);
  assert.equal(FILE.default_port, DEFAULT_PORT);
  assert.equal(FILE.default_port, contract.default_port);
  assert.deepEqual(FILE.standard_entry, { command: 'npx', args: bridgeArgs() });
  assert.deepEqual(FILE.standard_entry.args, [...NPX_FLAGS, PACKAGE_SPEC]);
  // The bridge's own STANDARD_ENTRY (DIST-M1) is the same entry, so every consumer of either one agrees.
  assert.deepEqual(FILE.standard_entry, JSON.parse(JSON.stringify(STANDARD_ENTRY)));
  // Snippets run the exact version; the 0.x range is only ever an opt-in (README "Versions").
  assert.ok(!RAW.includes(`"${PACKAGE_RANGE}"`) && !RAW.includes(`${PACKAGE_RANGE} `));
  // Every mention of the package names this exact version, with npx's --prefix / in front.
  for (const match of RAW.matchAll(/@wisply\/mcp[^\s"]*/g)) {
    if (match.index === RAW.indexOf(`"package": "${PACKAGE_NAME}"`) + '"package": "'.length) continue;
    assert.equal(match[0], PACKAGE_SPEC, `at ${match.index}`);
  }
  // A public text that VS Code shows when it asks for the token, so it names no command to run: a pasted token
  // must never be steered to whatever answers to an npm name (the setup command asks for the token).
  const description = JSON.parse(render('vscode-inputs').text).inputs[0].description;
  assert.equal(description, "Wisply read-only connector token. Leave empty to use the token that the connector's setup " +
    'saved in your login keychain.');
  assert.doesNotMatch(description, /npx|@wisply|wisply-mcp/);
});

test('"published" keeps the package name off public pages until the release', () => {
  // Consumers (wisply-ai DIST-A1, wisply-web DIST-W1) render nothing from this file while it's false.
  assert.equal(typeof FILE.published, 'boolean');
  // Published exactly when package.json can be published: the release change flips both.
  assert.equal(FILE.published, PKG.private !== true, 'clients/mcp-clients.json "published" must be !package.json "private"');
  if (process.env.WISPLY_RELEASE === '1') {
    assert.equal(FILE.published, true, 'set "published": true in clients/mcp-clients.json in the release change');
  }
  assert.ok(clientsProblems({ ...FILE, published: undefined }).includes('published'));
  assert.ok(clientsProblems({ ...FILE, published: 'no' }).includes('published'));
});

test('clientsProblems refuses entries without --prefix / and file installs into JSONC', () => {
  assert.ok(clientsProblems({ ...FILE, standard_entry: { command: 'npx', args: ['-y', PACKAGE_SPEC] } }).includes('standard_entry'));
  assert.ok(clientsProblems({ ...FILE, standard_entry: { command: 'npx', args: [...NPX_FLAGS, PACKAGE_RANGE] } }).includes('standard_entry'));
  const zed = FILE.clients.find((client) => client.id === 'zed');
  const withZedInstall = {
    ...FILE,
    clients: FILE.clients.map((client) => (client === zed
      ? { ...zed, install: { type: 'json-file', path: '~/.config/zed/settings.json', key: 'context_servers' } } : client)),
  };
  assert.deepEqual(clientsProblems(withZedInstall), ['client zed: install needs a json format']);
  const cline = FILE.clients.find((client) => client.id === 'cline');
  const badTarget = { ...FILE, clients: FILE.clients.map((client) => (client === cline ? { ...cline, install: { ...cline.install, target: '' } } : client)) };
  assert.deepEqual(clientsProblems(badTarget), ['client cline: install.target']);
  // Override variables: a variable name, and for a folder, a path that stays inside it.
  const withInstall = (install) => ({
    ...FILE, clients: FILE.clients.map((client) => (client === cline ? { ...cline, install: { ...cline.install, ...install } } : client)),
  });
  for (const dirEnv of ['CLINE_DIR', [{ name: 'CLINE_DIR' }], [{ name: 'cline_dir', path: 'x.json' }], [{ name: 'CLINE_DIR', path: '/x.json' }],
    [{ name: 'CLINE_DIR', path: '../x.json' }], [{ name: 'CLINE_DIR', path: 'a//x.json' }], [{ name: 'CLINE_DIR', path: '~/x.json' }]]) {
    assert.deepEqual(clientsProblems(withInstall({ dir_env: dirEnv })), ['client cline: install.dir_env'], JSON.stringify(dirEnv));
  }
  assert.deepEqual(clientsProblems(withInstall({ path_env: 'x y' })), ['client cline: install.path_env']);
  assert.deepEqual(clientsProblems(withInstall({ dir_env: [{ name: 'CLINE_DIR', path: 'data/settings/x.json' }] })), []);
});

test('the README names every app id and which ones install supports', () => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  for (const client of FILE.clients) {
    const row = readme.split('\n').find((line) => line.startsWith(`| ${client.name} | \`${client.id}\` |`));
    assert.ok(row, `README has a row for ${client.id}`);
    assert.equal(row.endsWith('| yes |'), Boolean(client.install), `${client.id}: the install column`);
  }
});

test('every app in the spec has an entry, in its order, and Wisply\'s own clients are among them', () => {
  assert.deepEqual([...CLIENT_IDS], SPEC_IDS);
  for (const id of APP_IDS) assert.ok(CLIENT_IDS.includes(id), id);
  assert.deepEqual(FILE.clients.flatMap((client) => (client.alternatives ?? []).map((alternative) => alternative.id)), ['vscode-inputs']);
  assert.deepEqual(Object.fromEntries(FILE.clients.filter((client) => client.install).map((client) => [client.id, client.install.type])),
    INSTALLS);
});

test('no template holds a token or anything that could carry one', () => {
  assert.doesNotMatch(RAW, TOKEN_SHAPE);
  for (const { id, text } of templates()) {
    assert.ok(!text.includes('{{token'), id);
    assert.doesNotMatch(text, /wsp[cr]?_/, `${id}: a token prefix`);
    assert.doesNotMatch(text, /Bearer|Authorization|headers|bearer_token|api[_-]?key/i, `${id}: an auth field`);
    assert.doesNotMatch(text, /https?:\/\/127\.0\.0\.1|localhost|"url"|serverUrl/, `${id}: talks HTTP to the port directly`);
    // The only placeholders are the two argument lists (and VS Code's own ${input:...}).
    assert.deepEqual([...text.matchAll(/\{\{[^}]*\}\}/g)].map((match) => match[0]).filter((p) => p !== ARGS_LIST && p !== ARGS_CLI), [], id);
    assert.ok(text.includes(ARGS_LIST) || text.includes(ARGS_CLI), `${id}: runs the connector`);
  }
  // The one secret-store option keeps the token in VS Code's secret storage, never in the file.
  const inputs = render('vscode-inputs');
  const parsed = JSON.parse(inputs.text);
  assert.deepEqual(parsed.servers.wisply.env, { WISPLY_MCP_TOKEN: '${input:wisply-token}' });
  assert.equal(parsed.inputs[0].password, true);
  assert.ok(!inputs.text.includes(`${NPX_COMMAND} setup`), 'the input description names no command');
});

// --- Rendering -----------------------------------------------------------

test('arguments: ["-y", "--prefix", "/", spec], --port only for another port, and nothing that needs escaping', () => {
  assert.deepEqual(bridgeArgs(), ARGS);
  assert.deepEqual(NPX_FLAGS, ['-y', '--prefix', '/']);
  assert.equal(NPX_COMMAND, `npx -y --prefix / ${PACKAGE_SPEC}`);
  assert.deepEqual(bridgeArgs({ port: DEFAULT_PORT }), ARGS);
  assert.deepEqual(bridgeArgs({ port: 51772 }), [...ARGS, '--port', '51772']);
  assert.deepEqual(bridgeArgs({ spec: PACKAGE_RANGE, port: 1024 }), ['-y', '--prefix', '/', PACKAGE_RANGE, '--port', '1024']);
  for (const argument of [...bridgeArgs({ port: 65535 }), PACKAGE_RANGE]) assert.doesNotMatch(argument, /["'\s\\$`]/);
  for (const port of [80, 1023, 65536, 51771.5, '51772', null]) assert.throws(() => bridgeArgs({ port }), RangeError, String(port));
  for (const spec of ['@wisply/mcp@0 --evil', '"@wisply/mcp"', "a'b", '$(id)', '`id`', 'a\\b', '~/x', '@wisply/mcp@^0', '', 7,
    '--registry', '-y']) {
    assert.throws(() => bridgeArgs({ spec }), TypeError, String(spec));
  }
  assert.equal(renderTemplate(`[${ARGS_LIST}] ${ARGS_CLI}`, ['-y', 'x@1']), '["-y", "x@1"] -y x@1');
  assert.throws(() => renderTemplate('{{token}}', ARGS), /unknown placeholder/);
});

test('every app and alternative renders completely, for the default and another port and spec', () => {
  for (const id of [...CLIENT_IDS, 'vscode-inputs']) {
    for (const options of [{}, { port: 51772 }, { spec: PACKAGE_RANGE }, { spec: `${PACKAGE_NAME}@0.1.0`, port: 60000 }]) {
      const rendered = render(id, options);
      assert.ok(rendered, id);
      assert.ok(!rendered.text.includes('{{'), `${id}: a placeholder is left`);
      const args = bridgeArgs(options);
      if (rendered.format === 'command') assert.ok(rendered.text.includes(args.join(' ')), id);
      else assert.ok(rendered.text.includes(args.map((argument) => `"${argument}"`).join(', ')), id);
      assert.equal(rendered.text.includes('--port'), options.port !== undefined && options.port !== DEFAULT_PORT, id);
      // npx never resolves the package from the folder the app starts it in.
      const spec = options.spec ?? PACKAGE_SPEC;
      const list = rendered.format === 'command' ? `-y --prefix / ${spec}` : `"-y", "--prefix", "/", "${spec}"`;
      assert.ok(rendered.text.includes(list), `${id}: --prefix / right before the package`);
    }
  }
  assert.equal(render('nope'), null);
  assert.equal(render(undefined), null);
  assert.equal(findClient('vscode-inputs').client.id, 'vscode');
});

/** The one server entry of a rendered JSON snippet, by the key the app uses. */
function jsonEntry(id, text) {
  const parsed = JSON.parse(text);
  const key = { vscode: 'servers', 'vscode-inputs': 'servers', zed: 'context_servers', opencode: 'mcp' }[id] ?? 'mcpServers';
  const keys = Object.keys(parsed).filter((name) => name !== '$schema' && name !== 'inputs');
  assert.deepEqual(keys, [key], id);
  assert.deepEqual(Object.keys(parsed[key]), [SERVER_KEY], id);
  return parsed[key][SERVER_KEY];
}

test('JSON and JSONC snippets parse and start npx with exactly the connector\'s arguments', () => {
  for (const port of [DEFAULT_PORT, 51772]) {
    const args = bridgeArgs({ port });
    for (const id of [...CLIENT_IDS, 'vscode-inputs']) {
      const rendered = render(id, { port });
      if (rendered.format !== 'json' && rendered.format !== 'jsonc') continue;
      const entry = jsonEntry(id, rendered.text);
      if (id === 'opencode') {
        assert.deepEqual(entry, { type: 'local', command: ['npx', ...args], enabled: true });
        continue;
      }
      assert.equal(entry.command, 'npx', id);
      assert.deepEqual(entry.args, args, id);
      for (const value of Object.values(entry.env ?? {})) assert.match(value, /^\$\{input:[a-z-]+\}$/, id);
    }
  }
  assert.deepEqual(jsonEntry('vscode', render('vscode').text), { type: 'stdio', command: 'npx', args: ARGS });
  assert.deepEqual(jsonEntry('zed', render('zed').text), { command: 'npx', args: ARGS, env: {} });
  assert.deepEqual(jsonEntry('copilot-cli', render('copilot-cli').text), { type: 'local', command: 'npx', args: ARGS, tools: ['*'] });
  assert.deepEqual(jsonEntry('cline', render('cline').text),
    { type: 'stdio', command: 'npx', args: ARGS, disabled: false, autoApprove: [] });
  assert.deepEqual(jsonEntry('cursor', render('cursor').text), FILE.standard_entry);
  assert.deepEqual(JSON.parse(render('opencode').text).$schema, 'https://opencode.ai/config.json');
});

test('TOML, YAML and command snippets', () => {
  const list = `"-y", "--prefix", "/", "${PACKAGE_SPEC}"`;
  const cli = `-y --prefix / ${PACKAGE_SPEC}`;
  assert.equal(render('codex').text, `[mcp_servers.wisply]\ncommand = "npx"\nargs = [${list}]`);
  assert.equal(render('goose').text,
    `extensions:\n  wisply:\n    name: Wisply\n    cmd: npx\n    args: [${list}]\n    enabled: true\n    type: stdio\n    timeout: 300`);
  assert.equal(render('claude-code').text, `claude mcp add --scope user wisply -- npx ${cli}`);
  assert.equal(render('gemini-cli').text, `gemini mcp add --scope user wisply npx -- ${cli}`);
  assert.equal(render('amp').text, `amp mcp add wisply -- npx ${cli}`);
  assert.equal(render('factory').text, `droid mcp add wisply "npx ${cli}"`);
  assert.equal(render('grok-cli').text, `grok mcp add wisply -- npx ${cli}`);
  assert.equal(`npx ${cli}`, NPX_COMMAND);
  // Gemini CLI reads a dash argument before -- as its own flag.
  const gemini = render('gemini-cli', { port: 51772 }).text.split(' ');
  assert.ok(gemini.indexOf('--') < gemini.indexOf('-y') && gemini.indexOf('--') < gemini.indexOf('--port'));
  assert.equal(gemini.indexOf('--'), gemini.indexOf('npx') + 1);
});

// --- install plans -------------------------------------------------------

test('install plans: fixed argv for apps with a command, never a shell', () => {
  const home = '/Users/someone';
  const plan = (id, options = {}) => installPlan(id, { home, env: {}, ...options });
  assert.deepEqual(plan('claude-code'), {
    kind: 'command', id: 'claude-code', file: 'claude', args: ['mcp', 'add', '--scope', 'user', 'wisply', '--', 'npx', ...ARGS],
    display: `claude mcp add --scope user wisply -- ${NPX_COMMAND}`, hint: null,
  });
  assert.deepEqual(plan('codex').args, ['mcp', 'add', 'wisply', '--', 'npx', ...ARGS]);
  assert.equal(plan('codex').file, 'codex');
  const gemini = plan('gemini-cli', { port: 51772 });
  assert.equal(gemini.file, 'gemini');
  assert.deepEqual(gemini.args, ['mcp', 'add', '--scope', 'user', 'wisply', 'npx', '--', ...ARGS, '--port', '51772']);
  assert.ok(gemini.args.indexOf('--') < gemini.args.indexOf('-y'));
  const vscode = plan('vscode');
  assert.equal(vscode.file, 'code');
  assert.equal(vscode.args.length, 2);
  assert.equal(vscode.args[0], '--add-mcp');
  assert.deepEqual(JSON.parse(vscode.args[1]), { name: 'wisply', type: 'stdio', command: 'npx', args: ARGS });
  assert.equal(vscode.args[1], `{"name":"wisply","type":"stdio","command":"npx","args":["-y","--prefix","/","${PACKAGE_SPEC}"]}`);
  assert.equal(vscode.display, `code --add-mcp '${vscode.args[1]}'`);
  assert.match(vscode.hint, /Shell Command: Install 'code' command in PATH/);
  // An install command is the printed command, word for word, and splits cleanly.
  for (const client of FILE.clients.filter((entry) => entry.install?.type === 'command')) {
    assert.doesNotMatch(client.install.command, /["'\\$`]| {2}|^ | $/, client.id);
    if (client.format === 'command') assert.equal(client.install.command, client.stdio, client.id);
    const { file, args, display } = plan(client.id, { port: 51772 });
    assert.deepEqual(display.split(' '), [file, ...args], client.id);
    assert.ok(args.every((argument) => argument !== ''), client.id);
  }
  assert.equal(plan('claude-code').display, render('claude-code').text);
  assert.equal(plan('gemini-cli').display, render('gemini-cli').text);
});

test('install plans: JSON apps get exactly the printed entry, at their own path', () => {
  const home = '/Users/someone';
  const plan = (id, env = {}) => installPlan(id, { home, env });
  const expected = {
    cursor: ['/Users/someone/.cursor/mcp.json', 'Cursor'],
    windsurf: ['/Users/someone/.codeium/windsurf/mcp_config.json', 'Windsurf'],
    'claude-desktop': ['/Users/someone/Library/Application Support/Claude/claude_desktop_config.json', 'Claude Desktop'],
    cline: ['/Users/someone/.cline/data/settings/cline_mcp_settings.json', 'Cline'],
    'copilot-cli': ['/Users/someone/.copilot/mcp-config.json', 'GitHub Copilot CLI'],
  };
  for (const [id, [path, target]] of Object.entries(expected)) {
    const result = plan(id);
    assert.deepEqual(result, {
      kind: 'json-file', id, target, path, pathFrom: null, key: 'mcpServers', name: 'wisply', entry: jsonEntry(id, render(id).text),
      hint: id === 'cline' ? FILE.clients.find((client) => client.id === 'cline').install.hint : null,
    }, id);
  }
  // Cline 4.0 and later: the extension, the CLI and the JetBrains plugin share one file, so install sets up "Cline".
  assert.equal(plan('cline').hint, 'Cline 4.0 and later read this one file from the extension, the CLI and the JetBrains plugin.');
  assert.equal(render('cline').installTarget, 'Cline');
  assert.equal(render('cline').note, 'Cline 4.0 and later keep one MCP settings file for the extension, the CLI and the ' +
    'JetBrains plugin: ~/.cline/data/settings/cline_mcp_settings.json.');
  assert.doesNotMatch(JSON.stringify(FILE.clients.find((client) => client.id === 'cline')), /Cline CLI|keeps its own list/);
  assert.equal(render('cursor').installTarget, 'Cursor');
  assert.equal(render('zed').installTarget, null);
  assert.match(messages.printConfigHint(render('cline')), /install cline` add it for you\./);
  assert.match(messages.printConfigHint(render('cursor')), /install cursor` add it for you\./);
  // The apps' own override variables, in the order the app reads them. Cline (getSharedMcpSettingsPath):
  // CLINE_MCP_SETTINGS_PATH, then CLINE_DATA_DIR + settings/, then CLINE_DIR + data/settings/.
  const clineFile = 'cline_mcp_settings.json';
  assert.deepEqual(plan('cline', { CLINE_MCP_SETTINGS_PATH: '/tmp/cline.json' }), {
    ...plan('cline'), path: '/tmp/cline.json', pathFrom: 'CLINE_MCP_SETTINGS_PATH',
  });
  assert.equal(plan('cline', { CLINE_DATA_DIR: '/d' }).path, `/d/settings/${clineFile}`);
  assert.equal(plan('cline', { CLINE_DATA_DIR: '/d' }).pathFrom, 'CLINE_DATA_DIR');
  assert.equal(plan('cline', { CLINE_DIR: '/c/' }).path, `/c/data/settings/${clineFile}`);
  assert.equal(plan('cline', { CLINE_DIR: '/c', CLINE_DATA_DIR: '/d' }).path, `/d/settings/${clineFile}`);
  assert.equal(plan('cline', { CLINE_DIR: '/c', CLINE_DATA_DIR: '/d', CLINE_MCP_SETTINGS_PATH: ' /f.json ' }).path, '/f.json');
  assert.equal(plan('cline', { CLINE_MCP_SETTINGS_PATH: '  ', CLINE_DATA_DIR: '', CLINE_DIR: '\t' }).path, expected.cline[0]);
  assert.equal(plan('copilot-cli', { COPILOT_HOME: '/opt/copilot' }).path, '/opt/copilot/mcp-config.json');
  assert.equal(plan('copilot-cli', { COPILOT_HOME: '/opt/copilot' }).pathFrom, 'COPILOT_HOME');
  assert.equal(plan('cursor', { COPILOT_HOME: '/opt/copilot', CLINE_MCP_SETTINGS_PATH: '/x', CLINE_DIR: '/c' }).path,
    expected.cursor[0]);
  // A value that isn't a full path is resolved by the app against a folder install can't know (Cline doesn't
  // expand ~ either), and install never acts on the folder it runs in: no file, the snippet instead.
  for (const [id, variable, value] of [['cline', 'CLINE_MCP_SETTINGS_PATH', 'cline.json'], ['cline', 'CLINE_MCP_SETTINGS_PATH', '~/c.json'],
    ['cline', 'CLINE_DATA_DIR', './data'], ['cline', 'CLINE_DIR', '~'], ['copilot-cli', 'COPILOT_HOME', 'project/.copilot']]) {
    const result = plan(id, { [variable]: value });
    assert.deepEqual(result, { kind: 'not-full-path', id, target: expected[id][1], variable, hint: plan(id).hint }, `${variable}=${value}`);
  }
  // The first variable that is set decides, as in the app: a relative one isn't skipped for a later one.
  assert.equal(plan('cline', { CLINE_DATA_DIR: 'rel', CLINE_DIR: '/c' }).variable, 'CLINE_DATA_DIR');
  assert.deepEqual(installPath({ path: '~/x.json' }, {}, '/h'), { path: '/h/x.json', from: null });
  // Everything else is pasted by hand.
  for (const id of CLIENT_IDS.filter((entry) => !Object.hasOwn(INSTALLS, entry))) assert.deepEqual(plan(id), { kind: 'manual', id });
  assert.deepEqual(plan('vscode-inputs'), { kind: 'manual', id: 'vscode-inputs' });
  assert.equal(plan('nope'), null);
});

// --- mergeEntry ----------------------------------------------------------

const ENTRY = { command: 'npx', args: ARGS };
const change = { key: 'mcpServers', name: 'wisply', entry: ENTRY };

/** The entry as install writes it inside an object whose members sit at `indent`. */
const laidOut = (value, indent, unit = '  ', eol = '\n') => JSON.stringify(value, null, unit).split('\n').join(`${eol}${indent}`);

test('mergeEntry changes only the wisply entry\'s text; every other byte of the file stays', () => {
  const fresh = `${JSON.stringify({ mcpServers: { wisply: ENTRY } }, null, 2)}\n`;
  assert.deepEqual(mergeEntry(null, change),
    { ok: true, text: fresh, unchanged: false, replaced: false, replacedHeldToken: false, kept: [], dropped: [] });
  assert.equal(mergeEntry(' \n', change).text, fresh);
  assert.equal(mergeEntry('{\n}\n', change).text, fresh);

  // A file laid out by JSON.stringify keeps that layout exactly (2 or 4 spaces, tabs; no newline added).
  const original = { theme: 'dark', mcpServers: { other: { command: 'other-mcp', env: { KEY: 'v' } }, wisply: { url: 'http://x' } }, last: [1, 2] };
  const after = { ...original, mcpServers: { ...original.mcpServers, wisply: ENTRY } };
  for (const indent of [2, 4, '\t']) {
    const merged = mergeEntry(JSON.stringify(original, null, indent), change);
    assert.deepEqual({ ...merged, text: undefined },
      { ok: true, text: undefined, unchanged: false, replaced: true, replacedHeldToken: false, kept: [], dropped: ['url'] });
    assert.equal(merged.text, JSON.stringify(after, null, indent), String(indent));
  }

  // Around the entry nothing is rewritten: compact arrays, escapes, number spellings, big integers, CRLF line ends.
  const odd = '{\r\n  "big": 12345678901234567890,\r\n  "s": "\\u2028 \\/ \\u00e9",\r\n  "a": [1,2,3],\r\n  "f": 1.0,\r\n' +
    '  "e": 1E5,\r\n  "mcpServers": {\r\n    "other": {"command": "x", "args": ["a","b"]},\r\n' +
    '    "wisply": {"url": "http://127.0.0.1:51771/mcp"}\r\n  },\r\n  "tail": [ ]\r\n}\r\n';
  const merged = mergeEntry(odd, change);
  assert.equal(merged.ok, true);
  assert.equal(merged.text, odd.replace('{"url": "http://127.0.0.1:51771/mcp"}', laidOut(ENTRY, '    ', '  ', '\r\n')));
  assert.ok(merged.text.includes('"big": 12345678901234567890,') && merged.text.includes('"a": [1,2,3]') && merged.text.includes('"f": 1.0'));
  assert.ok(merged.text.includes('"s": "\\u2028 \\/ \\u00e9"'));

  // A new entry goes last in its object, laid out like its neighbours.
  const neighbour = '{\n  "mcpServers": {\n    "other": { "command": "x" }\n  },\n  "n": 1\n}\n';
  assert.equal(mergeEntry(neighbour, change).text,
    `{\n  "mcpServers": {\n    "other": { "command": "x" },\n    "wisply": ${laidOut(ENTRY, '    ')}\n  },\n  "n": 1\n}\n`);
  const noKey = '{\n\t"theme": "dark"\n}\n';
  assert.equal(mergeEntry(noKey, change).text,
    `{\n\t"theme": "dark",\n\t"mcpServers": ${laidOut({ wisply: ENTRY }, '\t', '\t')}\n}\n`);
  const empty = '{\n    "mcpServers": {},\n    "x": 1\n}';
  assert.equal(mergeEntry(empty, change).text, `{\n    "mcpServers": {\n        "wisply": ${laidOut(ENTRY, '        ', '    ')}\n    },\n    "x": 1\n}`);
  // One-line files stay on one line.
  const compact = JSON.stringify(ENTRY);
  assert.equal(mergeEntry('{"mcpServers": {}}', change).text, `{"mcpServers": {"wisply": ${compact}}}`);
  assert.equal(mergeEntry('{"mcpServers": {"a": 1}}', change).text, `{"mcpServers": {"a": 1, "wisply": ${compact}}}`);
  assert.equal(mergeEntry('{"a":[1,2]}', change).text, `{"a":[1,2], "mcpServers": {"wisply":${compact}}}`);
  assert.equal(mergeEntry('{}', change).text, `{"mcpServers": {"wisply":${compact}}}`);
  // Values of every kind before the entry are skipped correctly.
  const kinds = '{"x": [[[{"a": [1, {"b": null}]}]], true, false, -1.5e-3, "q\\"u}o]te", {}, []], "mcpServers": {"y": "\\\\"}}';
  assert.equal(mergeEntry(kinds, change).text, kinds.replace('"\\\\"}}', `"\\\\", "wisply": ${compact}}}`));

  const bom = mergeEntry(`\uFEFF${JSON.stringify({ mcpServers: {} })}`, change);
  assert.equal(bom.text, `\uFEFF{"mcpServers":{"wisply": ${compact}}}`);

  const same = `${JSON.stringify({ mcpServers: { wisply: ENTRY } }, null, 2)}\n`;
  assert.deepEqual(mergeEntry(same, change),
    { ok: true, text: same, unchanged: true, replaced: false, replacedHeldToken: false, kept: [], dropped: [] });
  // The same entry in another key order is the same entry.
  const reordered = JSON.stringify({ mcpServers: { wisply: { args: ARGS, command: 'npx' } } });
  assert.equal(mergeEntry(reordered, change).unchanged, true);
  assert.equal(mergeEntry(reordered, change).text, reordered);

  const withToken = JSON.stringify({ mcpServers: { wisply: { url: 'http://127.0.0.1:51771/mcp', headers: { Authorization: `Bearer ${OLD_TOKEN}` } } } });
  const replaced = mergeEntry(withToken, change);
  assert.equal(replaced.replacedHeldToken, true);
  assert.doesNotMatch(replaced.text, TOKEN_SHAPE);
  // Another server's value is not install's to change, token or not.
  const other = JSON.stringify({ mcpServers: { other: { env: { T: OLD_TOKEN } } } });
  assert.equal(mergeEntry(other, change).replacedHeldToken, false);
  assert.ok(mergeEntry(other, change).text.startsWith(other.slice(0, -2)));
});

test('mergeEntry keeps what the app or the person set on the old entry, and names what it drops', () => {
  const cline = { type: 'stdio', command: 'npx', args: ARGS, disabled: false, autoApprove: [] };
  const clineChange = { key: 'mcpServers', name: 'wisply', entry: cline, keep: KEPT_FIELDS };
  // Cline wrote its own approvals and a timeout; the person turned the server off. Install again: nothing to do.
  const approved = JSON.stringify({ mcpServers: { wisply: { ...cline, autoApprove: ['list_memos'], disabled: true, timeout: 120 } } }, null, 2);
  const again = mergeEntry(approved, clineChange);
  assert.deepEqual({ ...again, text: undefined }, {
    ok: true, text: undefined, unchanged: true, replaced: false, replacedHeldToken: false, kept: ['autoApprove', 'disabled', 'timeout'], dropped: [],
  });
  assert.equal(again.text, approved);
  // An old entry of another version: the command and arguments change; the approvals and the switch stay.
  const older = JSON.stringify({
    mcpServers: { wisply: { autoApprove: ['get_action_items'], command: 'npx', args: ['-y', '@wisply/mcp@0.0.9'], timeout: 60, env: { A: '1' } } },
  }, null, 2);
  const updated = mergeEntry(older, clineChange);
  assert.equal(updated.replaced, true);
  assert.deepEqual(updated.kept, ['autoApprove', 'timeout']);
  assert.deepEqual(updated.dropped, ['env']);
  assert.deepEqual(JSON.parse(updated.text).mcpServers.wisply,
    { type: 'stdio', command: 'npx', args: ARGS, disabled: false, autoApprove: ['get_action_items'], timeout: 60 });
  // Copilot CLI's narrowed tools stay.
  const copilot = { type: 'local', command: 'npx', args: ARGS, tools: ['*'] };
  const narrowed = JSON.stringify({ mcpServers: { wisply: { ...copilot, args: ['-y', 'old'], tools: ['list_memos'] } } });
  assert.deepEqual(JSON.parse(mergeEntry(narrowed, { key: 'mcpServers', name: 'wisply', entry: copilot, keep: KEPT_FIELDS }).text)
    .mcpServers.wisply.tools, ['list_memos']);
  // A field that holds something token-shaped never stays; the old direct-HTTP entry goes entirely.
  const leaky = JSON.stringify({ mcpServers: { wisply: { url: 'http://127.0.0.1:51771/mcp', headers: { Authorization: `Bearer ${OLD_TOKEN}` },
    timeout: `${OLD_TOKEN}` } } });
  const cleaned = mergeEntry(leaky, clineChange);
  assert.deepEqual(cleaned.kept, []);
  assert.deepEqual(cleaned.dropped, ['url', 'headers', 'timeout']);
  assert.equal(cleaned.replacedHeldToken, true);
  assert.doesNotMatch(cleaned.text, TOKEN_SHAPE);
  // Without `keep` (the default), the template replaces the old entry whole.
  assert.deepEqual(JSON.parse(mergeEntry(older, { ...clineChange, keep: undefined }).text).mcpServers.wisply, cline);
  // A field named __proto__ is only ever reported, never copied.
  const proto = '{"mcpServers": {"wisply": {"__proto__": {"polluted": true}, "command": "x"}}}';
  const safe = mergeEntry(proto, clineChange);
  assert.deepEqual(safe.dropped, ['__proto__']);
  assert.equal({}.polluted, undefined);
  assert.deepEqual(JSON.parse(safe.text).mcpServers.wisply, cline);
  // The messages name kept and dropped fields, never anything token-like.
  assert.equal(messages.installUnchanged('Cline', '/x', ['autoApprove', 'disabled']),
    'Cline already has this Wisply entry in /x (with your own autoApprove, disabled). Nothing changed.');
  const text = messages.installedFile('Cline', { path: '/x', replaced: true, kept: ['timeout'], dropped: ['env', OLD_TOKEN, 'a b'] });
  assert.match(text, /Kept from the old entry: timeout\.\nNot carried over from the old entry: env, 2 more\./);
  assert.doesNotMatch(text, TOKEN_SHAPE);
});

test('mergeEntry: random files and layouts read back as exactly the change', () => {
  let seed = 7;
  const random = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const value = (depth) => {
    const kind = random(depth > 2 ? 4 : 6);
    if (kind === 0) return random(1000) - 500;
    if (kind === 1) return ['a', 'b"c', '\u2028', 'd\\e', ''][random(5)];
    if (kind === 2) return [true, false, null][random(3)];
    if (kind === 3) return random(2) ? 1.5 : 1e21;
    if (kind === 4) return Array.from({ length: random(3) }, () => value(depth + 1));
    return Object.fromEntries(Array.from({ length: random(3) }, (_, i) => [`k${i}`, value(depth + 1)]));
  };
  for (let round = 0; round < 300; round += 1) {
    const config = Object.fromEntries(Array.from({ length: random(4) }, (_, i) => [`top${i}`, value(0)]));
    if (random(3) > 0) {
      config.mcpServers = Object.fromEntries(Array.from({ length: random(3) }, (_, i) => [`s${i}`, value(1)]));
      if (random(2)) config.mcpServers.wisply = value(1);
    }
    const text = JSON.stringify(config, null, [0, 2, 4, '\t'][random(4)]) + ['', '\n'][random(2)];
    const merged = mergeEntry(text, change);
    assert.equal(merged.ok, true, text);
    const expected = JSON.parse(text);
    expected.mcpServers = { ...(expected.mcpServers ?? {}) };
    expected.mcpServers.wisply = ENTRY;
    assert.equal(JSON.stringify(JSON.parse(merged.text)), JSON.stringify(expected), text);
    // What comes before the mcpServers object never changes.
    const at = text.indexOf('"mcpServers"');
    if (at >= 0) assert.equal(merged.text.slice(0, at), text.slice(0, at));
  }
});

test('mergeEntry refuses what isn\'t plain JSON of the right shape, or a key it needs twice', () => {
  for (const text of ['// Zed settings\n{ "theme": "One" }', '{ "a": 1, }', '{', 'nul', '{"mcpServers": {"x": 1}} trailing']) {
    assert.deepEqual(mergeEntry(text, change), { ok: false, reason: 'invalid-json' }, text);
  }
  for (const text of ['[]', '"text"', '3', 'null', '{"mcpServers": []}', '{"mcpServers": "x"}', '{"mcpServers": null}']) {
    assert.deepEqual(mergeEntry(text, change), { ok: false, reason: 'not-object' }, text);
  }
  // A reader that keeps the first copy of a key would see something else than install wrote.
  for (const text of ['{"mcpServers": {}, "mcpServers": {}}', '{"mcpServers": {"wisply": 1, "wisply": 2}}']) {
    assert.deepEqual(mergeEntry(text, change), { ok: false, reason: 'not-plain' }, text);
  }
});

// --- runCli: print-config ------------------------------------------------

/** The apps' own commands, as executable stubs in a PATH folder of their own (never run: execFile is a spy). */
const PROGRAMS = ['claude', 'codex', 'gemini', 'code'];

/**
 * runCli's dependencies with a temporary HOME, an execFile spy and a Keychain that must stay untouched;
 * print-config and install work as after the release unless `released: false`.
 */
function harness({
  platform = 'darwin', env = {}, exec = () => ({ error: null, stdout: '', stderr: '' }), programs = PROGRAMS, released = true,
} = {}) {
  const home = mkdtempSync(join(tmpdir(), 'wisply-clients-'));
  const bin = mkdtempSync(join(tmpdir(), 'wisply-bin-'));
  for (const program of programs) {
    writeFileSync(join(bin, program), '#!/bin/sh\nexit 0\n');
    chmodSync(join(bin, program), 0o755);
  }
  const out = [];
  const err = [];
  const runs = [];
  const touched = [];
  const deps = {
    platform,
    released,
    env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, LANG: 'en_US.UTF-8', WISPLY_MCP_TOKEN: ENV_TOKEN, ...env },
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    execFile: (file, args, options, callback) => {
      runs.push({ file, args, options });
      const result = exec(file, args, options);
      setImmediate(() => callback(result.error, result.stdout, result.stderr));
      return {};
    },
    readKeychain: async () => { touched.push('readKeychain'); return KEYCHAIN_TOKEN; },
    writeKeychain: async () => { touched.push('writeKeychain'); return 'written'; },
    deleteKeychain: async () => { touched.push('deleteKeychain'); return 'deleted'; },
    resolveToken: async () => { touched.push('resolveToken'); return { token: KEYCHAIN_TOKEN, source: 'keychain', problem: null, placeholderIgnored: false }; },
    createLoopback: () => { touched.push('createLoopback'); return {}; },
  };
  return {
    home, bin, deps, runs, touched,
    get out() { return out.join(''); },
    get err() { return err.join(''); },
    cleanup: () => {
      rmSync(home, { recursive: true, force: true });
      rmSync(bin, { recursive: true, force: true });
    },
  };
}

/** Every file under a folder, with its contents. */
function filesUnder(root) {
  const found = {};
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const info = lstatSync(path);
      if (info.isDirectory()) walk(path);
      else if (info.isFile()) found[path.slice(root.length + 1)] = readFileSync(path, 'utf8');
    }
  };
  walk(root);
  return found;
}

test('print-config: the snippet alone on stdout, where it goes on stderr', async (t) => {
  for (const id of [...CLIENT_IDS, 'vscode-inputs']) {
    const h = harness();
    t.after(h.cleanup);
    assert.equal(await runCli(['print-config', id], h.deps), 0, id);
    assert.equal(h.out, `${render(id).text}\n`, id);
    assert.equal(h.err, messages.printConfigHint(render(id)), id);
    assert.match(h.err, /Docs: https:\/\//);
    assert.doesNotMatch(h.out + h.err, TOKEN_SHAPE);
    assert.equal(h.err.search(/[^\x00-\x7f]/), -1, `${id}: ASCII`);
    assert.deepEqual(h.runs, []);
    assert.deepEqual(h.touched, [], `${id}: print-config reads no token`);
  }
  const custom = harness();
  t.after(custom.cleanup);
  assert.equal(await runCli(['print-config', 'Cursor', '--port', '51772'], custom.deps), 0);
  assert.equal(custom.out, `${render('cursor', { port: 51772 }).text}\n`);
  // Only --port changes the port: a WISPLY_MCP_PORT in the shell (a test Wisply's) never ends up in an app's
  // settings unasked. stderr says it was ignored, without echoing it.
  const fromEnv = harness({ env: { WISPLY_MCP_PORT: '51773' } });
  t.after(fromEnv.cleanup);
  assert.equal(await runCli(['print-config', '--port=51772', 'codex'], fromEnv.deps), 0);
  assert.match(fromEnv.out, /"--port", "51772"/);
  assert.ok(fromEnv.err.startsWith(`${messages.envPortIgnored(51772)}\n`));
  for (const value of ['51773', 'eighty', ENV_TOKEN]) {
    const envPort = harness({ env: { WISPLY_MCP_PORT: value } });
    t.after(envPort.cleanup);
    assert.equal(await runCli(['print-config', 'codex'], envPort.deps), 0, value);
    assert.equal(envPort.out, `${render('codex').text}\n`, value);
    assert.equal(envPort.err, `${messages.envPortIgnored(DEFAULT_PORT)}\n${messages.printConfigHint(render('codex'))}`, value);
    assert.doesNotMatch(envPort.err, TOKEN_SHAPE);
  }
  // The same port, or a blank one, needs no note.
  for (const value of [String(DEFAULT_PORT), ' ']) {
    const same = harness({ env: { WISPLY_MCP_PORT: value } });
    t.after(same.cleanup);
    assert.equal(await runCli(['print-config', 'codex'], same.deps), 0);
    assert.equal(same.err, messages.printConfigHint(render('codex')));
  }
  for (const command of ['print-config', 'install']) {
    assert.equal(parseCliArgs([command, 'cursor'], { WISPLY_MCP_PORT: '51773' }).options.port, DEFAULT_PORT, command);
    assert.equal(parseCliArgs([command, 'cursor'], { WISPLY_MCP_PORT: 'eighty' }).options.port, DEFAULT_PORT, command);
    assert.equal(parseCliArgs([command, 'cursor', '--port', '51774'], { WISPLY_MCP_PORT: '51773' }).options.port, 51774, command);
  }
  // setup and status still take it, as serving does.
  assert.equal(parseCliArgs(['status'], { WISPLY_MCP_PORT: '51773' }).options.port, 51773);
  assert.equal(parseCliArgs(['setup'], { WISPLY_MCP_PORT: '51773' }).options.port, 51773);
  // Off macOS too: printing is harmless.
  const linux = harness({ platform: 'linux' });
  t.after(linux.cleanup);
  assert.equal(await runCli(['print-config', 'zed'], linux.deps), 0);
  assert.equal(linux.out, `${render('zed').text}\n`);
});

test('print-config: with no app, the list; unknown apps and stray arguments exit 2', async (t) => {
  const list = harness();
  t.after(list.cleanup);
  assert.equal(await runCli(['print-config'], list.deps), 0);
  for (const id of CLIENT_IDS) assert.match(list.out, new RegExp(`^  ${id} +`, 'm'));
  for (const id of Object.keys(INSTALLS)) assert.match(list.out, new RegExp(`^  ${id} +.* \\*$`, 'm'), id);
  assert.match(list.out, /^ {2}warp +Warp$/m);
  assert.match(list.out, /^ {2}zed +Zed$/m, 'Zed has no install: its settings file is JSONC');
  assert.equal(list.err, '');

  const refused = [
    ['print-config', 'nope'], ['print-config', 'cursor', 'zed'], ['print-config', 'cursor', '--full-access'],
    ['print-config', 'cursor', '--port', '80'], ['print-config', 'cursor', '--read-only'], ['install'], ['install', 'nope'],
    ['install', 'cursor', 'extra'], ['install', 'cursor', '--with-token'], ['install', '--port', '51772'],
  ];
  for (const argv of refused) {
    const h = harness();
    t.after(h.cleanup);
    assert.equal(await runCli(argv, h.deps), 2, argv.join(' '));
    assert.equal(h.out, '');
    assert.match(h.err, /^wisply-mcp: .*\n$/);
    assert.deepEqual(h.runs, []);
    assert.deepEqual(filesUnder(h.home), {});
  }
  const unknown = harness();
  t.after(unknown.cleanup);
  await runCli(['install', 'nope'], unknown.deps);
  assert.equal(unknown.err, `${messages.unknownApp('nope', CLIENT_IDS)}\n`);
  const missing = harness();
  t.after(missing.cleanup);
  await runCli(['install'], missing.deps);
  assert.equal(missing.err, `${messages.missingApp('install', CLIENT_IDS)}\n`);
  assert.deepEqual(parseCliArgs(['install', 'VSCode'], {}).options.app, 'vscode');
  assert.deepEqual(parseCliArgs(['print-config', 'cursor', '--port=51772'], {}), {
    options: { command: 'print-config', port: 51772, fullAccess: false, readOnly: false, allowClaudeSetup: false, app: 'cursor' },
  });
  assert.ok(CLI_COMMANDS.includes('print-config') && CLI_COMMANDS.includes('install'));
});

// --- runCli: install with the app's own command --------------------------

test('install: claude, codex and gemini get a fixed argv, by absolute path, without the token in argv or the environment', async (t) => {
  for (const [id, file] of [['claude-code', 'claude'], ['codex', 'codex'], ['gemini-cli', 'gemini']]) {
    const h = harness({
      env: { OTHER_SECRET_HOLDER: `x ${KEYCHAIN_TOKEN} y`, CLAUDE_CONFIG_DIR: '/tmp/claude-config' },
      exec: () => ({ error: null, stdout: `Added stdio MCP server wisply ${OLD_TOKEN}\n`, stderr: '' }),
    });
    t.after(h.cleanup);
    assert.equal(await runCli(['install', id], h.deps), 0, id);
    assert.equal(h.runs.length, 1);
    const [run] = h.runs;
    assert.equal(run.file, join(h.bin, file), `${id}: the program found in PATH, by its absolute path`);
    assert.deepEqual(run.args, installPlan(id, { home: h.home }).args);
    assert.equal(run.options.shell, undefined, 'no shell');
    assert.ok(Number.isInteger(run.options.timeout) && run.options.timeout > 0);
    assert.equal(Object.hasOwn(run.options.env, 'WISPLY_MCP_TOKEN'), false);
    assert.equal(Object.hasOwn(run.options.env, 'OTHER_SECRET_HOLDER'), false);
    assert.equal(run.options.env.CLAUDE_CONFIG_DIR, '/tmp/claude-config');
    assert.equal(run.options.env.HOME, h.home);
    assert.equal(run.options.env.PATH, `${h.bin}:/usr/bin:/bin`);
    for (const value of [run.file, ...run.args, ...Object.values(run.options.env)]) assert.doesNotMatch(value, TOKEN_SHAPE);
    assert.deepEqual(h.touched, [], `${id}: install never reads a token`);
    assert.deepEqual(filesUnder(h.home), {}, `${id}: install writes no file itself`);
    // The app's own output is passed on, with anything token-shaped masked.
    assert.ok(h.out.includes('Added stdio MCP server wisply wsp...'));
    assert.doesNotMatch(h.out + h.err, TOKEN_SHAPE);
    const { display } = installPlan(id, { home: h.home });
    assert.ok(h.out.startsWith(`${messages.installRunning(`${join(h.bin, file)}${display.slice(file.length)}`)}\n`));
    assert.ok(h.out.endsWith(`${messages.installedByCommand(render(id).name)}\n${messages.installNextSteps(render(id).name)}\n`));
  }
  assert.deepEqual(commandEnv({ A: '1', WISPLY_MCP_TOKEN: '', B: ENV_TOKEN, C: undefined, WISPLY_MCP_PORT: '51772' }),
    { A: '1', WISPLY_MCP_PORT: '51772' });
});

test('install finds programs only in PATH\'s absolute folders, and the child gets only those', async (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'wisply-path-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  writeFileSync(join(folder, 'claude'), '#!/bin/sh\n');
  chmodSync(join(folder, 'claude'), 0o755);
  writeFileSync(join(folder, 'codex'), 'not executable');
  mkdirSync(join(folder, 'gemini'));
  const fromHere = relative(process.cwd(), folder);
  assert.ok(!fromHere.startsWith('/'));
  assert.equal(await findProgram('claude', { PATH: folder }), join(folder, 'claude'));
  assert.equal(await findProgram('claude', { PATH: `/nonexistent:${folder}` }), join(folder, 'claude'));
  // A relative or empty entry finds programs in whatever folder install runs in: never used.
  assert.equal(await findProgram('claude', { PATH: fromHere }), null);
  assert.equal(await findProgram('claude', { PATH: `.:${fromHere}::` }), null);
  assert.equal(await findProgram('codex', { PATH: folder }), null, 'not executable');
  assert.equal(await findProgram('gemini', { PATH: folder }), null, 'a folder');
  assert.equal(await findProgram('../claude', { PATH: join(folder, 'x') }), null, 'a bare name only');
  assert.equal(await findProgram('claude', {}), null);
  assert.deepEqual(absolutePathFolders(`.:${folder}::bin:/usr/bin:`), [folder, '/usr/bin']);
  assert.equal(commandEnv({ PATH: `.:${folder}::bin:/usr/bin:` }).PATH, `${folder}:/usr/bin`);

  // install itself: a program only a relative entry would find counts as missing.
  const h = harness({ programs: [] });
  t.after(h.cleanup);
  h.deps.env.PATH = `.:${fromHere}:/usr/bin`;
  assert.equal(await runCli(['install', 'claude-code'], h.deps), 1);
  assert.deepEqual(h.runs, []);
  const { display } = installPlan('claude-code', { home: h.home });
  assert.equal(h.out, `${messages.programMissing('claude', 'Claude Code', null, display)}\n`);
});

test('install vscode runs code --add-mcp and never edits mcp.json', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  mkdirSync(join(h.home, 'Library/Application Support/Code/User'), { recursive: true });
  assert.equal(await runCli(['install', 'vscode', '--port', '51772'], h.deps), 0);
  assert.equal(h.runs.length, 1);
  assert.equal(h.runs[0].file, join(h.bin, 'code'));
  assert.equal(h.runs[0].args[0], '--add-mcp');
  assert.deepEqual(JSON.parse(h.runs[0].args[1]), { name: 'wisply', type: 'stdio', command: 'npx', args: [...ARGS, '--port', '51772'] });
  assert.deepEqual(filesUnder(h.home), {});
  assert.deepEqual(h.touched, []);
});

test('install: a missing or failing command changes nothing and says what to do', async (t) => {
  const missing = harness({ programs: ['claude'] });
  t.after(missing.cleanup);
  assert.equal(await runCli(['install', 'vscode'], missing.deps), 1);
  const plan = installPlan('vscode', {});
  assert.equal(missing.out, `${messages.programMissing('code', 'VS Code', plan.hint, plan.display)}\n`);
  assert.match(missing.out, /Shell Command: Install 'code' command in PATH/);
  assert.ok(missing.out.endsWith(`${plan.display}\n`), 'the command to run by hand');
  assert.deepEqual(missing.runs, []);

  // Found, but gone by the time it runs.
  const vanished = harness({ exec: () => ({ error: Object.assign(new Error('spawn code ENOENT'), { code: 'ENOENT' }), stdout: '', stderr: '' }) });
  t.after(vanished.cleanup);
  assert.equal(await runCli(['install', 'vscode'], vanished.deps), 1);
  assert.ok(vanished.out.endsWith(`${messages.programMissing('code', 'VS Code', plan.hint, plan.display)}\n`));

  // `claude mcp add` refuses a name it has (claude 2.1: exit 1, "MCP server wisply already exists in user
  // config"). install can't tell whether that entry is this one, so it exits 1 and says how to replace it.
  const exists = harness({
    exec: () => ({ error: Object.assign(new Error('exit 1'), { code: 1 }), stdout: '', stderr: 'MCP server wisply already exists in user config\n' }),
  });
  t.after(exists.cleanup);
  assert.equal(await runCli(['install', 'claude-code'], exists.deps), 1);
  assert.equal(exists.err, 'MCP server wisply already exists in user config\n');
  assert.ok(exists.out.endsWith(`${messages.commandEntryExists('claude', 'Claude Code', true)}\n`));
  assert.equal(messages.commandEntryExists('claude', 'Claude Code', true), 'Claude Code already has a server named wisply, so ' +
    'nothing changed. If install added it before, Wisply is already set up there. To replace it, run `claude mcp remove wisply`, ' +
    'then run install again.');
  // code --add-mcp has no `code mcp remove`.
  const codeExists = harness({ exec: () => ({ error: Object.assign(new Error('exit 1'), { code: 1 }), stdout: 'Server already exists\n', stderr: '' }) });
  t.after(codeExists.cleanup);
  assert.equal(await runCli(['install', 'vscode'], codeExists.deps), 1);
  assert.ok(codeExists.out.endsWith(`${messages.commandEntryExists('code', 'VS Code', false)}\n`));
  assert.match(messages.commandEntryExists('code', 'VS Code', false), /To replace it, remove it in VS Code, then run install again\.$/);
  const failing = harness({
    exec: () => ({ error: Object.assign(new Error('exit 1'), { code: 1 }), stdout: '', stderr: 'error: unknown option --scope\n' }),
  });
  t.after(failing.cleanup);
  assert.equal(await runCli(['install', 'claude-code'], failing.deps), 1);
  assert.equal(failing.err, 'error: unknown option --scope\n');
  assert.ok(failing.out.endsWith(`${messages.programFailed('claude', 'Claude Code', { code: 1 })}\n`));
  assert.match(messages.programFailed('claude', 'Claude Code', { code: 1 }), /^claude failed \(exit 1\)/);
  assert.match(messages.programFailed('codex', 'Codex', { signal: 'SIGTERM', timedOut: true }), /^codex didn't finish in time/);
  assert.match(messages.programFailed('codex', 'Codex', { signal: 'SIGKILL' }), /^codex stopped \(SIGKILL\)/);

  const thrown = harness();
  t.after(thrown.cleanup);
  thrown.deps.execFile = () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); };
  assert.equal(await runCli(['install', 'codex'], thrown.deps), 1);
  assert.match(thrown.out, /codex couldn't run/);

  const lookupFails = harness();
  t.after(lookupFails.cleanup);
  lookupFails.deps.findProgram = async () => { throw new Error('EIO'); };
  assert.equal(await runCli(['install', 'codex'], lookupFails.deps), 1);
  assert.deepEqual(lookupFails.runs, []);
  const relativeAnswer = harness();
  t.after(relativeAnswer.cleanup);
  relativeAnswer.deps.findProgram = async () => 'codex';
  assert.equal(await runCli(['install', 'codex'], relativeAnswer.deps), 1);
  assert.deepEqual(relativeAnswer.runs, [], 'only an absolute path is ever run');
});

test('install: off macOS, and apps without an install, change nothing', async (t) => {
  const linux = harness({ platform: 'linux' });
  t.after(linux.cleanup);
  mkdirSync(join(linux.home, '.cursor'));
  assert.equal(await runCli(['install', 'cursor'], linux.deps), 1);
  assert.equal(linux.out, `${messages.notMac('linux')}\n`);
  assert.deepEqual(linux.runs, []);
  assert.deepEqual(filesUnder(linux.home), {});

  for (const id of [...CLIENT_IDS.filter((entry) => !Object.hasOwn(INSTALLS, entry)), 'vscode-inputs']) {
    const h = harness();
    t.after(h.cleanup);
    if (id === 'zed') mkdirSync(join(h.home, '.config/zed'), { recursive: true });
    assert.equal(await runCli(['install', id], h.deps), 1, id);
    assert.equal(h.out, `${messages.installManual(render(id))}\n${render(id).text}\n`, id);
    assert.deepEqual(h.runs, []);
    assert.deepEqual(filesUnder(h.home), {});
  }
});

// --- runCli: install into a JSON settings file ---------------------------

const JSON_APPS = {
  cursor: '.cursor/mcp.json',
  windsurf: '.codeium/windsurf/mcp_config.json',
  'claude-desktop': 'Library/Application Support/Claude/claude_desktop_config.json',
  cline: '.cline/data/settings/cline_mcp_settings.json',
  'copilot-cli': '.copilot/mcp-config.json',
};

/** What install prints after it wrote the file, for an app. */
const written = (id, result) => {
  const plan = installPlan(id, {});
  return [messages.installedFile(plan.target, result), ...(result.warning ? [result.warning] : []), ...(plan.hint ? [plan.hint] : []),
    messages.installNextSteps(plan.target), ''].join('\n');
};

test('install into a JSON file: created when the app\'s folder exists, never with a token', async (t) => {
  assert.deepEqual(Object.keys(JSON_APPS).sort(), Object.keys(INSTALLS).filter((id) => INSTALLS[id] === 'json-file').sort());
  for (const [id, relativePath] of Object.entries(JSON_APPS)) {
    const h = harness();
    t.after(h.cleanup);
    const path = join(h.home, relativePath);
    mkdirSync(join(path, '..'), { recursive: true });
    assert.equal(await runCli(['install', id], h.deps), 0, id);
    const plan = installPlan(id, { home: h.home });
    const text = readFileSync(path, 'utf8');
    assert.deepEqual(JSON.parse(text), { [plan.key]: { wisply: plan.entry } }, id);
    assert.equal(text, `${JSON.stringify({ [plan.key]: { wisply: plan.entry } }, null, 2)}\n`);
    assert.deepEqual(plan.entry, jsonEntry(id, render(id).text));
    assert.equal(statSync(path).mode & 0o777, 0o600, `${id}: a new file is private`);
    assert.deepEqual(Object.keys(filesUnder(h.home)), [relativePath], `${id}: no backup, no temporary file`);
    for (const content of Object.values(filesUnder(h.home))) assert.doesNotMatch(content, TOKEN_SHAPE);
    assert.deepEqual(h.runs, []);
    assert.deepEqual(h.touched, []);
    assert.equal(h.out, written(id, { path, created: true }));
    // Again: nothing to do.
    const again = harness();
    again.deps.env.HOME = h.home;
    assert.equal(await runCli(['install', id], again.deps), 0);
    assert.equal(again.out, [messages.installUnchanged(plan.target, path), ...(plan.hint ? [plan.hint] : []),
      messages.installNextSteps(plan.target), ''].join('\n'));
    assert.deepEqual(Object.keys(filesUnder(h.home)), [relativePath]);
    again.cleanup();
  }
});

test('install into a JSON file: no app folder, no file, and the snippet to paste', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  assert.equal(await runCli(['install', 'cursor'], h.deps), 1);
  const path = join(h.home, '.cursor/mcp.json');
  assert.equal(h.out, `${messages.installFileProblem('no-folder', 'Cursor', path, join(h.home, '.cursor'))}\n${render('cursor').text}\n`);
  assert.deepEqual(filesUnder(h.home), {});
  // Cline: install sets up the one file the extension, the CLI and the JetBrains plugin share.
  const cline = harness();
  t.after(cline.cleanup);
  assert.equal(await runCli(['install', 'cline'], cline.deps), 1);
  const clinePath = join(cline.home, JSON_APPS.cline);
  const plan = installPlan('cline', { home: cline.home });
  assert.equal(cline.out,
    `${messages.installFileProblem('no-folder', 'Cline', clinePath, join(clinePath, '..'))}\n${render('cline').text}\n${plan.hint}\n`);
  assert.match(cline.out, /so Cline doesn't seem to be set up on this Mac/);
  assert.deepEqual(filesUnder(cline.home), {});
});

test('install into a JSON file: keeps other servers byte for byte, replaces an old wisply entry, backs up once without the token', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  const path = join(h.home, '.cursor/mcp.json');
  mkdirSync(join(h.home, '.cursor'));
  // What Wisply's own "Copy Cursor mcp.json" button used to produce: direct HTTP with the token.
  const original = `${JSON.stringify({
    mcpServers: {
      github: { command: 'docker', args: ['run', '-i', 'ghcr.io/github/github-mcp-server'] },
      wisply: { url: 'http://127.0.0.1:51771/mcp', headers: { Authorization: `Bearer ${OLD_TOKEN}` } },
    },
  }, null, 4)}\n`;
  writeFileSync(path, original, { mode: 0o644 });
  assert.equal(await runCli(['install', 'cursor'], h.deps), 0);
  const text = readFileSync(path, 'utf8');
  const after = JSON.parse(text);
  assert.deepEqual(Object.keys(after.mcpServers), ['github', 'wisply']);
  assert.deepEqual(after.mcpServers.wisply, FILE.standard_entry);
  assert.equal(text, `${JSON.stringify({ mcpServers: { github: JSON.parse(original).mcpServers.github, wisply: FILE.standard_entry } }, null, 4)}\n`,
    'only the wisply entry changed; the file keeps its indentation');
  assert.doesNotMatch(text, TOKEN_SHAPE);
  assert.equal(statSync(path).mode & 0o777, 0o644, 'the file keeps its mode');
  const backup = `${path}${BACKUP_SUFFIX}`;
  // The backup is new, private, and holds the old file with the token masked.
  assert.equal(readFileSync(backup, 'utf8'), original.replace(OLD_TOKEN, TOKEN_MASK));
  assert.doesNotMatch(readFileSync(backup, 'utf8'), TOKEN_SHAPE);
  assert.equal(statSync(backup).mode & 0o777, 0o600);
  assert.deepEqual(Object.keys(filesUnder(h.home)).sort(), ['.cursor/mcp.json', `.cursor/mcp.json${BACKUP_SUFFIX}`]);
  assert.equal(h.out, written('cursor', {
    path, replaced: true, backup, backupMasked: true, dropped: ['url', 'headers'], warning: messages.replacedTokenWarning(path),
  }));
  assert.match(h.out, /Not carried over from the old entry: url, headers\./);
  assert.match(messages.installedFile('Cursor', { path, replaced: true, backup, backupMasked: true }), /token in it masked \(wsp\.\.\.\)/);
  assert.match(messages.replacedTokenWarning(path), /It's gone from .*install's backup doesn't keep it/);
  for (const content of Object.values(filesUnder(h.home))) assert.doesNotMatch(content, TOKEN_SHAPE);

  // A later install keeps the first backup: it is the file before Wisply ever changed it.
  writeFileSync(path, JSON.stringify({ mcpServers: { wisply: { command: 'old' } } }));
  const second = harness();
  t.after(second.cleanup);
  second.deps.env.HOME = h.home;
  assert.equal(await runCli(['install', 'cursor'], second.deps), 0);
  assert.equal(readFileSync(backup, 'utf8'), original.replace(OLD_TOKEN, TOKEN_MASK));
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { mcpServers: { wisply: FILE.standard_entry } });
  assert.equal(second.out, written('cursor', { path, replaced: true, backup: null }));
  assert.ok(!second.out.includes('plain text'));

  // A backup made when nothing held a token is the old file exactly, still private.
  const third = harness();
  t.after(third.cleanup);
  const windsurf = join(third.home, JSON_APPS.windsurf);
  mkdirSync(join(windsurf, '..'), { recursive: true });
  const plain = '{"theme": "dark", "mcpServers": {"x": {"command": "x"}}}';
  writeFileSync(windsurf, plain, { mode: 0o644 });
  assert.equal(await runCli(['install', 'windsurf'], third.deps), 0);
  assert.equal(readFileSync(`${windsurf}${BACKUP_SUFFIX}`, 'utf8'), plain);
  assert.equal(statSync(`${windsurf}${BACKUP_SUFFIX}`).mode & 0o777, 0o600);
  assert.equal(readFileSync(windsurf, 'utf8'), `{"theme": "dark", "mcpServers": {"x": {"command": "x"}, "wisply": ${JSON.stringify(FILE.standard_entry)}}}`);
  assert.ok(third.out.includes(`The file as it was is saved as ${windsurf}${BACKUP_SUFFIX}. It still holds everything else the file ` +
    "held, other servers' keys and tokens included: delete it once Windsurf works with Wisply.\n"));
});

test('install into a JSON file: refuses comments, odd shapes, repeated keys and non-UTF-8, and leaves the file as it was', async (t) => {
  const cases = [
    ['cursor', '// Cursor\n{\n  "mcpServers": {}\n}\n', 'invalid-json'],
    ['cursor', '{ "mcpServers": { "a": {} }, }', 'invalid-json'],
    ['cursor', '[]', 'not-object'],
    ['windsurf', '{"mcpServers": ["x"]}', 'not-object'],
    ['windsurf', '{"mcpServers": {"wisply": {"command": "a"}, "wisply": {"command": "b"}}}', 'not-plain'],
    ['cursor', Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]), 'not-plain'],
  ];
  for (const [id, content, outcome] of cases) {
    const h = harness();
    t.after(h.cleanup);
    const path = join(h.home, JSON_APPS[id]);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content);
    assert.equal(await runCli(['install', id], h.deps), 1, `${id}: ${content}`);
    assert.ok(readFileSync(path).equals(Buffer.from(content)), 'unchanged, byte for byte');
    assert.deepEqual(Object.keys(filesUnder(h.home)), [JSON_APPS[id]], 'no backup, no temporary file');
    assert.equal(h.out, `${messages.installFileProblem(outcome, render(id).name, path, join(path, '..'))}\n${render(id).text}\n`);
  }
});

test('install into a JSON file: follows a symlinked config and keeps the link', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  mkdirSync(join(h.home, 'dotfiles'));
  mkdirSync(join(h.home, '.cursor'));
  const real = join(h.home, 'dotfiles/cursor-mcp.json');
  const link = join(h.home, '.cursor/mcp.json');
  writeFileSync(real, '{"mcpServers": {"other": {"command": "x"}}}\n');
  symlinkSync(real, link);
  assert.equal(await runCli(['install', 'cursor'], h.deps), 0);
  assert.ok(lstatSync(link).isSymbolicLink());
  assert.equal(readlinkSync(link), real);
  assert.deepEqual(JSON.parse(readFileSync(real, 'utf8')).mcpServers, { other: { command: 'x' }, wisply: FILE.standard_entry });
  // The backup sits next to the path the app reads, not in the dotfiles folder.
  assert.equal(readFileSync(`${link}${BACKUP_SUFFIX}`, 'utf8'), '{"mcpServers": {"other": {"command": "x"}}}\n');
  assert.deepEqual(readdirSync(join(h.home, 'dotfiles')), ['cursor-mcp.json']);
});

test('install into a JSON file: the apps\' own path variables', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  mkdirSync(join(h.home, 'alt'));
  h.deps.env.CLINE_MCP_SETTINGS_PATH = join(h.home, 'alt/cline.json');
  h.deps.env.COPILOT_HOME = join(h.home, 'alt');
  assert.equal(await runCli(['install', 'cline'], h.deps), 0);
  assert.ok(h.out.startsWith(`${messages.installPathFrom('CLINE_MCP_SETTINGS_PATH', join(h.home, 'alt/cline.json'))}\n`));
  assert.equal(await runCli(['install', 'copilot-cli'], h.deps), 0);
  assert.deepEqual(Object.keys(filesUnder(h.home)).sort(), ['alt/cline.json', 'alt/mcp-config.json']);
  assert.deepEqual(JSON.parse(readFileSync(join(h.home, 'alt/mcp-config.json'), 'utf8')).mcpServers.wisply,
    { type: 'local', command: 'npx', args: ARGS, tools: ['*'] });

  // Cline's CLINE_DATA_DIR and CLINE_DIR, where Cline itself looks.
  for (const [variable, folder, file] of [['CLINE_DATA_DIR', 'data', 'data/settings/cline_mcp_settings.json'],
    ['CLINE_DIR', 'cline', 'cline/data/settings/cline_mcp_settings.json']]) {
    const dir = harness();
    t.after(dir.cleanup);
    mkdirSync(join(dir.home, file, '..'), { recursive: true });
    dir.deps.env[variable] = join(dir.home, folder);
    assert.equal(await runCli(['install', 'cline'], dir.deps), 0, variable);
    assert.deepEqual(Object.keys(filesUnder(dir.home)), [file], variable);
    assert.ok(dir.out.startsWith(`${messages.installPathFrom(variable, join(dir.home, file))}\n`), variable);
  }

  // A relative value: Cline would resolve it against its own folder, so install changes nothing and says why.
  const relative = harness();
  t.after(relative.cleanup);
  mkdirSync(join(relative.home, JSON_APPS.cline, '..'), { recursive: true });
  relative.deps.env.CLINE_DATA_DIR = 'project/.cline';
  assert.equal(await runCli(['install', 'cline'], relative.deps), 1);
  const plan = installPlan('cline', {});
  assert.equal(relative.out, `${messages.installNotFullPath('CLINE_DATA_DIR', 'Cline')}\n${render('cline').text}\n${plan.hint}\n`);
  assert.deepEqual(filesUnder(relative.home), {});
  assert.deepEqual(relative.runs, []);
});

test('applyJsonInstall reports read and write failures without changing anything', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'wisply-apply-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  // The "file" is a folder: it can't be read.
  mkdirSync(join(home, 'mcp.json'));
  assert.deepEqual(await applyJsonInstall({ path: join(home, 'mcp.json'), key: 'mcpServers', name: 'wisply', entry: ENTRY }),
    { outcome: 'read-failed', path: join(home, 'mcp.json') });
  // The folder is a file.
  writeFileSync(join(home, 'plain'), 'x');
  assert.equal((await applyJsonInstall({ path: join(home, 'plain/mcp.json'), key: 'mcpServers', name: 'wisply', entry: ENTRY })).outcome,
    'no-folder');
  assert.equal(messages.installFileProblem('read-failed', 'Cursor', '/a/b.json', '/a'),
    "/a/b.json couldn't be read, so it wasn't changed. Check its permissions, or add this to /a/b.json yourself:");
  assert.equal(messages.installFileProblem('write-failed', 'Cursor', '/a/b.json', '/a'),
    "/a/b.json couldn't be written, so it wasn't changed. Check its permissions, or add this to /a/b.json yourself:");
  // A symlink whose target is gone stays a symlink.
  mkdirSync(join(home, 'linked'));
  symlinkSync(join(home, 'gone.json'), join(home, 'linked/mcp.json'));
  assert.equal((await applyJsonInstall({ path: join(home, 'linked/mcp.json'), key: 'mcpServers', name: 'wisply', entry: ENTRY })).outcome,
    'read-failed');
  assert.ok(lstatSync(join(home, 'linked/mcp.json')).isSymbolicLink());
  // A write that fails leaves the file as it was, takes back the backup it just made, and leaves others' files alone.
  mkdirSync(join(home, 'busy'));
  const busy = join(home, 'busy/mcp.json');
  writeFileSync(busy, '{"mcpServers": {}}\n');
  t.mock.method(Date, 'now', () => 42);
  mkdirSync(`${busy}.wisply-${process.pid}-42.tmp`);
  assert.deepEqual(await applyJsonInstall({ path: busy, key: 'mcpServers', name: 'wisply', entry: ENTRY }), { outcome: 'write-failed', path: busy });
  t.mock.restoreAll();
  assert.equal(readFileSync(busy, 'utf8'), '{"mcpServers": {}}\n');
  assert.deepEqual(readdirSync(join(home, 'busy')).sort(), ['mcp.json', `mcp.json.wisply-${process.pid}-42.tmp`]);
  // A failure inside install is reported, never thrown.
  const h = harness();
  t.after(h.cleanup);
  mkdirSync(join(h.home, '.cursor'));
  h.deps.applyJsonInstall = async () => { throw new Error('disk full'); };
  assert.equal(await runCli(['install', 'cursor'], h.deps), 1);
  assert.ok(h.out.startsWith(messages.installFileProblem('write-failed', 'Cursor', join(h.home, '.cursor/mcp.json'), join(h.home, '.cursor'))));
});

test('install into a JSON file: a hard-linked config is left alone; the temporary file is private until the rename', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  mkdirSync(join(h.home, '.cursor'));
  mkdirSync(join(h.home, 'dotfiles'));
  const path = join(h.home, '.cursor/mcp.json');
  const original = `{"mcpServers": {"wisply": {"url": "http://127.0.0.1:51771/mcp", "headers": {"Authorization": "Bearer ${OLD_TOKEN}"}}}}`;
  writeFileSync(path, original, { mode: 0o644 });
  // A dotfiles copy that is the same file: a rename would leave it with the old text (and the token the warning says is gone).
  linkSync(path, join(h.home, 'dotfiles/mcp.json'));
  assert.equal(await runCli(['install', 'cursor'], h.deps), 1);
  assert.equal(h.out, `${messages.installFileProblem('hard-linked', 'Cursor', path, join(h.home, '.cursor'))}\n${render('cursor').text}\n`);
  assert.equal(readFileSync(path, 'utf8'), original);
  assert.deepEqual(Object.keys(filesUnder(h.home)).sort(), ['.cursor/mcp.json', 'dotfiles/mcp.json'], 'no backup, no temporary file');
  assert.match(messages.installFileProblem('hard-linked', 'Cursor', '/a/b', '/a'),
    /^\/a\/b has another hard link \(a dotfiles copy\?\)\. install replaces the file, .* Instead, add this to \/a\/b yourself:$/);

  // The temporary file holds the whole new config (other servers' secrets too): 0600 whatever the target's mode.
  const folder = mkdtempSync(join(tmpdir(), 'wisply-temporary-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const temporary = await writeTemporary(join(folder, 'mcp.json'), '{"x": 1}');
  assert.equal(dirname(temporary), folder);
  assert.match(basename(temporary), /^mcp\.json\.wisply-\d+-\d+\.tmp$/);
  assert.equal(statSync(temporary).mode & 0o777, 0o600);
  // It never writes through something already at its name (O_EXCL).
  t.mock.method(Date, 'now', () => 45);
  const first = await writeTemporary(join(folder, 'mcp.json'), 'first');
  await assert.rejects(writeTemporary(join(folder, 'mcp.json'), 'second'), (error) => error.code === 'EEXIST');
  t.mock.restoreAll();
  assert.equal(readFileSync(first, 'utf8'), 'first');
  // The file itself keeps its own mode after the rename.
  const kept = join(folder, 'kept.json');
  writeFileSync(kept, '{"mcpServers": {}}', { mode: 0o640 });
  chmodSync(kept, 0o640);
  assert.equal((await applyJsonInstall({ path: kept, key: 'mcpServers', name: 'wisply', entry: ENTRY })).outcome, 'written');
  assert.equal(statSync(kept).mode & 0o777, 0o640);
});

test('install into a JSON file: Cline\'s own approvals and switch survive a second install', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  const path = join(h.home, JSON_APPS.cline);
  mkdirSync(join(path, '..'), { recursive: true });
  assert.equal(await runCli(['install', 'cline'], h.deps), 0);
  // Cline records approvals in the entry; the person turns it off for a while.
  const config = JSON.parse(readFileSync(path, 'utf8'));
  Object.assign(config.mcpServers.wisply, { autoApprove: ['list_memos', 'get_action_items'], disabled: true, timeout: 90 });
  const edited = `${JSON.stringify(config, null, 2)}\n`;
  writeFileSync(path, edited);
  const again = harness();
  t.after(again.cleanup);
  again.deps.env.HOME = h.home;
  assert.equal(await runCli(['install', 'cline'], again.deps), 0);
  assert.equal(readFileSync(path, 'utf8'), edited, 'nothing to change');
  assert.ok(again.out.startsWith(`${messages.installUnchanged('Cline', path, ['autoApprove', 'disabled', 'timeout'])}\n`));
  // A new version of the connector: the arguments change, the approvals stay, and install says so.
  config.mcpServers.wisply.args = ['-y', '--prefix', '/', '@wisply/mcp@0.0.1'];
  config.mcpServers.wisply.env = { WISPLY_MCP_PORT: '51772' };
  writeFileSync(path, JSON.stringify(config, null, 2));
  const third = harness();
  t.after(third.cleanup);
  third.deps.env.HOME = h.home;
  assert.equal(await runCli(['install', 'cline'], third.deps), 0);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).mcpServers.wisply, {
    type: 'stdio', command: 'npx', args: ARGS, disabled: true, autoApprove: ['list_memos', 'get_action_items'], timeout: 90,
  });
  assert.match(third.out, /Kept from the old entry: autoApprove, disabled, timeout\.\nNot carried over from the old entry: env\./);
});

test('applyJsonInstall leaves a file that changed while it worked (an app writing it) alone', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'wisply-race-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const path = join(home, 'mcp.json');
  writeFileSync(path, '{"mcpServers": {}}\n');
  // Date.now runs right before the temporary file is written: the "app" saves its own change then.
  t.mock.method(Date, 'now', () => { writeFileSync(path, '{"mcpServers": {}, "app": "saved"}\n'); return 43; });
  assert.deepEqual(await applyJsonInstall({ path, key: 'mcpServers', name: 'wisply', entry: ENTRY }), { outcome: 'changed', path });
  t.mock.restoreAll();
  assert.equal(readFileSync(path, 'utf8'), '{"mcpServers": {}, "app": "saved"}\n', "the app's change wins");
  assert.deepEqual(readdirSync(home), ['mcp.json'], 'no backup, no temporary file');
  // A file that appeared after install found none.
  const fresh = join(home, 'new.json');
  t.mock.method(Date, 'now', () => { writeFileSync(fresh, '{}'); return 44; });
  assert.deepEqual(await applyJsonInstall({ path: fresh, key: 'mcpServers', name: 'wisply', entry: ENTRY }), { outcome: 'changed', path: fresh });
  t.mock.restoreAll();
  assert.equal(readFileSync(fresh, 'utf8'), '{}');
  assert.match(messages.installFileProblem('changed', 'Claude Desktop', '/a/b.json', '/a'),
    /changed while install was working on it \(is Claude Desktop running\?\).*Quit Claude Desktop and run install again/);
});

test('every print-config and install text is ASCII and names only real commands, pinned', () => {
  const rendered = render('cursor');
  const texts = [
    messages.unknownApp('x', CLIENT_IDS), messages.missingApp('install', CLIENT_IDS),
    messages.appList([{ id: 'cursor', name: 'Cursor', install: true }]), messages.printConfigHint(rendered),
    messages.printConfigHint(render('cline')), messages.printConfigHint(render('vscode')),
    messages.installManual(render('warp')), messages.installManual(render('amp')), messages.installManual(render('vscode-inputs')),
    messages.installRunning('claude mcp add'), messages.programMissing('code', 'VS Code', null, installPlan('vscode', {}).display),
    messages.programFailed('claude', 'Claude Code', { code: 1 }), messages.installedByCommand('Codex'),
    messages.installedFile('Cursor', { path: '/x', created: true }), messages.replacedTokenWarning('/x'),
    messages.installedFile('Cursor', { path: '/x', backup: '/x.wisply-backup', backupMasked: true }),
    messages.installUnchanged('Cursor', '/x'), messages.installNextSteps('Cursor'), messages.HELP,
    messages.installUnchanged('Cline', '/x', ['autoApprove']), messages.SETUPS_NOT_RELEASED, messages.envPortIgnored(51772),
    messages.appDataNote('Cursor'), messages.commandEntryExists('claude', 'Claude Code', true),
    messages.commandEntryExists('code', 'VS Code', false), messages.installNotFullPath('CLINE_DIR', 'Cline'),
    messages.installPathFrom('CLINE_DIR', '/c/data/settings/cline_mcp_settings.json'),
    messages.installedFile('Cline', { path: '/x', replaced: true, kept: ['timeout'], dropped: ['env'] }),
    messages.appList([{ id: 'cursor', name: 'Cursor', install: true }], { released: false }),
    ...['no-folder', 'invalid-json', 'not-object', 'not-plain', 'hard-linked', 'changed', 'read-failed', 'write-failed']
      .map((outcome) => messages.installFileProblem(outcome, 'Cursor', '/a/b', '/a')),
    ...Object.values(messages).filter((value) => typeof value === 'string'),
    ...FILE.clients.flatMap((client) => [client.note ?? '', client.install?.hint ?? '']),
  ];
  for (const text of texts) {
    assert.equal(text.search(/[^\x00-\x7f]/), -1, text);
    assert.doesNotMatch(text, TOKEN_SHAPE);
    for (const match of text.matchAll(/(?:npx -y --prefix \/ @wisply\/mcp@[0-9.]+|wisply-mcp) ([a-z][a-z-]*)/g)) {
      assert.ok(CLI_COMMANDS.includes(match[1]), `${match[1]} in: ${text}`);
    }
    // Every command people are told to run names this exact version, after --prefix /.
    assert.doesNotMatch(text, /@wisply\/mcp(?!@)/, `the package without its version in: ${text}`);
    assert.doesNotMatch(text, /npx -y @wisply/, `npx without --prefix / in: ${text}`);
  }
  assert.equal(messages.unknownApp('a\u0007b"', ['x']), 'wisply-mcp: unknown app "a?b"". Apps: x.');
  // Adding the entry is when transcripts start to reach the app: print-config and install say where they go.
  assert.equal(messages.appDataNote('Cursor'),
    "What Cursor reads from Wisply, transcripts included, goes to the AI service Cursor uses, under that service's terms.");
  for (const id of [...CLIENT_IDS, 'vscode-inputs']) {
    assert.ok(messages.printConfigHint(render(id)).includes(`\n${messages.appDataNote(render(id).name)}\n`), id);
  }
  assert.ok(messages.installNextSteps('Cursor').endsWith(`\n${messages.appDataNote('Cursor')}`));
  // Not an inherited property name: an unknown outcome is a write failure.
  assert.equal(messages.installFileProblem('toString', 'Cursor', '/a/b', '/a'), messages.installFileProblem('write-failed', 'Cursor', '/a/b', '/a'));
  assert.match(messages.HELP, /print-config \[<app>\] \[--port <n>\]/);
  assert.match(messages.HELP, /install <app> \[--port <n>\]/);
  // Through npx with the pinned spec once the package name is final, by the bin's name until then (DIST-M2).
  assert.equal(messages.COMMAND_PREFIX, PACKAGE_NAME_FINAL ? `npx -y --prefix / ${PACKAGE_SPEC}` : 'wisply-mcp');
  for (const [text, command] of [[messages.PRINT_CONFIG_COMMAND, 'print-config'], [messages.INSTALL_COMMAND, 'install'],
    [messages.SETUP_COMMAND, 'setup'], [messages.FORGET_COMMAND, 'forget']]) {
    assert.equal(text, `${messages.COMMAND_PREFIX} ${command}`);
  }
  assert.ok(PACKAGE_SPEC.endsWith(`@${VERSION}`));
});

test('the docs run the pinned connector with --prefix / everywhere', () => {
  for (const doc of ['README.md', 'SECURITY.md', 'CHANGELOG.md', 'docs/design-differences.md', 'llms-install.md']) {
    const text = readFileSync(join(ROOT, doc), 'utf8');
    assert.doesNotMatch(text, /npx -y @wisply/, `${doc}: npx without --prefix /`);
    assert.doesNotMatch(text, /@wisply\/mcp (setup|status|forget|print-config|install)/, `${doc}: a command without the version`);
    for (const match of text.matchAll(/npx -y --prefix \/ (@wisply\/mcp\S*)/g)) assert.ok(match[1].startsWith(PACKAGE_SPEC) || match[1].startsWith(`${PACKAGE_NAME}@<version>`), `${doc}: ${match[1]}`);
  }
});

// --- Before the release --------------------------------------------------

test('before the release, nothing renders a setup: render, installPlan, print-config and install refuse', async (t) => {
  // Tied to the package name and "published", which the release change flips together (pack.test, the test above).
  assert.equal(SETUPS_RELEASED, PACKAGE_NAME_FINAL && FILE.published === true);
  if (!SETUPS_RELEASED) {
    for (const id of [...CLIENT_IDS, 'vscode-inputs']) {
      assert.throws(() => renderGated(id), NotReleasedError, id);
      assert.throws(() => installPlanGated(id, { home: '/h', env: {} }), (error) => error.code === 'WISPLY_NOT_RELEASED', id);
    }
  }
  // An unknown app is still just unknown.
  assert.equal(renderGated('nope'), null);
  assert.equal(installPlanGated('nope'), null);

  // The CLI as it runs from the bin (released: SETUPS_RELEASED), forced to "not yet".
  for (const id of [...CLIENT_IDS, 'vscode-inputs']) {
    const printed = harness({ released: false });
    t.after(printed.cleanup);
    assert.equal(await runCli(['print-config', id], printed.deps), 1, id);
    assert.equal(printed.out, '', `${id}: no setup on stdout`);
    assert.equal(printed.err, `${messages.SETUPS_NOT_RELEASED}\n`);
    const installed = harness({ released: false });
    t.after(installed.cleanup);
    for (const folder of Object.values(JSON_APPS)) mkdirSync(join(installed.home, folder, '..'), { recursive: true });
    assert.equal(await runCli(['install', id], installed.deps), 1, id);
    assert.equal(installed.out, `${messages.SETUPS_NOT_RELEASED}\n`);
    assert.deepEqual(installed.runs, [], `${id}: no app command runs`);
    assert.deepEqual(filesUnder(installed.home), {}, `${id}: no file is written`);
    for (const output of [printed.out, printed.err, installed.out, installed.err]) assert.doesNotMatch(output, /\bnpx\b|@wisply\/mcp/);
  }
  // The app list still prints, and says why the rest waits.
  const list = harness({ released: false });
  t.after(list.cleanup);
  assert.equal(await runCli(['print-config'], list.deps), 0);
  assert.equal(list.out, messages.appList(clientsFile.clients.map((client) => ({ id: client.id, name: client.name, install: Boolean(client.install) })),
    { released: false }));
  assert.match(list.out, /Not yet: `wisply-mcp print-config <app>` and `wisply-mcp install <app>`/);
  // Unknown apps and usage mistakes keep their exit code 2.
  for (const argv of [['print-config', 'nope'], ['install', 'nope'], ['install']]) {
    const h = harness({ released: false });
    t.after(h.cleanup);
    assert.equal(await runCli(argv, h.deps), 2, argv.join(' '));
  }
  assert.doesNotMatch(messages.SETUPS_NOT_RELEASED, /\bnpx\b|@wisply/);
});

// --- The real bin --------------------------------------------------------

async function bin(args, env = {}) {
  const child = spawn(process.execPath, [BIN, ...args], { env: { PATH: process.env.PATH, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const [code] = await once(child, 'exit');
  return { code, stdout, stderr };
}

test('bin: print-config and install as this build ships them (nothing for an app before the release)', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'wisply-bin-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const result = await bin(['print-config', 'cursor'], { HOME: home, WISPLY_MCP_TOKEN: ENV_TOKEN });
  if (SETUPS_RELEASED) {
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, `${render('cursor').text}\n`);
    assert.equal(result.stderr, messages.printConfigHint(render('cursor')));
  } else {
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '', 'no setup on stdout before the release');
    assert.equal(result.stderr, `${messages.SETUPS_NOT_RELEASED}\n`);
  }
  const list = await bin(['print-config'], { HOME: home });
  assert.equal(list.code, 0);
  for (const id of CLIENT_IDS) assert.ok(list.stdout.includes(`  ${id} `), id);
  assert.equal(list.stdout.includes('Not yet:'), !SETUPS_RELEASED);
  const usage = await bin(['install'], { HOME: home });
  assert.equal(usage.code, 2);
  assert.equal(usage.stdout, '');
  assert.equal(usage.stderr, `${messages.missingApp('install', CLIENT_IDS)}\n`);
  const install = await bin(['install', 'cursor'], { HOME: home });
  assert.equal(install.code, 1);
  if (!SETUPS_RELEASED) assert.equal(install.stdout, `${messages.SETUPS_NOT_RELEASED}\n`);
  else if (process.platform !== 'darwin') assert.equal(install.stdout, `${messages.notMac(process.platform)}\n`);
  for (const output of [result, list, usage, install]) assert.doesNotMatch(output.stdout + output.stderr, /\bnpx\b|@wisply\/mcp/);
  assert.deepEqual(readdirSync(home), []);
});
