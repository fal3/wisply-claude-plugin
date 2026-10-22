// src/sidecar.ts against test/fixtures/fake-server.mjs, run with process.execPath.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn as nodeSpawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  CHECK_ARGUMENTS, CHECK_TOOL, CONNECTION_TEXT, READ_ONLY_FLAG, createSidecar, describeConnection, sidecarEnv,
} from '../out/test/sidecar.mjs';
import * as messages from '../vendor/wisply-mcp/lib/messages.mjs';
import { FAKE_TOKENS } from './fixtures/fake-vscode.mjs';

const FAKE_SERVER = fileURLToPath(new URL('./fixtures/fake-server.mjs', import.meta.url));
const HOST_ENV = Object.freeze({
  HOME: '/Users/someone', PATH: process.env.PATH, SENTINEL_PARENT_ONLY: 'leak', WISPLY_MCP_TOKEN: FAKE_TOKENS.full,
  HTTP_PROXY: 'http://127.0.0.1:9', NODE_OPTIONS: '--require /nowhere.js', ELECTRON_RUN_AS_NODE: '0',
});
const ALLOWED_KEYS = new Set(['ELECTRON_RUN_AS_NODE', 'WISPLY_MCP_PORT', 'HOME', 'PATH', 'WISPLY_MCP_TOKEN']);
const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

function makeSidecar({ token = null, port = 51771, idleMs, spawn, execPath = process.execPath, serverPath = FAKE_SERVER } = {}) {
  const state = { token, port, spawns: [] };
  const sidecar = createSidecar({
    execPath,
    serverPath,
    getPort: () => state.port,
    getToken: async () => state.token,
    hostEnv: HOST_ENV,
    spawn: (command, args, options) => {
      state.spawns.push({ command, args, options });
      return (spawn ?? nodeSpawn)(command, args, options);
    },
    ...(idleMs ? { idleMs } : {}),
    clientVersion: '0.1.0',
  });
  return { sidecar, state };
}

const report = (answer) => {
  assert.equal(answer.kind, 'result', JSON.stringify(answer));
  return answer.result.structuredContent;
};
const childEnvKeys = (env) => Object.keys(env).filter((key) => !key.startsWith('__CF'));

test('one child: initialize once, then tools/call with increasing ids, --read-only', async (t) => {
  const { sidecar, state } = makeSidecar({ token: FAKE_TOKENS.connector });
  t.after(() => sidecar.dispose());
  const first = report(await sidecar.call('list_memos', { limit: 1 }, 5000));
  const second = report(await sidecar.call('get_live_transcript', { tail_words: 1 }, 5000));
  assert.equal(first.pid, second.pid);
  assert.equal(second.initializes, 1);
  assert.equal(second.initialized, 1);
  assert.ok(second.id > first.id);
  assert.deepEqual(first.args, { limit: 1 });
  assert.deepEqual(first.argv, [READ_ONLY_FLAG]);
  assert.equal(state.spawns.length, 1);
  assert.equal(state.spawns[0].command, process.execPath);
  assert.deepEqual(state.spawns[0].args, [FAKE_SERVER, '--read-only']);
  assert.deepEqual(state.spawns[0].options.stdio, ['pipe', 'pipe', 'ignore']);
  assert.equal(sidecar.running, true);
});

test('the child env: the stored token and four fixed variables, nothing else from the host', async (t) => {
  const { sidecar } = makeSidecar({ token: FAKE_TOKENS.connector, port: 51772 });
  t.after(() => sidecar.dispose());
  const { env } = report(await sidecar.call('list_memos', {}, 5000));
  assert.deepEqual(childEnvKeys(env).sort(), [...ALLOWED_KEYS].sort());
  assert.equal(env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(env.WISPLY_MCP_PORT, '51772');
  assert.equal(env.HOME, '/Users/someone');
  assert.equal(env.WISPLY_MCP_TOKEN, FAKE_TOKENS.connector, 'the stored token, not the host\'s');
  for (const key of ['SENTINEL_PARENT_ONLY', 'HTTP_PROXY', 'NODE_OPTIONS']) assert.equal(Object.hasOwn(env, key), false, key);
});

test('no stored token: no WISPLY_MCP_TOKEN at all (the connector falls back to the Keychain)', async (t) => {
  const { sidecar } = makeSidecar({ token: null });
  t.after(() => sidecar.dispose());
  const { env } = report(await sidecar.call('list_memos', {}, 5000));
  assert.equal(Object.hasOwn(env, 'WISPLY_MCP_TOKEN'), false);
  assert.ok(childEnvKeys(env).every((key) => ALLOWED_KEYS.has(key)));
});

test('sidecarEnv is the whole environment', () => {
  assert.deepEqual(sidecarEnv({ port: 51771, token: null, hostEnv: {} }), { ELECTRON_RUN_AS_NODE: '1', WISPLY_MCP_PORT: '51771' });
  assert.deepEqual(sidecarEnv({ port: 51771, token: FAKE_TOKENS.connector, hostEnv: { HOME: '/h', PATH: '/p', USER: 'u', HOMEX: 'x' } }),
    { ELECTRON_RUN_AS_NODE: '1', WISPLY_MCP_PORT: '51771', HOME: '/h', PATH: '/p', WISPLY_MCP_TOKEN: FAKE_TOKENS.connector });
  assert.deepEqual(sidecarEnv({ port: 51771, token: null, hostEnv: { HOME: '', PATH: undefined } }),
    { ELECTRON_RUN_AS_NODE: '1', WISPLY_MCP_PORT: '51771' });
});

test('after the child exits, the next call starts a new one', async (t) => {
  const { sidecar, state } = makeSidecar();
  t.after(() => sidecar.dispose());
  const before = report(await sidecar.call('list_memos', {}, 5000));
  assert.deepEqual(await sidecar.call('exit', {}, 5000), { kind: 'failure', failure: 'exited' });
  const after = report(await sidecar.call('list_memos', {}, 5000));
  assert.notEqual(after.pid, before.pid);
  assert.equal(after.initializes, 1);
  assert.equal(state.spawns.length, 2);
});

test('an idle child is stopped and started again on demand', async (t) => {
  const { sidecar, state } = makeSidecar({ idleMs: 100 });
  t.after(() => sidecar.dispose());
  const first = report(await sidecar.call('list_memos', {}, 5000));
  assert.equal(sidecar.running, true);
  await delay(400);
  assert.equal(sidecar.running, false);
  assert.throws(() => process.kill(first.pid, 0), 'the idle child is gone');
  const second = report(await sidecar.call('list_memos', {}, 5000));
  assert.notEqual(second.pid, first.pid);
  assert.equal(state.spawns.length, 2);
});

test('a call that times out stops the child; the next call works', async (t) => {
  const { sidecar } = makeSidecar();
  t.after(() => sidecar.dispose());
  const first = report(await sidecar.call('list_memos', {}, 5000));
  assert.deepEqual(await sidecar.call('hang', {}, 200), { kind: 'failure', failure: 'timeout' });
  const next = report(await sidecar.call('list_memos', {}, 5000));
  assert.notEqual(next.pid, first.pid);
});

test('stderr is ignored, and noise on stdout is skipped', async (t) => {
  const { sidecar } = makeSidecar();
  t.after(() => sidecar.dispose());
  assert.equal(report(await sidecar.call('noise', {}, 5000)).tool, 'noise');
  assert.equal(report(await sidecar.call('garbage', {}, 5000)).tool, 'garbage');
});

test('JSON-RPC errors and tool errors come back as answers', async (t) => {
  const { sidecar } = makeSidecar();
  t.after(() => sidecar.dispose());
  assert.deepEqual(await sidecar.call('error', {}, 5000), { kind: 'rpc-error', code: -32602, message: 'Fixed error text' });
  const toolError = await sidecar.call('tool-error', { text: 'nope' }, 5000);
  assert.equal(toolError.kind, 'result');
  assert.equal(toolError.result.isError, true);
  assert.equal(toolError.result.content[0].text, 'nope');
});

test('a line over the limit stops the child', async (t) => {
  const { sidecar } = makeSidecar();
  t.after(() => sidecar.dispose());
  assert.deepEqual(await sidecar.call('huge', {}, 10000), { kind: 'failure', failure: 'too-large' });
  assert.equal(report(await sidecar.call('list_memos', {}, 5000)).tool, 'list_memos');
});

test('parallel calls share one child and each gets its own answer', async (t) => {
  const { sidecar, state } = makeSidecar();
  t.after(() => sidecar.dispose());
  const answers = await Promise.all([
    sidecar.call('list_memos', { n: 1 }, 5000), sidecar.call('list_memos', { n: 2 }, 5000), sidecar.call('list_memos', { n: 3 }, 5000),
  ]);
  assert.deepEqual(answers.map((answer) => report(answer).args.n), [1, 2, 3]);
  assert.equal(new Set(answers.map((answer) => report(answer).pid)).size, 1);
  assert.equal(state.spawns.length, 1);
});

test('sync keeps a child whose token and port are current, and replaces one that isn\'t', async (t) => {
  const { sidecar, state } = makeSidecar({ token: FAKE_TOKENS.connector });
  t.after(() => sidecar.dispose());
  const first = report(await sidecar.call('list_memos', {}, 5000));
  await sidecar.sync();
  const same = report(await sidecar.call('list_memos', {}, 5000));
  assert.equal(same.pid, first.pid, 'an unchanged token keeps the child');

  state.token = FAKE_TOKENS.full;
  await sidecar.sync();
  assert.equal(sidecar.running, false);
  const rotated = report(await sidecar.call('list_memos', {}, 5000));
  assert.notEqual(rotated.pid, first.pid);
  assert.equal(rotated.env.WISPLY_MCP_TOKEN, FAKE_TOKENS.full);

  state.port = 51773;
  await sidecar.sync();
  const moved = report(await sidecar.call('list_memos', {}, 5000));
  assert.equal(moved.env.WISPLY_MCP_PORT, '51773');

  state.token = null;
  await sidecar.sync();
  const forgotten = report(await sidecar.call('list_memos', {}, 5000));
  assert.equal(Object.hasOwn(forgotten.env, 'WISPLY_MCP_TOKEN'), false);
});

test('a token change while the child is starting reaches the call', async (t) => {
  const { sidecar, state } = makeSidecar({ token: FAKE_TOKENS.connector });
  t.after(() => sidecar.dispose());
  const pending = sidecar.call('list_memos', {}, 5000);
  state.token = FAKE_TOKENS.full;
  await sidecar.sync();
  const answer = report(await pending);
  assert.equal(answer.env.WISPLY_MCP_TOKEN, FAKE_TOKENS.full);
});

test('restart and dispose', async () => {
  const { sidecar, state } = makeSidecar();
  const first = report(await sidecar.call('list_memos', {}, 5000));
  sidecar.restart();
  const second = report(await sidecar.call('list_memos', {}, 5000));
  assert.notEqual(second.pid, first.pid);
  sidecar.dispose();
  assert.equal(sidecar.running, false);
  assert.deepEqual(await sidecar.call('list_memos', {}, 5000), { kind: 'failure', failure: 'disposed' });
  assert.equal(state.spawns.length, 2);
  await delay(100);
  assert.throws(() => process.kill(second.pid, 0), 'the disposed child is gone');
});

test('a connector that can\'t start is a failure, not an exception', async (t) => {
  const { sidecar } = makeSidecar({ execPath: '/nonexistent/editor-binary' });
  t.after(() => sidecar.dispose());
  const answer = await sidecar.call('list_memos', {}, 2000);
  assert.equal(answer.kind, 'failure');
  assert.ok(['spawn-failed', 'exited'].includes(answer.failure), answer.failure);
  const throwing = makeSidecar({ spawn: () => { throw new Error('EACCES'); } });
  assert.deepEqual(await throwing.sidecar.call('list_memos', {}, 2000), { kind: 'failure', failure: 'spawn-failed' });
});

test('Check Connection asks for one memo: bounded on every Wisply build', () => {
  assert.equal(CHECK_TOOL, 'list_memos');
  assert.deepEqual({ ...CHECK_ARGUMENTS }, { limit: 1 });
});

test('Check Connection reports the identity proof and the tools the editor gets', () => {
  const ok = { kind: 'result', result: { content: [{ type: 'text', text: '{}' }], isError: false } };
  assert.deepEqual(describeConnection(ok, { port: 51771, stored: 'connector', allowClaudeSetup: false }), {
    kind: 'ok', text: 'Wisply answered on 127.0.0.1:51771 and proved its identity. Read-only connector token: 4 tools.',
  });
  assert.equal(describeConnection(ok, { port: 51771, stored: 'full', allowClaudeSetup: false }).text,
    'Wisply answered on 127.0.0.1:51771 and proved its identity. Full-access token: 8 tools.');
  assert.equal(describeConnection(ok, { port: 51771, stored: 'full', allowClaudeSetup: true }).text,
    'Wisply answered on 127.0.0.1:51771 and proved its identity. Full-access token: 9 tools.');
  assert.equal(describeConnection(ok, { port: 51772, stored: null, allowClaudeSetup: false }).text,
    `Wisply answered on 127.0.0.1:51772 and proved its identity. ${CONNECTION_TEXT.keychain}`);
});

test('Check Connection passes the connector\'s problem through, and turns SETUP into the editor\'s steps', () => {
  const toolError = (text) => ({ kind: 'result', result: { content: [{ type: 'text', text }], isError: true } });
  assert.deepEqual(describeConnection(toolError(messages.SETUP), { port: 51771, stored: null, allowClaudeSetup: false }),
    { kind: 'setup', text: CONNECTION_TEXT.setup });
  for (const text of [messages.unavailable(51771), messages.notWisply(51771), messages.UPDATE_WISPLY, messages.notMac('linux')]) {
    assert.deepEqual(describeConnection(toolError(text), { port: 51771, stored: 'connector', allowClaudeSetup: false }),
      { kind: 'problem', text });
  }
  assert.deepEqual(describeConnection({ kind: 'rpc-error', code: -32602, message: 'Fixed' }, { port: 1, stored: null, allowClaudeSetup: false }),
    { kind: 'problem', text: 'Fixed' });
  for (const failure of ['timeout', 'exited', 'spawn-failed', 'too-large', 'bad-response', 'disposed']) {
    assert.deepEqual(describeConnection({ kind: 'failure', failure }, { port: 1, stored: null, allowClaudeSetup: false }),
      { kind: 'problem', text: CONNECTION_TEXT.failed });
  }
});
