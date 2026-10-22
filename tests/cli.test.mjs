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
import { PACKAGE_NAME, PLANNED_COMMANDS, VERSION } from '../lib/constants.mjs';
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
 * A simulated login keychain plus the injected dependencies of runCli.
 * `paste` is what the user types at security's prompt; `write` overrides
 * the outcome of the interactive write; `readBack` replaces what the
 * read-back returns; `remove` forces the delete's outcome.
 */
function harness({
  platform = 'darwin', isTTY = true, env = {}, item = null, paste = CONNECTOR, write = 'written',
  readBack, remove, identity = 'ok',
} = {}) {
  const keychain = { item, reads: 0, writes: 0, deletes: 0 };
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
      if (write === 'written') keychain.item = paste;
      return write;
    },
    readKeychain: async () => {
      keychain.reads += 1;
      if (readBack !== undefined) return readBack;
      return keychain.item === null ? null : `${keychain.item}\n`;
    },
    deleteKeychain: async () => {
      keychain.deletes += 1;
      if (remove) return remove;
      if (keychain.item === null) return 'not-found';
      keychain.item = null;
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
  assert.deepEqual(h.order.slice(0, 2), ['out', 'write']);
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
  assert.equal(h.keychain.item, CONNECTOR);
  assert.deepEqual([h.keychain.writes, h.keychain.reads, h.keychain.deletes], [1, 1, 0], 'one write, one read-back');
  assert.deepEqual(h.checks, [{ port: 51771, token: CONNECTOR, scope: 'connector' }]);
  assert.doesNotMatch(h.text, TOKEN_SHAPE);
  assert.deepEqual(h.errors, []);
});

test('setup keeps a recording token, and a full-access token only with --full-access', async () => {
  const recording = harness({ paste: RECORDING });
  assert.equal(await run(['setup'], recording), 0);
  assert.ok(recording.lines.includes('Stored. Wisply answered on 127.0.0.1:51771 and proved it holds this token (recording-control: 3 tools).'));

  const full = harness({ paste: FULL });
  assert.equal(await run(['setup', '--full-access'], full), 0);
  assert.equal(full.text.startsWith(messages.setupIntro({ fullAccess: true })), true);
  assert.ok(full.lines.includes('Stored. Wisply answered on 127.0.0.1:51771 and proved it holds this token (full-access: 8 tools).'));
  assert.equal(full.keychain.item, FULL);
  assert.deepEqual(full.checks.map((check) => check.scope), ['full']);
  for (const h of [recording, full]) assert.doesNotMatch(h.text, TOKEN_SHAPE);
});

test('setup deletes a full-access token again unless --full-access (FULL_ACCESS_REFUSED, exit 1)', async () => {
  const h = harness({ paste: FULL, item: CONNECTOR });
  assert.equal(await run(['setup'], h), 1);
  assert.deepEqual(h.lines, [...INTRO, messages.FULL_ACCESS_REFUSED, messages.NO_ITEM_NOW]);
  assert.equal(h.keychain.item, null, 'no item is left, not even the one -U replaced');
  assert.equal(h.keychain.deletes, 1);
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
  assert.equal(unreadable.keychain.deletes, 1);
  assert.deepEqual(unreadable.checks, []);
});

test('if removing a refused value fails, setup says so and points at forget', async () => {
  for (const [options, reason] of [[{ paste: FULL }, 'full-access'], [{ paste: 'junk' }, 'malformed'], [{ readBack: null }, 'unreadable']]) {
    for (const remove of ['failed', 'weird']) {
      const h = harness({ ...options, remove });
      assert.equal(await run(['setup'], h), 1);
      assert.deepEqual(h.lines, [...INTRO, messages.removeFailed(reason)], `${reason} ${remove}`);
      assert.ok(h.text.includes(messages.FORGET_COMMAND));
      assert.ok(!h.text.includes("it wasn't saved"));
    }
  }
});

test('a cancelled or failed write stops setup before any read', async () => {
  const cancelled = harness({ write: 'cancelled', item: CONNECTOR });
  assert.equal(await run(['setup'], cancelled), 1);
  assert.deepEqual(cancelled.lines, [...INTRO, messages.SETUP_CANCELLED]);
  const failed = harness({ write: 'failed' });
  assert.equal(await run(['setup'], failed), 1);
  assert.deepEqual(failed.lines, [...INTRO, messages.KEYCHAIN_NOT_STORED]);
  for (const h of [cancelled, failed]) assert.deepEqual([h.keychain.reads, h.keychain.deletes, h.checks.length], [0, 0, 0]);
  assert.equal(cancelled.keychain.item, CONNECTOR, 'the item from before is untouched');
});

test('a stored token that Wisply doesn\'t confirm stays stored, with the reason (exit 1)', async () => {
  for (const outcome of ['unavailable', 'not-wisply', 'old-wisply', 'missing-scope', 'surprising']) {
    const h = harness({ identity: outcome, paste: outcome === 'missing-scope' ? RECORDING : CONNECTOR });
    assert.equal(await run(['setup'], h), 1, outcome);
    assert.deepEqual(h.lines, [...INTRO, messages.STORED_UNCHECKED, messages.identityProblem(outcome, 51771), messages.RESTART_NOTE]);
    assert.notEqual(h.keychain.item, null);
  }
  assert.equal(messages.identityProblem('unavailable', 51771), messages.unavailable(51771));
  assert.equal(messages.identityProblem('not-wisply', 51771), messages.notWisply(51771));
  assert.equal(messages.identityProblem('old-wisply', 51771), messages.UPDATE_WISPLY);
  assert.equal(messages.identityProblem('missing-scope', 51771), messages.UPDATE_WISPLY_SCOPE);
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

test('setup through the real Keychain functions: fixed argv, -w last, stdio inherited, no token in any argv', async () => {
  const runs = [];
  const signals = new EventEmitter();
  const spawn = (file, args, options) => {
    runs.push({ via: 'spawn', file, args, options });
    const child = new EventEmitter();
    setImmediate(() => child.emit('exit', 0, null));
    return child;
  };
  const answers = { 'find-generic-password': `${FULL}\n`, 'delete-generic-password': '' };
  const execFile = (file, args, options, callback) => {
    runs.push({ via: 'execFile', file, args, options });
    setImmediate(() => callback(null, answers[args[0]], ''));
    return { stdin: { end() {} }, kill() {} };
  };
  const h = harness({ env: { WISPLY_MCP_TOKEN: CONNECTOR } });
  const code = await runCli(['setup'], {
    ...h.deps,
    writeKeychain: () => writeKeychainInteractive({ spawn, signals }),
    readKeychain: () => defaultReadKeychain({ execFile }),
    deleteKeychain: () => deleteKeychain({ execFile }),
  });
  assert.equal(code, 1);
  assert.deepEqual(runs.map((entry) => [entry.via, entry.file, entry.args]), [
    ['spawn', '/usr/bin/security', [...WRITE_ARGS]],
    ['execFile', '/usr/bin/security', [...READ_ARGS]],
    ['execFile', '/usr/bin/security', [...DELETE_ARGS]],
  ]);
  assert.equal(runs[0].options.stdio, 'inherit');
  assert.equal(runs[0].args.at(-1), '-w');
  for (const entry of runs) {
    for (const argument of entry.args) assert.doesNotMatch(argument, TOKEN_SHAPE);
    assert.doesNotMatch(JSON.stringify(entry.options), TOKEN_SHAPE);
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
  assert.ok(refused.lines.includes(messages.notWisply(impostor.port)));
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
  for (const token of [FULL, RECORDING]) {
    const other = harness({ item: token });
    assert.equal(await run(['status'], other), 0);
    assert.doesNotMatch(other.text, TOKEN_SHAPE);
  }
});

test('status from WISPLY_MCP_TOKEN, and a placeholder that was ignored', async () => {
  const env = harness({ env: { WISPLY_MCP_TOKEN: FULL, WISPLY_MCP_PORT: '51772' }, item: CONNECTOR });
  assert.equal(await run(['status'], env), 0);
  assert.equal(env.lines[1], 'Token:  full-access token, from WISPLY_MCP_TOKEN');
  assert.equal(env.lines[2], 'Wisply: answered on 127.0.0.1:51772 and proved it holds this token');
  assert.equal(env.lines[3], `Tools:  8 (${contract.tools.filter((tool) => tool !== 'setup_claude').join(', ')})`);
  assert.equal(env.keychain.reads, 0, 'a usable env token wins without a Keychain read');

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
    'Wisply: not checked (the identity check needs a token)',
    `Tools:  4 read-only tools, listed without a token (${CONNECTOR_TOOLS.join(', ')})`,
    messages.SETUP,
  ]);
  assert.ok(messages.SETUP.includes(messages.SETUP_COMMAND), 'the setup text names the command now that it exists');

  const malformed = harness({ env: { WISPLY_MCP_TOKEN: 'sk-synthetic' } });
  assert.equal(await run(['status'], malformed), 1);
  assert.equal(malformed.lines[1], "Token:  not usable (WISPLY_MCP_TOKEN isn't a Wisply token)");
  assert.equal(malformed.lines.at(-1), messages.MALFORMED);
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
    'missing-scope': "Wisply: answered on 127.0.0.1:51771, but doesn't know recording-control tokens",
  };
  for (const [outcome, line] of Object.entries(short)) {
    const h = harness({ item: RECORDING, identity: outcome });
    assert.equal(await run(['status'], h), 1, outcome);
    assert.equal(h.lines[2], line);
    assert.equal(h.lines[4], messages.identityProblem(outcome, 51771));
    assert.equal(h.lines[5], messages.RESTART_NOTE);
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
  const linux = harness({ platform: 'win32', item: CONNECTOR });
  assert.equal(await run(['forget'], linux), 1);
  assert.deepEqual(linux.lines, [messages.notMac('win32')]);
  assert.equal(linux.keychain.deletes, 0);
  for (const h of [removed, none, shadowed]) assert.equal(h.keychain.reads, 0, 'forget never reads the token');
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

test('every CLI text is ASCII, holds no token, and names only commands this build has', () => {
  const texts = [
    messages.setupIntro(), messages.setupIntro({ fullAccess: true }), messages.SETUP_NEEDS_TERMINAL,
    messages.SETUP_CANCELLED, messages.KEYCHAIN_NOT_STORED, messages.SETUP_MALFORMED, messages.READ_BACK_FAILED,
    messages.NO_ITEM_NOW, messages.removeFailed('full-access'), messages.removeFailed('malformed'),
    messages.stored(51771, 'connector', 4), messages.STORED_UNCHECKED, messages.RESTART_NOTE, messages.ENV_WINS,
    messages.FORGOTTEN, messages.NOTHING_TO_FORGET, messages.FORGET_FAILED, messages.ENV_UNCHANGED,
    messages.FULL_ACCESS_REFUSED, messages.HELP, messages.STATUS.header, messages.STATUS.placeholder,
    messages.STATUS.token('full', 'env'), messages.STATUS.token('connector', 'keychain'), messages.STATUS.noToken('missing'),
    messages.STATUS.noToken('malformed'), messages.STATUS.wisply(null, 51771), messages.STATUS.wisply('ok', 51771),
    messages.STATUS.tools(CONNECTOR_TOOLS), messages.STATUS.tools(CONNECTOR_TOOLS, { withoutToken: true }),
  ];
  for (const text of texts) {
    assert.equal(typeof text, 'string');
    assert.equal(text.search(/[^\x00-\x7f]/), -1, text);
    assert.doesNotMatch(text, TOKEN_SHAPE);
    for (const command of PLANNED_COMMANDS) {
      assert.ok(!text.includes(`${PACKAGE_NAME} ${command}`) && !text.includes(`wisply-mcp ${command}`), `${command}: ${text}`);
    }
  }
  assert.equal(messages.FORGET_COMMAND, 'npx -y --prefix / @wisply/mcp@0.1.0 forget');
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

test('bin: setup without a terminal changes nothing (on macOS it never reaches security)', async () => {
  const result = await bin(['setup'], { stdin: 'pipe' });
  assert.equal(result.code, 1);
  const expected = process.platform === 'darwin' ? messages.SETUP_NEEDS_TERMINAL : messages.notMac(process.platform);
  assert.equal(result.stdout, `${expected}\n`);
  assert.equal(result.stderr, '');
});

test('bin: forget and status off macOS say so', {
  skip: process.platform === 'darwin' ? 'would run the real /usr/bin/security against your login keychain' : false,
}, async () => {
  const forget = await bin(['forget']);
  assert.equal(forget.code, 1);
  assert.equal(forget.stdout, `${messages.notMac(process.platform)}\n`);
  const status = await bin(['status']);
  assert.equal(status.code, 1);
  assert.equal(status.stdout.trim().split('\n').at(-1), messages.notMac(process.platform));
});
