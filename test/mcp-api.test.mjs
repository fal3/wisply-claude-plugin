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
const activate = (vs, context, deps = {}) =>
  activateExtension(vs, context, { execPath: EXEC, platform: 'darwin', hostEnv: { HOME: '/Users/someone', PATH: '/usr/bin' }, ...deps });

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

test('the Cursor config runs the bundled connector and holds no token', () => {
  const config = cursorServerConfig({ execPath: EXEC, serverPath: SERVER, port: 51771, allowClaudeSetup: false });
  assert.deepEqual(config, {
    name: 'wisply',
    server: { command: EXEC, args: [SERVER], env: { ELECTRON_RUN_AS_NODE: '1', WISPLY_MCP_PORT: '51771' } },
  });
  assert.equal(CURSOR_SERVER_NAME, 'wisply');
  const mcp = createFakeVscode({ mcp: false, cursor: true }).cursor.mcp;
  const registration = registerWithCursor(mcp, { execPath: EXEC, serverPath: SERVER, port: 51772, allowClaudeSetup: true });
  assert.deepEqual(mcp.registered[0].server.args, [SERVER, '--allow-claude-setup']);
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
  assert.deepEqual(definition.args, [SERVER]);
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
  assert.deepEqual(config, {
    name: 'wisply',
    server: { command: EXEC, args: [SERVER], env: { ELECTRON_RUN_AS_NODE: '1', WISPLY_MCP_PORT: '51771' } },
  });
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
  assert.equal(copied.text, manualConfig());
  const entry = JSON.parse(copied.text);
  assert.deepEqual(Object.keys(entry.mcpServers), ['wisply']);
  assert.equal(entry.mcpServers.wisply.command, 'npx');
  assert.equal(entry.mcpServers.wisply.args[0], '-y');
  assert.match(entry.mcpServers.wisply.args[1], /^@wisply\/mcp@/);
  assert.equal(Object.hasOwn(entry.mcpServers.wisply, 'env'), false);
  assert.doesNotMatch(copied.text, TOKEN_SHAPED);
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
  assert.deepEqual(terminal.options, {
    name: 'Wisply setup', shellPath: EXEC, shellArgs: [SERVER, 'setup', '--port', '51771'], env: { ELECTRON_RUN_AS_NODE: '1' },
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
  assert.ok(vs.log.some((entry) => entry.kind === 'info' && entry.text === TEXT.forgotten));
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
  assert.equal(definition.version, '0.1.0+full');
  vs.changeConfiguration({ 'mcp.allowClaudeSetup': { globalValue: true } });
  assert.equal(changes, 2);
  const [allowed] = await provider.provideMcpServerDefinitions({ isCancellationRequested: false });
  assert.deepEqual(allowed.args, [SERVER, '--allow-claude-setup']);
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
