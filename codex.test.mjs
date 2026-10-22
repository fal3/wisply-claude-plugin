// Checks for the Codex build of this plugin: the Codex marketplace, the Codex
// manifest and MCP configuration, the Codex skill, the Keychain read and the
// Codex entry point. Synthetic data only; nothing here contacts port 51771 or
// reads a real Keychain.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {existsSync, mkdtempSync, readFileSync, rmSync, statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {handle} from './bridge.mjs';
import {expectedProof} from './lib/identity.mjs';
import {IDENTITY_MARKER, READ_ONLY_TOOLS, SETUP_MARKER, TOOL_DESCRIPTORS, UNAVAILABLE_MESSAGE} from './lib/shared.mjs';
import {
  CODEX_MESSAGES,
  CODEX_NOT_WISPLY_MESSAGE,
  CODEX_SCOPE_MESSAGE,
  CODEX_SETUP_MESSAGE,
  codexOptions,
} from './codex/bridge.mjs';
import {
  KEYCHAIN_ACCOUNT,
  KEYCHAIN_DELETE_COMMAND,
  KEYCHAIN_LABEL,
  KEYCHAIN_READ_ARGS,
  KEYCHAIN_SAVE_COMMAND,
  KEYCHAIN_SERVICE,
  KEYCHAIN_TIMEOUT_MS,
  MAX_KEYCHAIN_OUTPUT,
  SECURITY_BIN,
  readKeychainToken,
} from './codex/keychain.mjs';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const readJson = (path) => JSON.parse(readFileSync(join(ROOT, path), 'utf8'));
const codexMarketplace = readJson('.agents/plugins/marketplace.json');
const claudeMarketplace = readJson('.claude-plugin/marketplace.json');
const plugin = readJson('.claude-plugin/plugin.json');
const codexPlugin = readJson('.codex-plugin/plugin.json');
const codexMcp = readJson('codex/mcp.json');
const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');

// Synthetic, well-formed tokens built at runtime; never real Wisply tokens.
const TOKEN = 'wsp_' + '8d'.repeat(32);
const CONNECTOR = 'wspc_' + '9e'.repeat(32);
const PORT = 51771;
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RELEASE_TAG = /^v\d+\.\d+\.\d+$/;
const COMMIT_SHA = /^[0-9a-f]{40}$/;
// Wisply's own Codex marketplace (fal3/wisply-mcp, the Agent Plugin) is
// named `wisply`, and Codex refuses a second marketplace with a name it
// already has. This repository's Codex marketplace takes another name, so a
// person can add both.
const AGENT_PLUGIN_MARKETPLACE = 'wisply';

const request = (method, params = {}) => ({jsonrpc: '2.0', id: 'synthetic-codex', method, params});
const refuse = () => { throw new Error('must not contact the app'); };
const toolText = (result) => result.result.content.map((block) => block.text).join(' ');
const identityBody = (nonce, full = TOKEN) => ({
  server: 'wisply', scheme: 'wisply-mcp-identity-v1', algorithm: 'HMAC-SHA256', port: PORT, nonce,
  proofs: {full: expectedProof(full, PORT, nonce).toString('hex'), connector: expectedProof(CONNECTOR, PORT, nonce).toString('hex')},
});
const proving = (full) => async ({nonce}) => ({status: 200, text: JSON.stringify(identityBody(nonce, full))});

function repoName(url) {
  const match = /^https:\/\/github\.com\/[A-Za-z0-9-]+\/([A-Za-z0-9._-]+)$/.exec(url);
  assert.ok(match, `a plain GitHub URL: ${url}`);
  return match[1];
}

// A manifest path Codex accepts: "./" plus a normalized path inside the plugin root.
function pluginPath(path, label) {
  assert.equal(typeof path, 'string', `${label} is a path`);
  assert.match(path, /^\.\/(?!.*(?:^|\/)\.\.?(?:\/|$))/, `${label} is ./-relative and stays inside the plugin`);
  const absolute = resolve(ROOT, path);
  assert.ok(absolute.startsWith(ROOT), `${label} stays inside the plugin`);
  assert.ok(existsSync(absolute), `${label} exists: ${path}`);
  return absolute;
}

// A fake execFile that records the call and answers like `security` would.
function fakeSecurity(answer) {
  const calls = [];
  const run = (file, args, options, callback) => {
    calls.push({file, args, options});
    answer(callback);
  };
  return Object.assign(run, {calls});
}

test('the Codex marketplace has its own name, so Wisply\'s Agent Plugin marketplace can be added beside it', () => {
  assert.deepEqual(Object.keys(codexMarketplace).filter((key) => !['name', 'interface', 'plugins'].includes(key)), []);
  assert.match(codexMarketplace.name, KEBAB);
  assert.notEqual(codexMarketplace.name, AGENT_PLUGIN_MARKETPLACE);
  assert.equal(codexMarketplace.name, repoName(plugin.repository), 'named after this repository');
  // Claude Code reads only .claude-plugin/marketplace.json, where the name stays `wisply`.
  assert.equal(claudeMarketplace.name, 'wisply');
  assert.equal(typeof codexMarketplace.interface?.displayName, 'string');
});

test('the Codex marketplace lists this plugin from the repository root, and pins anything else', () => {
  const own = codexMarketplace.plugins.filter((entry) => entry.source === './');
  assert.equal(own.length, 1, 'this plugin, once');
  assert.equal(own[0].name, plugin.name);
  assert.equal(own[0].category, 'Productivity');
  for (const entry of codexMarketplace.plugins.filter((item) => item.source !== './')) {
    // A plugin from another Wisply repository must pin a release tag and its
    // full commit, so Codex never installs an unreviewed default branch.
    assert.match(entry.name ?? '', KEBAB);
    assert.notEqual(entry.name, plugin.name);
    assert.equal(entry.source?.source, 'url', `${entry.name}: a remote source`);
    assert.match(entry.source.url, /^https:\/\/github\.com\/fal3\/[A-Za-z0-9._-]+$/);
    assert.notEqual(repoName(entry.source.url), repoName(plugin.repository));
    assert.match(entry.source.ref ?? '', RELEASE_TAG, `${entry.name}: pinned to a release tag`);
    assert.match(entry.source.sha ?? '', COMMIT_SHA, `${entry.name}: pinned to the tag's full commit`);
  }
});

test('the Codex manifest is this plugin, with Codex\'s skill, server and no hooks', () => {
  // Codex reads .codex-plugin/plugin.json before .claude-plugin/plugin.json.
  const known = ['name', 'version', 'description', 'keywords', 'skills', 'mcpServers', 'apps', 'hooks', 'interface'];
  assert.deepEqual(Object.keys(codexPlugin).filter((key) => !known.includes(key)), []);
  assert.equal(codexPlugin.name, plugin.name);
  assert.equal(codexPlugin.version, plugin.version, 'versions move together');
  assert.deepEqual(codexPlugin.keywords, plugin.keywords);
  assert.match(codexPlugin.description, /from Codex on the Mac running Wisply/);
  assert.match(codexPlugin.description, /127\.0\.0\.1/);
  assert.doesNotMatch(codexPlugin.description, /Claude/);
  // Without these, Codex would load the Claude Code skill (./skills) and
  // server (./.mcp.json), whose ${CLAUDE_PLUGIN_ROOT} and ${user_config.*} it
  // doesn't expand.
  assert.equal(codexPlugin.skills, './codex/skills/');
  assert.ok(statSync(pluginPath(codexPlugin.skills, 'skills')).isDirectory());
  assert.equal(codexPlugin.mcpServers, './codex/mcp.json');
  pluginPath(codexPlugin.mcpServers, 'mcpServers');
  // An inline hooks file with no events keeps Codex from reading
  // hooks/hooks.json, which declares the Claude Code mod.
  assert.equal(typeof codexPlugin.hooks, 'object');
  assert.deepEqual(Object.keys(codexPlugin.hooks), ['description']);
});

test('the Codex manifest\'s interface fields are complete and point at real files', () => {
  const ui = codexPlugin.interface;
  assert.equal(ui.displayName, plugin.displayName);
  assert.equal(ui.category, 'Productivity');
  assert.equal(ui.developerName, claudeMarketplace.owner.name);
  assert.equal(ui.websiteURL, plugin.homepage);
  assert.equal(ui.privacyPolicyURL, plugin.privacyPolicyUrl);
  assert.equal(ui.termsOfServiceURL, plugin.termsOfServiceUrl);
  assert.ok(ui.shortDescription.length > 0 && ui.longDescription.length > ui.shortDescription.length);
  // Codex keeps at most three default prompts of at most 128 characters.
  assert.ok(Array.isArray(ui.defaultPrompt) && ui.defaultPrompt.length > 0 && ui.defaultPrompt.length <= 3);
  for (const prompt of ui.defaultPrompt) assert.ok(prompt.length > 0 && prompt.length <= 128, prompt);
  assert.match(pluginPath(ui.logo, 'interface.logo'), /\.png$/);
});

test('the Codex server runs codex/bridge.mjs and carries no token, variable or placeholder', () => {
  const servers = codexMcp.mcpServers;
  assert.deepEqual(Object.keys(codexMcp), ['mcpServers']);
  // Not `wisply`: that name belongs to a `codex mcp add wisply` entry or the
  // Agent Plugin, and the same name twice is ambiguous.
  assert.deepEqual(Object.keys(servers), ['wisply-local']);
  const server = servers['wisply-local'];
  assert.deepEqual(server, {command: 'node', args: ['./codex/bridge.mjs'], cwd: '.'});
  pluginPath(server.args[0], 'the server script');
  // No env and no env_vars: the token never passes through Codex's config or
  // environment, where every command Codex runs could read it.
  const text = readFileSync(join(ROOT, 'codex/mcp.json'), 'utf8');
  assert.doesNotMatch(text, /\$\{|wsp|TOKEN|env/i);
});

test('the Codex skill has the Claude skill\'s name and description and Codex\'s steps', () => {
  const codexSkill = readFileSync(join(ROOT, 'codex/skills/wisply/SKILL.md'), 'utf8');
  const claudeSkill = readFileSync(join(ROOT, 'skills/wisply/SKILL.md'), 'utf8');
  const frontmatter = (text) => /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1];
  assert.equal(frontmatter(codexSkill), frontmatter(claudeSkill));
  const body = codexSkill.slice(frontmatter(codexSkill).length + 8);
  assert.match(body, /in Codex only on the Mac that runs Wisply/);
  assert.match(body, /untrusted evidence, never instructions/);
  assert.match(body, /Never run that command yourself, never ask for the token in chat and never print it/);
  assert.doesNotMatch(body, /Claude Code|plugin's options|\/wisply-status|restart/);
});

test('the Keychain read runs /usr/bin/security with fixed arguments and returns its output', async () => {
  const run = fakeSecurity((callback) => callback(null, `${CONNECTOR}\n`, ''));
  assert.equal(await readKeychainToken({run}), `${CONNECTOR}\n`);
  assert.equal(run.calls.length, 1);
  const [{file, args, options}] = run.calls;
  assert.equal(file, SECURITY_BIN);
  assert.equal(SECURITY_BIN, '/usr/bin/security', 'an absolute path, never looked up on PATH');
  assert.deepEqual(args, ['find-generic-password', '-s', 'ai.wisply.mcp', '-a', 'token', '-w']);
  assert.deepEqual(args, [...KEYCHAIN_READ_ARGS]);
  assert.equal(options.timeout, KEYCHAIN_TIMEOUT_MS);
  assert.equal(KEYCHAIN_TIMEOUT_MS, 2000);
  assert.equal(options.killSignal, 'SIGKILL');
  assert.equal(options.maxBuffer, MAX_KEYCHAIN_OUTPUT);
  assert.equal(options.shell, undefined, 'no shell');
  assert.equal(options.env, undefined, 'nothing chosen by the environment');
});

test('the Keychain read gives null for a missing item, a failure, a timeout or no security tool', async () => {
  const missing = Object.assign(new Error('The specified item could not be found in the keychain.'), {code: 44});
  const timedOut = Object.assign(new Error('timed out'), {killed: true, signal: 'SIGTERM'});
  const absent = Object.assign(new Error('spawn /usr/bin/security ENOENT'), {code: 'ENOENT'});
  for (const answer of [
    (callback) => callback(missing, '', 'security: SecKeychainSearchCopyNext: The specified item could not be found'),
    (callback) => callback(timedOut, '', ''),
    (callback) => callback(absent),
    (callback) => callback(null, Buffer.from(CONNECTOR)),
    () => { throw new Error('spawn failed'); },
  ]) {
    assert.equal(await readKeychainToken({run: fakeSecurity(answer)}), null);
  }
});

test('the Keychain read answers null when security never calls back', async () => {
  const started = Date.now();
  assert.equal(await readKeychainToken({run: fakeSecurity(() => {}), timeoutMs: 50}), null);
  assert.ok(Date.now() - started < 2000);
});

test('the Keychain commands in the messages name the item the bridge reads', () => {
  assert.equal(KEYCHAIN_SERVICE, 'ai.wisply.mcp');
  assert.equal(KEYCHAIN_ACCOUNT, 'token');
  // -w last makes security prompt for the token, so it isn't in shell history.
  assert.equal(KEYCHAIN_LABEL, 'Wisply MCP token');
  assert.equal(KEYCHAIN_SAVE_COMMAND,
    'security add-generic-password -U -s ai.wisply.mcp -a token -l "Wisply MCP token" -T /usr/bin/security -w');
  assert.ok(KEYCHAIN_SAVE_COMMAND.endsWith(' -w'), 'the token is asked for, never an argument');
  assert.equal(KEYCHAIN_DELETE_COMMAND, 'security delete-generic-password -s ai.wisply.mcp -a token');
  for (const command of [KEYCHAIN_SAVE_COMMAND, KEYCHAIN_DELETE_COMMAND]) assert.ok(readme.includes(command), `README.md is missing: ${command}`);
});

test('Codex\'s messages keep the shared markers, give Codex\'s steps and never a token', () => {
  assert.deepEqual(CODEX_MESSAGES, {setup: CODEX_SETUP_MESSAGE, notWisply: CODEX_NOT_WISPLY_MESSAGE, scope: CODEX_SCOPE_MESSAGE});
  assert.ok(Object.isFrozen(CODEX_MESSAGES));
  assert.ok(CODEX_SETUP_MESSAGE.startsWith(`${SETUP_MARKER} is not set or not valid.`));
  assert.ok(CODEX_NOT_WISPLY_MESSAGE.startsWith(`${IDENTITY_MARKER} failed:`));
  assert.match(CODEX_SCOPE_MESSAGE, /full-access token/);
  for (const message of [CODEX_SETUP_MESSAGE, CODEX_NOT_WISPLY_MESSAGE]) {
    // Quoted, so nothing after the command is copied with it.
    assert.ok(message.includes(`\`${KEYCHAIN_SAVE_COMMAND}\``));
  }
  for (const message of Object.values(CODEX_MESSAGES)) {
    assert.doesNotMatch(message, /Claude|plugin's options|wspc?_|wspr_/);
  }
});

test('Codex reads the Keychain only for a read-only tool call, never for the handshake', async () => {
  let reads = 0;
  const options = {...codexOptions(async () => { reads += 1; return null; }), transport: refuse, identityTransport: refuse};
  for (const method of ['initialize', 'ping', 'tools/list']) assert.ok((await handle(request(method), options)).result);
  assert.deepEqual((await handle(request('tools/list'), options)).result.tools, TOOL_DESCRIPTORS);
  for (const name of ['setup_claude', 'start_recording', 'stop_recording', 'propose_follow_up']) {
    assert.equal((await handle(request('tools/call', {name}), options)).error.code, -32602);
  }
  assert.equal((await handle(request('tools/call', {name: 'list_memos', arguments: 'all'}), options)).error.code, -32602);
  assert.equal(reads, 0);
  const result = await handle(request('tools/call', {name: 'get_live_transcript'}), options);
  assert.equal(reads, 1);
  assert.equal(result.result.isError, true);
  assert.equal(toolText(result), CODEX_SETUP_MESSAGE);
});

test('Codex refuses an empty, placeholder or malformed Keychain value before contacting the app', async () => {
  for (const value of [null, '', '\n', '${user_config.wisply_mcp_token}', 'an-api-key-pasted-by-mistake', `${TOKEN}\r\nInjected: x`]) {
    const result = await handle(request('tools/call', {name: 'list_memos'}), {
      ...codexOptions(async () => value), transport: refuse, identityTransport: refuse,
    });
    assert.equal(toolText(result), CODEX_SETUP_MESSAGE);
    if (value) assert.ok(!JSON.stringify(result).includes(value.trim() || value));
  }
});

test('Codex ignores a token passed the Claude Code way: only the Keychain counts', async () => {
  const result = await handle(request('tools/call', {name: 'list_memos'}), {
    ...codexOptions(async () => null), token: TOKEN, transport: refuse, identityTransport: refuse,
  });
  assert.equal(toolText(result), CODEX_SETUP_MESSAGE);
});

test('Codex sends the Keychain token, trimmed, only after Wisply proves it holds it', async () => {
  const sent = [];
  const challenges = [];
  const result = await handle(request('tools/call', {name: 'search_transcripts', arguments: {query: 'pricing'}}), {
    ...codexOptions(async () => `${CONNECTOR}\n`),
    identityTransport: async (challenge) => { challenges.push(challenge); return proving(TOKEN)(challenge); },
    transport: async (sending) => {
      sent.push(sending);
      return {status: 200, text: JSON.stringify({jsonrpc: '2.0', id: 'synthetic-codex', result: {content: [{type: 'text', text: 'Synthetic match'}]}})};
    },
  });
  assert.equal(toolText(result), 'Synthetic match');
  assert.equal(challenges.length, 1);
  assert.ok(!JSON.stringify(challenges).includes(CONNECTOR), 'the challenge never carries the token');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].headers.Authorization, `Bearer ${CONNECTOR}`);
  assert.ok(!sent[0].body.includes(CONNECTOR));
});

test('Codex gets its own identity and scope messages', async () => {
  const wrongProof = await handle(request('tools/call', {name: 'list_memos'}), {
    ...codexOptions(async () => CONNECTOR),
    identityTransport: async ({nonce}) => ({status: 200, text: JSON.stringify({...identityBody(nonce), proofs: {full: '00'.repeat(32), connector: '00'.repeat(32)}})}),
    transport: refuse,
  });
  assert.equal(toolText(wrongProof), CODEX_NOT_WISPLY_MESSAGE);
  const garbage = await handle(request('tools/call', {name: 'list_memos'}), {
    ...codexOptions(async () => CONNECTOR),
    identityTransport: async () => ({status: 200, text: 'not json'}),
    transport: refuse,
  });
  assert.equal(toolText(garbage), CODEX_NOT_WISPLY_MESSAGE);
  const offline = await handle(request('tools/call', {name: 'list_memos'}), {
    ...codexOptions(async () => CONNECTOR),
    identityTransport: async () => { throw Object.assign(new Error('connect ECONNREFUSED'), {code: 'ECONNREFUSED'}); },
    transport: refuse,
  });
  assert.equal(toolText(offline), UNAVAILABLE_MESSAGE);
  const scope = await handle(request('tools/call', {name: 'get_action_items'}), {
    ...codexOptions(async () => CONNECTOR),
    identityTransport: proving(TOKEN),
    transport: async () => ({status: 200, text: JSON.stringify({jsonrpc: '2.0', id: 'synthetic-codex', error: {code: -32003, message: 'Tool not permitted'}})}),
  });
  assert.equal(toolText(scope), CODEX_SCOPE_MESSAGE);
});

test('codex/bridge.mjs speaks stdio and, without a Keychain item, answers with Codex\'s setup steps', {
  // On a Mac this would read the real login Keychain.
  skip: process.platform === 'darwin' ? 'reads the real Keychain on macOS' : false,
}, async () => {
  const home = mkdtempSync(join(tmpdir(), 'wisply-codex-'));
  try {
    // The environment Codex gives a plugin's MCP server: a few safe variables,
    // none of the parent's secrets. A token in it must still be ignored.
    const server = codexMcp.mcpServers['wisply-local'];
    const child = spawn(process.execPath, server.args, {
      cwd: resolve(ROOT, server.cwd),
      env: {HOME: home, PATH: process.env.PATH, WISPLY_PLUGIN_TOKEN: TOKEN, WISPLY_MCP_TOKEN: TOKEN},
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '', stderr = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdin.end([
      JSON.stringify({jsonrpc: '2.0', id: 'init', method: 'initialize', params: {protocolVersion: '2025-06-18'}}),
      JSON.stringify({jsonrpc: '2.0', method: 'notifications/initialized'}),
      JSON.stringify({jsonrpc: '2.0', id: 'list', method: 'tools/list'}),
      JSON.stringify({jsonrpc: '2.0', id: 'call', method: 'tools/call', params: {name: 'list_memos'}}),
    ].join('\n') + '\n');
    const [code] = await once(child, 'close');
    assert.equal(code, 0);
    assert.equal(stderr, '');
    const frames = output.trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(frames.map((frame) => frame.id), ['init', 'list', 'call']);
    assert.equal(frames[0].result.serverInfo.name, 'wisply-local');
    assert.deepEqual(frames[1].result.tools.map((tool) => tool.name), [...READ_ONLY_TOOLS]);
    assert.equal(frames[2].result.isError, true);
    assert.equal(frames[2].result.content[0].text, CODEX_SETUP_MESSAGE);
    assert.ok(!output.includes(TOKEN));
  } finally {
    rmSync(home, {recursive: true, force: true});
  }
});

test('the README gives the Codex install lines with this marketplace\'s Codex name', () => {
  const slug = 'fal3/' + repoName(plugin.repository);
  for (const line of [
    `codex plugin marketplace add ${slug}`,
    `codex plugin add ${plugin.name}@${codexMarketplace.name}`,
    `codex plugin remove ${plugin.name}@${codexMarketplace.name}`,
    `codex plugin marketplace remove ${codexMarketplace.name}`,
    `codex plugin marketplace upgrade ${codexMarketplace.name}`,
  ]) {
    assert.ok(readme.includes(line), `README.md is missing: ${line}`);
  }
});
