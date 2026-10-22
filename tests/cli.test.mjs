// setup, status and forget (lib/cli.mjs), with a simulated login keychain,
// spawn and execFile spies standing in for /usr/bin/security, and the
// synthetic Wisply from tests/fixtures. No test touches a real keychain:
// every Keychain function is injected, and runCli's own defaults are only
// reached where they can't run security (no terminal, or not macOS).
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn as nodeSpawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import contract from '../lib/contract.mjs';
import { KEYCHAIN_MAX_COPIES, PACKAGE_NAME, PLANNED_COMMANDS, VERSION } from '../lib/constants.mjs';
import { CLI_COMMANDS, parseCliArgs, runCli } from '../lib/cli.mjs';
import { createLoopback } from '../lib/loopback.mjs';
import * as messages from '../lib/messages.mjs';
import {
  DELETE_ARGS, READ_ARGS, WRITE_ARGS, defaultReadKeychain, deleteKeychain, writeKeychainInteractive,
} from '../lib/token.mjs';
import { FAKE_TOKENS, startFakeWisply } from './fixtures/fake-wisply.mjs';

const FULL = `wsp_${'5a'.repeat(32)}`;
const CONNECTOR = `wspc_${'6b'.repeat(32)}`;
const RECORDING = `wspr_${'7c'.repeat(32)}`;
const TOKEN_SHAPE = /wsp[cr]?_[0-9a-f]{64}/;
const CONNECTOR_TOOLS = ['list_memos', 'search_transcripts', 'get_live_transcript', 'get_action_items'];
const BIN = fileURLToPath(new URL('../bin/wisply-mcp.mjs', import.meta.url));

/**
 * A simulated keychain search list plus the injected dependencies of runCli.
 * `item` (and `copies` more of it) is what the keychains hold before; a read
 * and a delete see the first copy, as security does. `paste` is what the user
 * types at security's prompt; `write` overrides the outcome of the
 * interactive write (a write onto a copy that is still there fails, as an add
 * without -U does); `readBack` replaces what the read-back returns; `remove`
 * forces every delete's outcome, `removeAfterWrite` only the deletes after
 * the write.
 */
function harness({
  platform = 'darwin', isTTY = true, env = {}, item = null, copies = 0, paste = CONNECTOR, write = 'written',
  readBack, remove, removeAfterWrite, identity = 'ok',
} = {}) {
  const keychain = {
    items: item === null ? [] : Array.from({ length: copies + 1 }, () => item),
    get item() { return this.items[0] ?? null; },
    reads: 0, writes: 0, deletes: 0,
  };
  const output = [];
  const errors = [];
  const checks = [];
  const order = [];
  const deps = {
    env, platform, isTTY,
    out: (text) => { output.push(text); order.push('out'); },
    err: (text) => errors.push(text),
    writeKeychain: async () => {
      order.push('write');
      keychain.writes += 1;
      if (write !== 'written') return write;
      if (keychain.items.length > 0) return 'failed';
      keychain.items.push(paste);
      return 'written';
    },
    readKeychain: async () => {
      keychain.reads += 1;
      if (readBack !== undefined) return readBack;
      return keychain.item === null ? null : `${keychain.item}\n`;
    },
    deleteKeychain: async () => {
      order.push('delete');
      keychain.deletes += 1;
      const forced = keychain.writes > 0 && removeAfterWrite ? removeAfterWrite : remove;
      if (forced) return forced;
      if (keychain.items.length === 0) return 'not-found';
      keychain.items.shift();
      return 'deleted';
    },
    createLoopback: ({ port }) => ({
      port,
      async identity(token, scope) {
        checks.push({ port, token, scope });
        return { outcome: typeof identity === 'function' ? identity(token, scope) : identity };
      },
      async call() { throw new Error('the CLI never calls a tool'); },
    }),
  };
  return {
    keychain, checks, errors, order, deps,
    get text() { return output.join(''); },
    get lines() { return output.join('').split('\n').filter((line) => line !== ''); },
  };
}

const run = (argv, h) => runCli(argv, h.deps);
const INTRO = messages.setupIntro().split('\n').filter(Boolean);

test('the setup intro is the spec\'s text, ASCII, printed before security asks', async () => {
  assert.equal(messages.setupIntro(),
    'Wisply MCP setup\n' +
    'Paste the token from Wisply > Settings > Integrations > MCP Server.\n' +
    'Use the read-only connector token (wspc_...). macOS asks for it twice and stores it in your login keychain as "Wisply MCP token".\n');
  assert.match(messages.setupIntro({ fullAccess: true }), /^Wisply MCP setup\n.*\nWith --full-access .*"Wisply MCP token"\.\n$/s);
  const h = harness();
  await run(['setup'], h);
  assert.deepEqual(h.order.slice(0, 3), ['out', 'delete', 'write'], 'intro, then the old item goes, then security asks');
  assert.equal(h.text.startsWith(messages.setupIntro()), true);
});

test('setup stores the connector token, checks it, and prints the spec\'s success line', async () => {
  const h = harness();
  assert.equal(await run(['setup'], h), 0);
  assert.deepEqual(h.lines, [
    ...INTRO,
    'Stored. Wisply answered on 127.0.0.1:51771 and proved it holds this token (read-only connector: 4 tools).',
    messages.RESTART_NOTE,
  ]);
  assert.deepEqual(h.keychain.items, [CONNECTOR]);
  assert.deepEqual([h.keychain.writes, h.keychain.reads, h.keychain.deletes], [1, 1, 1],
    'one delete that finds nothing, one write, one read-back');
  assert.deepEqual(h.checks, [{ port: 51771, token: CONNECTOR, scope: 'connector' }]);
  assert.doesNotMatch(h.text, TOKEN_SHAPE);
  assert.deepEqual(h.errors, []);
});

test('setup keeps a recording token, and a full-access token only with --full-access', async () => {
  const recording = harness({ paste: RECORDING });
  assert.equal(await run(['setup'], recording), 0);
  // A recording-control item reaches every app that brings no token of its own, as a full-access item does.
  assert.deepEqual(recording.lines.slice(-3), [
    'Stored. Wisply answered on 127.0.0.1:51771 and proved it holds this token (recording-control: 3 tools).',
    messages.RECORDING_SHARED,
    messages.RESTART_NOTE,
  ], 'a recording-control item says every app without its own token can now start and stop recordings');
  assert.ok(!recording.lines.includes(messages.FULL_ACCESS_SHARED));
  assert.equal(messages.RECORDING_SHARED, 'Every AI app on this Mac that starts the connector without its own WISPLY_MCP_TOKEN ' +
    'can now start and stop recordings while Wisply allows agents to ("Allow agents to start and stop recordings"), and ' +
    `propose follow-ups for you to confirm in Wisply. To undo this, run \`${messages.SETUP_COMMAND}\` again with the read-only connector token.`);
  const connector = harness({ paste: CONNECTOR });
  assert.equal(await run(['setup'], connector), 0);
  assert.ok(!connector.lines.includes(messages.RECORDING_SHARED) && !connector.lines.includes(messages.FULL_ACCESS_SHARED),
    'the read-only connector token needs no note');

  const full = harness({ paste: FULL });
  assert.equal(await run(['setup', '--full-access'], full), 0);
  assert.equal(full.text.startsWith(messages.setupIntro({ fullAccess: true })), true);
  assert.deepEqual(full.lines.slice(-3), [
    'Stored. Wisply answered on 127.0.0.1:51771 and proved it holds this token (full-access: 8 tools).',
    messages.FULL_ACCESS_SHARED,
    messages.RESTART_NOTE,
  ], 'a full-access item says it reaches every app that brings no token');
  assert.equal(full.keychain.item, FULL);
  assert.deepEqual(full.checks.map((check) => check.scope), ['full']);
  for (const h of [recording, full]) assert.doesNotMatch(h.text, TOKEN_SHAPE);
});

test('setup deletes a full-access token again unless --full-access (FULL_ACCESS_REFUSED, exit 1)', async () => {
  const h = harness({ paste: FULL, item: CONNECTOR });
  assert.equal(await run(['setup'], h), 1);
  assert.deepEqual(h.lines, [...INTRO, messages.FULL_ACCESS_REFUSED, messages.NO_ITEM_NOW]);
  assert.equal(h.keychain.item, null, 'no item is left, not even the one saved before');
  assert.equal(h.keychain.deletes, 4, 'before: deleted, not found; after: deleted, not found');
  assert.deepEqual(h.checks, [], 'a refused token is never sent anywhere, not even to the identity check');
  assert.doesNotMatch(h.text, TOKEN_SHAPE);
});

test('setup deletes a malformed or unreadable value again', async () => {
  for (const paste of ['', 'sk-ant-synthetic', `wspc_${'6b'.repeat(31)}`, `WSPC_${'6B'.repeat(32)}`, `Bearer ${CONNECTOR}`]) {
    const h = harness({ paste });
    assert.equal(await run(['setup'], h), 1, JSON.stringify(paste));
    assert.deepEqual(h.lines, [...INTRO, messages.SETUP_MALFORMED, messages.NO_ITEM_NOW]);
    assert.equal(h.keychain.item, null);
    assert.deepEqual(h.checks, []);
  }
  // Pasted with spaces around it: getpass keeps them, the read-back trims them.
  const padded = harness({ paste: `  ${CONNECTOR} ` });
  assert.equal(await run(['setup'], padded), 0);
  assert.deepEqual(padded.checks.map((check) => check.token), [CONNECTOR]);

  const unreadable = harness({ readBack: null });
  assert.equal(await run(['setup'], unreadable), 1);
  assert.deepEqual(unreadable.lines, [...INTRO, messages.READ_BACK_FAILED, messages.NO_ITEM_NOW]);
  assert.equal(unreadable.keychain.item, null);
  assert.equal(unreadable.keychain.deletes, 3, 'before: not found; after: deleted, not found');
  assert.deepEqual(unreadable.checks, []);
});

test('if removing a refused value fails, setup says so and points at forget', async () => {
  for (const [options, reason] of [[{ paste: FULL }, 'full-access'], [{ paste: 'junk' }, 'malformed'], [{ readBack: null }, 'unreadable']]) {
    for (const removeAfterWrite of ['failed', 'weird']) {
      const h = harness({ ...options, removeAfterWrite });
      assert.equal(await run(['setup'], h), 1);
      assert.deepEqual(h.lines, [...INTRO, messages.removeFailed(reason)], `${reason} ${removeAfterWrite}`);
      assert.ok(h.text.includes(messages.FORGET_COMMAND));
      assert.ok(!h.text.includes("it wasn't saved"));
    }
  }
});

test('a cancelled or failed write stops setup before any read, and says if the old item is gone', async () => {
  const cancelled = harness({ write: 'cancelled' });
  assert.equal(await run(['setup'], cancelled), 1);
  assert.deepEqual(cancelled.lines, [...INTRO, messages.SETUP_CANCELLED]);
  const failed = harness({ write: 'failed' });
  assert.equal(await run(['setup'], failed), 1);
  assert.deepEqual(failed.lines, [...INTRO, messages.KEYCHAIN_NOT_STORED]);
  // An item saved before was removed first, so "your keychain wasn't changed" would be wrong.
  const replacedCancel = harness({ write: 'cancelled', item: CONNECTOR });
  assert.equal(await run(['setup'], replacedCancel), 1);
  assert.deepEqual(replacedCancel.lines, [...INTRO, messages.SETUP_CANCELLED_AFTER_REMOVAL, messages.PREVIOUS_REMOVED]);
  const replacedFail = harness({ write: 'failed', item: CONNECTOR });
  assert.equal(await run(['setup'], replacedFail), 1);
  assert.deepEqual(replacedFail.lines, [...INTRO, messages.KEYCHAIN_NOT_STORED, messages.PREVIOUS_REMOVED]);
  for (const h of [cancelled, failed, replacedCancel, replacedFail]) {
    assert.deepEqual([h.keychain.reads, h.keychain.writes, h.checks.length], [0, 1, 0]);
    assert.equal(h.keychain.item, null);
  }
});

test('setup removes every copy saved before, and stops before asking if one stays', async () => {
  // Copies in several keychains of the search list: all go, then one new item.
  const h = harness({ item: RECORDING, copies: 2 });
  assert.equal(await run(['setup'], h), 0);
  assert.deepEqual(h.keychain.items, [CONNECTOR]);
  assert.equal(h.keychain.deletes, 4, 'three deleted, then not found');
  // A delete that fails, or more copies than setup will remove, stop setup before security asks.
  for (const options of [{ item: CONNECTOR, remove: 'failed' }, { remove: 'weird' }, { item: CONNECTOR, copies: KEYCHAIN_MAX_COPIES + 1 }]) {
    const stopped = harness(options);
    assert.equal(await run(['setup'], stopped), 1, JSON.stringify(options));
    assert.deepEqual(stopped.lines, [...INTRO, messages.REPLACE_FAILED]);
    assert.deepEqual([stopped.keychain.writes, stopped.keychain.reads, stopped.checks.length], [0, 0, 0]);
  }
  const throwing = harness();
  assert.equal(await runCli(['setup'], { ...throwing.deps, deleteKeychain: async () => { throw new Error('boom'); } }), 1);
  assert.deepEqual(throwing.lines, [...INTRO, messages.REPLACE_FAILED]);
  assert.equal(throwing.keychain.writes, 0);
});

test('a stored token that Wisply doesn\'t confirm stays stored, with the reason (exit 1)', async () => {
  for (const outcome of ['unavailable', 'not-wisply', 'old-wisply', 'missing-scope', 'keychain', 'surprising']) {
    const h = harness({ identity: outcome, paste: outcome === 'missing-scope' ? RECORDING : CONNECTOR });
    assert.equal(await run(['setup'], h), 1, outcome);
    assert.deepEqual(h.lines, [...INTRO, messages.STORED_UNCHECKED, messages.identityProblem(outcome, 51771, { terminal: true }),
      ...(outcome === 'missing-scope' ? [messages.RECORDING_SHARED] : []), messages.RESTART_NOTE]);
    assert.notEqual(h.keychain.item, null);
  }
  assert.equal(messages.identityProblem('unavailable', 51771), messages.unavailable(51771));
  assert.equal(messages.identityProblem('not-wisply', 51771), messages.notWisply(51771));
  // In a terminal, a failed check names the setup command, whatever the tool texts may name.
  assert.equal(messages.identityProblem('not-wisply', 51771, { terminal: true }), messages.TERMINAL_TEXTS.notWisply(51771));
  assert.ok(messages.identityProblem('not-wisply', 51771, { terminal: true }).includes(messages.SETUP_COMMAND));
  assert.equal(messages.identityProblem('old-wisply', 51771), messages.UPDATE_WISPLY);
  assert.equal(messages.identityProblem('missing-scope', 51771), messages.UPDATE_WISPLY_SCOPE);
  // Wisply's own 503 (it couldn't read its tokens from the Keychain) gets the same text as in a tool result.
  assert.equal(messages.identityProblem('keychain', 51771), messages.keychainUnavailable(51771));
  assert.equal(messages.identityProblem('keychain', 51771, { terminal: true }), messages.keychainUnavailable(51771));
  assert.equal(messages.identityProblem('surprising', 51771, { terminal: true }), messages.TERMINAL_TEXTS.notWisply(51771));
  // A check that throws counts as nothing answering.
  const throwing = harness({ identity: () => { throw new Error('boom'); } });
  assert.equal(await run(['setup'], throwing), 1);
  assert.ok(throwing.lines.includes(messages.unavailable(51771)));
});

test('setup checks the port from --port or WISPLY_MCP_PORT, and checks the keychain token, not the env one', async () => {
  const flagged = harness({ env: { WISPLY_MCP_PORT: '51773' } });
  assert.equal(await run(['setup', '--port', '51772'], flagged), 0);
  assert.deepEqual(flagged.checks.map((check) => check.port), [51772]);
  assert.ok(flagged.lines.some((line) => line.startsWith('Stored. Wisply answered on 127.0.0.1:51772 ')));
  const fromEnv = harness({ env: { WISPLY_MCP_PORT: '51773' } });
  assert.equal(await run(['setup', '--full-access', '--port=51774'], fromEnv), 0);
  assert.deepEqual(fromEnv.checks.map((check) => check.port), [51774]);
  const envOnly = harness({ env: { WISPLY_MCP_PORT: '51773' } });
  await run(['setup'], envOnly);
  assert.deepEqual(envOnly.checks.map((check) => check.port), [51773]);

  const shadowed = harness({ env: { WISPLY_MCP_TOKEN: RECORDING } });
  assert.equal(await run(['setup'], shadowed), 0);
  assert.deepEqual(shadowed.checks.map((check) => check.token), [CONNECTOR]);
  assert.equal(shadowed.lines.at(-1), messages.ENV_WINS);
  for (const value of ['', '${user_config.wisply_mcp_token}', 'junk']) {
    const quiet = harness({ env: { WISPLY_MCP_TOKEN: value } });
    await run(['setup'], quiet);
    assert.ok(!quiet.lines.includes(messages.ENV_WINS), value);
  }
});

test('setup needs macOS and a terminal, and touches nothing without them', async () => {
  const linux = harness({ platform: 'linux' });
  assert.equal(await run(['setup'], linux), 1);
  assert.deepEqual(linux.lines, [messages.notMac('linux')]);
  const piped = harness({ isTTY: false });
  assert.equal(await run(['setup'], piped), 1);
  assert.deepEqual(piped.lines, [messages.SETUP_NEEDS_TERMINAL]);
  for (const h of [linux, piped]) {
    assert.deepEqual([h.keychain.writes, h.keychain.reads, h.keychain.deletes, h.checks.length], [0, 0, 0, 0]);
  }
  // runCli's own default is "not a terminal", so a caller that forgets to say gets the refusal.
  const output = [];
  assert.equal(await runCli(['setup'], { platform: 'darwin', env: {}, out: (text) => output.push(text) }), 1);
  assert.deepEqual(output, [`${messages.SETUP_NEEDS_TERMINAL}\n`]);
});

test('setup through the real Keychain functions: fixed argv, -w last, stdio inherited, no token in any argv or env', async () => {
  const runs = [];
  const signals = new EventEmitter();
  let stored = null; // what the simulated keychain holds; the user "pastes" the full-access token
  const notFound = () => Object.assign(new Error('exit 44'), { code: 44 });
  const spawn = (file, args, options) => {
    runs.push({ via: 'spawn', file, args, options });
    const child = new EventEmitter();
    setImmediate(() => { stored = FULL; child.emit('exit', 0, null); });
    return child;
  };
  const execFile = (file, args, options, callback) => {
    runs.push({ via: 'execFile', file, args, options });
    setImmediate(() => {
      if (stored === null) return callback(notFound(), '', '');
      if (args[0] === 'delete-generic-password') stored = null;
      return callback(null, args[0] === 'find-generic-password' ? `${FULL}\n` : '', '');
    });
    return { stdin: { end() {} }, kill() {} };
  };
  const env = { WISPLY_MCP_TOKEN: CONNECTOR, WISPLY_MCP_PORT: '51771', PATH: '/usr/bin:/bin', HOME: '/Users/synthetic' };
  const h = harness({ env });
  const code = await runCli(['setup'], {
    ...h.deps,
    writeKeychain: () => writeKeychainInteractive({ spawn, signals, env }),
    readKeychain: () => defaultReadKeychain({ execFile, env }),
    deleteKeychain: () => deleteKeychain({ execFile, env }),
  });
  assert.equal(code, 1);
  assert.deepEqual(runs.map((entry) => [entry.via, entry.file, entry.args]), [
    ['execFile', '/usr/bin/security', [...DELETE_ARGS]],
    ['spawn', '/usr/bin/security', [...WRITE_ARGS]],
    ['execFile', '/usr/bin/security', [...READ_ARGS]],
    ['execFile', '/usr/bin/security', [...DELETE_ARGS]],
    ['execFile', '/usr/bin/security', [...DELETE_ARGS]],
  ]);
  assert.equal(runs[1].options.stdio, 'inherit');
  assert.equal(runs[1].args.at(-1), '-w');
  for (const entry of runs) {
    for (const argument of entry.args) assert.doesNotMatch(argument, TOKEN_SHAPE);
    assert.doesNotMatch(JSON.stringify(entry.options), TOKEN_SHAPE);
    // security gets the environment without WISPLY_MCP_*: the env token never reaches a child.
    assert.deepEqual(entry.options.env, { PATH: '/usr/bin:/bin', HOME: '/Users/synthetic' });
  }
  assert.ok(h.lines.includes(messages.FULL_ACCESS_REFUSED));
  assert.doesNotMatch(h.text, TOKEN_SHAPE);
  assert.equal(signals.listenerCount('SIGINT'), 0);
});

test('setup against the synthetic Wisply: the success line names the real port', async (t) => {
  const fake = await startFakeWisply();
  t.after(fake.close);
  const h = harness({ paste: FAKE_TOKENS.connector });
  const code = await runCli(['setup', '--port', String(fake.port)], { ...h.deps, createLoopback });
  assert.equal(code, 0);
  assert.ok(h.lines.includes(`Stored. Wisply answered on 127.0.0.1:${fake.port} and proved it holds this token (read-only connector: 4 tools).`));
  assert.equal(fake.state.challenges.length, 1);
  assert.equal(fake.state.challenges[0].authorization, undefined, 'the check sends no token');
  assert.equal(fake.state.calls.length, 0, 'setup never calls a tool');

  const impostor = await startFakeWisply({ mode: 'impostor' });
  t.after(impostor.close);
  const refused = harness({ paste: FAKE_TOKENS.connector });
  assert.equal(await runCli(['setup', '--port', String(impostor.port)], { ...refused.deps, createLoopback }), 1);
  assert.ok(refused.lines.includes(messages.TERMINAL_TEXTS.notWisply(impostor.port)));
  assert.equal(impostor.state.calls.length, 0);
});

test('status from the keychain: scope, source, port, identity and tools; never the token', async () => {
  const h = harness({ item: CONNECTOR });
  assert.equal(await run(['status'], h), 0);
  assert.deepEqual(h.lines, [
    `wisply-mcp ${VERSION} status`,
    'Token:  read-only connector token, from your login keychain ("Wisply MCP token")',
    'Wisply: answered on 127.0.0.1:51771 and proved it holds this token',
    `Tools:  4 (${CONNECTOR_TOOLS.join(', ')})`,
    messages.RESTART_NOTE,
  ]);
  assert.deepEqual(h.checks, [{ port: 51771, token: CONNECTOR, scope: 'connector' }]);
  assert.deepEqual([h.keychain.writes, h.keychain.deletes], [0, 0], 'status only reads');
  assert.doesNotMatch(h.text, TOKEN_SHAPE);
  assert.ok(!h.lines.includes(messages.STATUS.fullAccessShared) && !h.lines.includes(messages.STATUS.recordingShared));
  for (const token of [FULL, RECORDING]) {
    const other = harness({ item: token });
    assert.equal(await run(['status'], other), 0);
    assert.doesNotMatch(other.text, TOKEN_SHAPE);
    // A full-access or recording-control keychain item reaches every app that brings no token of its own; status says so.
    assert.equal(other.lines.includes(messages.STATUS.fullAccessShared), token === FULL);
    assert.equal(other.lines.includes(messages.STATUS.recordingShared), token === RECORDING);
  }
  const recording = harness({ item: RECORDING });
  await run(['status'], recording);
  assert.deepEqual(recording.lines.slice(3, 5), ['Tools:  3 (start_recording, stop_recording, propose_follow_up)',
    messages.STATUS.recordingShared]);
  const full = harness({ item: FULL });
  await run(['status'], full);
  assert.deepEqual(full.lines.slice(3, 5), [`Tools:  8 (${contract.tools.filter((tool) => tool !== 'setup_claude').join(', ')})`,
    messages.STATUS.fullAccessShared]);
});

test('status from WISPLY_MCP_TOKEN, and a placeholder that was ignored', async () => {
  const env = harness({ env: { WISPLY_MCP_TOKEN: FULL, WISPLY_MCP_PORT: '51772' }, item: CONNECTOR });
  assert.equal(await run(['status'], env), 0);
  assert.equal(env.lines[1], 'Token:  full-access token, from WISPLY_MCP_TOKEN');
  assert.equal(env.lines[2], 'Wisply: answered on 127.0.0.1:51772 and proved it holds this token');
  assert.equal(env.lines[3], `Tools:  8 (${contract.tools.filter((tool) => tool !== 'setup_claude').join(', ')})`);
  assert.equal(env.keychain.reads, 0, 'a usable env token wins without a Keychain read');
  assert.ok(!env.lines.includes(messages.STATUS.fullAccessShared), 'an env token reaches only the app that sets it');
  const recordingEnv = harness({ env: { WISPLY_MCP_TOKEN: RECORDING } });
  assert.equal(await run(['status'], recordingEnv), 0);
  assert.ok(!recordingEnv.lines.includes(messages.STATUS.recordingShared), 'an env recording token reaches only the app that sets it');

  const placeholder = harness({ env: { WISPLY_MCP_TOKEN: '${user_config.wisply_mcp_token}' }, item: RECORDING });
  assert.equal(await run(['status'], placeholder), 0);
  assert.deepEqual(placeholder.lines.slice(1, 4), [
    'Token:  recording-control token, from your login keychain ("Wisply MCP token")',
    messages.STATUS.placeholder,
    'Wisply: answered on 127.0.0.1:51771 and proved it holds this token',
  ]);
  assert.equal(messages.STATUS.placeholder, 'Note:   WISPLY_MCP_TOKEN holds an unresolved ${...} placeholder, so it was ignored.');
  for (const h of [env, placeholder]) assert.doesNotMatch(h.text, TOKEN_SHAPE);
});

test('status with the serve options counts the tools an app would see', async () => {
  const cases = [
    [['status'], {}, 8],
    [['status', '--allow-claude-setup'], {}, 9],
    [['status'], { WISPLY_MCP_ALLOW_CLAUDE_SETUP: '1' }, 9],
    [['status', '--read-only'], {}, 4],
    [['status', '--read-only', '--allow-claude-setup'], {}, 4],
  ];
  for (const [argv, env, count] of cases) {
    const h = harness({ env, item: FULL });
    assert.equal(await run(argv, h), 0);
    assert.match(h.lines[3], new RegExp(`^Tools:  ${count} \\(`), argv.join(' '));
  }
  // --read-only with a recording-control token leaves nothing to call; status says so plainly.
  const nothing = harness({ item: RECORDING });
  assert.equal(await run(['status', '--read-only'], nothing), 0);
  assert.equal(nothing.lines[3],
    'Tools:  none (--read-only offers only the read-only memo tools, and a recording-control token reaches none of them)');
  assert.equal(messages.STATUS.tools([], { withoutToken: true }), nothing.lines[3]);
  // setup counts the default list: the env switch is for status and serving only.
  const setup = harness({ env: { WISPLY_MCP_ALLOW_CLAUDE_SETUP: '1' }, paste: FULL });
  await run(['setup', '--full-access'], setup);
  assert.ok(setup.lines.some((line) => line.endsWith('(full-access: 8 tools).')));
});

test('status without a usable token: what is wrong, the read-only tools, exit 1', async () => {
  const missing = harness();
  assert.equal(await run(['status'], missing), 1);
  assert.deepEqual(missing.lines, [
    `wisply-mcp ${VERSION} status`,
    'Token:  not set',
    'Wisply: not checked on 127.0.0.1:51771 (the identity check needs a token)',
    `Tools:  4 read-only tools, listed without a token (${CONNECTOR_TOOLS.join(', ')})`,
    messages.TERMINAL_TEXTS.SETUP,
  ]);
  assert.ok(messages.TERMINAL_TEXTS.SETUP.includes(messages.SETUP_COMMAND), 'in a terminal, the setup text names the command');
  // The port the connector would use shows even without a token.
  const elsewhere = harness({ env: { WISPLY_MCP_PORT: '51779' } });
  await run(['status'], elsewhere);
  assert.equal(elsewhere.lines[2], 'Wisply: not checked on 127.0.0.1:51779 (the identity check needs a token)');
  const flagged = harness();
  await run(['status', '--port=51778'], flagged);
  assert.equal(flagged.lines[2], 'Wisply: not checked on 127.0.0.1:51778 (the identity check needs a token)');

  const malformed = harness({ env: { WISPLY_MCP_TOKEN: 'sk-synthetic' } });
  assert.equal(await run(['status'], malformed), 1);
  assert.equal(malformed.lines[1], "Token:  not usable (WISPLY_MCP_TOKEN isn't a Wisply token)");
  assert.equal(malformed.lines.at(-1), messages.TERMINAL_TEXTS.MALFORMED);
  assert.ok(!malformed.text.includes('sk-synthetic'), 'the value itself is never shown');
  assert.equal(malformed.keychain.reads, 0);

  const linux = harness({ platform: 'linux', item: CONNECTOR, env: { WISPLY_MCP_TOKEN: '${input:wisply-token}' } });
  assert.equal(await run(['status'], linux), 1);
  assert.deepEqual(linux.lines.slice(1, 3), ['Token:  not set', messages.STATUS.placeholder]);
  assert.equal(linux.lines.at(-1), messages.notMac('linux'));
  assert.equal(linux.keychain.reads, 0, 'no Keychain off macOS');

  for (const h of [missing, malformed, linux]) assert.deepEqual(h.checks, []);
});

test('status reports each failed identity check with its message (exit 1)', async () => {
  const short = {
    unavailable: 'Wisply: not answering on 127.0.0.1:51771',
    'not-wisply': 'Wisply: the program on 127.0.0.1:51771 failed the identity check',
    'old-wisply': 'Wisply: answered on 127.0.0.1:51771, but has no identity check',
    'missing-scope': 'Wisply: answered on 127.0.0.1:51771, but sent no proof for recording-control tokens',
    keychain: "Wisply: answered on 127.0.0.1:51771, but couldn't read its MCP tokens from the Keychain",
  };
  for (const [outcome, line] of Object.entries(short)) {
    const h = harness({ item: RECORDING, identity: outcome });
    assert.equal(await run(['status'], h), 1, outcome);
    assert.equal(h.lines[2], line);
    assert.equal(h.lines[4], messages.STATUS.recordingShared);
    assert.equal(h.lines[5], messages.identityProblem(outcome, 51771, { terminal: true }));
    assert.equal(h.lines[6], messages.RESTART_NOTE);
    assert.doesNotMatch(h.text, TOKEN_SHAPE);
  }
  // A resolver that throws is no token, not a crash.
  const broken = harness();
  assert.equal(await runCli(['status'], { ...broken.deps, resolveToken: async () => { throw new Error(`boom ${CONNECTOR}`); } }), 1);
  assert.equal(broken.lines[1], 'Token:  not set');
  assert.doesNotMatch(broken.text, TOKEN_SHAPE);
});

test('status against the synthetic Wisply, with the token in the env', async (t) => {
  const fake = await startFakeWisply();
  t.after(fake.close);
  const h = harness({ env: { WISPLY_MCP_TOKEN: FAKE_TOKENS.recording, WISPLY_MCP_PORT: String(fake.port) } });
  assert.equal(await runCli(['status'], { ...h.deps, createLoopback }), 0);
  assert.equal(h.lines[2], `Wisply: answered on 127.0.0.1:${fake.port} and proved it holds this token`);
  assert.equal(h.lines[3], 'Tools:  3 (start_recording, stop_recording, propose_follow_up)');
  assert.equal(fake.state.challenges[0].authorization, undefined);
  assert.equal(fake.state.calls.length, 0);
});

test('status and setup against a Wisply that can\'t read its tokens from the Keychain (its own 503)', async (t) => {
  const fake = await startFakeWisply({ mode: 'keychain-locked' });
  t.after(fake.close);
  const env = { WISPLY_MCP_PORT: String(fake.port) };
  const status = harness({ env, item: FAKE_TOKENS.connector });
  assert.equal(await runCli(['status'], { ...status.deps, createLoopback }), 1);
  assert.equal(status.lines[2], `Wisply: answered on 127.0.0.1:${fake.port}, but couldn't read its MCP tokens from the Keychain`);
  assert.equal(status.lines[4], messages.keychainUnavailable(fake.port));
  const setup = harness({ env, paste: FAKE_TOKENS.connector });
  assert.equal(await runCli(['setup'], { ...setup.deps, createLoopback }), 1);
  assert.deepEqual(setup.lines.slice(INTRO.length), [
    messages.STORED_UNCHECKED, messages.keychainUnavailable(fake.port), messages.RESTART_NOTE,
  ]);
  assert.equal(setup.keychain.item, FAKE_TOKENS.connector, 'the token stays stored: Wisply has to reopen, not the user to redo setup');
  // The token never went to the listener: identity challenges only, no Authorization, no call.
  assert.ok(fake.state.challenges.length >= 2);
  for (const challenge of fake.state.challenges) assert.equal(challenge.authorization, undefined);
  assert.equal(fake.state.calls.length, 0);
  for (const h of [status, setup]) assert.doesNotMatch(h.text, TOKEN_SHAPE);
});

test('forget removes the item, says when there was none, and reports a failure', async () => {
  const removed = harness({ item: CONNECTOR });
  assert.equal(await run(['forget'], removed), 0);
  assert.deepEqual(removed.lines, [messages.FORGOTTEN]);
  assert.equal(removed.keychain.item, null);
  const none = harness();
  assert.equal(await run(['forget'], none), 0);
  assert.deepEqual(none.lines, [messages.NOTHING_TO_FORGET]);
  for (const remove of ['failed', undefined]) {
    const failed = harness({ item: CONNECTOR, remove: remove ?? 'surprise' });
    assert.equal(await run(['forget'], failed), 1);
    assert.deepEqual(failed.lines, [messages.FORGET_FAILED]);
  }
  const throwing = harness();
  assert.equal(await runCli(['forget'], { ...throwing.deps, deleteKeychain: async () => { throw new Error('boom'); } }), 1);
  assert.deepEqual(throwing.lines, [messages.FORGET_FAILED]);
  const shadowed = harness({ item: CONNECTOR, env: { WISPLY_MCP_TOKEN: CONNECTOR } });
  assert.equal(await run(['forget'], shadowed), 0);
  assert.deepEqual(shadowed.lines, [messages.FORGOTTEN, messages.ENV_UNCHANGED]);
  // Off macOS setup never stores anything, so there is nothing to remove: done, exit 0.
  const windows = harness({ platform: 'win32', item: CONNECTOR });
  assert.equal(await run(['forget'], windows), 0);
  assert.deepEqual(windows.lines, [messages.nothingSavedOffMac('win32')]);
  assert.equal(windows.keychain.deletes, 0);
  const linux = harness({ platform: 'linux', env: { WISPLY_MCP_TOKEN: CONNECTOR, WISPLY_MCP_PORT: 'eighty' } });
  assert.equal(await run(['forget'], linux), 0);
  assert.deepEqual(linux.lines, [messages.nothingSavedOffMac('linux'), messages.ENV_UNCHANGED]);
  assert.deepEqual(linux.errors, []);
  assert.equal(linux.keychain.deletes, 0);
  assert.match(messages.nothingSavedOffMac('linux'), /runs Linux, so there's nothing to remove\.$/);
  for (const h of [removed, none, shadowed, windows, linux]) assert.equal(h.keychain.reads, 0, 'forget never reads the token');
});

test('forget removes every copy in the search list, and never reports a copy it left as gone', async () => {
  // delete-generic-password removes the first match only; a second keychain's copy would stay readable.
  const two = harness({ item: CONNECTOR, copies: 1 });
  assert.equal(await run(['forget'], two), 0);
  assert.deepEqual(two.lines, [messages.forgotten(2)]);
  assert.deepEqual(two.keychain.items, []);
  assert.equal(two.keychain.deletes, 3, 'deleted, deleted, then not found');
  // More copies than forget removes: it says it couldn't, and exits 1.
  const most = harness({ item: CONNECTOR, copies: KEYCHAIN_MAX_COPIES - 1 });
  assert.equal(await run(['forget'], most), 0);
  assert.deepEqual(most.lines, [messages.forgotten(KEYCHAIN_MAX_COPIES)]);
  const many = harness({ item: CONNECTOR, copies: KEYCHAIN_MAX_COPIES + 1 });
  assert.equal(await run(['forget'], many), 1);
  assert.deepEqual(many.lines, [messages.FORGET_FAILED]);
  assert.equal(many.keychain.items.length, 1);
  assert.equal(many.keychain.deletes, KEYCHAIN_MAX_COPIES + 1);
  // A failure after a successful delete is still a failure.
  let calls = 0;
  const partial = harness();
  const deleteKeychain = async () => { calls += 1; return calls === 1 ? 'deleted' : 'failed'; };
  assert.equal(await runCli(['forget'], { ...partial.deps, deleteKeychain }), 1);
  assert.deepEqual(partial.lines, [messages.FORGET_FAILED]);
});

test('forget ignores WISPLY_MCP_PORT, so a stale value never keeps the item', async () => {
  for (const value of ['eighty', '80', '70000']) {
    const h = harness({ item: CONNECTOR, env: { WISPLY_MCP_PORT: value } });
    assert.equal(await run(['forget'], h), 0, value);
    assert.deepEqual(h.errors, []);
    assert.deepEqual(h.lines, [messages.FORGOTTEN]);
    assert.equal(h.keychain.deletes, 2);
  }
  assert.deepEqual(parseCliArgs(['forget'], { WISPLY_MCP_PORT: 'eighty' }), {
    options: { command: 'forget', port: 51771, fullAccess: false, readOnly: false, allowClaudeSetup: false },
  });
  // setup and status, which use the port, still refuse a bad one (exit 2).
  for (const command of ['setup', 'status']) {
    const h = harness({ env: { WISPLY_MCP_PORT: 'eighty' } });
    assert.equal(await run([command], h), 2, command);
    assert.match(h.errors[0], /port must be a whole number/);
  }
});

test('forget runs delete-generic-password through the real function', async () => {
  const runs = [];
  const execFile = (file, args, options, callback) => {
    runs.push({ file, args });
    setImmediate(() => callback(Object.assign(new Error('exit 44'), { code: 44 }), '', ''));
    return { stdin: { end() {} }, kill() {} };
  };
  const h = harness();
  assert.equal(await runCli(['forget'], { ...h.deps, deleteKeychain: () => deleteKeychain({ execFile }) }), 0);
  assert.deepEqual(runs, [{ file: '/usr/bin/security', args: [...DELETE_ARGS] }]);
  assert.deepEqual(h.lines, [messages.NOTHING_TO_FORGET]);
});

test('arguments: each command takes only its own flags; --help; bad ports exit 2', async () => {
  assert.deepEqual(CLI_COMMANDS, ['setup', 'status', 'forget']);
  for (const command of CLI_COMMANDS) assert.ok(!PLANNED_COMMANDS.includes(command));
  const refused = [
    ['setup', '--read-only'], ['setup', '--allow-claude-setup'], ['setup', 'extra'], ['status', '--full-access'],
    ['forget', '--port', '51772'], ['forget', '--full-access'], ['status', '--host', 'example.com'], ['setup', '--port'],
    ['setup', '--port', '80'], ['status', '--port=abc'], ['status', '--port', '70000'],
  ];
  for (const argv of refused) {
    const h = harness();
    assert.equal(await run(argv, h), 2, argv.join(' '));
    assert.equal(h.text, '');
    assert.equal(h.errors.length, 1);
    assert.match(h.errors[0], /^wisply-mcp: .*\n$/);
    assert.deepEqual([h.keychain.writes, h.keychain.reads, h.keychain.deletes], [0, 0, 0]);
  }
  const badEnv = harness({ env: { WISPLY_MCP_PORT: 'eighty' } });
  assert.equal(await run(['status'], badEnv), 2);
  assert.match(badEnv.errors[0], /port must be a whole number/);
  for (const argv of [['setup', '--help'], ['status', '-h'], ['forget', '--help']]) {
    const h = harness();
    assert.equal(await run(argv, h), 0);
    assert.equal(h.text, messages.HELP);
    assert.equal(h.keychain.writes + h.keychain.reads + h.keychain.deletes, 0);
  }
  assert.deepEqual(parseCliArgs(['status', '--port=51772', '--read-only'], {}), {
    options: { command: 'status', port: 51772, fullAccess: false, readOnly: true, allowClaudeSetup: false },
  });
  assert.deepEqual(parseCliArgs(['setup', '--full-access'], { WISPLY_MCP_PORT: ' 51779 ', WISPLY_MCP_ALLOW_CLAUDE_SETUP: '1' }), {
    options: { command: 'setup', port: 51779, fullAccess: true, readOnly: false, allowClaudeSetup: false },
  });
  assert.ok('error' in parseCliArgs(['serve'], {}));
});

/** True when no 16-character run of `token` appears in `text`. */
function holdsNoPartOf(text, token) {
  for (let start = 0; start + 16 <= token.length; start += 1) {
    if (text.includes(token.slice(start, start + 16))) return false;
  }
  return true;
}

test('a token passed as an argument or as the port is never echoed, not even in part', async () => {
  const values = [CONNECTOR, FULL, RECORDING, CONNECTOR.slice(0, 30), CONNECTOR.toUpperCase(), `--token=${CONNECTOR}`,
    CONNECTOR.slice(5), `"${RECORDING}"`];
  for (const value of values) {
    for (const argv of [['setup', value], ['status', value], ['forget', value], ['status', '--port', value], ['setup', `--port=${value}`]]) {
      const h = harness();
      assert.equal(await run(argv, h), 2, argv.join(' '));
      assert.deepEqual(h.errors, [`${messages.TOKEN_AS_ARGUMENT}\n`], argv.join(' '));
      assert.ok(holdsNoPartOf(h.errors.join('') + h.text, value.replace(/^--token=|"/g, '')), argv.join(' '));
      assert.equal(h.keychain.writes + h.keychain.reads + h.keychain.deletes, 0);
    }
    const env = harness({ env: { WISPLY_MCP_PORT: value } });
    assert.equal(await run(['status'], env), 2);
    assert.deepEqual(env.errors, [`${messages.TOKEN_AS_ARGUMENT}\n`]);
  }
  for (const text of [messages.unknownArgument(CONNECTOR), messages.badPort(FULL)]) assert.equal(text, messages.TOKEN_AS_ARGUMENT);
  // Anything else is still shown, cut and made printable, so typos are easy to spot.
  assert.equal(messages.unknownArgument('--verbose'), 'wisply-mcp: unknown argument "--verbose". Run wisply-mcp --help.');
  assert.equal(messages.badPort('eighty'), 'wisply-mcp: the port must be a whole number from 1024 to 65535 (got "eighty").');
  assert.match(messages.TOKEN_AS_ARGUMENT, /^wisply-mcp: /);
  assert.ok(messages.TOKEN_AS_ARGUMENT.includes(messages.SETUP_COMMAND));
});

test('every CLI text is ASCII, holds no token, and names only commands this build has', () => {
  const texts = [
    messages.setupIntro(), messages.setupIntro({ fullAccess: true }), messages.SETUP_NEEDS_TERMINAL,
    messages.SETUP_CANCELLED, messages.SETUP_CANCELLED_AFTER_REMOVAL, messages.REPLACE_FAILED, messages.PREVIOUS_REMOVED,
    messages.KEYCHAIN_NOT_STORED, messages.SETUP_MALFORMED, messages.READ_BACK_FAILED,
    messages.NO_ITEM_NOW, messages.removeFailed('full-access'), messages.removeFailed('malformed'),
    messages.stored(51771, 'connector', 4), messages.STORED_UNCHECKED, messages.FULL_ACCESS_SHARED, messages.RECORDING_SHARED,
    messages.RESTART_NOTE,
    messages.ENV_WINS, messages.FORGOTTEN, messages.forgotten(1), messages.forgotten(3), messages.NOTHING_TO_FORGET,
    messages.FORGET_FAILED, messages.ENV_UNCHANGED,
    messages.FULL_ACCESS_REFUSED, messages.HELP, messages.STATUS.header, messages.STATUS.placeholder,
    messages.STATUS.token('full', 'env'), messages.STATUS.token('connector', 'keychain'), messages.STATUS.noToken('missing'),
    messages.STATUS.noToken('malformed'), messages.STATUS.wisply(null, 51771), messages.STATUS.wisply('ok', 51771),
    messages.STATUS.tools(CONNECTOR_TOOLS), messages.STATUS.tools(CONNECTOR_TOOLS, { withoutToken: true }),
    messages.STATUS.tools([]), messages.STATUS.fullAccessShared, messages.STATUS.recordingShared, messages.TOKEN_AS_ARGUMENT,
    ...PLANNED_COMMANDS.map((command) => messages.notInThisBuild(command)),
    messages.TERMINAL_TEXTS.SETUP, messages.TERMINAL_TEXTS.MALFORMED, messages.TERMINAL_TEXTS.notWisply(51771),
    messages.identityProblem('not-wisply', 51771, { terminal: true }),
  ];
  for (const text of texts) {
    assert.equal(typeof text, 'string');
    assert.equal(text.search(/[^\x00-\x7f]/), -1, text);
    assert.doesNotMatch(text, TOKEN_SHAPE);
    for (const command of PLANNED_COMMANDS) {
      assert.ok(!text.includes(`${PACKAGE_NAME} ${command}`) && !text.includes(`wisply-mcp ${command}`), `${command}: ${text}`);
    }
  }
  assert.equal(messages.FORGET_COMMAND, `${messages.COMMAND_PREFIX} forget`);
  assert.equal(messages.forgotten(1), messages.FORGOTTEN);
  assert.equal(messages.forgotten(3).startsWith('Removed 3 copies of "Wisply MCP token" from your keychains.'), true);
  assert.equal(messages.stored(51771, 'connector', 4),
    'Stored. Wisply answered on 127.0.0.1:51771 and proved it holds this token (read-only connector: 4 tools).');
});

// --- The real bin ----------------------------------------------------------

async function bin(args, { env = {}, stdin = 'ignore' } = {}) {
  const child = nodeSpawn(process.execPath, [BIN, ...args], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME ?? '/tmp', ...env },
    stdio: [stdin, 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const [code] = await once(child, 'exit');
  return { code, stdout, stderr };
}

test('bin: status with an env token against the synthetic Wisply, exit 0, no token in the output', async (t) => {
  const fake = await startFakeWisply();
  t.after(fake.close);
  const result = await bin(['status', '--port', String(fake.port)], { env: { WISPLY_MCP_TOKEN: FAKE_TOKENS.connector } });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(result.stderr, '');
  assert.deepEqual(result.stdout.split('\n').slice(0, 4), [
    `wisply-mcp ${VERSION} status`,
    'Token:  read-only connector token, from WISPLY_MCP_TOKEN',
    `Wisply: answered on 127.0.0.1:${fake.port} and proved it holds this token`,
    `Tools:  4 (${CONNECTOR_TOOLS.join(', ')})`,
  ]);
  assert.doesNotMatch(result.stdout, TOKEN_SHAPE);
  const help = await bin(['status', '--help']);
  assert.equal(help.code, 0);
  assert.equal(help.stdout, messages.HELP);
  const usage = await bin(['forget', '--port', '1']);
  assert.equal(usage.code, 2);
  assert.equal(usage.stdout, '');
  assert.match(usage.stderr, /^wisply-mcp: unknown argument "--port"/);
});

test('bin: a token in the arguments (as an AI app config might pass it) is never echoed to stderr', async () => {
  for (const args of [[CONNECTOR], ['--read-only', FULL], ['--port', RECORDING], ['setup', CONNECTOR]]) {
    const result = await bin(args);
    assert.equal(result.code, 2, args.join(' '));
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, `${messages.TOKEN_AS_ARGUMENT}\n`);
    for (const value of args) if (TOKEN_SHAPE.test(value)) assert.ok(holdsNoPartOf(result.stderr, value));
  }
  const fromEnv = await bin([], { env: { WISPLY_MCP_PORT: CONNECTOR } });
  assert.equal(fromEnv.code, 2);
  assert.equal(fromEnv.stderr, `${messages.TOKEN_AS_ARGUMENT}\n`);
});

test('bin: setup without a terminal changes nothing (on macOS it never reaches security)', async () => {
  const result = await bin(['setup'], { stdin: 'pipe' });
  assert.equal(result.code, 1);
  const expected = process.platform === 'darwin' ? messages.SETUP_NEEDS_TERMINAL : messages.notMac(process.platform);
  assert.equal(result.stdout, `${expected}\n`);
  assert.equal(result.stderr, '');
});

test('bin: forget and status off macOS say so (forget has nothing to remove: exit 0; status: exit 1)', {
  skip: process.platform === 'darwin' ? 'would run the real /usr/bin/security against your login keychain' : false,
}, async () => {
  // A stale WISPLY_MCP_PORT doesn't stop forget (it takes no port).
  const forget = await bin(['forget'], { env: { WISPLY_MCP_PORT: 'eighty' } });
  assert.equal(forget.code, 0, forget.stdout + forget.stderr);
  assert.equal(forget.stdout, `${messages.nothingSavedOffMac(process.platform)}\n`);
  assert.equal(forget.stderr, '');
  const status = await bin(['status']);
  assert.equal(status.code, 1);
  assert.equal(status.stdout.trim().split('\n').at(-1), messages.notMac(process.platform));
});
