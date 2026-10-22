// server/wisply-mcp.mjs: the vendored connector as one file. It runs alone,
// it is exactly what vendor/ builds to, it answers with the editor texts of
// src/editor-messages.mjs, the environment the editor gives it can't turn on
// setup_claude, and through the sidecar it checks Wisply's identity before
// the token is sent. Also: dist/extension.js has no network code of its own.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';
import { ROOT as BUILD_ROOT, buildServerBundle, editorMessagesPlugin } from '../esbuild.mjs';
import { createProvider, serverLaunch, stringEnv } from '../out/test/provider.mjs';
import { CONNECTION_TEXT, createSidecar, describeConnection } from '../out/test/sidecar.mjs';
import { expectedProof } from '../vendor/wisply-mcp/lib/identity.mjs';
import * as vendoredMessages from '../vendor/wisply-mcp/lib/messages.mjs';
import * as messages from '../src/editor-messages.mjs';
import { FAKE_TOKENS, FakeEventEmitter, FakeMcpStdioServerDefinition } from './fixtures/fake-vscode.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BUNDLE = join(ROOT, 'server/wisply-mcp.mjs');
const CONNECTOR_TOOLS = ['list_memos', 'search_transcripts', 'get_live_transcript', 'get_action_items'];

/** The bundle copied alone into a fresh directory. */
function loneBundle(t) {
  const dir = mkdtempSync(join(tmpdir(), 'wisply-bundle-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'wisply-mcp.mjs');
  copyFileSync(BUNDLE, path);
  return { dir, path };
}

const TOOLS_LIST = Object.freeze({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
const CALL_LIST_MEMOS = Object.freeze({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_memos', arguments: {} } });

async function session(path, { args = [], env, extraEnv = {}, cwd, execArgv = [], request = TOOLS_LIST } = {}) {
  const child = spawn(process.execPath, [...execArgv, path, ...args], {
    cwd, env: env ?? { PATH: process.env.PATH, HOME: process.env.HOME ?? '/tmp', ...extraEnv }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  for (const message of [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    request,
  ]) child.stdin.write(`${JSON.stringify(message)}\n`);
  child.stdin.end();
  const [code] = await once(child, 'exit');
  const lines = stdout.split('\n').filter(Boolean);
  return { code, stderr, lines, responses: lines.map((line) => JSON.parse(line)) };
}

test('the bundle runs alone in an empty directory and lists the 4 connector tools', async (t) => {
  const { dir, path } = loneBundle(t);
  const result = await session(path, { args: ['--read-only'], cwd: dir });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.deepEqual(result.responses.map((response) => response.id), [1, 2]);
  assert.equal(result.responses[0].result.serverInfo.name, 'wisply');
  assert.deepEqual(result.responses[1].result.tools.map((tool) => tool.name), CONNECTOR_TOOLS);
  for (const tool of result.responses[1].result.tools) assert.equal(tool.annotations.readOnlyHint, true);
});

test('the bundle lists by scope: full access 8, 9 with --allow-claude-setup, --read-only 4', async (t) => {
  const { dir, path } = loneBundle(t);
  const full = await session(path, { cwd: dir, extraEnv: { WISPLY_MCP_TOKEN: FAKE_TOKENS.full } });
  assert.equal(full.responses[1].result.tools.length, 8);
  assert.equal(full.responses[1].result.tools.some((tool) => tool.name === 'setup_claude'), false);
  const claude = await session(path, { cwd: dir, args: ['--allow-claude-setup'], extraEnv: { WISPLY_MCP_TOKEN: FAKE_TOKENS.full } });
  assert.equal(claude.responses[1].result.tools.length, 9);
  const readOnly = await session(path, { cwd: dir, args: ['--read-only'], extraEnv: { WISPLY_MCP_TOKEN: FAKE_TOKENS.full } });
  assert.deepEqual(readOnly.responses[1].result.tools.map((tool) => tool.name), CONNECTOR_TOOLS);
});

/**
 * The environment an editor gives a server it starts: its own (the
 * extension host's), with the definition's env on top; null removes
 * (McpStdioServerDefinition.env).
 */
function editorEnv(hostEnv, definitionEnv) {
  const env = { ...hostEnv };
  for (const [key, value] of Object.entries(definitionEnv)) {
    if (value === null) delete env[key];
    else env[key] = String(value);
  }
  return env;
}

/** A user who exported these in their shell for another AI app (on macOS VS Code takes the login shell's env). */
const EXPORTED = Object.freeze({
  PATH: process.env.PATH, HOME: process.env.HOME ?? '/tmp', WISPLY_MCP_ALLOW_CLAUDE_SETUP: '1',
  WISPLY_MCP_TOKEN: `wsp_${'1b'.repeat(32)}`, WISPLY_MCP_DEBUG: '1', NODE_OPTIONS: '--require /nonexistent/preload.js',
});

test('an exported WISPLY_MCP_ALLOW_CLAUDE_SETUP=1 doesn\'t reach the server VS Code starts: only the setting decides', async (t) => {
  const { dir, path } = loneBundle(t);
  let stored = { token: FAKE_TOKENS.full, scope: 'full' };
  const provider = createProvider({ McpStdioServerDefinition: FakeMcpStdioServerDefinition }, {
    platform: 'darwin',
    getLaunch: () => ({ execPath: process.execPath, serverPath: path, port: 51771, allowClaudeSetup: false, extVersion: '0.1.0' }),
    getToken: async () => stored,
    promptForToken: async () => undefined,
    storeToken: async (value) => { stored = value; },
    createEmitter: () => new FakeEventEmitter(),
  });
  const [provided] = await provider.provider.provideMcpServerDefinitions({ isCancellationRequested: false });
  const resolved = await provider.provider.resolveMcpServerDefinition(provided, { isCancellationRequested: false });
  const env = editorEnv(EXPORTED, resolved.env);
  assert.equal(env.WISPLY_MCP_TOKEN, FAKE_TOKENS.full, 'the token from SecretStorage, not the exported one');
  for (const key of ['WISPLY_MCP_ALLOW_CLAUDE_SETUP', 'WISPLY_MCP_DEBUG', 'NODE_OPTIONS']) assert.equal(Object.hasOwn(env, key), false, key);
  const result = await session(resolved.args[0], { cwd: dir, env, args: resolved.args.slice(1) });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.responses[1].result.tools.length, 8);
  assert.equal(result.responses[1].result.tools.some((tool) => tool.name === 'setup_claude'), false);

  // Without the stored token, the exported one is removed too: tools/list falls back to the 4 read-only tools.
  stored = null;
  const [bare] = await provider.provider.provideMcpServerDefinitions({ isCancellationRequested: false });
  const noToken = await session(path, { cwd: dir, env: editorEnv(EXPORTED, bare.env) });
  assert.deepEqual(noToken.responses[1].result.tools.map((tool) => tool.name), CONNECTOR_TOOLS);
});

test('the same holds for Cursor\'s string-only config: empty values count as unset', async (t) => {
  const { dir, path } = loneBundle(t);
  const { args, env } = serverLaunch({ execPath: process.execPath, serverPath: path, port: 51771, allowClaudeSetup: false }, 'keychain');
  const result = await session(path, { cwd: dir, args: args.slice(1), env: { ...EXPORTED, ...stringEnv(env) } });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.deepEqual(result.responses[1].result.tools.map((tool) => tool.name), CONNECTOR_TOOLS);
});

test('the bundle answers with the editor texts: the extension\'s commands, never npx', async (t) => {
  const { dir, path } = loneBundle(t);
  // The overlay replaces the texts that say where the token comes from (the
  // setup terminal's are covered below).
  for (const name of ['SETUP', 'MALFORMED']) {
    assert.notEqual(messages[name], vendoredMessages[name], name);
    assert.match(messages[name], /Wisply: Set Token from the Command Palette/);
    assert.match(messages[name], /Wisply: Store Token in the Mac Keychain/);
  }
  assert.notEqual(messages.notWisply(51771), vendoredMessages.notWisply(51771));
  assert.equal(messages.unavailable(51771), vendoredMessages.unavailable(51771), 'everything else is the vendored text');
  for (const text of [messages.SETUP, messages.MALFORMED, messages.notWisply(51771)]) {
    assert.doesNotMatch(text, /npx|@wisply\/mcp|wisply-mcp setup/);
    assert.match(text, /^[\x20-\x7e]+$/, 'ASCII only');
  }

  const malformed = await session(path, { cwd: dir, extraEnv: { WISPLY_MCP_TOKEN: 'not-a-token' }, request: CALL_LIST_MEMOS });
  assert.equal(malformed.responses[1].result.isError, true);
  assert.equal(malformed.responses[1].result.content[0].text, messages.MALFORMED);
});

// macOS with no token anywhere. Simulated off macOS only: on a Mac the
// connector would read the developer's own Keychain.
const wouldTouchKeychain = process.platform === 'darwin' || existsSync('/usr/bin/security');
test('with no token, the bundle sends chat the editor\'s SETUP, and Check Connection turns it into its steps', { skip: wouldTouchKeychain }, async (t) => {
  const { dir, path } = loneBundle(t);
  const asMac = `data:text/javascript,${encodeURIComponent("Object.defineProperty(process, 'platform', { value: 'darwin' });")}`;
  const result = await session(path, { cwd: dir, execArgv: ['--import', asMac], request: CALL_LIST_MEMOS });
  assert.equal(result.code, 0, result.stderr);
  const answer = { kind: 'result', result: result.responses[1].result };
  assert.equal(answer.result.content[0].text, messages.SETUP);
  assert.deepEqual(describeConnection(answer, { port: 51771, stored: null, allowClaudeSetup: false }),
    { kind: 'setup', text: CONNECTION_TEXT.setup });
});

test('the bundle is exactly what vendor/ builds to', async () => {
  const rebuilt = Buffer.from(await buildServerBundle({ write: false }));
  assert.ok(rebuilt.equals(readFileSync(BUNDLE)), 'run node esbuild.mjs --server (or npm run sync-vendor) and commit');
});

test('the bundle imports only Node built-ins', () => {
  const text = readFileSync(BUNDLE, 'utf8');
  const specifiers = [...text.matchAll(/^\s*import\s[^;]*?from\s+"([^"]+)"/gm)].map((match) => match[1]);
  assert.ok(specifiers.length > 0);
  for (const specifier of specifiers) assert.match(specifier, /^node:/, specifier);
  assert.doesNotMatch(text, /\bimport\(/, 'no dynamic import');
  assert.ok(text.startsWith('#!/usr/bin/env node\n// GENERATED by scripts/sync-vendor.mjs'));
});

test('dist/extension.js has no network code: only vscode and child_process are required', () => {
  const text = readFileSync(join(ROOT, 'dist/extension.js'), 'utf8');
  const required = [...new Set([...text.matchAll(/\brequire\("([^"]+)"\)/g)].map((match) => match[1]))].sort();
  assert.deepEqual(required, ['node:child_process', 'vscode']);
  assert.doesNotMatch(text, /\bfetch\(|XMLHttpRequest|WebSocket\(/);
  assert.doesNotMatch(text, /wsp[cr]?_[0-9a-f]{64}/);
});

/** What Wisply answers the identity check with when it can read none of its tokens (MCPServer+Identity.swift). */
const WISPLY_KEYCHAIN_503 = 'MCP tokens are unavailable. Check Keychain access in Wisply.';

/**
 * A synthetic Wisply on a system-assigned port. `impostor` proves the wrong
 * token; `keychainFailure` answers the identity check as a Wisply that
 * couldn't read its tokens from the Keychain.
 */
async function startFakeWisply(t, { impostor = false, keychainFailure = false } = {}) {
  const seen = { challenges: [], calls: [] };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const port = server.address().port;
    if (url.pathname === '/mcp/identity') {
      const nonce = url.searchParams.get('nonce');
      seen.challenges.push({ authorization: req.headers.authorization });
      if (keychainFailure) {
        res.writeHead(503, { 'Content-Type': 'text/plain' });
        res.end(WISPLY_KEYCHAIN_503);
        return;
      }
      const proven = impostor ? `wspc_${'99'.repeat(32)}` : FAKE_TOKENS.connector;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ server: 'wisply', scheme: 'wisply-mcp-identity-v1', port, nonce,
        proofs: { connector: expectedProof(proven, port, nonce).toString('hex') } }));
      return;
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    const message = JSON.parse(body);
    seen.calls.push({ authorization: req.headers.authorization, message });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {
      content: [{ type: 'text', text: '{"memos":[]}' }], structuredContent: { memos: [], count: 0 }, isError: false,
    } }));
  });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise((resolve) => { server.close(resolve); }));
  return { port: server.address().port, seen };
}

test('end to end: sidecar -> bundle -> Wisply, identity first, then the bearer', async (t) => {
  const wisply = await startFakeWisply(t);
  const { path } = loneBundle(t);
  const sidecar = createSidecar({
    execPath: process.execPath, serverPath: path, getPort: () => wisply.port,
    getToken: async () => FAKE_TOKENS.connector, hostEnv: { PATH: process.env.PATH, HOME: process.env.HOME },
  });
  t.after(() => sidecar.dispose());
  const answer = await sidecar.call('list_memos', { limit: 1 }, 10000);
  assert.equal(answer.kind, 'result', JSON.stringify(answer));
  assert.deepEqual(answer.result.structuredContent, { memos: [], count: 0 });
  assert.equal(wisply.seen.challenges.length, 1);
  assert.equal(wisply.seen.challenges[0].authorization, undefined, 'the challenge carries no token');
  assert.equal(wisply.seen.calls.length, 1);
  assert.equal(wisply.seen.calls[0].authorization, `Bearer ${FAKE_TOKENS.connector}`);
  assert.deepEqual(wisply.seen.calls[0].message.params, { name: 'list_memos', arguments: { limit: 1 } });
  assert.equal(describeConnection(answer, { port: wisply.port, stored: 'connector', allowClaudeSetup: false }).text,
    `Wisply answered on 127.0.0.1:${wisply.port} and proved its identity. Read-only connector token: 4 tools.`);

  // --read-only: the sidecar can't reach a tool with side effects, whatever the token.
  const refused = await sidecar.call('start_recording', {}, 10000);
  assert.equal(refused.result.isError, true);
  assert.equal(wisply.seen.calls.length, 1);
});

test('end to end: an impostor on the port never sees the token', async (t) => {
  const impostor = await startFakeWisply(t, { impostor: true });
  const { path } = loneBundle(t);
  const sidecar = createSidecar({
    execPath: process.execPath, serverPath: path, getPort: () => impostor.port,
    getToken: async () => FAKE_TOKENS.connector, hostEnv: { PATH: process.env.PATH },
  });
  t.after(() => sidecar.dispose());
  const answer = await sidecar.call('list_memos', { limit: 1 }, 15000);
  assert.equal(answer.kind, 'result');
  assert.equal(answer.result.isError, true);
  assert.equal(answer.result.content[0].text, messages.notWisply(impostor.port));
  assert.equal(impostor.seen.calls.length, 0);
  assert.ok(impostor.seen.challenges.length >= 1);
  assert.ok(impostor.seen.challenges.every((challenge) => challenge.authorization === undefined));
  assert.deepEqual(describeConnection(answer, { port: impostor.port, stored: 'connector', allowClaudeSetup: false }),
    { kind: 'problem', text: messages.notWisply(impostor.port) });
});

test('the 503 advice never asks to approve a Keychain dialog that doesn\'t name Wisply', () => {
  // Any program on the port can send that 503, so the text must not help it
  // get a Keychain dialog of its own approved.
  const text = messages.keychainUnavailable(51771);
  assert.notEqual(text, vendoredMessages.keychainUnavailable(51771));
  assert.match(text, /allow it only when the dialog names Wisply/);
  assert.doesNotMatch(text, /allow Keychain access if macOS asks/);
  assert.equal(messages.identityProblem('keychain', 51771), text);
  assert.equal(messages.identityProblem('keychain', 51771, { terminal: true }), text);
});

test('end to end: a Wisply that can\'t read its Keychain gets no token, and Check Connection says what to do', async (t) => {
  const wisply = await startFakeWisply(t, { keychainFailure: true });
  const { path } = loneBundle(t);
  const sidecar = createSidecar({
    execPath: process.execPath, serverPath: path, getPort: () => wisply.port,
    getToken: async () => FAKE_TOKENS.connector, hostEnv: { PATH: process.env.PATH },
  });
  t.after(() => sidecar.dispose());
  const answer = await sidecar.call('list_memos', { limit: 1 }, 15000);
  assert.equal(answer.kind, 'result', JSON.stringify(answer));
  assert.equal(answer.result.isError, true);
  assert.equal(answer.result.content[0].text, messages.keychainUnavailable(wisply.port));
  assert.equal(wisply.seen.calls.length, 0, 'the token is kept back');
  assert.ok(wisply.seen.challenges.every((challenge) => challenge.authorization === undefined));
  assert.deepEqual(describeConnection(answer, { port: wisply.port, stored: 'connector', allowClaudeSetup: false }),
    { kind: 'problem', text: messages.keychainUnavailable(wisply.port) });
});

test('every text the bundled bridge can send to chat names neither npx, the npm package nor a connector command', () => {
  // The bridge's texts, as it names them (messages.<name>), resolved through
  // the overlay the bundle uses. A re-vendor that adds an npm or CLI step to
  // one of them must overlay it in src/editor-messages.mjs (its header says why).
  const bridge = readFileSync(join(ROOT, 'vendor/wisply-mcp/lib/bridge.mjs'), 'utf8');
  const names = [...new Set([...bridge.matchAll(/\bmessages\.([A-Za-z_]\w*)/g)].map((match) => match[1]))]
    .filter((name) => name !== 'mjs').sort();
  for (const name of ['SETUP', 'MALFORMED', 'notWisply', 'keychainUnavailable', 'UPDATE_WISPLY_SCOPE', 'unavailable']) {
    assert.ok(names.includes(name), `${name} is one of the bridge's texts`);
  }
  const texts = (value) => {
    if (typeof value === 'string') return [value];
    if (typeof value === 'function') return [String(value(51771)), String(value('list_memos', 'connector'))];
    if (value && typeof value === 'object') return Object.values(value).flatMap(texts);
    return [];
  };
  for (const name of names) {
    assert.ok(Object.hasOwn(messages, name), `src/editor-messages.mjs exports ${name}`);
    for (const text of texts(messages[name])) {
      assert.doesNotMatch(text, /npx|@wisply\/mcp|wisply-mcp (setup|status|forget)/, `${name}: ${text}`);
      assert.match(text, /^[\x20-\x7e\n]*$/, `${name} is ASCII`);
    }
  }
});

test('end to end through the extension: Set Token stores the token and checks the connection', async (t) => {
  const wisply = await startFakeWisply(t);
  const { activateExtension } = await import('../out/test/extension.mjs');
  const { createFakeContext, createFakeSecrets, createFakeVscode } = await import('./fixtures/fake-vscode.mjs');
  const secrets = createFakeSecrets();
  const vs = createFakeVscode({ config: { port: { globalValue: wisply.port } }, inputs: [FAKE_TOKENS.connector] });
  const context = createFakeContext({ root: ROOT, secrets, state: { 'wisply.welcomeShown': true } });
  const activation = activateExtension(vs, context, {
    execPath: process.execPath, platform: 'darwin', hostEnv: { PATH: process.env.PATH, HOME: process.env.HOME },
  });
  t.after(() => activation.dispose());
  await vs.commands.run('wisply.setToken');
  assert.equal(secrets.values.get('wisply.mcpToken'), FAKE_TOKENS.connector);
  const info = vs.log.filter((entry) => entry.kind === 'info').map((entry) => entry.text);
  assert.deepEqual(info, [
    "Saved the read-only connector token in this editor's secret storage. " +
    `Wisply answered on 127.0.0.1:${wisply.port} and proved its identity. Read-only connector token: 4 tools.`,
  ]);
  assert.equal(wisply.seen.calls.length, 1);
  assert.equal(wisply.seen.calls[0].authorization, `Bearer ${FAKE_TOKENS.connector}`);

  // Check Connection again: same sidecar child, one more call.
  await vs.commands.run('wisply.checkConnection');
  assert.equal(wisply.seen.calls.length, 2);
  assert.equal(vs.log.filter((entry) => entry.kind === 'info').length, 2);
  assert.equal(wisply.seen.challenges.every((challenge) => challenge.authorization === undefined), true);
});

test('end to end in Cursor: the check passes and points to the Keychain, which Cursor\'s server reads', async (t) => {
  const wisply = await startFakeWisply(t);
  const { BUTTONS, TEXT, activateExtension } = await import('../out/test/extension.mjs');
  const { createFakeContext, createFakeSecrets, createFakeVscode } = await import('./fixtures/fake-vscode.mjs');
  const vs = createFakeVscode({ mcp: false, cursor: true, appName: 'Cursor', config: { port: { globalValue: wisply.port } },
    inputs: [FAKE_TOKENS.connector] });
  const context = createFakeContext({ root: ROOT, secrets: createFakeSecrets(), state: { 'wisply.welcomeShown': true } });
  const activation = activateExtension(vs, context, {
    execPath: process.execPath, platform: 'darwin', hostEnv: { PATH: process.env.PATH, HOME: process.env.HOME },
  });
  t.after(() => activation.dispose());
  assert.equal(activation.mode, 'cursor');
  await vs.commands.run('wisply.setToken');
  const [info] = vs.log.filter((entry) => entry.kind === 'info');
  assert.ok(info.text.endsWith(TEXT.keychainHint), info.text);
  assert.ok(info.text.includes('proved its identity'), info.text);
  assert.deepEqual(info.buttons, [BUTTONS.storeInKeychain]);
  // Cursor's registration never got the token.
  assert.doesNotMatch(JSON.stringify(vs.cursor.mcp.registered), /wsp[cr]?_[0-9a-f]{64}/);
});

// --- The setup terminal (Wisply: Store Token in the Mac Keychain) ----------

/**
 * lib/cli.mjs as the bundle has it: built with the same overlay plugin, so
 * runCli can be driven through every path of `setup` with fakes for the
 * Keychain and Wisply. The terminal runs the bundle itself, so a text naming
 * `wisply-mcp setup` (or `--full-access`, `forget`) would send the user to a
 * command that doesn't exist in the editor.
 */
async function overlaidCli(t) {
  const result = await esbuild.build({
    absWorkingDir: BUILD_ROOT, entryPoints: ['vendor/wisply-mcp/lib/cli.mjs'], plugins: [editorMessagesPlugin()],
    bundle: true, platform: 'node', format: 'esm', target: 'node20', write: false, logLevel: 'silent',
  });
  const dir = mkdtempSync(join(tmpdir(), 'wisply-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'cli.mjs');
  writeFileSync(file, result.outputFiles[0].contents);
  return import(pathToFileURL(file).href);
}

/**
 * One `setup` run. `deletes` is what each delete-generic-password run answers
 * ('deleted', 'not-found' or 'failed'), in order; then 'not-found'.
 */
async function runSetup(cli, { platform = 'darwin', isTTY = true, deletes = [], write = 'written', read, outcome = 'ok' } = {}) {
  const queue = [...deletes];
  let output = '';
  const code = await cli.runCli(['setup', '--port', '51771'], {
    env: {}, platform, isTTY,
    out: (text) => { output += text; },
    err: (text) => { output += text; },
    deleteKeychain: async () => queue.shift() ?? 'not-found',
    writeKeychain: async () => write,
    readKeychain: async () => {
      if (read instanceof Error) throw read;
      return read;
    },
    createLoopback: () => ({ identity: async () => ({ outcome }) }),
  });
  return { code, output };
}

test('every text the setup terminal can print points to the extension\'s commands, never to wisply-mcp or npx', async (t) => {
  const cli = await overlaidCli(t);
  const runs = {
    notMac: await runSetup(cli, { platform: 'linux' }),
    noTerminal: await runSetup(cli, { isTTY: false }),
    replaceFailed: await runSetup(cli, { deletes: ['failed'] }),
    cancelled: await runSetup(cli, { write: 'cancelled' }),
    cancelledAfterRemoval: await runSetup(cli, { deletes: ['deleted'], write: 'cancelled' }),
    notStored: await runSetup(cli, { write: 'failed' }),
    notStoredAfterRemoval: await runSetup(cli, { deletes: ['deleted'], write: 'failed' }),
    readBackFailed: await runSetup(cli, { read: new Error('no item') }),
    malformed: await runSetup(cli, { read: 'not-a-token' }),
    fullAccess: await runSetup(cli, { read: FAKE_TOKENS.full }),
    removeFailedFull: await runSetup(cli, { read: FAKE_TOKENS.full, deletes: ['not-found', 'failed'] }),
    removeFailedMalformed: await runSetup(cli, { read: 'not-a-token', deletes: ['not-found', 'failed'] }),
    removeFailedUnreadable: await runSetup(cli, { read: new Error('no item'), deletes: ['not-found', 'failed'] }),
  };
  for (const outcome of ['ok', 'unavailable', 'not-wisply', 'old-wisply', 'missing-scope', 'keychain']) {
    runs[`identity:${outcome}`] = await runSetup(cli, { read: FAKE_TOKENS.connector, outcome });
  }

  for (const [name, { output }] of Object.entries(runs)) {
    assert.ok(output.length > 0, name);
    assert.doesNotMatch(output, /wisply-mcp|npx|@wisply\/mcp|--full-access/, `${name}: ${output}`);
    assert.match(output, /^[\x20-\x7e\n]*$/, `${name} is ASCII`);
  }
  // The overlay's texts are the ones printed.
  assert.ok(runs.fullAccess.output.includes(messages.FULL_ACCESS_REFUSED));
  assert.match(messages.FULL_ACCESS_REFUSED, /Wisply: Store Token in the Mac Keychain again/);
  assert.match(messages.FULL_ACCESS_REFUSED, /use Wisply: Set Token instead/);
  assert.ok(runs.malformed.output.includes(messages.SETUP_MALFORMED));
  assert.ok(runs.readBackFailed.output.includes(messages.READ_BACK_FAILED));
  assert.ok(runs.notStored.output.includes(messages.KEYCHAIN_NOT_STORED));
  assert.ok(runs.notStoredAfterRemoval.output.includes(messages.PREVIOUS_REMOVED));
  assert.ok(runs.replaceFailed.output.includes(messages.REPLACE_FAILED));
  assert.ok(runs.noTerminal.output.includes(messages.SETUP_NEEDS_TERMINAL));
  for (const reason of ['full-access', 'malformed', 'unreadable']) {
    const key = { 'full-access': 'removeFailedFull', malformed: 'removeFailedMalformed', unreadable: 'removeFailedUnreadable' }[reason];
    assert.ok(runs[key].output.includes(messages.removeFailed(reason)), reason);
    assert.match(messages.removeFailed(reason), /Keychain Access/);
  }
  assert.ok(runs['identity:not-wisply'].output.includes(messages.notWisply(51771)));
  assert.ok(runs['identity:keychain'].output.includes(messages.keychainUnavailable(51771)));
  assert.equal(runs['identity:ok'].code, 0);
  for (const [name, run] of Object.entries(runs)) if (name !== 'identity:ok') assert.equal(run.code, 1, name);

  // The vendored texts it replaces named the connector's commands.
  for (const name of ['FULL_ACCESS_REFUSED', 'SETUP_MALFORMED', 'READ_BACK_FAILED', 'KEYCHAIN_NOT_STORED', 'PREVIOUS_REMOVED',
    'REPLACE_FAILED', 'SETUP_NEEDS_TERMINAL', 'FULL_ACCESS_SHARED']) {
    assert.match(vendoredMessages[name], /wisply-mcp/, name);
    assert.doesNotMatch(messages[name], /wisply-mcp|npx|--full-access/, name);
  }
});
