// Identity proof vectors and the scope-aware proof check. Every token here is
// synthetic. The first vectors are the ones the Claude plugin
// (bridge.test.mjs) and Wisply (MCPHTTPTransportTests.identityProofVectors)
// pin; the recording-token vectors are new, computed with the vendored
// expectedProof and cross-checked with Python's hmac module.
import test from 'node:test';
import assert from 'node:assert/strict';
import { IDENTITY_SCHEME, expectedProof, newNonce } from '../lib/identity.mjs';
import { TOKEN_RE, scopeOfToken, scopedProofMatches } from '../lib/scopes.mjs';

const NONCE = '0123456789abcdef0123456789abcdef';
const FULL = `wsp_${'8f'.repeat(32)}`;
const CONNECTOR = `wspc_${'1a'.repeat(32)}`;
const RECORDING = `wspr_${'2b'.repeat(32)}`;
const hex = (token, port, nonce = NONCE) => expectedProof(token, port, nonce).toString('hex');

test('the known-answer vectors shared with the plugin and Wisply', () => {
  assert.equal(IDENTITY_SCHEME, 'wisply-mcp-identity-v1');
  assert.equal(
    hex(`wsp_${'00112233445566778899aabbccddeeff'.repeat(2)}`, 51771, '000102030405060708090a0b0c0d0e0f'),
    '30bdb69d15b0a406a77b35142dddf1a666a6657df4bbd61bd9833c437f29e423',
  );
  assert.equal(hex(FULL, 51771), 'db240df529a37aa2f7fd92239a1fa4e1b61b6e92f52de68e4d5becadcfe93ca7');
  assert.equal(hex(CONNECTOR, 51771), 'a26f4b91fb1a0ea6ad573a8f56bc93489f4d14e03297e810239dc875c4a8193f');
  assert.equal(hex(FULL, 51772), 'a39015a77d29e36849e92f2865d1fa359579b789f21f2ebc5bea4446c9e9bd15');
});

test('recording-control (wspr_) vectors', () => {
  assert.equal(hex(RECORDING, 51771), '32a38b8d0236571ff960f7a1d4ef891eb7ddfd9fdd0dbe8a240ec96ef52d1035');
  assert.equal(hex(RECORDING, 51772), '04f67ff55ee1f624c4ce2b8b24943d897fd2619fa580e76dd2009ee5c9ea1de1');
});

test('nonces are 16 fresh random bytes as lowercase hex', () => {
  assert.match(newNonce(), /^[0-9a-f]{32}$/);
  assert.notEqual(newNonce(), newNonce());
});

test('scopeOfToken knows exactly the three Wisply token shapes', () => {
  assert.equal(scopeOfToken(FULL), 'full');
  assert.equal(scopeOfToken(CONNECTOR), 'connector');
  assert.equal(scopeOfToken(RECORDING), 'recording');
  const lookalikes = [
    undefined, null, 42, '', ' ', 'synthetic', `sk-${'x'.repeat(40)}`, `wsp_${'8F'.repeat(32)}`, `wsp_${'8f'.repeat(31)}`,
    `${FULL}0`, `wspx_${'8f'.repeat(32)}`, `wspcc_${'1a'.repeat(32)}`, `wsc_${'1a'.repeat(32)}`, ` ${FULL}`, `${FULL}\n`,
    `${FULL}\r\nInjected: x`, `WSP_${'8f'.repeat(32)}`, '${user_config.wisply_mcp_token}',
  ];
  for (const value of lookalikes) {
    assert.equal(scopeOfToken(value), null, String(value));
    if (typeof value === 'string') assert.equal(TOKEN_RE.test(value), false, value);
  }
});

const body = (overrides = {}, port = 51771, nonce = NONCE) => ({
  server: 'wisply', scheme: IDENTITY_SCHEME, port, nonce,
  proofs: { full: hex(FULL, port, nonce), connector: hex(CONNECTOR, port, nonce), recording: hex(RECORDING, port, nonce) },
  ...overrides,
});
const check = (answer, token, scope, port = 51771) => scopedProofMatches(answer, { token, port, nonce: NONCE, scope });

test('each scope is checked against its own proof only', () => {
  assert.equal(check(body(), FULL, 'full'), 'ok');
  assert.equal(check(body(), CONNECTOR, 'connector'), 'ok');
  assert.equal(check(body(), RECORDING, 'recording'), 'ok');
  // A proof that is right for another scope's token is not a proof for this one.
  const swapped = body({ proofs: { full: hex(CONNECTOR, 51771), connector: hex(FULL, 51771), recording: hex(FULL, 51771) } });
  assert.equal(check(swapped, FULL, 'full'), 'mismatch');
  assert.equal(check(swapped, CONNECTOR, 'connector'), 'mismatch');
  assert.equal(check(swapped, RECORDING, 'recording'), 'mismatch');
});

test('a well-formed answer without this scope is missing-scope; with no proofs at all a mismatch', () => {
  const older = body({ proofs: { full: hex(FULL, 51771), connector: hex(CONNECTOR, 51771) } });
  assert.equal(check(older, RECORDING, 'recording'), 'missing-scope');
  assert.equal(check(older, FULL, 'full'), 'ok');
  assert.equal(check(body({ proofs: {} }), RECORDING, 'recording'), 'mismatch');
});

test('anything else is a mismatch', () => {
  const other = `wsp_${'7c'.repeat(32)}`;
  const cases = {
    'not an object': 'wisply',
    'null': null,
    'an array': [body()],
    'another server': body({ server: 'impostor' }),
    'another scheme': body({ scheme: 'wisply-mcp-identity-v2' }),
    'the port as a string': body({ port: '51771' }),
    'another port in the answer': body({}, 51772),
    'the right port with proofs for another port': body({
      proofs: { full: hex(FULL, 51772), connector: hex(CONNECTOR, 51772), recording: hex(RECORDING, 51772) },
    }),
    'a replayed nonce': body({ nonce: 'ab'.repeat(16) }),
    'proofs not an object': body({ proofs: 'x' }),
    'proofs an array': body({ proofs: [hex(FULL, 51771)] }),
    'a proof for another token': body({ proofs: { full: hex(other, 51771) } }),
    'an uppercase proof': body({ proofs: { full: hex(FULL, 51771).toUpperCase() } }),
    'a short proof': body({ proofs: { full: hex(FULL, 51771).slice(0, 62) } }),
    'a long proof': body({ proofs: { full: `${hex(FULL, 51771)}00` } }),
    'a non-hex proof': body({ proofs: { full: 'zz'.repeat(32) } }),
    'a number proof': body({ proofs: { full: 1 } }),
  };
  for (const [label, answer] of Object.entries(cases)) {
    assert.equal(check(answer, FULL, 'full'), 'mismatch', label);
  }
  // Another port in the check itself.
  assert.equal(check(body(), FULL, 'full', 51772), 'mismatch');
  // An answer without a nonce is accepted only when the proof is for this nonce.
  const { nonce: _ignored, ...withoutNonce } = body();
  assert.equal(check(withoutNonce, FULL, 'full'), 'ok');
});
