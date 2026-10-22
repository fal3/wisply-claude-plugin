// The re-vendor path (DIST-M5): scripts/sync-vendor.mjs, run in a temporary
// copy of this repository against temporary git repositories that stand in
// for wisply-ai and wisply-claude-plugin. It must take a contract the
// connector can load, byte for byte, with provisional: false, and refuse
// anything else before it writes a single file: a contract without
// tool_descriptors (wisply-ai's as raycast PR 1 has it), a commit without
// the contract, a file that isn't JSON, a plugin commit without identity.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { upstreamContractProblems } from '../scripts/sync-vendor.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIXTURE = JSON.parse(readFileSync(join(ROOT, 'contract/mcp-contract.json'), 'utf8'));
// The plugin's identity.mjs one commit later: any byte that lands in the copy before a refusal shows up.
const PLUGIN_IDENTITY = Buffer.concat([readFileSync(join(ROOT, 'lib/identity.mjs')), Buffer.from('// a later plugin commit\n')]);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

/** wisply-ai's contract once DIST-A1's descriptors are on main after raycast PR 1 (tail_words included). */
function finalContract() {
  const contract = structuredClone(FIXTURE);
  const live = contract.tool_descriptors.find((descriptor) => descriptor.name === 'get_live_transcript');
  live.inputSchema.properties = {
    tail_words: { type: 'integer', description: 'Return only the last N words of the transcript (1-5000).', minimum: 1, maximum: 5000 },
  };
  return contract;
}

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
};
const git = (dir, ...args) => {
  const result = spawnSync('git', ['-C', dir, '-c', 'commit.gpgsign=false', ...args], { env: GIT_ENV, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};

/** A one-commit repository holding `files`; returns its directory and the full commit. */
function repoWith(parent, name, files) {
  const dir = join(parent, name);
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  for (const [path, bytes] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), bytes);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'fixture');
  return { dir, commit: git(dir, 'rev-parse', 'HEAD') };
}

/** A copy of what sync-vendor reads and writes, so the real tree is never touched. */
function workspace(t) {
  const parent = mkdtempSync(join(tmpdir(), 'wisply-sync-vendor-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const copy = join(parent, 'wisply-mcp');
  for (const folder of ['scripts', 'lib', 'contract']) cpSync(join(ROOT, folder), join(copy, folder), { recursive: true });
  cpSync(join(ROOT, 'package.json'), join(copy, 'package.json'));
  const plugin = repoWith(parent, 'wisply-claude-plugin', { 'lib/identity.mjs': PLUGIN_IDENTITY });
  return { parent, copy, plugin };
}

function syncVendor(copy, app, plugin, ...extra) {
  return spawnSync(process.execPath, [join(copy, 'scripts/sync-vendor.mjs'), '--app', app.dir, '--app-commit', app.commit,
    '--plugin', plugin.dir, '--plugin-commit', plugin.commit, ...extra], { cwd: copy, encoding: 'utf8' });
}

const VENDORED = ['contract/mcp-contract.json', 'contract/mcp-contract.mjs', 'contract/SOURCE.json', 'lib/identity.mjs'];
const snapshot = (copy) => Object.fromEntries(VENDORED.map((path) => [path, readFileSync(join(copy, path), 'utf8')]));

test('a contract the connector can load is vendored byte for byte, not provisional, and the connector loads it', async (t) => {
  const { parent, copy, plugin } = workspace(t);
  const bytes = jsonBytes(finalContract());
  const app = repoWith(parent, 'wisply-ai', { 'Docs/mcp-contract.json': bytes });
  const result = syncVendor(copy, app, plugin);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /wrote contract\/SOURCE\.json\n$/);

  assert.ok(readFileSync(join(copy, 'contract/mcp-contract.json')).equals(bytes));
  assert.ok(readFileSync(join(copy, 'lib/identity.mjs')).equals(PLUGIN_IDENTITY));
  const source = JSON.parse(readFileSync(join(copy, 'contract/SOURCE.json'), 'utf8'));
  assert.deepEqual(source, {
    schema: 'wisply-mcp-vendor-v1',
    provisional: false,
    sources: [
      {
        repository: 'github:fal3/wisply-ai', commit: app.commit, provisional: false, on_main: false,
        files: { 'contract/mcp-contract.json': { upstream: 'Docs/mcp-contract.json', sha256: sha256(bytes) } },
      },
      {
        repository: 'github:fal3/wisply-claude-plugin', commit: plugin.commit, provisional: false,
        files: { 'lib/identity.mjs': { upstream: 'lib/identity.mjs', sha256: sha256(PLUGIN_IDENTITY) } },
      },
    ],
  });
  // gen-data ran, and the connector loads what was vendored.
  const loaded = await import(`${pathToFileURL(join(copy, 'lib/contract.mjs')).href}?${Date.now()}`);
  assert.equal(loaded.descriptorFor('get_live_transcript').inputSchema.properties.tail_words.maximum, 5000);
});

test('"on_main" says whether the app checkout\'s origin/main has the commit, and only that ref counts', (t) => {
  const { parent, copy, plugin } = workspace(t);
  const app = repoWith(parent, 'wisply-ai', { 'Docs/mcp-contract.json': jsonBytes(finalContract()) });
  const appSource = () => JSON.parse(readFileSync(join(copy, 'contract/SOURCE.json'), 'utf8')).sources[0];
  // No origin/main (and a local main that has the commit doesn't count): not on main, and sync-vendor says so.
  let result = syncVendor(copy, app, plugin);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(appSource().on_main, false);
  assert.match(result.stderr, /isn't on the app checkout's origin\/main, so SOURCE\.json says "on_main": false/);
  // A branch commit that origin/main doesn't have yet (DIST-A1 before it merges).
  git(app.dir, 'update-ref', 'refs/remotes/origin/main', app.commit);
  git(app.dir, 'checkout', '-q', '-b', 'claude/lane');
  writeFileSync(join(app.dir, 'NOTES.md'), 'a later commit on the lane\n');
  git(app.dir, 'add', '-A');
  git(app.dir, 'commit', '-q', '-m', 'lane');
  const lane = { dir: app.dir, commit: git(app.dir, 'rev-parse', 'HEAD') };
  result = syncVendor(copy, lane, plugin);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(appSource().on_main, false);
  // Once origin/main has it (the merge), the same command records true and says nothing more.
  git(app.dir, 'update-ref', 'refs/remotes/origin/main', lane.commit);
  result = syncVendor(copy, lane, plugin);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual({ commit: appSource().commit, on_main: appSource().on_main }, { commit: lane.commit, on_main: true });
  assert.doesNotMatch(result.stderr, /on_main/);
  // --provisional records no "on_main": the transcribed fixture comes from no commit's file.
  result = syncVendor(copy, lane, plugin, '--provisional');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(Object.hasOwn(appSource(), 'on_main'), false);
});

test('a contract without tool_descriptors (raycast PR 1 alone) is refused, and nothing is written', (t) => {
  const { parent, copy, plugin } = workspace(t);
  const contract = finalContract();
  delete contract.tool_descriptors;
  const app = repoWith(parent, 'wisply-ai', { 'Docs/mcp-contract.json': jsonBytes(contract) });
  const before = snapshot(copy);
  const result = syncVendor(copy, app, plugin);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^sync-vendor: Docs\/mcp-contract\.json at [0-9a-f]{7} isn't a contract this connector can load \(tool_descriptors\)\./);
  assert.match(result.stderr, /Nothing was changed\.\n$/);
  assert.deepEqual(snapshot(copy), before);
});

test('a contract without the recording scope, or with a broken shape, is refused too', (t) => {
  const { parent, copy, plugin } = workspace(t);
  const before = snapshot(copy);
  const noRecording = finalContract();
  delete noRecording.scopes.recording;
  const cases = [
    [noRecording, /\(scopes\.recording\)/],
    [{ ...finalContract(), schema: 'wisply-mcp-contract-v2' }, /\(schema\)/],
    [{ ...finalContract(), tool_descriptors: finalContract().tool_descriptors.slice(1) }, /\(tool_descriptors\)/],
  ];
  for (const [index, [contract, expected]] of cases.entries()) {
    const app = repoWith(parent, `wisply-ai-${index}`, { 'Docs/mcp-contract.json': jsonBytes(contract) });
    const result = syncVendor(copy, app, plugin);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, expected);
    assert.deepEqual(snapshot(copy), before);
  }
});

test('a commit without the contract, a file that isn\'t JSON, or a plugin commit without identity.mjs writes nothing', (t) => {
  const { parent, copy, plugin } = workspace(t);
  const before = snapshot(copy);
  const empty = repoWith(parent, 'empty-app', { 'README.md': 'no contract here\n' });
  let result = syncVendor(copy, empty, plugin);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^sync-vendor: Docs\/mcp-contract\.json doesn't exist at [0-9a-f]{7}\. Nothing was changed\.\n$/);
  assert.deepEqual(snapshot(copy), before);

  const broken = repoWith(parent, 'broken-app', { 'Docs/mcp-contract.json': '{"schema": ' });
  result = syncVendor(copy, broken, plugin);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /\(not JSON\)/);
  assert.deepEqual(snapshot(copy), before);

  const app = repoWith(parent, 'wisply-ai', { 'Docs/mcp-contract.json': jsonBytes(finalContract()) });
  const noIdentity = repoWith(parent, 'old-plugin', { 'bridge.mjs': '// no lib/identity.mjs yet\n' });
  result = syncVendor(copy, app, noIdentity);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^sync-vendor: lib\/identity\.mjs doesn't exist at [0-9a-f]{7}\. Nothing was changed\.\n$/);
  assert.deepEqual(snapshot(copy), before);
});

test('a broken local contract doesn\'t stop a good re-vendor (the shape check has no side effects)', (t) => {
  const { parent, copy, plugin } = workspace(t);
  // lib/contract.mjs throws at import on this module; sync-vendor must not import it.
  writeFileSync(join(copy, 'contract/mcp-contract.mjs'), 'export default {};\n');
  const bytes = jsonBytes(finalContract());
  const app = repoWith(parent, 'wisply-ai', { 'Docs/mcp-contract.json': bytes });
  const result = syncVendor(copy, app, plugin);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(readFileSync(join(copy, 'contract/mcp-contract.json')).equals(bytes));
});

test('--provisional keeps the transcribed fixture and says so, with or without an upstream file', (t) => {
  const { parent, copy, plugin } = workspace(t);
  const before = snapshot(copy);
  for (const [name, files, note] of [
    ['wisply-ai', { 'Docs/mcp-contract.json': jsonBytes(finalContract()) }, true],
    ['empty-app', { 'README.md': 'no contract here\n' }, false],
  ]) {
    const app = repoWith(parent, name, files);
    const result = syncVendor(copy, app, plugin, '--provisional');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(/re-vendor without --provisional once it has tool_descriptors/.test(result.stderr), note, result.stderr);
    const after = snapshot(copy);
    assert.equal(after['contract/mcp-contract.json'], before['contract/mcp-contract.json']);
    const source = JSON.parse(after['contract/SOURCE.json']);
    assert.equal(source.provisional, true);
    assert.equal(source.sources[0].commit, `${app.commit.slice(0, 7)} (transcribed)`);
    assert.equal(source.sources[0].files['contract/mcp-contract.json'].transcribed_from, 'Wisply/Services/MCP/MCPToolCatalog.swift');
  }
});

test('upstreamContractProblems is the connector\'s own shape check, on the upstream bytes', () => {
  assert.deepEqual(upstreamContractProblems(jsonBytes(finalContract())), []);
  assert.deepEqual(upstreamContractProblems(jsonBytes(FIXTURE)), []);
  assert.deepEqual(upstreamContractProblems(Buffer.from('nope')), ['not JSON']);
  assert.deepEqual(upstreamContractProblems(jsonBytes({ ...FIXTURE, schema: 'other' })), ['schema']);
  assert.deepEqual(upstreamContractProblems(jsonBytes([])), ['contract is not an object']);
});
