// The client setup templates (clients/mcp-clients.json), their renderer
// (lib/clients.mjs), and print-config and install (lib/cli.mjs).
//
// install runs against a temporary HOME with an execFile spy standing in for
// every app's own command, a token in the environment and a Keychain that
// would hand out another one if anything asked. Nothing asks: no argv, no
// child environment and no written file may hold a token.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import contract from '../lib/contract.mjs';
import { DEFAULT_PORT, PACKAGE_NAME, PACKAGE_RANGE, PACKAGE_SPEC, SERVER_KEY } from '../lib/constants.mjs';
import {
  ARGS_CLI, ARGS_LIST, BACKUP_SUFFIX, CLIENT_IDS, FORMATS, applyJsonInstall, bridgeArgs, clientsFile, clientsProblems,
  findClient, installPlan, mergeEntry, render, renderTemplate,
} from '../lib/clients.mjs';
import { CLI_COMMANDS, commandEnv, parseCliArgs, runCli } from '../lib/cli.mjs';
import * as messages from '../lib/messages.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BIN = join(ROOT, 'bin/wisply-mcp.mjs');
const RAW = readFileSync(join(ROOT, 'clients/mcp-clients.json'), 'utf8');
const FILE = JSON.parse(RAW);
const TOKEN_SHAPE = /wsp[cr]?_[0-9a-f]{64}/;
const ENV_TOKEN = `wspc_${'9e'.repeat(32)}`;
const KEYCHAIN_TOKEN = `wsp_${'8d'.repeat(32)}`;
const OLD_TOKEN = `wsp_${'4f'.repeat(32)}`;
const ARGS = ['-y', PACKAGE_SPEC];

/** The apps of the spec's per-client table, in its order. */
const SPEC_IDS = ['claude-code', 'claude-desktop', 'cursor', 'vscode', 'windsurf', 'zed', 'jetbrains', 'codex', 'gemini-cli',
  'copilot-cli', 'warp', 'cline', 'roo-code', 'goose', 'lm-studio', 'kiro', 'opencode', 'amp', 'factory', 'grok-cli'];
/** The apps Wisply's own Settings copy setups for (wisply-ai MCPClientSnippets.Client). */
const APP_IDS = ['cursor', 'claude-desktop', 'claude-code', 'vscode', 'codex', 'gemini-cli', 'windsurf', 'zed', 'jetbrains',
  'warp', 'cline', 'copilot-cli', 'goose'];
/** What install does per app. */
const INSTALLS = {
  'claude-code': 'command', codex: 'command', 'gemini-cli': 'command', vscode: 'add-mcp',
  cursor: 'json-file', windsurf: 'json-file', 'claude-desktop': 'json-file', cline: 'json-file', 'copilot-cli': 'json-file',
  zed: 'json-file',
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
  // Snippets run the exact version; the 0.x range is only ever an opt-in (README "Versions").
  assert.ok(!RAW.includes(`"${PACKAGE_RANGE}"`) && !RAW.includes(`${PACKAGE_RANGE} `));
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
  assert.ok(inputs.text.includes(`npx -y ${PACKAGE_NAME} setup`), 'the input description names this package\'s setup command');
});

// --- Rendering -----------------------------------------------------------

test('arguments: ["-y", spec], --port only for another port, and nothing that needs escaping', () => {
  assert.deepEqual(bridgeArgs(), ARGS);
  assert.deepEqual(bridgeArgs({ port: DEFAULT_PORT }), ARGS);
  assert.deepEqual(bridgeArgs({ port: 51772 }), [...ARGS, '--port', '51772']);
  assert.deepEqual(bridgeArgs({ spec: PACKAGE_RANGE, port: 1024 }), ['-y', PACKAGE_RANGE, '--port', '1024']);
  for (const argument of [...bridgeArgs({ port: 65535 }), PACKAGE_RANGE]) assert.doesNotMatch(argument, /["'\s\\$`]/);
  for (const port of [80, 1023, 65536, 51771.5, '51772', null]) assert.throws(() => bridgeArgs({ port }), RangeError, String(port));
  for (const spec of ['@wisply/mcp@0 --evil', '"@wisply/mcp"', "a'b", '$(id)', '`id`', 'a\\b', '~/x', '@wisply/mcp@^0', '', 7]) {
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
  assert.equal(render('codex').text, `[mcp_servers.wisply]\ncommand = "npx"\nargs = ["-y", "${PACKAGE_SPEC}"]`);
  assert.equal(render('goose').text,
    `extensions:\n  wisply:\n    name: Wisply\n    cmd: npx\n    args: ["-y", "${PACKAGE_SPEC}"]\n    enabled: true\n    type: stdio\n    timeout: 300`);
  assert.equal(render('claude-code').text, `claude mcp add --scope user wisply -- npx -y ${PACKAGE_SPEC}`);
  assert.equal(render('gemini-cli').text, `gemini mcp add --scope user wisply npx -- -y ${PACKAGE_SPEC}`);
  assert.equal(render('amp').text, `amp mcp add wisply -- npx -y ${PACKAGE_SPEC}`);
  assert.equal(render('factory').text, `droid mcp add wisply "npx -y ${PACKAGE_SPEC}"`);
  assert.equal(render('grok-cli').text, `grok mcp add wisply -- npx -y ${PACKAGE_SPEC}`);
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
    display: `claude mcp add --scope user wisply -- npx -y ${PACKAGE_SPEC}`, hint: null,
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
  assert.equal(vscode.args[1], `{"name":"wisply","type":"stdio","command":"npx","args":["-y","${PACKAGE_SPEC}"]}`);
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
    cursor: ['/Users/someone/.cursor/mcp.json', 'mcpServers'],
    windsurf: ['/Users/someone/.codeium/windsurf/mcp_config.json', 'mcpServers'],
    'claude-desktop': ['/Users/someone/Library/Application Support/Claude/claude_desktop_config.json', 'mcpServers'],
    cline: ['/Users/someone/.cline/data/settings/cline_mcp_settings.json', 'mcpServers'],
    'copilot-cli': ['/Users/someone/.copilot/mcp-config.json', 'mcpServers'],
    zed: ['/Users/someone/.config/zed/settings.json', 'context_servers'],
  };
  for (const [id, [path, key]] of Object.entries(expected)) {
    const result = plan(id);
    assert.deepEqual(result, { kind: 'json-file', id, path, key, name: 'wisply', entry: jsonEntry(id, render(id).text) }, id);
  }
  // The apps' own override variables.
  assert.equal(plan('cline', { CLINE_MCP_SETTINGS_PATH: '/tmp/cline.json' }).path, '/tmp/cline.json');
  assert.equal(plan('cline', { CLINE_MCP_SETTINGS_PATH: '~/c/cline.json' }).path, '/Users/someone/c/cline.json');
  assert.equal(plan('cline', { CLINE_MCP_SETTINGS_PATH: '  ' }).path, expected.cline[0]);
  assert.equal(plan('copilot-cli', { COPILOT_HOME: '/opt/copilot' }).path, '/opt/copilot/mcp-config.json');
  assert.equal(plan('cursor', { COPILOT_HOME: '/opt/copilot', CLINE_MCP_SETTINGS_PATH: '/x' }).path, expected.cursor[0]);
  // Everything else is pasted by hand.
  for (const id of CLIENT_IDS.filter((entry) => !Object.hasOwn(INSTALLS, entry))) assert.deepEqual(plan(id), { kind: 'manual', id });
  assert.deepEqual(plan('vscode-inputs'), { kind: 'manual', id: 'vscode-inputs' });
  assert.equal(plan('nope'), null);
});

// --- mergeEntry ----------------------------------------------------------

const ENTRY = { command: 'npx', args: ARGS };
const change = { key: 'mcpServers', name: 'wisply', entry: ENTRY };

test('mergeEntry sets only the wisply entry and keeps the rest, its order and its indentation', () => {
  assert.deepEqual(mergeEntry(null, change),
    { ok: true, text: `${JSON.stringify({ mcpServers: { wisply: ENTRY } }, null, 2)}\n`, unchanged: false, replaced: false, replacedHeldToken: false });
  assert.equal(mergeEntry(' \n', change).text, `${JSON.stringify({ mcpServers: { wisply: ENTRY } }, null, 2)}\n`);

  const original = { theme: 'dark', mcpServers: { other: { command: 'other-mcp', env: { KEY: 'v' } }, wisply: { url: 'http://x' } }, last: [1, 2] };
  const four = mergeEntry(JSON.stringify(original, null, 4), change);
  assert.equal(four.ok, true);
  assert.equal(four.replaced, true);
  assert.equal(four.replacedHeldToken, false);
  const after = JSON.parse(four.text);
  assert.deepEqual(Object.keys(after), ['theme', 'mcpServers', 'last']);
  assert.deepEqual(Object.keys(after.mcpServers), ['other', 'wisply']);
  assert.deepEqual(after.mcpServers.other, original.mcpServers.other);
  assert.deepEqual(after.mcpServers.wisply, ENTRY);
  assert.deepEqual(after.last, [1, 2]);
  assert.equal(four.text, `${JSON.stringify(after, null, 4)}\n`);
  assert.equal(mergeEntry(JSON.stringify(original, null, '\t'), change).text, `${JSON.stringify(after, null, '\t')}\n`);

  const bom = mergeEntry(`\uFEFF${JSON.stringify({ mcpServers: {} })}`, change);
  assert.ok(bom.text.startsWith('\uFEFF{'));
  assert.deepEqual(JSON.parse(bom.text.slice(1)), { mcpServers: { wisply: ENTRY } });

  const same = `${JSON.stringify({ mcpServers: { wisply: ENTRY } }, null, 2)}\n`;
  assert.deepEqual(mergeEntry(same, change), { ok: true, text: same, unchanged: true, replaced: false, replacedHeldToken: false });

  const withToken = JSON.stringify({ mcpServers: { wisply: { url: 'http://127.0.0.1:51771/mcp', headers: { Authorization: `Bearer ${OLD_TOKEN}` } } } });
  const replaced = mergeEntry(withToken, change);
  assert.equal(replaced.replacedHeldToken, true);
  assert.doesNotMatch(replaced.text, TOKEN_SHAPE);
  assert.equal(mergeEntry(JSON.stringify({ mcpServers: { other: { env: { T: OLD_TOKEN } } } }), change).replacedHeldToken, false);
});

test('mergeEntry refuses what isn\'t plain JSON of the right shape', () => {
  for (const text of ['// Zed settings\n{ "theme": "One" }', '{ "a": 1, }', '{', 'nul', '{"mcpServers": {"x": 1}} trailing']) {
    assert.deepEqual(mergeEntry(text, change), { ok: false, reason: 'invalid-json' }, text);
  }
  for (const text of ['[]', '"text"', '3', 'null', '{"mcpServers": []}', '{"mcpServers": "x"}', '{"mcpServers": null}']) {
    assert.deepEqual(mergeEntry(text, change), { ok: false, reason: 'not-object' }, text);
  }
});

// --- runCli: print-config ------------------------------------------------

/** runCli's dependencies with a temporary HOME, an execFile spy and a Keychain that must stay untouched. */
function harness({ platform = 'darwin', env = {}, exec = () => ({ error: null, stdout: '', stderr: '' }) } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'wisply-clients-'));
  const out = [];
  const err = [];
  const runs = [];
  const touched = [];
  const deps = {
    platform,
    env: { HOME: home, PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', WISPLY_MCP_TOKEN: ENV_TOKEN, ...env },
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
    home, deps, runs, touched,
    get out() { return out.join(''); },
    get err() { return err.join(''); },
    cleanup: () => rmSync(home, { recursive: true, force: true }),
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
  const fromEnv = harness({ env: { WISPLY_MCP_PORT: '51773' } });
  t.after(fromEnv.cleanup);
  assert.equal(await runCli(['print-config', '--port=51772', 'codex'], fromEnv.deps), 0);
  assert.match(fromEnv.out, /"--port", "51772"/);
  const envPort = harness({ env: { WISPLY_MCP_PORT: '51773' } });
  t.after(envPort.cleanup);
  assert.equal(await runCli(['print-config', 'codex'], envPort.deps), 0);
  assert.match(envPort.out, /"--port", "51773"/);
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

test('install: claude, codex and gemini get a fixed argv, without the token in argv or the environment', async (t) => {
  for (const [id, file] of [['claude-code', 'claude'], ['codex', 'codex'], ['gemini-cli', 'gemini']]) {
    const h = harness({
      env: { OTHER_SECRET_HOLDER: `x ${KEYCHAIN_TOKEN} y`, CLAUDE_CONFIG_DIR: '/tmp/claude-config' },
      exec: () => ({ error: null, stdout: `Added stdio MCP server wisply ${OLD_TOKEN}\n`, stderr: '' }),
    });
    t.after(h.cleanup);
    assert.equal(await runCli(['install', id], h.deps), 0, id);
    assert.equal(h.runs.length, 1);
    const [run] = h.runs;
    assert.equal(run.file, file);
    assert.deepEqual(run.args, installPlan(id, { home: h.home }).args);
    assert.equal(run.options.shell, undefined, 'no shell');
    assert.ok(Number.isInteger(run.options.timeout) && run.options.timeout > 0);
    assert.equal(Object.hasOwn(run.options.env, 'WISPLY_MCP_TOKEN'), false);
    assert.equal(Object.hasOwn(run.options.env, 'OTHER_SECRET_HOLDER'), false);
    assert.equal(run.options.env.CLAUDE_CONFIG_DIR, '/tmp/claude-config');
    assert.equal(run.options.env.HOME, h.home);
    assert.equal(run.options.env.PATH, '/usr/bin:/bin');
    for (const value of [file, ...run.args, ...Object.values(run.options.env)]) assert.doesNotMatch(value, TOKEN_SHAPE);
    assert.deepEqual(h.touched, [], `${id}: install never reads a token`);
    assert.deepEqual(filesUnder(h.home), {}, `${id}: install writes no file itself`);
    // The app's own output is passed on, with anything token-shaped masked.
    assert.ok(h.out.includes('Added stdio MCP server wisply wsp...'));
    assert.doesNotMatch(h.out + h.err, TOKEN_SHAPE);
    assert.ok(h.out.startsWith(`${messages.installRunning(installPlan(id, { home: h.home }).display)}\n`));
    assert.ok(h.out.endsWith(`${messages.installedByCommand(render(id).name)}\n${messages.installNextSteps(render(id).name)}\n`));
  }
  assert.deepEqual(commandEnv({ A: '1', WISPLY_MCP_TOKEN: '', B: ENV_TOKEN, C: undefined, WISPLY_MCP_PORT: '51772' }),
    { A: '1', WISPLY_MCP_PORT: '51772' });
});

test('install vscode runs code --add-mcp and never edits mcp.json', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  mkdirSync(join(h.home, 'Library/Application Support/Code/User'), { recursive: true });
  assert.equal(await runCli(['install', 'vscode', '--port', '51772'], h.deps), 0);
  assert.equal(h.runs.length, 1);
  assert.equal(h.runs[0].file, 'code');
  assert.equal(h.runs[0].args[0], '--add-mcp');
  assert.deepEqual(JSON.parse(h.runs[0].args[1]), { name: 'wisply', type: 'stdio', command: 'npx', args: [...ARGS, '--port', '51772'] });
  assert.deepEqual(filesUnder(h.home), {});
  assert.deepEqual(h.touched, []);
});

test('install: a missing or failing command changes nothing and says what to do', async (t) => {
  const missing = harness({ exec: () => ({ error: Object.assign(new Error('spawn code ENOENT'), { code: 'ENOENT' }), stdout: '', stderr: '' }) });
  t.after(missing.cleanup);
  assert.equal(await runCli(['install', 'vscode'], missing.deps), 1);
  assert.ok(missing.out.includes(messages.programMissing('code', 'VS Code', installPlan('vscode', {}).hint)));
  assert.match(missing.out, /Shell Command: Install 'code' command in PATH/);

  const failing = harness({
    exec: () => ({ error: Object.assign(new Error('exit 1'), { code: 1 }), stdout: '', stderr: 'MCP server wisply already exists in user config\n' }),
  });
  t.after(failing.cleanup);
  assert.equal(await runCli(['install', 'claude-code'], failing.deps), 1);
  assert.equal(failing.err, 'MCP server wisply already exists in user config\n');
  assert.ok(failing.out.endsWith(`${messages.programFailed('claude', 'Claude Code', { code: 1 })}\n`));
  assert.match(messages.programFailed('claude', 'Claude Code', { code: 1 }), /^claude failed \(exit 1\)/);
  assert.match(messages.programFailed('codex', 'Codex', { signal: 'SIGTERM', timedOut: true }), /^codex didn't finish in time/);
  assert.match(messages.programFailed('codex', 'Codex', { signal: 'SIGKILL' }), /^codex stopped \(SIGKILL\)/);

  const thrown = harness();
  t.after(thrown.cleanup);
  thrown.deps.execFile = () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); };
  assert.equal(await runCli(['install', 'codex'], thrown.deps), 1);
  assert.match(thrown.out, /codex couldn't run/);
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
  zed: '.config/zed/settings.json',
};

test('install into a JSON file: created when the app\'s folder exists, never with a token', async (t) => {
  for (const [id, relative] of Object.entries(JSON_APPS)) {
    const h = harness();
    t.after(h.cleanup);
    const path = join(h.home, relative);
    mkdirSync(join(path, '..'), { recursive: true });
    assert.equal(await runCli(['install', id], h.deps), 0, id);
    const plan = installPlan(id, { home: h.home });
    const written = JSON.parse(readFileSync(path, 'utf8'));
    assert.deepEqual(written, { [plan.key]: { wisply: plan.entry } }, id);
    assert.deepEqual(plan.entry, jsonEntry(id, render(id).text));
    assert.equal(statSync(path).mode & 0o777, 0o600, `${id}: a new file is private`);
    assert.deepEqual(Object.keys(filesUnder(h.home)), [relative], `${id}: no backup, no temporary file`);
    for (const text of Object.values(filesUnder(h.home))) assert.doesNotMatch(text, TOKEN_SHAPE);
    assert.deepEqual(h.runs, []);
    assert.deepEqual(h.touched, []);
    assert.equal(h.out, `${messages.installedFile(render(id).name, { path, created: true })}\n${messages.installNextSteps(render(id).name)}\n`);
    // Again: nothing to do.
    const again = harness();
    again.deps.env.HOME = h.home;
    assert.equal(await runCli(['install', id], again.deps), 0);
    assert.equal(again.out, `${messages.installUnchanged(render(id).name, path)}\n${messages.installNextSteps(render(id).name)}\n`);
    assert.deepEqual(Object.keys(filesUnder(h.home)), [relative]);
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
});

test('install into a JSON file: keeps other servers, replaces an old wisply entry, backs up once', async (t) => {
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
  const after = JSON.parse(readFileSync(path, 'utf8'));
  assert.deepEqual(Object.keys(after.mcpServers), ['github', 'wisply']);
  assert.deepEqual(after.mcpServers.github, JSON.parse(original).mcpServers.github);
  assert.deepEqual(after.mcpServers.wisply, FILE.standard_entry);
  assert.match(readFileSync(path, 'utf8'), /^\{\n {4}"mcpServers"/, 'the file keeps its indentation');
  assert.doesNotMatch(readFileSync(path, 'utf8'), TOKEN_SHAPE);
  assert.equal(statSync(path).mode & 0o777, 0o644, 'the file keeps its mode');
  const backup = `${path}${BACKUP_SUFFIX}`;
  assert.equal(readFileSync(backup, 'utf8'), original);
  assert.deepEqual(Object.keys(filesUnder(h.home)).sort(), ['.cursor/mcp.json', `.cursor/mcp.json${BACKUP_SUFFIX}`]);
  assert.ok(h.out.includes(messages.installedFile('Cursor', { path, replaced: true, backup })));
  assert.ok(h.out.includes(messages.replacedTokenWarning('Cursor', backup)));
  assert.match(messages.replacedTokenWarning('Cursor', backup), /still holds it: delete that file/);

  // A later install keeps the first backup: it is the file before Wisply ever changed it.
  writeFileSync(path, JSON.stringify({ mcpServers: { wisply: { command: 'old' } } }));
  const second = harness();
  t.after(second.cleanup);
  second.deps.env.HOME = h.home;
  assert.equal(await runCli(['install', 'cursor'], second.deps), 0);
  assert.equal(readFileSync(backup, 'utf8'), original);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { mcpServers: { wisply: FILE.standard_entry } });
  assert.ok(second.out.includes(messages.installedFile('Cursor', { path, replaced: true, backup: null })));
  assert.ok(!second.out.includes('plain text'));
});

test('install into a JSON file: refuses comments and odd shapes, and leaves the file as it was', async (t) => {
  const cases = [
    ['zed', '.config/zed/settings.json', '// Zed settings\n{\n  "theme": "One Dark"\n}\n', 'invalid-json'],
    ['cursor', '.cursor/mcp.json', '{ "mcpServers": { "a": {} }, }', 'invalid-json'],
    ['cursor', '.cursor/mcp.json', '[]', 'not-object'],
    ['windsurf', '.codeium/windsurf/mcp_config.json', '{"mcpServers": ["x"]}', 'not-object'],
  ];
  for (const [id, relative, text, outcome] of cases) {
    const h = harness();
    t.after(h.cleanup);
    const path = join(h.home, relative);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, text);
    assert.equal(await runCli(['install', id], h.deps), 1, `${id}: ${text}`);
    assert.equal(readFileSync(path, 'utf8'), text);
    assert.deepEqual(Object.keys(filesUnder(h.home)), [relative], 'no backup, no temporary file');
    assert.equal(h.out, `${messages.installFileProblem(outcome, render(id).name, path, join(path, '..'))}\n${render(id).text}\n`);
  }
  // Plain JSON Zed settings are fine.
  const zed = harness();
  t.after(zed.cleanup);
  const path = join(zed.home, JSON_APPS.zed);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, '{\n  "theme": "One Dark",\n  "context_servers": {}\n}\n');
  assert.equal(await runCli(['install', 'zed'], zed.deps), 0);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')),
    { theme: 'One Dark', context_servers: { wisply: { command: 'npx', args: ARGS, env: {} } } });
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
  assert.equal(await runCli(['install', 'copilot-cli'], h.deps), 0);
  assert.deepEqual(Object.keys(filesUnder(h.home)).sort(), ['alt/cline.json', 'alt/mcp-config.json']);
  assert.deepEqual(JSON.parse(readFileSync(join(h.home, 'alt/mcp-config.json'), 'utf8')).mcpServers.wisply,
    { type: 'local', command: 'npx', args: ARGS, tools: ['*'] });
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
  // A write that fails leaves the file as it was and takes back the backup it just made.
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

test('every print-config and install text is ASCII and names only real commands', () => {
  const rendered = render('cursor');
  const texts = [
    messages.unknownApp('x', CLIENT_IDS), messages.missingApp('install', CLIENT_IDS),
    messages.appList([{ id: 'cursor', name: 'Cursor', install: true }]), messages.printConfigHint(rendered),
    messages.installManual(render('warp')), messages.installManual(render('amp')), messages.installManual(render('vscode-inputs')),
    messages.installRunning('claude mcp add'), messages.programMissing('code', 'VS Code', null),
    messages.programFailed('claude', 'Claude Code', { code: 1 }), messages.installedByCommand('Codex'),
    messages.installedFile('Cursor', { path: '/x', created: true }), messages.replacedTokenWarning('Cursor', null),
    messages.installUnchanged('Cursor', '/x'), messages.installNextSteps('Cursor'), messages.HELP,
    ...['no-folder', 'invalid-json', 'not-object', 'read-failed', 'write-failed'].map((outcome) => messages.installFileProblem(outcome, 'Cursor', '/a/b', '/a')),
  ];
  for (const text of texts) {
    assert.equal(text.search(/[^\x00-\x7f]/), -1, text);
    assert.doesNotMatch(text, TOKEN_SHAPE);
    for (const match of text.matchAll(/(?:npx -y @wisply\/mcp|wisply-mcp) ([a-z][a-z-]*)/g)) {
      assert.ok(CLI_COMMANDS.includes(match[1]), `${match[1]} in: ${text}`);
    }
  }
  assert.equal(messages.unknownApp('a\u0007b"', ['x']), 'wisply-mcp: unknown app "a?b"". Apps: x.');
  assert.match(messages.HELP, /print-config \[<app>\] \[--port <n>\]/);
  assert.match(messages.HELP, /install <app> \[--port <n>\]/);
  assert.equal(messages.PRINT_CONFIG_COMMAND, `npx -y ${PACKAGE_NAME} print-config`);
  assert.equal(messages.INSTALL_COMMAND, `npx -y ${PACKAGE_NAME} install`);
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

test('bin: print-config prints the snippet on stdout and the hint on stderr', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'wisply-bin-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const result = await bin(['print-config', 'cursor'], { HOME: home, WISPLY_MCP_TOKEN: ENV_TOKEN });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, `${render('cursor').text}\n`);
  assert.equal(result.stderr, messages.printConfigHint(render('cursor')));
  const list = await bin(['print-config'], { HOME: home });
  assert.equal(list.code, 0);
  for (const id of CLIENT_IDS) assert.ok(list.stdout.includes(`  ${id} `), id);
  const usage = await bin(['install'], { HOME: home });
  assert.equal(usage.code, 2);
  assert.equal(usage.stdout, '');
  assert.equal(usage.stderr, `${messages.missingApp('install', CLIENT_IDS)}\n`);
  if (process.platform !== 'darwin') {
    const install = await bin(['install', 'cursor'], { HOME: home });
    assert.equal(install.code, 1);
    assert.equal(install.stdout, `${messages.notMac(process.platform)}\n`);
  }
  assert.deepEqual(readdirSync(home), []);
});
