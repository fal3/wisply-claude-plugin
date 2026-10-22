// src/token.ts: validation, the Set Token prompt and the SecretStorage store.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SECRET_KEY, TOKEN_TEXT, createTokenStore, inputProblem, promptForToken, scopeTitle, validateToken,
} from '../out/test/token.mjs';
import { FAKE_TOKENS, createFakeSecrets, createFakeVscode } from './fixtures/fake-vscode.mjs';

test('validateToken accepts connector and full-access tokens, trimmed', () => {
  assert.deepEqual(validateToken(FAKE_TOKENS.connector), { ok: true, token: FAKE_TOKENS.connector, scope: 'connector' });
  assert.deepEqual(validateToken(`  ${FAKE_TOKENS.full}\n`), { ok: true, token: FAKE_TOKENS.full, scope: 'full' });
});

test('validateToken refuses recording tokens, malformed values and nothing', () => {
  assert.deepEqual(validateToken(FAKE_TOKENS.recording), { ok: false, scope: 'recording', problem: 'recording' });
  for (const value of ['wspc_123', `wspx_${'4d'.repeat(32)}`, `WSPC_${'4d'.repeat(32)}`, `wspc_${'4D'.repeat(32)}`,
    `wspc_${'4d'.repeat(32)}0`, `Bearer ${FAKE_TOKENS.connector}`, '${input:wisply-token}']) {
    assert.equal(validateToken(value).problem, 'malformed', value);
  }
  for (const value of ['', '   ', undefined, null, 42, {}]) {
    assert.deepEqual(validateToken(value), { ok: false, scope: null, problem: 'empty' });
  }
});

test('the input box explains a wrong value and stays quiet while empty or valid', () => {
  assert.equal(inputProblem(''), undefined);
  assert.equal(inputProblem(FAKE_TOKENS.connector), undefined);
  assert.equal(inputProblem(FAKE_TOKENS.full), undefined);
  assert.equal(inputProblem(FAKE_TOKENS.recording), TOKEN_TEXT.recording);
  assert.equal(inputProblem('not a token'), TOKEN_TEXT.malformed);
  assert.equal(TOKEN_TEXT.recording, "This token can only start and stop recordings, so it can't read memos. Paste the connector token.");
  assert.equal(TOKEN_TEXT.prompt, 'Paste the read-only connector token from Wisply > Settings > Integrations > MCP Server');
});

test('scope titles come from the connector\'s labels', () => {
  assert.equal(scopeTitle('connector'), 'Read-only connector');
  assert.equal(scopeTitle('full'), 'Full-access');
  assert.equal(scopeTitle('recording'), 'Recording-control');
});

test('promptForToken uses a password box and returns a connector token without a second question', async () => {
  const vs = createFakeVscode({ inputs: [` ${FAKE_TOKENS.connector} `] });
  assert.deepEqual(await promptForToken(vs.window), { token: FAKE_TOKENS.connector, scope: 'connector' });
  const [box] = vs.log.filter((entry) => entry.kind === 'inputBox');
  assert.equal(box.options.password, true);
  assert.equal(box.options.ignoreFocusOut, true);
  assert.equal(box.options.prompt, TOKEN_TEXT.prompt);
  assert.equal(vs.log.some((entry) => entry.kind === 'warning'), false);
});

test('a full-access token needs the modal confirmation', async () => {
  const confirmed = createFakeVscode({ inputs: [FAKE_TOKENS.full], answers: { "full-access token": TOKEN_TEXT.useFullAccess } });
  assert.deepEqual(await promptForToken(confirmed.window), { token: FAKE_TOKENS.full, scope: 'full' });
  const warning = confirmed.log.find((entry) => entry.kind === 'warning');
  assert.equal(warning.text, "This is Wisply's full-access token. AI chat will be able to start and stop recordings " +
    '(if you allow it in Wisply) and propose follow-ups. Use the read-only connector token unless you need that.');
  assert.deepEqual(warning.options, { modal: true });
  assert.deepEqual(warning.buttons, ['Use Full Access']);

  const declined = createFakeVscode({ inputs: [FAKE_TOKENS.full] });
  assert.equal(await promptForToken(declined.window), undefined);
});

test('cancel, empty, recording and malformed values store nothing', async () => {
  for (const value of [undefined, '', FAKE_TOKENS.recording, 'nope']) {
    const vs = createFakeVscode({ inputs: [value] });
    assert.equal(await promptForToken(vs.window), undefined, String(value));
  }
  const vs = createFakeVscode({ inputs: [FAKE_TOKENS.recording] });
  await promptForToken(vs.window);
  assert.equal(vs.log.find((entry) => entry.kind === 'inputBox').problem, TOKEN_TEXT.recording);
});

test('the token store keeps only usable tokens under wisply.mcpToken', async () => {
  assert.equal(SECRET_KEY, 'wisply.mcpToken');
  const secrets = createFakeSecrets();
  const store = createTokenStore(secrets);
  assert.equal(await store.get(), null);
  await store.set({ token: FAKE_TOKENS.connector, scope: 'connector' });
  assert.equal(secrets.values.get(SECRET_KEY), FAKE_TOKENS.connector);
  assert.deepEqual(await store.get(), { token: FAKE_TOKENS.connector, scope: 'connector' });
  await assert.rejects(store.set({ token: FAKE_TOKENS.recording, scope: 'connector' }), TypeError);
  await assert.rejects(store.set({ token: 'nope', scope: 'connector' }), TypeError);
  await store.forget();
  assert.equal(secrets.values.has(SECRET_KEY), false);
  assert.equal(await store.get(), null);
});

test('a corrupt or recording value in SecretStorage counts as no token', async () => {
  for (const value of ['garbage', FAKE_TOKENS.recording, '']) {
    const store = createTokenStore(createFakeSecrets({ [SECRET_KEY]: value }));
    assert.equal(await store.get(), null, value);
  }
  const failing = createTokenStore({ ...createFakeSecrets(), get: async () => { throw new Error('locked'); } });
  assert.equal(await failing.get(), null);
});

test('onDidChange fires only for the Wisply key', async () => {
  const secrets = createFakeSecrets();
  const store = createTokenStore(secrets);
  let changes = 0;
  const subscription = store.onDidChange(() => { changes += 1; });
  secrets.fireChange('someone.else');
  assert.equal(changes, 0);
  await store.set({ token: FAKE_TOKENS.connector, scope: 'connector' });
  assert.equal(changes, 1);
  subscription.dispose();
  await store.forget();
  assert.equal(changes, 1);
});
