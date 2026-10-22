// Token resolution (environment first, then the Keychain) and the Keychain
// item itself: read, interactive write and delete through /usr/bin/security.
// Every `security` run here is a spy or a plain node child standing in for
// it; no test ever touches a real keychain (on a Mac, the tests that would
// run the real /usr/bin/security are skipped). Tokens are synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFile as nodeExecFile } from 'node:child_process';
import {
  KEYCHAIN_ACCOUNT, KEYCHAIN_LABEL, KEYCHAIN_MAX_COPIES, KEYCHAIN_SERVICE, KEYCHAIN_TIMEOUT_MS, SECURITY_BIN,
} from '../lib/constants.mjs';
import {
  DELETE_ARGS, ITEM_NOT_FOUND_EXIT, PLACEHOLDER_RE, READ_ARGS, WRITE_ARGS, defaultReadKeychain, deleteAllKeychain,
  deleteKeychain, envToken, redact, resolveToken, securityEnv, writeKeychainInteractive,
} from '../lib/token.mjs';

const FULL = `wsp_${'5a'.repeat(32)}`;
const CONNECTOR = `wspc_${'6b'.repeat(32)}`;
const RECORDING = `wspr_${'7c'.repeat(32)}`;

/** A Keychain reader spy that answers `value`. */
function keychain(value = null) {
  const spy = async () => { spy.calls += 1; if (value instanceof Error) throw value; return value; };
  spy.calls = 0;
  return spy;
}

test('a valid env token wins and the Keychain is not consulted', async () => {
  for (const token of [FULL, CONNECTOR, RECORDING]) {
    for (const platform of ['darwin', 'linux']) {
      const readKeychain = keychain(CONNECTOR);
      assert.deepEqual(await resolveToken({ env: { WISPLY_MCP_TOKEN: token }, platform, readKeychain }),
        { token, source: 'env', problem: null, placeholderIgnored: false });
      assert.equal(readKeychain.calls, 0);
    }
  }
  // Pasted with whitespace around it.
  const padded = await resolveToken({ env: { WISPLY_MCP_TOKEN: `  ${CONNECTOR}\n` }, platform: 'darwin', readKeychain: keychain() });
  assert.equal(padded.token, CONNECTOR);
});

test('unset, empty and whitespace-only env values fall through to the Keychain', async () => {
  for (const env of [{}, { WISPLY_MCP_TOKEN: '' }, { WISPLY_MCP_TOKEN: '   ' }, { WISPLY_MCP_TOKEN: '\n\t' }]) {
    const readKeychain = keychain(CONNECTOR);
    assert.deepEqual(await resolveToken({ env, platform: 'darwin', readKeychain }),
      { token: CONNECTOR, source: 'keychain', problem: null, placeholderIgnored: false });
    assert.equal(readKeychain.calls, 1);
  }
});

test('placeholders a client left unresolved count as unset', async () => {
  const placeholders = ['${user_config.wisply_mcp_token}', '${input:wisply-token}', '${env:WISPLY_MCP_TOKEN}', ' ${WISPLY_PLUGIN_TOKEN} '];
  for (const value of placeholders) {
    const readKeychain = keychain(FULL);
    const result = await resolveToken({ env: { WISPLY_MCP_TOKEN: value }, platform: 'darwin', readKeychain });
    assert.deepEqual(result, { token: FULL, source: 'keychain', problem: null, placeholderIgnored: true }, value);
    assert.equal(readKeychain.calls, 1);
    const missing = await resolveToken({ env: { WISPLY_MCP_TOKEN: value }, platform: 'darwin', readKeychain: keychain(null) });
    assert.deepEqual(missing, { token: null, source: null, problem: 'missing', placeholderIgnored: true });
  }
  assert.ok(PLACEHOLDER_RE.test('${a}'));
  assert.ok(!PLACEHOLDER_RE.test('${}'));
  assert.ok(!PLACEHOLDER_RE.test(`wspc_\${x}`));
});

test('a malformed env value is reported, without the Keychain and without the value', async () => {
  const malformed = [
    'synthetic', `sk-ant-${'x'.repeat(40)}`, `wsp_${'5A'.repeat(32)}`, `wsp_${'5a'.repeat(31)}`, `${FULL}0`,
    `${FULL}\r\nInjected: yes`, `Bearer ${FULL}`, `wspc_\${input:x}`, `"${CONNECTOR}"`,
  ];
  for (const value of malformed) {
    for (const platform of ['darwin', 'linux']) {
      const readKeychain = keychain(CONNECTOR);
      const result = await resolveToken({ env: { WISPLY_MCP_TOKEN: value }, platform, readKeychain });
      assert.deepEqual(result, { token: null, source: null, problem: 'malformed', placeholderIgnored: false }, value);
      assert.equal(readKeychain.calls, 0);
      assert.ok(!JSON.stringify(result).includes(value.trim()));
    }
  }
});

test('without a usable env token, other platforms are not-mac and never read a Keychain', async () => {
  for (const platform of ['linux', 'win32', 'freebsd']) {
    for (const env of [{}, { WISPLY_MCP_TOKEN: '${user_config.wisply_mcp_token}' }]) {
      const readKeychain = keychain(CONNECTOR);
      const result = await resolveToken({ env, platform, readKeychain });
      assert.equal(result.problem, 'not-mac');
      assert.equal(result.token, null);
      assert.equal(result.placeholderIgnored, env.WISPLY_MCP_TOKEN !== undefined);
      assert.equal(readKeychain.calls, 0);
    }
  }
});

test('a Keychain that fails, answers nothing or answers junk is missing; nothing throws', async () => {
  for (const answer of [null, undefined, '', 42, {}, 'not a token', `${FULL}x`, new Error(`failed ${FULL}`)]) {
    const result = await resolveToken({ env: {}, platform: 'darwin', readKeychain: keychain(answer) });
    assert.deepEqual(result, { token: null, source: null, problem: 'missing', placeholderIgnored: false });
  }
  const throwsSync = () => { throw new Error('sync'); };
  assert.equal((await resolveToken({ env: {}, platform: 'darwin', readKeychain: throwsSync })).problem, 'missing');
  // A stored value with a trailing newline (security -w prints one) is fine.
  assert.equal((await resolveToken({ env: {}, platform: 'darwin', readKeychain: keychain(`${CONNECTOR}\n`) })).token, CONNECTOR);
  // A hostile env object never makes it throw either.
  const hostile = new Proxy({}, { get() { throw new Error('boom'); } });
  assert.equal((await resolveToken({ env: hostile, platform: 'darwin', readKeychain: keychain() })).problem, 'missing');
});

test('envToken classifies the variable without returning anything but a token', () => {
  assert.deepEqual(envToken({ WISPLY_MCP_TOKEN: ` ${CONNECTOR} ` }), { kind: 'token', token: CONNECTOR });
  for (const env of [undefined, {}, { WISPLY_MCP_TOKEN: '' }, { WISPLY_MCP_TOKEN: ' \n' }, { WISPLY_MCP_TOKEN: 42 }]) {
    assert.deepEqual(envToken(env), { kind: 'unset' });
  }
  assert.deepEqual(envToken({ WISPLY_MCP_TOKEN: '${user_config.wisply_mcp_token}' }), { kind: 'placeholder' });
  assert.deepEqual(envToken({ WISPLY_MCP_TOKEN: 'sk-synthetic' }), { kind: 'malformed' });
});

// --- The Keychain item through /usr/bin/security -------------------------

const TOKEN_SHAPE = /wsp[cr]?_[0-9a-f]{64}/;

/**
 * An execFile spy standing in for /usr/bin/security. It records each run and
 * answers with `stdout`, or fails with exit `code`, or (never) not at all.
 */
function fakeExecFile({ stdout = '', code = null, never = false, throws = false } = {}) {
  const spy = (file, args, options, callback) => {
    if (throws) throw new Error('spawn failed');
    const child = new EventEmitter();
    child.stdin = { end: () => { spy.stdinEnded += 1; } };
    child.kill = (signal) => { spy.kills.push(signal); return true; };
    spy.calls.push({ file, args, options });
    if (!never) {
      setImmediate(() => {
        if (code === null) callback(null, stdout, '');
        else callback(Object.assign(new Error(`Command failed: exit ${code}`), { code }), '', 'security: SecKeychainSearchCopyNext');
      });
    }
    return child;
  };
  spy.calls = [];
  spy.kills = [];
  spy.stdinEnded = 0;
  return spy;
}

test('the item and the security argument lists are fixed, absolute and token-free', () => {
  assert.equal(SECURITY_BIN, '/usr/bin/security');
  assert.equal(KEYCHAIN_SERVICE, 'ai.wisply.mcp');
  assert.equal(KEYCHAIN_ACCOUNT, 'token');
  assert.equal(KEYCHAIN_LABEL, 'Wisply MCP token');
  assert.equal(KEYCHAIN_TIMEOUT_MS, 2000);
  assert.equal(ITEM_NOT_FOUND_EXIT, (-25300) & 0xff, 'errSecItemNotFound as an exit status');
  assert.deepEqual(READ_ARGS, ['find-generic-password', '-s', 'ai.wisply.mcp', '-a', 'token', '-w']);
  // No -U: updating an existing item would merge -T into its old access list, so setup deletes first.
  assert.deepEqual(WRITE_ARGS, ['add-generic-password', '-s', 'ai.wisply.mcp', '-a', 'token', '-l', 'Wisply MCP token',
    '-T', '/usr/bin/security', '-w']);
  assert.ok(!WRITE_ARGS.includes('-U'));
  assert.deepEqual(DELETE_ARGS, ['delete-generic-password', '-s', 'ai.wisply.mcp', '-a', 'token']);
  // -w last with no value: security prompts for the password itself.
  assert.equal(WRITE_ARGS.at(-1), '-w');
  for (const list of [READ_ARGS, WRITE_ARGS, DELETE_ARGS]) {
    assert.ok(Object.isFrozen(list));
    assert.ok(!list.includes('-A'), 'never "any application may read"');
    for (const argument of list) assert.doesNotMatch(argument, TOKEN_SHAPE);
  }
});

test('defaultReadKeychain runs find-generic-password -w with a 2 s budget and a pipe', async () => {
  const execFile = fakeExecFile({ stdout: `${CONNECTOR}\n` });
  assert.equal(await defaultReadKeychain({ execFile }), `${CONNECTOR}\n`);
  assert.equal(execFile.calls.length, 1);
  const [{ file, args, options }] = execFile.calls;
  assert.equal(file, '/usr/bin/security');
  assert.deepEqual(args, [...READ_ARGS]);
  assert.equal(options.timeout, 2000);
  assert.equal(options.killSignal, 'SIGKILL');
  assert.equal(options.encoding, 'utf8');
  assert.ok(options.maxBuffer <= 4096);
  assert.equal(Object.hasOwn(options, 'stdio'), false, 'execFile pipes stdout back');
  assert.equal(execFile.stdinEnded, 1, 'stdin is closed, so security can never wait for input');
});

test('defaultReadKeychain is null for no item, any failure, and a runner that throws', async () => {
  for (const code of [ITEM_NOT_FOUND_EXIT, 1, 51, 128]) {
    assert.equal(await defaultReadKeychain({ execFile: fakeExecFile({ code }) }), null, `exit ${code}`);
  }
  assert.equal(await defaultReadKeychain({ execFile: fakeExecFile({ throws: true }) }), null);
});

test('a read that never answers is null after exactly 2 s, and the child is killed', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const execFile = fakeExecFile({ never: true });
  let result = 'pending';
  const read = defaultReadKeychain({ execFile }).then((value) => { result = value; });
  t.mock.timers.tick(KEYCHAIN_TIMEOUT_MS - 1);
  await Promise.resolve();
  assert.equal(result, 'pending');
  t.mock.timers.tick(1);
  await read;
  assert.equal(result, null);
  assert.deepEqual(execFile.kills, ['SIGKILL']);
});

// Real child processes standing in for /usr/bin/security (the file argument
// is ignored), so the pipe, the timeout kill and the size cap are Node's own.
const stand = (script) => (_file, _args, options, callback) => nodeExecFile(process.execPath, ['-e', script], options, callback);

test('a real child: its stdout comes back through the pipe, and resolveToken takes it', async () => {
  const execFile = stand(`process.stdout.write(${JSON.stringify(`${RECORDING}\n`)})`);
  assert.equal(await defaultReadKeychain({ execFile }), `${RECORDING}\n`);
  const result = await resolveToken({ env: {}, platform: 'darwin', readKeychain: () => defaultReadKeychain({ execFile }) });
  assert.deepEqual(result, { token: RECORDING, source: 'keychain', problem: null, placeholderIgnored: false });
});

test('a real child that hangs is killed at the timeout; one that floods stdout is refused', async () => {
  const started = Date.now();
  assert.equal(await defaultReadKeychain({ execFile: stand('setInterval(() => {}, 1000)'), timeoutMs: 300 }), null);
  assert.ok(Date.now() - started < 2000, 'answered at the timeout, not after the child chose to exit');
  assert.equal(await defaultReadKeychain({ execFile: stand("process.stdout.write('a'.repeat(100000))") }), null);
  assert.equal(await defaultReadKeychain({ execFile: stand('process.exit(44)') }), null);
});

test('placeholders fall through to the real reader, which runs the fixed find argv', async () => {
  for (const value of ['${user_config.wisply_mcp_token}', '${input:wisply-token}', '${env:X}', '', '  ']) {
    const execFile = fakeExecFile({ stdout: `${CONNECTOR}\n` });
    const result = await resolveToken({
      env: { WISPLY_MCP_TOKEN: value }, platform: 'darwin', readKeychain: () => defaultReadKeychain({ execFile }),
    });
    assert.deepEqual(result, { token: CONNECTOR, source: 'keychain', problem: null, placeholderIgnored: value.trim() !== '' }, value);
    assert.deepEqual(execFile.calls.map((run) => run.args), [[...READ_ARGS]]);
  }
  // A valid env token means security never runs, and no argv ever holds a token.
  const execFile = fakeExecFile({ stdout: `${FULL}\n` });
  await resolveToken({ env: { WISPLY_MCP_TOKEN: CONNECTOR }, platform: 'darwin', readKeychain: () => defaultReadKeychain({ execFile }) });
  assert.equal(execFile.calls.length, 0);
});

test('the Keychain holding junk, an empty value or a hex dump is no token', async () => {
  for (const stdout of ['', '\n', 'not a token\n', `${'77'.repeat(40)}\n`, `${CONNECTOR} ${CONNECTOR}\n`]) {
    const execFile = fakeExecFile({ stdout });
    const result = await resolveToken({ env: {}, platform: 'darwin', readKeychain: () => defaultReadKeychain({ execFile }) });
    assert.deepEqual(result, { token: null, source: null, problem: 'missing', placeholderIgnored: false }, JSON.stringify(stdout));
  }
});

/** A spawn spy whose child exits as told, after the caller had a chance to look. */
function fakeSpawn({ exit = [0, null], error = null, throws = false } = {}) {
  const spy = (file, args, options) => {
    if (throws) throw new Error('spawn failed');
    spy.calls.push({ file, args, options });
    const child = new EventEmitter();
    spy.child = child;
    setImmediate(() => {
      spy.listenersDuring = spy.signals?.listenerCount('SIGINT');
      if (error) child.emit('error', error);
      else child.emit('exit', ...exit);
    });
    return child;
  };
  spy.calls = [];
  return spy;
}

test('writeKeychainInteractive lets security prompt in the terminal: -w last, stdio inherited', async () => {
  const signals = new EventEmitter();
  const spawn = fakeSpawn();
  spawn.signals = signals;
  assert.equal(await writeKeychainInteractive({ spawn, signals }), 'written');
  assert.equal(spawn.calls.length, 1);
  const [{ file, args, options }] = spawn.calls;
  assert.equal(file, '/usr/bin/security');
  assert.deepEqual(args, [...WRITE_ARGS]);
  assert.equal(args.at(-1), '-w');
  assert.equal(options.stdio, 'inherit');
  assert.deepEqual(options.env, securityEnv(process.env), 'this process\'s environment, minus WISPLY_MCP_*');
  for (const argument of args) assert.doesNotMatch(argument, TOKEN_SHAPE);
  // Ctrl-C is left to security while it runs, and the handler is gone after.
  assert.equal(spawn.listenersDuring, 1);
  assert.equal(signals.listenerCount('SIGINT'), 0);
});

test('writeKeychainInteractive reports cancel, failure and a spawn error, and always lets go of SIGINT', async () => {
  const cases = [
    [{ exit: [1, null] }, 'failed'],
    [{ exit: [null, 'SIGINT'] }, 'cancelled'],
    [{ exit: [null, 'SIGTERM'] }, 'cancelled'],
    [{ error: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) }, 'failed'],
    [{ throws: true }, 'failed'],
  ];
  for (const [options, expected] of cases) {
    const signals = new EventEmitter();
    assert.equal(await writeKeychainInteractive({ spawn: fakeSpawn(options), signals }), expected, JSON.stringify(options));
    assert.equal(signals.listenerCount('SIGINT'), 0);
  }
  // A SIGINT while security runs doesn't end the write by itself; security's exit does.
  const signals = new EventEmitter();
  let finished = false;
  const spawn = (file, args, options) => {
    const child = new EventEmitter();
    setImmediate(() => {
      signals.emit('SIGINT');
      setImmediate(() => {
        assert.equal(finished, false);
        child.emit('exit', null, 'SIGINT');
      });
    });
    return child;
  };
  assert.equal(await writeKeychainInteractive({ spawn, signals }).finally(() => { finished = true; }), 'cancelled');
  assert.equal(await writeKeychainInteractive({ spawn: () => null, signals }), 'failed');
});

test('deleteKeychain: deleted, not found (exit 44), failed, and a 2 s budget', async (t) => {
  const execFile = fakeExecFile({ stdout: 'keychain: "/Users/synthetic/Library/Keychains/login.keychain-db"\n' });
  assert.equal(await deleteKeychain({ execFile }), 'deleted');
  const [{ file, args, options }] = execFile.calls;
  assert.equal(file, '/usr/bin/security');
  assert.deepEqual(args, [...DELETE_ARGS]);
  assert.equal(options.timeout, 2000);
  assert.ok(options.maxBuffer >= 16 * 1024, 'room for the attributes security prints');
  assert.equal(await deleteKeychain({ execFile: fakeExecFile({ code: ITEM_NOT_FOUND_EXIT }) }), 'not-found');
  assert.equal(await deleteKeychain({ execFile: fakeExecFile({ code: 1 }) }), 'failed');
  assert.equal(await deleteKeychain({ execFile: fakeExecFile({ throws: true }) }), 'failed');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const never = fakeExecFile({ never: true });
  const pending = deleteKeychain({ execFile: never });
  t.mock.timers.tick(KEYCHAIN_TIMEOUT_MS);
  assert.equal(await pending, 'failed');
  assert.deepEqual(never.kills, ['SIGKILL']);
});

test('off macOS the real reader and delete find no security binary and say so quietly', {
  skip: process.platform === 'darwin' ? 'would run the real /usr/bin/security against your login keychain' : false,
}, async () => {
  assert.equal(await defaultReadKeychain(), null);
  assert.equal(await deleteKeychain(), 'failed');
  const result = await resolveToken({ env: {}, platform: 'darwin' });
  assert.deepEqual(result, { token: null, source: null, problem: 'missing', placeholderIgnored: false });
});

test('security never gets WISPLY_MCP_* variables: not for a read, a write or a delete', async () => {
  const env = {
    WISPLY_MCP_TOKEN: CONNECTOR, WISPLY_MCP_PORT: '51772', WISPLY_MCP_DEBUG: '1', wisply_mcp_token: FULL,
    PATH: '/usr/bin:/bin', HOME: '/Users/synthetic', LANG: 'en_US.UTF-8', OTHER_TOKEN_NAME: 'kept', EMPTY: '',
  };
  const kept = { PATH: '/usr/bin:/bin', HOME: '/Users/synthetic', LANG: 'en_US.UTF-8', OTHER_TOKEN_NAME: 'kept', EMPTY: '' };
  assert.deepEqual(securityEnv(env), kept);
  assert.deepEqual(securityEnv(null), {});
  assert.deepEqual(securityEnv(), securityEnv(process.env), 'the default is this process\'s environment');
  assert.equal(securityEnv({ A: undefined }).A, undefined);
  const execFile = fakeExecFile({ stdout: `${RECORDING}\n` });
  await defaultReadKeychain({ execFile, env });
  await deleteKeychain({ execFile, env });
  const spawn = fakeSpawn();
  await writeKeychainInteractive({ spawn, signals: new EventEmitter(), env });
  for (const options of [...execFile.calls.map((run) => run.options), spawn.calls[0].options]) {
    assert.deepEqual(options.env, kept);
    assert.doesNotMatch(JSON.stringify(options), TOKEN_SHAPE);
  }
  // A real child sees no token variable either.
  const real = (_file, _args, options, callback) => nodeExecFile(process.execPath,
    ['-e', 'process.stdout.write(JSON.stringify(Object.keys(process.env).filter((key) => /^wisply_mcp_/i.test(key))))'], options, callback);
  assert.equal(await defaultReadKeychain({ execFile: real, env: { ...process.env, ...env } }), '[]');
  // An environment that can't be read is a failed run, not a crash.
  const hostile = new Proxy({}, { ownKeys() { throw new Error('boom'); } });
  assert.equal(await defaultReadKeychain({ execFile: fakeExecFile({ stdout: CONNECTOR }), env: hostile }), null);
  assert.equal(await writeKeychainInteractive({ spawn: fakeSpawn(), signals: new EventEmitter(), env: hostile }), 'failed');
});

test('deleteAllKeychain deletes until security finds none, and never calls a copy it left removed', async () => {
  const script = (...outcomes) => {
    const spy = async () => { spy.calls += 1; const next = outcomes.shift(); if (next instanceof Error) throw next; return next; };
    spy.calls = 0;
    return spy;
  };
  assert.deepEqual(await deleteAllKeychain({ deleteOnce: script('not-found') }), { removed: 0, complete: true });
  assert.deepEqual(await deleteAllKeychain({ deleteOnce: script('deleted', 'not-found') }), { removed: 1, complete: true });
  assert.deepEqual(await deleteAllKeychain({ deleteOnce: script('deleted', 'deleted', 'deleted', 'not-found') }), { removed: 3, complete: true });
  assert.deepEqual(await deleteAllKeychain({ deleteOnce: script('deleted', 'failed') }), { removed: 1, complete: false });
  assert.deepEqual(await deleteAllKeychain({ deleteOnce: script('failed') }), { removed: 0, complete: false });
  assert.deepEqual(await deleteAllKeychain({ deleteOnce: script(new Error('boom')) }), { removed: 0, complete: false });
  assert.deepEqual(await deleteAllKeychain({ deleteOnce: script('surprise') }), { removed: 0, complete: false });
  // Bounded: up to KEYCHAIN_MAX_COPIES copies, plus the run that has to find none.
  const endless = script(...Array(100).fill('deleted'));
  assert.deepEqual(await deleteAllKeychain({ deleteOnce: endless }), { removed: KEYCHAIN_MAX_COPIES + 1, complete: false });
  assert.equal(endless.calls, KEYCHAIN_MAX_COPIES + 1);
  // Through the real deleteKeychain: exit 0 twice, then exit 44.
  let left = 2;
  const execFile = (file, args, options, callback) => {
    setImmediate(() => (left > 0 ? (left -= 1, callback(null, '', '')) : callback(Object.assign(new Error('exit 44'), { code: 44 }), '', '')));
    return { stdin: { end() {} }, kill() {} };
  };
  assert.deepEqual(await deleteAllKeychain({ deleteOnce: () => deleteKeychain({ execFile }) }), { removed: 2, complete: true });
});

test('redact replaces every token shape', () => {
  assert.equal(redact(`a ${FULL} b ${CONNECTOR} c ${RECORDING}`), 'a wsp... b wsp... c wsp...');
  assert.equal(redact('no secrets here'), 'no secrets here');
  assert.equal(redact(42), '42');
  assert.ok(!redact(`${FULL}${FULL}`).includes('5a5a'));
});
