// src/provider.ts: the token-free definition, and the token added only when the server starts.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ALLOW_CLAUDE_SETUP_FLAG, PROVIDER_ID, READ_ONLY_FLAG, REMOVED_ENV, SERVER_LABEL, buildDefinition, createProvider,
  definitionVersion, serverLaunch, stringEnv,
} from '../out/test/provider.mjs';
import { FAKE_TOKENS, FakeEventEmitter, FakeMcpStdioServerDefinition } from './fixtures/fake-vscode.mjs';

const api = { McpStdioServerDefinition: FakeMcpStdioServerDefinition };
const LAUNCH = Object.freeze({
  execPath: '/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)',
  serverPath: '/Users/someone/.vscode/extensions/wisply.wisply-0.1.0/server/wisply-mcp.mjs',
  port: 51771,
  allowClaudeSetup: false,
  extVersion: '0.1.0',
});
const TOKEN_SHAPED = /wsp[cr]?_[0-9a-f]{64}/;
const CONNECTOR = Object.freeze({ token: FAKE_TOKENS.connector, scope: 'connector' });
const FULL = Object.freeze({ token: FAKE_TOKENS.full, scope: 'full' });
/** What every definition removes from the extension host's environment (null: removed). */
const REMOVED = Object.freeze({ WISPLY_MCP_TOKEN: null, WISPLY_MCP_ALLOW_CLAUDE_SETUP: null, WISPLY_MCP_DEBUG: null, NODE_OPTIONS: null });
const BASE_ENV = Object.freeze({ ELECTRON_RUN_AS_NODE: '1', WISPLY_MCP_PORT: '51771', ...REMOVED });

function setup({ stored = null, entered, launch = LAUNCH, platform = 'darwin', storeFails = false } = {}) {
  const calls = { prompts: 0, stores: [] };
  let token = stored;
  const wisply = createProvider(api, {
    platform,
    getLaunch: () => launch,
    getToken: async () => token,
    promptForToken: async () => { calls.prompts += 1; return entered; },
    storeToken: async (value) => {
      calls.stores.push(value);
      if (storeFails) throw new Error('secret storage unavailable');
      token = value;
    },
    createEmitter: () => new FakeEventEmitter(),
  });
  return { wisply, calls, setToken: (value) => { token = value; } };
}

test('ids and labels match the manifest contribution', () => {
  assert.equal(PROVIDER_ID, 'wisply.local');
  assert.equal(SERVER_LABEL, 'Wisply (this Mac)');
});

test('the definition runs the bundled connector on the editor\'s Node, with no token', () => {
  const definition = buildDefinition(api, { ...LAUNCH, scope: 'connector' });
  assert.ok(definition instanceof FakeMcpStdioServerDefinition);
  assert.equal(definition.label, SERVER_LABEL);
  assert.equal(definition.command, LAUNCH.execPath);
  assert.deepEqual(definition.args, [LAUNCH.serverPath]);
  assert.deepEqual(definition.env, BASE_ENV);
  assert.equal(definition.version, '0.1.0+connector');
});

test('the definition removes what the connector must not inherit from the extension host', () => {
  assert.deepEqual({ ...REMOVED_ENV }, REMOVED);
  // The editor merges the definition's env over its own, so a value exported
  // in the user's shell for another app must be removed (null), not left out.
  for (const [allowClaudeSetup, source] of [[false, 'secret-storage'], [true, 'secret-storage'], [true, 'keychain']]) {
    const { env, args } = serverLaunch({ ...LAUNCH, allowClaudeSetup }, source);
    assert.equal(Object.hasOwn(env, 'WISPLY_MCP_ALLOW_CLAUDE_SETUP'), true);
    assert.equal(env.WISPLY_MCP_ALLOW_CLAUDE_SETUP, null, 'only the user setting (the flag) decides');
    assert.equal(args.includes(ALLOW_CLAUDE_SETUP_FLAG), allowClaudeSetup && source === 'secret-storage');
    assert.equal(env.WISPLY_MCP_TOKEN, null);
    assert.equal(env.NODE_OPTIONS, null);
    assert.equal(env.WISPLY_MCP_DEBUG, null);
  }
});

test('stringEnv: a removed variable becomes empty, which the connector treats as unset', () => {
  assert.deepEqual(stringEnv(serverLaunch(LAUNCH, 'keychain').env), {
    ELECTRON_RUN_AS_NODE: '1', WISPLY_MCP_PORT: '51771', WISPLY_MCP_TOKEN: '', WISPLY_MCP_ALLOW_CLAUDE_SETUP: '',
    WISPLY_MCP_DEBUG: '', NODE_OPTIONS: '',
  });
});

test('a token from the Mac Keychain gets --read-only, whatever the settings', () => {
  assert.equal(READ_ONLY_FLAG, '--read-only');
  for (const allowClaudeSetup of [false, true]) {
    assert.deepEqual(serverLaunch({ ...LAUNCH, allowClaudeSetup }, 'keychain').args, [LAUNCH.serverPath, READ_ONLY_FLAG]);
  }
  // A provided definition with no token stored is the Keychain case.
  assert.deepEqual(buildDefinition(api, { ...LAUNCH, allowClaudeSetup: true, scope: null }).args, [LAUNCH.serverPath, READ_ONLY_FLAG]);
  assert.deepEqual(buildDefinition(api, { ...LAUNCH, scope: 'connector' }).args, [LAUNCH.serverPath]);
});

test('--allow-claude-setup is added only with the user setting, and changes the version', () => {
  assert.deepEqual(serverLaunch(LAUNCH, 'secret-storage').args, [LAUNCH.serverPath]);
  const allowed = buildDefinition(api, { ...LAUNCH, allowClaudeSetup: true, scope: 'full' });
  assert.deepEqual(allowed.args, [LAUNCH.serverPath, ALLOW_CLAUDE_SETUP_FLAG]);
  assert.equal(ALLOW_CLAUDE_SETUP_FLAG, '--allow-claude-setup');
  assert.equal(allowed.version, '0.1.0+full.claude-setup');
});

test('the version follows the scope, so the editor refreshes tools when it changes', () => {
  assert.equal(definitionVersion('0.1.0', null, false), '0.1.0+none');
  assert.equal(definitionVersion('0.1.0', 'connector', false), '0.1.0+connector');
  assert.equal(definitionVersion('0.1.0', 'full', false), '0.1.0+full');
  assert.notEqual(definitionVersion('0.1.0', 'full', false), definitionVersion('0.1.0', 'connector', false));
  assert.equal(definitionVersion('0.1.0', 'connector', false, 0), '0.1.0+connector');
  assert.equal(definitionVersion('0.1.0', 'connector', false, 2), '0.1.0+connector.token2');
  assert.equal(definitionVersion('0.1.0', 'full', true, 1), '0.1.0+full.claude-setup.token1');
});

test('a new token of the same scope still changes the version, so a running server is offered a restart', async () => {
  const { wisply, setToken } = setup({ stored: CONNECTOR });
  let fired = 0;
  wisply.provider.onDidChangeMcpServerDefinitions(() => { fired += 1; });
  const [before] = await wisply.provider.provideMcpServerDefinitions({ isCancellationRequested: false });
  setToken({ token: `wspc_${'6f'.repeat(32)}`, scope: 'connector' });
  wisply.tokenChanged();
  assert.equal(fired, 1);
  const [after] = await wisply.provider.provideMcpServerDefinitions({ isCancellationRequested: false });
  assert.notEqual(after.version, before.version);
  assert.equal(after.version, '0.1.0+connector.token1');
  assert.doesNotMatch(after.version, TOKEN_SHAPED);
  // Forgetting it is a change too; a settings refresh alone isn't.
  setToken(null);
  wisply.tokenChanged();
  wisply.refresh();
  const [forgotten] = await wisply.provider.provideMcpServerDefinitions({ isCancellationRequested: false });
  assert.equal(forgotten.version, '0.1.0+none.token2');
  assert.equal(fired, 3);
});

test('a custom port reaches the connector through WISPLY_MCP_PORT', () => {
  const definition = buildDefinition(api, { ...LAUNCH, port: 51772, scope: null });
  assert.equal(definition.env.WISPLY_MCP_PORT, '51772');
});

test('provided definitions never hold the token, whatever is stored', async () => {
  for (const stored of [null, CONNECTOR, FULL]) {
    const { wisply, calls } = setup({ stored });
    const definitions = await wisply.provider.provideMcpServerDefinitions({ isCancellationRequested: false });
    assert.equal(definitions.length, 1);
    assert.equal(definitions[0].env.WISPLY_MCP_TOKEN, null, 'removed from what the server inherits, never set');
    assert.doesNotMatch(JSON.stringify(definitions), TOKEN_SHAPED);
    assert.equal(definitions[0].version, `0.1.0+${stored?.scope ?? 'none'}`);
    assert.equal(calls.prompts, 0, 'providing never asks the user anything');
  }
});

test('resolve adds the stored token to a copy and leaves the provided definition as it was', async () => {
  const { wisply, calls } = setup({ stored: CONNECTOR });
  const [provided] = await wisply.provider.provideMcpServerDefinitions({ isCancellationRequested: false });
  const before = JSON.stringify(provided);
  const resolved = await wisply.provider.resolveMcpServerDefinition(provided, { isCancellationRequested: false });
  assert.notEqual(resolved, provided);
  assert.equal(resolved.env.WISPLY_MCP_TOKEN, FAKE_TOKENS.connector);
  assert.equal(resolved.env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(resolved.env.WISPLY_MCP_PORT, '51771');
  assert.equal(resolved.command, provided.command);
  assert.deepEqual(resolved.args, provided.args);
  assert.equal(resolved.version, provided.version);
  assert.equal(JSON.stringify(provided), before);
  assert.equal(calls.prompts, 0);
});

test('with no token stored, starting asks once, stores the answer and uses it', async () => {
  const { wisply, calls } = setup({ entered: CONNECTOR });
  const [provided] = await wisply.provider.provideMcpServerDefinitions({ isCancellationRequested: false });
  assert.deepEqual(provided.args, [LAUNCH.serverPath, READ_ONLY_FLAG], 'listed before a token exists: the Keychain case');
  const resolved = await wisply.provider.resolveMcpServerDefinition(provided, { isCancellationRequested: false });
  assert.equal(calls.prompts, 1);
  assert.deepEqual(calls.stores, [CONNECTOR]);
  assert.equal(resolved.env.WISPLY_MCP_TOKEN, FAKE_TOKENS.connector);
  assert.deepEqual(resolved.args, [LAUNCH.serverPath], 'started with the entered token, not read-only');
  assert.equal(resolved.version, provided.version);
});

test('the change event for the token resolve stored doesn\'t give a new version; the next change does', async () => {
  const { wisply, setToken } = setup({ entered: CONNECTOR });
  let fired = 0;
  wisply.provider.onDidChangeMcpServerDefinitions(() => { fired += 1; });
  const [provided] = await wisply.provider.provideMcpServerDefinitions({ isCancellationRequested: false });
  await wisply.provider.resolveMcpServerDefinition(provided, { isCancellationRequested: false });
  // SecretStorage reports the store resolve made.
  await wisply.tokenChanged();
  assert.equal(fired, 0, 'the server that just started already has this token');
  // Any later change counts, the same token stored again in another window included.
  setToken({ token: `wspc_${'4d'.repeat(32)}`, scope: 'connector' });
  await wisply.tokenChanged();
  assert.equal(fired, 1);
  const [next] = await wisply.provider.provideMcpServerDefinitions({ isCancellationRequested: false });
  assert.equal(next.version, '0.1.0+connector.token1');
});

test('if another token arrived before resolve\'s own event, the change counts', async () => {
  const { wisply, setToken } = setup({ entered: CONNECTOR });
  let fired = 0;
  wisply.provider.onDidChangeMcpServerDefinitions(() => { fired += 1; });
  const [provided] = await wisply.provider.provideMcpServerDefinitions({ isCancellationRequested: false });
  await wisply.provider.resolveMcpServerDefinition(provided, { isCancellationRequested: false });
  setToken(FULL);
  await wisply.tokenChanged();
  assert.equal(fired, 1, 'the stored token is no longer the one this start got');
});

test('a token that couldn\'t be stored is still used for this start, and no event is waited for', async () => {
  const { wisply, calls } = setup({ entered: CONNECTOR, storeFails: true });
  let fired = 0;
  wisply.provider.onDidChangeMcpServerDefinitions(() => { fired += 1; });
  const [provided] = await wisply.provider.provideMcpServerDefinitions({ isCancellationRequested: false });
  const resolved = await wisply.provider.resolveMcpServerDefinition(provided, { isCancellationRequested: false });
  assert.equal(calls.stores.length, 1);
  assert.equal(resolved.env.WISPLY_MCP_TOKEN, FAKE_TOKENS.connector);
  await wisply.tokenChanged();
  assert.equal(fired, 1, 'a later change from elsewhere is a change');
});

test('a cancelled prompt still starts the server without a token (the Keychain item, read-only), and isn\'t repeated', async () => {
  const { wisply, calls } = setup({ entered: undefined });
  const [provided] = await wisply.provider.provideMcpServerDefinitions({ isCancellationRequested: false });
  const first = await wisply.provider.resolveMcpServerDefinition(provided, { isCancellationRequested: false });
  assert.equal(first.env.WISPLY_MCP_TOKEN, null);
  assert.deepEqual(first.env, provided.env);
  assert.deepEqual(first.args, [LAUNCH.serverPath, READ_ONLY_FLAG]);
  const second = await wisply.provider.resolveMcpServerDefinition(provided, { isCancellationRequested: false });
  assert.equal(second.env.WISPLY_MCP_TOKEN, null);
  assert.equal(calls.prompts, 1, 'asked once per session');
  assert.deepEqual(calls.stores, []);
});

test('outside macOS, starting never asks for a token (there is no Wisply to connect to)', async () => {
  for (const platform of ['linux', 'win32']) {
    const { wisply, calls } = setup({ entered: CONNECTOR, platform });
    const [provided] = await wisply.provider.provideMcpServerDefinitions({ isCancellationRequested: false });
    const resolved = await wisply.provider.resolveMcpServerDefinition(provided, { isCancellationRequested: false });
    assert.equal(calls.prompts, 0, platform);
    assert.deepEqual(calls.stores, []);
    assert.equal(resolved.env.WISPLY_MCP_TOKEN, null);
  }
  // A token stored anyway is still passed on (the connector then explains it's not a Mac).
  const { wisply } = setup({ stored: CONNECTOR, platform: 'linux' });
  const [provided] = await wisply.provider.provideMcpServerDefinitions({ isCancellationRequested: false });
  assert.equal((await wisply.provider.resolveMcpServerDefinition(provided, { isCancellationRequested: false })).env.WISPLY_MCP_TOKEN,
    FAKE_TOKENS.connector);
});

test('resolve removes the inherited variables again if the editor hands back a copy without them', async () => {
  const { wisply } = setup({ stored: CONNECTOR });
  const stripped = new FakeMcpStdioServerDefinition(SERVER_LABEL, LAUNCH.execPath, [LAUNCH.serverPath],
    { ELECTRON_RUN_AS_NODE: '1', WISPLY_MCP_PORT: '51771' }, '0.1.0+connector');
  const resolved = await wisply.provider.resolveMcpServerDefinition(stripped, { isCancellationRequested: false });
  assert.deepEqual(resolved.env, { ...BASE_ENV, WISPLY_MCP_TOKEN: FAKE_TOKENS.connector });
});

test('a token stored later is used at the next start, and a forgotten one falls back to read-only', async () => {
  const { wisply, setToken } = setup({ entered: undefined });
  const [provided] = await wisply.provider.provideMcpServerDefinitions({ isCancellationRequested: false });
  await wisply.provider.resolveMcpServerDefinition(provided, { isCancellationRequested: false });
  setToken(FULL);
  const resolved = await wisply.provider.resolveMcpServerDefinition(provided, { isCancellationRequested: false });
  assert.equal(resolved.env.WISPLY_MCP_TOKEN, FAKE_TOKENS.full);
  assert.deepEqual(resolved.args, [LAUNCH.serverPath], 'rebuilt for the token source, not copied from the stale listing');
  // Listed with a token, started after it was forgotten: the Keychain case again.
  const [withToken] = await wisply.provider.provideMcpServerDefinitions({ isCancellationRequested: false });
  setToken(null);
  const forgotten = await wisply.provider.resolveMcpServerDefinition(withToken, { isCancellationRequested: false });
  assert.equal(forgotten.env.WISPLY_MCP_TOKEN, null);
  assert.deepEqual(forgotten.args, [LAUNCH.serverPath, READ_ONLY_FLAG]);
});

test('a cancelled start resolves to undefined; another label passes through untouched', async () => {
  const { wisply } = setup({ stored: CONNECTOR });
  const [provided] = await wisply.provider.provideMcpServerDefinitions({ isCancellationRequested: false });
  assert.equal(await wisply.provider.resolveMcpServerDefinition(provided, { isCancellationRequested: true }), undefined);
  const other = new FakeMcpStdioServerDefinition('Other server', 'node', ['x.js'], {});
  assert.equal(await wisply.provider.resolveMcpServerDefinition(other, { isCancellationRequested: false }), other);
  assert.deepEqual(other.env, {});
});

test('resolve keeps a working directory the editor set', async () => {
  const { wisply } = setup({ stored: CONNECTOR });
  const [provided] = await wisply.provider.provideMcpServerDefinitions({ isCancellationRequested: false });
  provided.cwd = { fsPath: '/tmp' };
  const resolved = await wisply.provider.resolveMcpServerDefinition(provided, { isCancellationRequested: false });
  assert.equal(resolved.cwd, provided.cwd);
});

test('refresh fires the change event; dispose ends it', () => {
  const { wisply } = setup();
  let fired = 0;
  wisply.provider.onDidChangeMcpServerDefinitions(() => { fired += 1; });
  wisply.refresh();
  wisply.refresh();
  assert.equal(fired, 2);
  wisply.dispose();
  wisply.refresh();
  assert.equal(fired, 2);
});
