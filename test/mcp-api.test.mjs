// src/mcp-api.ts detection, src/cursor.ts, and how activation picks between
// VS Code's MCP API, Cursor's API and the manual notice.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getMcpApi } from '../out/test/mcp-api.mjs';
import { CURSOR_SERVER_NAME, cursorServerConfig, getCursorMcp, registerWithCursor } from '../out/test/cursor.mjs';
import {
  BUTTONS, COMMANDS, SETUP_GUIDE_URL, STATE_KEYS, TEXT, activateExtension, manualConfig,
} from '../out/test/extension.mjs';
import {
  FAKE_TOKENS, FakeMcpStdioServerDefinition, createFakeContext, createFakeSecrets, createFakeVscode,
} from './fixtures/fake-vscode.mjs';

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const TOKEN_SHAPED = /wsp[cr]?_[0-9a-f]{64}/;
const EXEC = '/Applications/Cursor.app/Contents/Frameworks/Cursor Helper (Plugin).app/Contents/MacOS/Cursor Helper (Plugin)';
const ROOT = '/Users/someone/.cursor/extensions/wisply.wisply-0.1.0';
const SERVER = `${ROOT}/server/wisply-mcp.mjs`;
const HOST_ENV = Object.freeze({
  HOME: '/Users/someone', PATH: '/usr/bin', USER: 'someone', LANG: 'en_US.UTF-8',
  NODE_OPTIONS: '--require /Users/someone/.debug/bootloader.js', WISPLY_MCP_TOKEN: FAKE_TOKENS.full,
  WISPLY_MCP_ALLOW_CLAUDE_SETUP: '1', SENTINEL_PARENT_ONLY: 'leak',
});
/** Cursor's config: strings only, so the variables the connector must not inherit are empty. */
const CURSOR_ENV = Object.freeze({
  ELECTRON_RUN_AS_NODE: '1', WISPLY_MCP_PORT: '51771', WISPLY_MCP_TOKEN: '', WISPLY_MCP_ALLOW_CLAUDE_SETUP: '',
  WISPLY_MCP_DEBUG: '', NODE_OPTIONS: '',
});
const activate = (vs, context, deps = {}) =>
  activateExtension(vs, context, { execPath: EXEC, platform: 'darwin', hostEnv: HOST_ENV, ...deps });

/** Sample arguments for the texts that take one. */
const SAMPLE_ARGS = Object.freeze({
  saved: ['connector', 'full'], welcomeCursor: ['Cursor', 'Windsurf'], forgotten: ['provider', 'cursor', 'manual'],
  ok: [51771], tools: [],
});

/** Every text of a text table, functions called with their sample arguments. */
function everyText(table, prefix) {
  return Object.entries(table).flatMap(([name, value]) => {
    if (typeof value === 'string') return [[`${prefix}.${name}`, value]];
    assert.ok(Object.hasOwn(SAMPLE_ARGS, name), `sample arguments for ${prefix}.${name}`);
    return SAMPLE_ARGS[name].map((arg) => [`${prefix}.${name}(${arg})`, String(value(arg))]);
  });
}

test('getMcpApi needs both registerMcpServerDefinitionProvider and McpStdioServerDefinition', () => {
  assert.equal(getMcpApi(undefined), null);
  assert.equal(getMcpApi({}), null);
  assert.equal(getMcpApi({ lm: {} , McpStdioServerDefinition: FakeMcpStdioServerDefinition }), null);
  assert.equal(getMcpApi({ lm: { registerMcpServerDefinitionProvider: 'no' }, McpStdioServerDefinition: FakeMcpStdioServerDefinition }), null);
  assert.equal(getMcpApi({ lm: { registerMcpServerDefinitionProvider() {} } }), null);
  assert.equal(getMcpApi({ lm: { registerMcpServerDefinitionProvider() {} }, McpStdioServerDefinition: {} }), null);
  const api = getMcpApi(createFakeVscode());
  assert.ok(api);
  assert.equal(api.McpStdioServerDefinition, FakeMcpStdioServerDefinition);
});

test('getMcpApi calls register on vscode.lm', () => {
  const vs = createFakeVscode();
  const api = getMcpApi(vs);
  const disposable = api.registerMcpServerDefinitionProvider('wisply.local', { provideMcpServerDefinitions: () => [] });
  assert.ok(vs.lm.providers.has('wisply.local'));
  disposable.dispose();
  assert.equal(vs.lm.providers.has('wisply.local'), false);
});

test('getCursorMcp finds vscode.cursor.mcp.registerServer only', () => {
  assert.equal(getCursorMcp(createFakeVscode()), null);
  assert.equal(getCursorMcp({ cursor: {} }), null);
  assert.equal(getCursorMcp({ cursor: { mcp: { registerServer: 1 } } }), null);
  assert.ok(getCursorMcp(createFakeVscode({ mcp: false, cursor: true })));
});

test('the Cursor config runs the bundled connector read-only and holds no token', () => {
  const config = cursorServerConfig({ execPath: EXEC, serverPath: SERVER, port: 51771, allowClaudeSetup: false });
  assert.deepEqual(config, { name: 'wisply', server: { command: EXEC, args: [SERVER, '--read-only'], env: CURSOR_ENV } });
  assert.equal(CURSOR_SERVER_NAME, 'wisply');
  // The token comes from the Keychain, unconfirmed and of unknown scope: only
  // the read-only memo tools, so the setup_claude opt-in has nothing to add.
  const mcp = createFakeVscode({ mcp: false, cursor: true }).cursor.mcp;
  const registration = registerWithCursor(mcp, { execPath: EXEC, serverPath: SERVER, port: 51772, allowClaudeSetup: true });
  assert.deepEqual(mcp.registered[0].server.args, [SERVER, '--read-only']);
  assert.equal(mcp.registered[0].server.env.WISPLY_MCP_PORT, '51772');
  registration.dispose();
  registration.dispose();
});

test('with VS Code\'s MCP API: the provider is registered, Cursor\'s API is not used', async () => {
  const vs = createFakeVscode({ cursor: true });
  const context = createFakeContext({ root: ROOT });
  const activation = activate(vs, context);
  await activation.noticesDone;
  assert.equal(activation.mode, 'provider');
  assert.ok(vs.lm.providers.has('wisply.local'));
  assert.equal(vs.cursor.mcp.registered.length, 0);
  const provider = vs.lm.providers.get('wisply.local');
  const [definition] = await provider.provideMcpServerDefinitions({ isCancellationRequested: false });
  assert.equal(definition.command, EXEC);
  // No token set: the server will use the Keychain item, read-only.
  assert.deepEqual(definition.args, [SERVER, '--read-only']);
  activation.dispose();
  assert.equal(vs.lm.providers.has('wisply.local'), false);
});

test('without it, Cursor\'s registerServer gets the connector with no token, even when one is stored', async () => {
  const secrets = createFakeSecrets({ 'wisply.mcpToken': FAKE_TOKENS.connector });
  const vs = createFakeVscode({ mcp: false, cursor: true, appName: 'Cursor' });
  const context = createFakeContext({ root: ROOT, secrets });
  const activation = activate(vs, context);
  await activation.noticesDone;
  assert.equal(activation.mode, 'cursor');
  assert.equal(vs.cursor.mcp.registered.length, 1);
  const [config] = vs.cursor.mcp.registered;
  assert.deepEqual(config, { name: 'wisply', server: { command: EXEC, args: [SERVER, '--read-only'], env: CURSOR_ENV } });
  assert.doesNotMatch(JSON.stringify(vs.log), TOKEN_SHAPED);
  activation.dispose();
  assert.ok(vs.log.some((entry) => entry.kind === 'cursorUnregister' && entry.name === 'wisply'));
});

test('a settings change re-registers with Cursor', async () => {
  const vs = createFakeVscode({ mcp: false, cursor: true });
  const activation = activate(vs, createFakeContext({ root: ROOT }));
  vs.changeConfiguration({ port: { globalValue: 51772 } });
  assert.equal(vs.cursor.mcp.registered.length, 2);
  assert.equal(vs.cursor.mcp.registered[1].server.env.WISPLY_MCP_PORT, '51772');
  assert.equal(vs.log.filter((entry) => entry.kind === 'cursorUnregister').length, 1);
  // Unrelated or workspace-only changes don't.
  vs.changeConfiguration({}, () => false);
  vs.changeConfiguration({ port: { globalValue: 51772, workspaceValue: 1 } });
  assert.equal(vs.cursor.mcp.registered.length, 2);
  activation.dispose();
});

test('Cursor\'s first-run notice offers the Keychain setup', async () => {
  const vs = createFakeVscode({ mcp: false, cursor: true, appName: 'Cursor' });
  const context = createFakeContext({ root: ROOT });
  const activation = activate(vs, context);
  await activation.noticesDone;
  const notice = vs.log.find((entry) => entry.kind === 'info');
  assert.equal(notice.text, TEXT.welcomeCursor('Cursor'));
  assert.deepEqual(notice.buttons, [BUTTONS.storeInKeychain, BUTTONS.notNow]);
  assert.equal(context.globalState.get(STATE_KEYS.welcomed), true);
  activation.dispose();
});

test('neither API: one notice offers the token-free config, once', async () => {
  const vs = createFakeVscode({ mcp: false, answers: { "MCP settings": BUTTONS.copyConfig } });
  const context = createFakeContext({ root: ROOT });
  const activation = activate(vs, context);
  await activation.noticesDone;
  assert.equal(activation.mode, 'manual');
  const notice = vs.log.find((entry) => entry.kind === 'info');
  assert.equal(notice.text, "Add Wisply to this editor's MCP settings.");
  assert.deepEqual(notice.buttons, [BUTTONS.copyConfig, BUTTONS.openSetupGuide]);
  const copied = vs.log.find((entry) => entry.kind === 'clipboard');
  assert.equal(copied.text, manualConfig({ execPath: EXEC, serverPath: SERVER, port: 51771, allowClaudeSetup: false }));
  // The connector bundled in the extension, on the editor's Node: no npm package, no npx.
  const entry = JSON.parse(copied.text);
  assert.deepEqual(entry, {
    mcpServers: {
      wisply: {
        command: EXEC,
        args: [SERVER, '--read-only'],
        env: { ELECTRON_RUN_AS_NODE: '1', WISPLY_MCP_PORT: '51771', WISPLY_MCP_ALLOW_CLAUDE_SETUP: '', WISPLY_MCP_DEBUG: '', NODE_OPTIONS: '' },
      },
    },
  });
  assert.doesNotMatch(copied.text, /npx|@wisply\/mcp/);
  assert.doesNotMatch(copied.text, TOKEN_SHAPED);
  assert.ok(vs.log.some((logged) => logged.kind === 'info' && logged.text === TEXT.copied));
  activation.dispose();

  const again = createFakeVscode({ mcp: false });
  await activate(again, context).noticesDone;
  assert.equal(again.log.some((logged) => logged.kind === 'info'), false);
});

test('the welcome notice: once, only without a token, only on macOS', async () => {
  const vs = createFakeVscode();
  const context = createFakeContext({ root: ROOT });
  await activate(vs, context).noticesDone;
  const notice = vs.log.find((entry) => entry.kind === 'info');
  assert.equal(notice.text, "Wisply can connect VS Code's AI chat to the Wisply app on this Mac. Set a token to start.");
  assert.deepEqual(notice.buttons, ['Set Token…', 'Not Now']);

  const second = createFakeVscode();
  await activate(second, context).noticesDone;
  assert.equal(second.log.some((entry) => entry.kind === 'info'), false);

  const withToken = createFakeVscode();
  await activate(withToken, createFakeContext({ root: ROOT, secrets: createFakeSecrets({ 'wisply.mcpToken': FAKE_TOKENS.connector }) })).noticesDone;
  assert.equal(withToken.log.some((entry) => entry.kind === 'info'), false);

  const linux = createFakeVscode();
  await activate(linux, createFakeContext({ root: ROOT }), { platform: 'linux' }).noticesDone;
  assert.equal(linux.log.some((entry) => entry.kind === 'info'), false);
});

test('activation registers exactly the commands package.json declares', () => {
  const vs = createFakeVscode();
  const activation = activate(vs, createFakeContext({ root: ROOT }));
  const declared = manifest.contributes.commands.map((command) => command.command).sort();
  assert.deepEqual(vs.commands.registered(), declared);
  assert.deepEqual(Object.values(COMMANDS).sort(), declared);
  activation.dispose();
  assert.deepEqual(vs.commands.registered(), []);
});

test('Open Setup Guide and Store Token in the Mac Keychain…', async () => {
  const vs = createFakeVscode();
  const activation = activate(vs, createFakeContext({ root: ROOT }));
  await vs.commands.run(COMMANDS.openSetupGuide);
  assert.ok(vs.log.some((entry) => entry.kind === 'openExternal' && entry.uri === SETUP_GUIDE_URL));
  assert.equal(SETUP_GUIDE_URL, 'https://www.wisply.ai/docs/mcp/install#vscode');
  vs.commands.run(COMMANDS.storeTokenInKeychain);
  const terminal = vs.log.find((entry) => entry.kind === 'createTerminal');
  // A complete environment of its own (strictEnv): nothing else from the
  // window, the user's terminal settings or other extensions, so no
  // NODE_OPTIONS reaches the process that handles the token.
  assert.deepEqual(terminal.options, {
    name: 'Wisply setup',
    shellPath: EXEC,
    shellArgs: [SERVER, 'setup', '--port', '51771'],
    env: {
      ELECTRON_RUN_AS_NODE: '1', PATH: '/usr/bin:/bin:/usr/sbin:/sbin', TERM: 'xterm-256color',
      HOME: '/Users/someone', USER: 'someone', LANG: 'en_US.UTF-8',
    },
    strictEnv: true,
  });
  assert.ok(vs.log.some((entry) => entry.kind === 'terminalShown'));
  activation.dispose();
});

test('Forget Token clears SecretStorage and says what stays in the Keychain', async () => {
  const secrets = createFakeSecrets({ 'wisply.mcpToken': FAKE_TOKENS.connector });
  const vs = createFakeVscode();
  const activation = activate(vs, createFakeContext({ root: ROOT, secrets }));
  await vs.commands.run(COMMANDS.forgetToken);
  assert.equal(secrets.values.has('wisply.mcpToken'), false);
  assert.ok(vs.log.some((entry) => entry.kind === 'info' && entry.text === TEXT.forgotten('provider')));
  // A running server keeps the token until it restarts, and the text says so.
  assert.match(TEXT.forgotten('provider'), /keeps using it until it restarts/);
  assert.match(TEXT.forgotten('provider'), /Keychain Access/);
  assert.doesNotMatch(TEXT.forgotten('cursor'), /restarts/);
  await vs.commands.run(COMMANDS.forgetToken);
  assert.ok(vs.log.some((entry) => entry.kind === 'info' && entry.text === TEXT.nothingToForget));
  activation.dispose();
});

test('a token change refreshes the provider', async () => {
  const secrets = createFakeSecrets();
  const vs = createFakeVscode();
  const activation = activate(vs, createFakeContext({ root: ROOT, secrets }));
  const provider = vs.lm.providers.get('wisply.local');
  let changes = 0;
  provider.onDidChangeMcpServerDefinitions(() => { changes += 1; });
  await secrets.store('wisply.mcpToken', FAKE_TOKENS.full);
  assert.equal(changes, 1);
  const [definition] = await provider.provideMcpServerDefinitions({ isCancellationRequested: false });
  assert.equal(definition.version, '0.1.0+full.token1');
  vs.changeConfiguration({ 'mcp.allowClaudeSetup': { globalValue: true } });
  assert.equal(changes, 2);
  const [allowed] = await provider.provideMcpServerDefinitions({ isCancellationRequested: false });
  assert.deepEqual(allowed.args, [SERVER, '--allow-claude-setup']);
  assert.equal(allowed.version, '0.1.0+full.claude-setup.token1');
  // The same scope again (a regenerated token) still gives a new version.
  await secrets.store('wisply.mcpToken', `wsp_${'7a'.repeat(32)}`);
  const [rotated] = await provider.provideMcpServerDefinitions({ isCancellationRequested: false });
  assert.equal(rotated.version, '0.1.0+full.claude-setup.token2');
  activation.dispose();
});

test('no text the extension shows or copies names npx or the npm package', async () => {
  const { CONNECTION_TEXT } = await import('../out/test/sidecar.mjs');
  const { TOKEN_TEXT } = await import('../out/test/token.mjs');
  const texts = [...everyText(TEXT, 'TEXT'), ...everyText(CONNECTION_TEXT, 'CONNECTION_TEXT'), ...everyText(TOKEN_TEXT, 'TOKEN_TEXT')];
  assert.ok(texts.length > 20);
  for (const [name, text] of texts) {
    assert.doesNotMatch(text, /npx|@wisply\/mcp|wisply-mcp (setup|forget)/, name);
  }
  for (const allowClaudeSetup of [false, true]) {
    assert.doesNotMatch(manualConfig({ execPath: EXEC, serverPath: SERVER, port: 51771, allowClaudeSetup }), /npx|@wisply\/mcp/);
  }
  // And nothing the commands show along the way, in each mode.
  for (const options of [{}, { mcp: false, cursor: true, appName: 'Cursor' }, { mcp: false }]) {
    const secrets = createFakeSecrets({ 'wisply.mcpToken': FAKE_TOKENS.connector });
    const vs = createFakeVscode({ ...options, answers: { 'MCP settings': BUTTONS.copyConfig } });
    const activation = activate(vs, createFakeContext({ root: ROOT, secrets }));
    await activation.noticesDone;
    await vs.commands.run(COMMANDS.forgetToken);
    await vs.commands.run(COMMANDS.forgetToken);
    vs.commands.run(COMMANDS.storeTokenInKeychain);
    activation.dispose();
    for (const entry of vs.log) {
      if (typeof entry.text === 'string') assert.doesNotMatch(entry.text, /npx|@wisply\/mcp/, entry.text);
    }
  }
});

test('outside macOS the provider never asks for a token when the server starts', async () => {
  const vs = createFakeVscode({ inputs: [FAKE_TOKENS.connector] });
  const activation = activate(vs, createFakeContext({ root: ROOT }), { platform: 'linux' });
  const provider = vs.lm.providers.get('wisply.local');
  const [definition] = await provider.provideMcpServerDefinitions({ isCancellationRequested: false });
  const resolved = await provider.resolveMcpServerDefinition(definition, { isCancellationRequested: false });
  assert.equal(vs.log.some((entry) => entry.kind === 'inputBox'), false);
  assert.equal(resolved.env.WISPLY_MCP_TOKEN, null);
  activation.dispose();
});

test('Store Token in the Mac Keychain… outside macOS says why and opens nothing', async () => {
  const { notMac } = await import('../vendor/wisply-mcp/lib/messages.mjs');
  const vs = createFakeVscode();
  const activation = activate(vs, createFakeContext({ root: ROOT }), { platform: 'linux' });
  vs.commands.run(COMMANDS.storeTokenInKeychain);
  assert.equal(vs.log.some((entry) => entry.kind === 'createTerminal'), false);
  assert.ok(vs.log.some((entry) => entry.kind === 'warning' && entry.text === notMac('linux')));
  activation.dispose();
});

test('a custom port reaches the setup terminal', () => {
  const vs = createFakeVscode({ config: { port: { globalValue: 51790 } } });
  const activation = activate(vs, createFakeContext({ root: ROOT }));
  vs.commands.run(COMMANDS.storeTokenInKeychain);
  assert.deepEqual(vs.log.find((entry) => entry.kind === 'createTerminal').options.shellArgs, [SERVER, 'setup', '--port', '51790']);
  activation.dispose();
});

test('the token entered when the server first starts gives no new version: the starting server already has it', async () => {
  // VS Code stops a running server whose definition changed (version
  // included), which would cut off the tool call that started it.
  const secrets = createFakeSecrets();
  const vs = createFakeVscode({ inputs: [FAKE_TOKENS.connector] });
  const activation = activate(vs, createFakeContext({ root: ROOT, secrets, state: { 'wisply.welcomeShown': true } }));
  const provider = vs.lm.providers.get('wisply.local');
  let changes = 0;
  provider.onDidChangeMcpServerDefinitions(() => { changes += 1; });
  const [provided] = await provider.provideMcpServerDefinitions({ isCancellationRequested: false });
  assert.equal(provided.version, '0.1.0+none');
  const resolved = await provider.resolveMcpServerDefinition(provided, { isCancellationRequested: false });
  assert.equal(secrets.values.get('wisply.mcpToken'), FAKE_TOKENS.connector, 'stored');
  assert.equal(resolved.env.WISPLY_MCP_TOKEN, FAKE_TOKENS.connector, 'and used by this start');
  assert.deepEqual(resolved.args, [SERVER], 'with its own token, not read-only');
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.equal(changes, 0, 'no change event for the token this start stored');

  // A later change is a change again.
  await secrets.store('wisply.mcpToken', `wspc_${'5e'.repeat(32)}`);
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.equal(changes, 1);
  const [next] = await provider.provideMcpServerDefinitions({ isCancellationRequested: false });
  assert.equal(next.version, '0.1.0+connector.token1');
  activation.dispose();
});

test('with no token set and the prompt cancelled, VS Code\'s server uses the Keychain item read-only', async () => {
  const vs = createFakeVscode({ inputs: [undefined], config: { 'mcp.allowClaudeSetup': { globalValue: true } } });
  const activation = activate(vs, createFakeContext({ root: ROOT, state: { 'wisply.welcomeShown': true } }));
  const provider = vs.lm.providers.get('wisply.local');
  const [provided] = await provider.provideMcpServerDefinitions({ isCancellationRequested: false });
  assert.deepEqual(provided.args, [SERVER, '--read-only']);
  const resolved = await provider.resolveMcpServerDefinition(provided, { isCancellationRequested: false });
  assert.deepEqual(resolved.args, [SERVER, '--read-only'], 'a full-access Keychain token gets no more than the memo tools');
  assert.equal(resolved.env.WISPLY_MCP_TOKEN, null);
  activation.dispose();
});
