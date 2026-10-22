// Token resolution from the environment, with an injected Keychain reader.
// (The real Keychain reader, setup and forget arrive with DIST-M2.) Tokens
// are synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PLACEHOLDER_RE, defaultReadKeychain, redact, resolveToken } from '../lib/token.mjs';

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

test('until DIST-M2 the default Keychain reader finds nothing', async () => {
  assert.equal(await defaultReadKeychain(), null);
  const result = await resolveToken({ env: {}, platform: 'darwin' });
  assert.deepEqual(result, { token: null, source: null, problem: 'missing', placeholderIgnored: false });
});

test('redact replaces every token shape', () => {
  assert.equal(redact(`a ${FULL} b ${CONNECTOR} c ${RECORDING}`), 'a wsp... b wsp... c wsp...');
  assert.equal(redact('no secrets here'), 'no secrets here');
  assert.equal(redact(42), '42');
  assert.ok(!redact(`${FULL}${FULL}`).includes('5a5a'));
});
