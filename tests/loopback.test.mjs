// The loopback client against real servers on ports the system assigns
// (never 51771). Tokens are synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { expectedProof } from '../lib/identity.mjs';
import { MAX_IDENTITY_BYTES, MAX_RESPONSE_BYTES } from '../lib/constants.mjs';
import { createLoopback, parsePort } from '../lib/loopback.mjs';

const FULL = `wsp_${'5a'.repeat(32)}`;
const CONNECTOR = `wspc_${'6b'.repeat(32)}`;
const RECORDING = `wspr_${'7c'.repeat(32)}`;
const LOOPBACK_URL = new URL('../lib/loopback.mjs', import.meta.url).href;

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const seen = [];
  server.on('request', (req) => seen.push({ method: req.method, url: req.url, headers: req.headers }));
  return {
    server, seen, port: server.address().port,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }),
  };
}

const identityAnswer = (port, nonce, tokens = { full: FULL, connector: CONNECTOR, recording: RECORDING }) => ({
  server: 'wisply', scheme: 'wisply-mcp-identity-v1', port, nonce,
  proofs: Object.fromEntries(Object.entries(tokens).map(([scope, token]) => [scope, expectedProof(token, port, nonce).toString('hex')])),
});

/** A fake that answers the identity challenge with `answer(port, nonce)` and /mcp with `onCall`. */
async function fakeWisply({ answer = identityAnswer, onCall } = {}) {
  let port;
  const fake = await listen(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/mcp/identity') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(answer(port, url.searchParams.get('nonce'))));
      return;
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    if (onCall) return onCall(req, res, body);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(body).id, result: { content: [{ type: 'text', text: 'Synthetic' }] } }));
  });
  port = fake.port;
  return fake;
}

test('parsePort accepts 1024-65535 only', () => {
  assert.equal(parsePort('51771'), 51771);
  assert.equal(parsePort(' 2000 '), 2000);
  assert.equal(parsePort(1024), 1024);
  assert.equal(parsePort('65535'), 65535);
  for (const value of ['', '0', '80', '1023', '65536', '99999', '-1', '5e4', '51771.0', '0x1f', 'abc', null, undefined, {}, 51771.5]) {
    assert.equal(parsePort(value), null, String(value));
  }
  assert.throws(() => createLoopback({ port: 80 }), RangeError);
  assert.throws(() => createLoopback({ port: '51771' }), RangeError);
});

test('the identity challenge carries no token and is checked for the token\'s scope', async (t) => {
  const fake = await fakeWisply();
  t.after(fake.close);
  const loopback = createLoopback({ port: fake.port });
  assert.equal((await loopback.identity(FULL, 'full')).outcome, 'ok');
  assert.equal((await loopback.identity(CONNECTOR, 'connector')).outcome, 'ok');
  assert.equal((await loopback.identity(RECORDING, 'recording')).outcome, 'ok');
  assert.equal(fake.seen.length, 3);
  for (const request of fake.seen) {
    assert.equal(request.method, 'GET');
    assert.match(request.url, /^\/mcp\/identity\?nonce=[0-9a-f]{32}$/);
    assert.equal(request.headers.authorization, undefined);
    assert.equal(request.headers.host, `127.0.0.1:${fake.port}`);
    assert.equal(request.headers.accept, 'application/json');
    assert.ok(!JSON.stringify(request).includes(FULL) && !JSON.stringify(request).includes(CONNECTOR));
  }
  assert.equal(new Set(fake.seen.map((request) => request.url)).size, 3, 'a fresh nonce each time');
});

test('a wrong proof, a missing proof or a wrong answer is not Wisply', async (t) => {
  const other = `wsp_${'99'.repeat(32)}`;
  const answers = {
    'a proof for another token': (port, nonce) => identityAnswer(port, nonce, { full: other, connector: other }),
    'a proof for another port': (port, nonce) => identityAnswer(port + 1, nonce),
    'no proofs': (port, nonce) => ({ ...identityAnswer(port, nonce), proofs: {} }),
    'not JSON': () => undefined,
  };
  for (const [label, answer] of Object.entries(answers)) {
    const fake = await fakeWisply({ answer });
    t.after(fake.close);
    assert.equal((await createLoopback({ port: fake.port }).identity(FULL, 'full')).outcome, 'not-wisply', label);
  }
  // A Wisply that holds no recording token yet: recording is missing-scope,
  // but a connector token without its proof just fails the check.
  const older = await fakeWisply({ answer: (port, nonce) => identityAnswer(port, nonce, { full: FULL }) });
  t.after(older.close);
  const loopback = createLoopback({ port: older.port });
  assert.equal((await loopback.identity(RECORDING, 'recording')).outcome, 'missing-scope');
  assert.equal((await loopback.identity(CONNECTOR, 'connector')).outcome, 'not-wisply');
  assert.equal((await loopback.identity(FULL, 'full')).outcome, 'ok');
});

test('status codes: old Wisply (404, or 401 with its realm), Wisply without its tokens (its 503), anything else', async (t) => {
  const cases = [
    [404, {}, 'old-wisply'],
    [401, { 'WWW-Authenticate': 'Bearer realm="wisply-mcp"' }, 'old-wisply'],
    [401, { 'WWW-Authenticate': 'Bearer realm="other"' }, 'not-wisply'],
    [401, {}, 'not-wisply'],
    [503, {}, 'not-wisply'],
    [503, { 'Content-Type': 'text/plain' }, 'keychain', 'MCP tokens are unavailable. Check Keychain access in Wisply.'],
    [503, { 'Content-Type': 'text/plain' }, 'not-wisply', 'Service Unavailable'],
    [500, { 'Content-Type': 'text/plain' }, 'not-wisply', 'MCP tokens are unavailable. Check Keychain access in Wisply.'],
    [302, { Location: 'http://127.0.0.1:9/mcp/identity' }, 'not-wisply'],
    [500, {}, 'not-wisply'],
  ];
  for (const [status, headers, outcome, body = ''] of cases) {
    const fake = await listen((req, res) => res.writeHead(status, headers).end(body));
    t.after(fake.close);
    const result = await createLoopback({ port: fake.port }).identity(FULL, 'full');
    assert.equal(result.outcome, outcome, `${status} ${JSON.stringify(headers)} ${body}`);
    assert.equal(result.status, status);
  }
});

test('an identity answer over 8 KiB is not Wisply', async (t) => {
  const fake = await listen((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('x'.repeat(MAX_IDENTITY_BYTES + 1));
  });
  t.after(fake.close);
  assert.equal((await createLoopback({ port: fake.port }).identity(FULL, 'full')).outcome, 'not-wisply');
});

test('bytes that are not HTTP are not Wisply', async (t) => {
  const server = net.createServer((socket) => {
    socket.resume();
    socket.end('SSH-2.0-synthetic\r\n\r\ngarbage');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  assert.equal((await createLoopback({ port: server.address().port }).identity(FULL, 'full')).outcome, 'not-wisply');
});

test('nothing listening, or no answer in time, is unavailable', async (t) => {
  const closed = await listen(() => {});
  const closedPort = closed.port;
  await closed.close();
  assert.equal((await createLoopback({ port: closedPort }).identity(FULL, 'full')).outcome, 'unavailable');

  const silent = await listen(() => { /* never answers */ });
  t.after(silent.close);
  const started = Date.now();
  const result = await createLoopback({ port: silent.port, identityTimeoutMs: 150 }).identity(FULL, 'full');
  assert.equal(result.outcome, 'unavailable');
  assert.ok(Date.now() - started < 2000);
});

test('call sends the token only as a bearer header to /mcp', async (t) => {
  let received;
  const fake = await fakeWisply({
    onCall: (req, res, body) => {
      received = { method: req.method, url: req.url, headers: req.headers, body };
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"jsonrpc":"2.0","id":1,"result":{"content":[]}}');
    },
  });
  t.after(fake.close);
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_memos', arguments: {} } });
  const response = await createLoopback({ port: fake.port }).call(CONNECTOR, body, 5000);
  assert.equal(response.status, 200);
  assert.equal(response.text, '{"jsonrpc":"2.0","id":1,"result":{"content":[]}}');
  assert.equal(response.bytes, Buffer.byteLength(response.text));
  assert.equal(received.method, 'POST');
  assert.equal(received.url, '/mcp');
  assert.equal(received.headers.authorization, `Bearer ${CONNECTOR}`);
  assert.equal(received.headers['content-type'], 'application/json');
  assert.equal(received.headers['content-length'], String(Buffer.byteLength(body)));
  assert.equal(received.headers.host, `127.0.0.1:${fake.port}`);
  assert.equal(received.body, body);
});

test('call refuses anything that is not a Wisply token before connecting', async (t) => {
  const fake = await fakeWisply();
  t.after(fake.close);
  const loopback = createLoopback({ port: fake.port });
  for (const token of ['', `${FULL}\r\nInjected: yes`, 'sk-synthetic', `${FULL} `]) {
    await assert.rejects(loopback.call(token, '{}', 1000), TypeError);
  }
  assert.equal(fake.seen.length, 0);
});

test('call never follows a redirect', async (t) => {
  const target = await listen((req, res) => res.writeHead(200).end('{}'));
  t.after(target.close);
  const fake = await fakeWisply({
    onCall: (req, res) => res.writeHead(307, { Location: `http://127.0.0.1:${target.port}/elsewhere` }).end(),
  });
  t.after(fake.close);
  const response = await createLoopback({ port: fake.port }).call(FULL, '{}', 5000);
  assert.equal(response.status, 307);
  assert.equal(target.seen.length, 0);
});

test('call stops reading past 2 MiB', async (t) => {
  const fake = await fakeWisply({
    onCall: (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('x'.repeat(MAX_RESPONSE_BYTES + 1));
    },
  });
  t.after(fake.close);
  await assert.rejects(createLoopback({ port: fake.port }).call(FULL, '{}', 5000), /too large/i);
});

test('call gives up at its timeout', async (t) => {
  const fake = await fakeWisply({ onCall: () => { /* never answers */ } });
  t.after(fake.close);
  const started = Date.now();
  await assert.rejects(createLoopback({ port: fake.port }).call(FULL, '{}', 150));
  assert.ok(Date.now() - started < 2000);
});

test('proxy settings in the environment are ignored', async (t) => {
  const trap = await listen((req, res) => res.writeHead(502).end());
  t.after(trap.close);
  const trapSockets = [];
  trap.server.on('connection', (socket) => trapSockets.push(socket.remotePort));
  const fake = await fakeWisply();
  t.after(fake.close);
  // A separate Node process, so NODE_USE_ENV_PROXY is read at startup the way
  // a client-started connector would read it.
  const script = `
    import { createLoopback } from ${JSON.stringify(LOOPBACK_URL)};
    const loopback = createLoopback({ port: ${fake.port} });
    const identity = await loopback.identity(${JSON.stringify(FULL)}, 'full');
    const call = await loopback.call(${JSON.stringify(FULL)}, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_memos', arguments: {} } }), 5000);
    process.stdout.write(JSON.stringify({ identity: identity.outcome, status: call.status }));
  `;
  const proxy = `http://127.0.0.1:${trap.port}`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    env: {
      PATH: process.env.PATH, HTTP_PROXY: proxy, HTTPS_PROXY: proxy, http_proxy: proxy, https_proxy: proxy,
      ALL_PROXY: proxy, NO_PROXY: '', no_proxy: '', NODE_USE_ENV_PROXY: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const [code] = await once(child, 'exit');
  assert.equal(code, 0, stderr);
  assert.deepEqual(JSON.parse(stdout), { identity: 'ok', status: 200 });
  assert.equal(trap.seen.length, 0);
  assert.equal(trapSockets.length, 0);
  assert.equal(fake.seen.length, 2);
});
