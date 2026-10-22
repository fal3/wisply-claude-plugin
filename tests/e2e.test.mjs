// End to end: the real bin over stdio, against the synthetic Wisply in
// tests/fixtures/fake-wisply.mjs on a port the system assigns.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { FAKE_TOKENS, startFakeWisply } from './fixtures/fake-wisply.mjs';
import { PLANNED_COMMANDS, VERSION } from '../lib/constants.mjs';
import * as messages from '../lib/messages.mjs';

const BIN = fileURLToPath(new URL('../bin/wisply-mcp.mjs', import.meta.url));
const SENTINEL = 'SENTINEL-transcript-7f3a';

/**
 * Runs the connector with `lines` on stdin (then closes it) and returns
 * every stdout line parsed, the raw stdout and stderr, and the exit code.
 */
async function run({ args = [], env = {}, lines = [] } = {}) {
  const child = spawn(process.execPath, [BIN, ...args], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME ?? '/tmp', ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  for (const line of lines) child.stdin.write(`${typeof line === 'string' ? line : JSON.stringify(line)}\n`);
  child.stdin.end();
  const [code] = await once(child, 'exit');
  // A line that isn't JSON stays a string, so protocol checks fail on it.
  const responses = stdout.split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return line; } });
  return { code, stdout, stderr, responses };
}

const rpc = (id, method, params) => (params === undefined ? { jsonrpc: '2.0', id, method } : { jsonrpc: '2.0', id, method, params });
const toolText = (response) => response.result.content.map((block) => block.text).join(' ');
const SESSION = [
  rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'synthetic-client', version: '1' } }),
  { jsonrpc: '2.0', method: 'notifications/initialized' },
  rpc(2, 'tools/list', {}),
  rpc(3, 'tools/call', { name: 'list_memos', arguments: { limit: 5 } }),
  rpc(4, 'tools/call', { name: 'start_recording', arguments: {} }),
  rpc(5, 'ping'),
];

function assertProtocolOnly(result, ids) {
  for (const response of result.responses) {
    assert.equal(response.jsonrpc, '2.0');
    assert.ok(Object.hasOwn(response, 'result') !== Object.hasOwn(response, 'error'));
  }
  assert.deepEqual(result.responses.map((response) => response.id), ids);
  assert.equal(result.stdout.endsWith('\n'), true);
}

test('a connector session: handshake, list, call and a scope refusal', async (t) => {
  const fake = await startFakeWisply();
  t.after(fake.close);
  const result = await run({ env: { WISPLY_MCP_PORT: String(fake.port), WISPLY_MCP_TOKEN: FAKE_TOKENS.connector }, lines: SESSION });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, '');
  assertProtocolOnly(result, [1, 2, 3, 4, 5]);
  const [init, list, memos, refused, ping] = result.responses;
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.equal(init.result.serverInfo.version, VERSION);
  assert.deepEqual(list.result.tools.map((tool) => tool.name), ['list_memos', 'search_transcripts', 'get_live_transcript', 'get_action_items']);
  assert.equal(memos.result.structuredContent.memos[0].title, 'Synthetic planning sync');
  assert.equal(refused.result.isError, true);
  assert.equal(toolText(refused), messages.scope('start_recording', 'connector'));
  assert.deepEqual(ping.result, {});
  // One identity challenge (no token in it), then one call with the bearer.
  assert.equal(fake.state.challenges.length, 1);
  assert.equal(fake.state.challenges[0].authorization, undefined);
  assert.equal(fake.state.challenges[0].host, `127.0.0.1:${fake.port}`);
  assert.equal(fake.state.calls.length, 1);
  assert.equal(fake.state.calls[0].authorization, `Bearer ${FAKE_TOKENS.connector}`);
  assert.deepEqual(fake.state.calls[0].message.params, { name: 'list_memos', arguments: { limit: 5 } });
});

test('full, recording, --read-only and --allow-claude-setup sessions', async (t) => {
  const fake = await startFakeWisply();
  t.after(fake.close);
  const env = (token) => ({ WISPLY_MCP_PORT: String(fake.port), WISPLY_MCP_TOKEN: token });
  const listNames = (result) => result.responses.find((response) => response.id === 2).result.tools.map((tool) => tool.name);

  const full = await run({ env: env(FAKE_TOKENS.full), lines: SESSION });
  assert.equal(listNames(full).length, 8);
  assert.ok(!listNames(full).includes('setup_claude'));
  assert.equal(full.responses.find((response) => response.id === 4).result.structuredContent.state, 'recording');

  const recording = await run({ env: env(FAKE_TOKENS.recording), lines: SESSION });
  assert.deepEqual(listNames(recording), ['start_recording', 'stop_recording', 'propose_follow_up']);
  assert.equal(toolText(recording.responses.find((response) => response.id === 3)), messages.scope('list_memos', 'recording'));
  assert.equal(recording.responses.find((response) => response.id === 4).result.structuredContent.state, 'recording');

  const readOnly = await run({ args: ['--read-only'], env: env(FAKE_TOKENS.full), lines: SESSION });
  assert.equal(listNames(readOnly).length, 4);
  assert.equal(toolText(readOnly.responses.find((response) => response.id === 4)), messages.scope('start_recording', 'full', { readOnly: true }));

  const claude = await run({ args: ['--allow-claude-setup'], env: env(FAKE_TOKENS.full), lines: SESSION });
  assert.equal(listNames(claude).length, 9);
  const claudeByEnv = await run({ env: { ...env(FAKE_TOKENS.full), WISPLY_MCP_ALLOW_CLAUDE_SETUP: '1' }, lines: SESSION });
  assert.equal(listNames(claudeByEnv).length, 9);
});

test('an impostor never receives the token; an old Wisply is told to update', async (t) => {
  const impostor = await startFakeWisply({ mode: 'impostor' });
  t.after(impostor.close);
  const env = (port) => ({ WISPLY_MCP_PORT: String(port), WISPLY_MCP_TOKEN: FAKE_TOKENS.full });
  const lines = [rpc(1, 'tools/call', { name: 'list_memos' })];
  const refused = await run({ env: env(impostor.port), lines });
  assert.equal(toolText(refused.responses[0]), messages.notWisply(impostor.port));
  assert.equal(impostor.state.challenges.length, 2, 'one retry after a fresh lookup');
  assert.equal(impostor.state.calls.length, 0);

  const old = await startFakeWisply({ mode: 'old' });
  t.after(old.close);
  const update = await run({ env: env(old.port), lines });
  assert.equal(toolText(update.responses[0]), messages.UPDATE_WISPLY);
  assert.equal(old.state.calls.length, 0);

  const noRecording = await startFakeWisply({ mode: 'no-recording-proof' });
  t.after(noRecording.close);
  const scoped = await run({
    env: { WISPLY_MCP_PORT: String(noRecording.port), WISPLY_MCP_TOKEN: FAKE_TOKENS.recording },
    lines: [rpc(1, 'tools/call', { name: 'start_recording' })],
  });
  assert.equal(toolText(scoped.responses[0]), messages.UPDATE_WISPLY_SCOPE);
  assert.equal(noRecording.state.calls.length, 0);
});

test('without a token the connector still lists the read-only tools and explains the setup', async () => {
  const result = await run({ env: { WISPLY_MCP_PORT: '1025' }, lines: [rpc(1, 'tools/list'), rpc(2, 'tools/call', { name: 'list_memos' })] });
  assert.equal(result.code, 0);
  assert.equal(result.responses[0].result.tools.length, 4);
  const expected = process.platform === 'darwin' ? messages.SETUP : messages.notMac(process.platform);
  assert.equal(toolText(result.responses[1]), expected);
  const placeholder = await run({ env: { WISPLY_MCP_TOKEN: '${user_config.wisply_mcp_token}' }, lines: [rpc(1, 'tools/call', { name: 'list_memos' })] });
  assert.equal(toolText(placeholder.responses[0]), expected);
  const malformed = await run({ env: { WISPLY_MCP_TOKEN: 'sk-synthetic' }, lines: [rpc(1, 'tools/call', { name: 'list_memos' })] });
  assert.equal(toolText(malformed.responses[0]), messages.MALFORMED);
});

test('nothing listening on the port is unavailable', async (t) => {
  const fake = await startFakeWisply();
  const port = fake.port;
  await fake.close();
  const result = await run({ env: { WISPLY_MCP_PORT: String(port), WISPLY_MCP_TOKEN: FAKE_TOKENS.connector }, lines: [rpc(1, 'tools/call', { name: 'list_memos' })] });
  assert.equal(toolText(result.responses[0]), messages.unavailable(port));
});

test('bad lines get JSON-RPC errors on stdout and nothing else', async () => {
  const result = await run({ lines: ['not json', '', '   ', '[]', rpc(7, 'ping'), '{"jsonrpc":"2.0","id":8,"method":"server/discover"}'] });
  assert.equal(result.code, 0);
  assert.deepEqual(result.responses, [
    { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON' } },
    { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid JSON-RPC request' } },
    { jsonrpc: '2.0', id: 7, result: {} },
    { jsonrpc: '2.0', id: 8, error: { code: -32601, message: 'Method not available' } },
  ]);
  assert.equal(result.stderr, '');
});

test('--port wins over WISPLY_MCP_PORT, and bad ports or arguments exit 2', async (t) => {
  const fake = await startFakeWisply();
  t.after(fake.close);
  const lines = [rpc(1, 'tools/call', { name: 'list_memos' })];
  const flagged = await run({ args: ['--port', String(fake.port)], env: { WISPLY_MCP_PORT: '1025', WISPLY_MCP_TOKEN: FAKE_TOKENS.connector }, lines });
  assert.equal(flagged.responses[0].result.isError, false);
  const equals = await run({ args: [`--port=${fake.port}`], env: { WISPLY_MCP_TOKEN: FAKE_TOKENS.connector }, lines });
  assert.equal(equals.responses[0].result.isError, false);

  for (const args of [['--port', '80'], ['--port'], ['--port=abc'], ['--port', '70000'], ['--host', 'example.com'], ['--read-only', 'setup'], ['bogus']]) {
    const result = await run({ args, lines });
    assert.equal(result.code, 2, args.join(' '));
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^wisply-mcp: /);
  }
  // Commands of later releases say so plainly, and exit 1.
  for (const command of PLANNED_COMMANDS) {
    const result = await run({ args: [command], lines });
    assert.equal(result.code, 1, command);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, `${messages.notInThisBuild(command)}\n`);
  }
  const badEnv = await run({ env: { WISPLY_MCP_PORT: 'eighty' }, lines });
  assert.equal(badEnv.code, 2);
  assert.match(badEnv.stderr, /port must be a whole number/);
});

test('--help and --version', async () => {
  const help = await run({ args: ['--help'] });
  assert.equal(help.code, 0);
  assert.equal(help.stdout, messages.HELP);
  assert.match(help.stdout, /127\.0\.0\.1/);
  assert.equal((await run({ args: ['-h'] })).stdout, messages.HELP);
  const version = await run({ args: ['--version'] });
  assert.equal(version.code, 0);
  assert.equal(version.stdout, `${VERSION}\n`);
});

test('WISPLY_MCP_DEBUG=1 logs to stderr without arguments, results or the token', async (t) => {
  const fake = await startFakeWisply();
  t.after(fake.close);
  fake.state.payloads.search_transcripts = { query: SENTINEL, matches: [{ excerpt: `${SENTINEL} said ${FAKE_TOKENS.full}` }], count: 1 };
  const lines = [
    rpc(1, 'initialize', {}),
    rpc(2, 'tools/call', { name: 'search_transcripts', arguments: { query: SENTINEL } }),
    rpc(3, 'tools/call', { name: SENTINEL }),
    `{"broken": "${SENTINEL}"`,
  ];
  const env = { WISPLY_MCP_PORT: String(fake.port), WISPLY_MCP_TOKEN: FAKE_TOKENS.connector, WISPLY_MCP_DEBUG: '1' };
  const result = await run({ env, lines });
  assert.ok(result.stdout.includes(SENTINEL), 'the result itself reaches the client');
  const logged = result.stderr.split('\n').filter(Boolean);
  assert.equal(logged.length, 4);
  for (const line of logged) assert.match(line, /^wisply-mcp:( [a-z]+=[a-z0-9/_-]+)+$/);
  assert.ok(!result.stderr.includes(SENTINEL));
  for (const token of Object.values(FAKE_TOKENS)) assert.ok(!result.stderr.includes(token));
  assert.match(logged[1], /tool=search_transcripts outcome=ok status=200 bytes=\d+/);
});
