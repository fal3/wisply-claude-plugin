// The re-vendor path (DIST-M5): scripts/sync-vendor.mjs, run in a temporary
// copy of this repository against temporary git repositories that stand in
// for wisply-ai and wisply-claude-plugin. It must take a contract the
// connector can load, byte for byte, with provisional: false, and refuse
// anything else before it writes a file: wisply-ai's contract as DIST-A1
// alone has it (no wspr_ scope) or as raycast PR 1 alone has it (no
// tool_descriptors).
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
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

/** What wisply-ai's file should look like once DIST-A1 is on main after raycast PR 1: the union of both. */
function mergedContract() {
  const contract = structuredClone(FIXTURE);
  const live = contract.tool_descriptors.find((descriptor) => descriptor.name === 'get_live_transcript');
  live.inputSchema.properties = {
    tail_words: {
      type: 'integer', description: 'Return only the last N words of the transcript (1-5000).', minimum: 1, maximum: 5000,
    },
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

/** A one-commit repository holding `files`; returns its directory and the commit. */
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
  for (const folder of ['scripts', 'lib', 'contract', 'clients']) cpSync(join(ROOT, folder), join(copy, folder), { recursive: true });
  cpSync(join(ROOT, 'package.json'), join(copy, 'package.json'));
  const plugin = repoWith(parent, 'wisply-claude-plugin', { 'lib/identity.mjs': readFileSync(join(ROOT, 'lib/identity.mjs')) });
  return { parent, copy, plugin };
}

function syncVendor(copy, app, plugin, ...extra) {
  return spawnSync(process.execPath, [join(copy, 'scripts/sync-vendor.mjs'), '--app', app.dir, '--app-commit', app.commit,
    '--plugin', plugin.dir, '--plugin-commit', plugin.commit, ...extra], { cwd: copy, encoding: 'utf8' });
}

const snapshot = (copy) => Object.fromEntries(['contract/mcp-contract.json', 'contract/mcp-contract.mjs', 'contract/SOURCE.json',
  'lib/identity.mjs'].map((path) => [path, readFileSync(join(copy, path), 'utf8')]));

test('a contract with raycast PR 1\'s keys and DIST-A1\'s descriptors is vendored byte for byte, not provisional', async (t) => {
  const { parent, copy, plugin } = workspace(t);
  const bytes = jsonBytes(mergedContract());
  const app = repoWith(parent, 'wisply-ai', { 'Docs/mcp-contract.json': bytes });
  const result = syncVendor(copy, app, plugin);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /wrote contract\/SOURCE\.json\n$/);

  assert.ok(readFileSync(join(copy, 'contract/mcp-contract.json')).equals(bytes));
  const source = JSON.parse(readFileSync(join(copy, 'contract/SOURCE.json'), 'utf8'));
  assert.equal(source.provisional, false);
  const [appSource, pluginSource] = source.sources;
  assert.deepEqual(appSource, {
    repository: 'github:fal3/wisply-ai', commit: app.commit, provisional: false,
    files: { 'contract/mcp-contract.json': { upstream: 'Docs/mcp-contract.json', sha256: sha256(bytes) } },
  });
  assert.match(appSource.commit, /^[0-9a-f]{40}$/);
  assert.equal(pluginSource.commit, plugin.commit);
  assert.equal(pluginSource.provisional, false);
  // gen-data ran: the module the connector imports is the new contract.
  const module = await import(`${pathToFileURL(join(copy, 'contract/mcp-contract.mjs')).href}?${Date.now()}`);
  assert.deepEqual(module.default, mergedContract());
  // And the connector loads it.
  const loaded = await import(`${pathToFileURL(join(copy, 'lib/contract.mjs')).href}?${Date.now()}`);
  assert.deepEqual(loaded.descriptorFor('get_live_transcript').inputSchema.properties.tail_words.maximum, 5000);
});

test('DIST-A1\'s contract without raycast PR 1 (no wspr_ scope) is refused, and nothing is written', (t) => {
  const { parent, copy, plugin } = workspace(t);
  const contract = mergedContract();
  delete contract.scopes.recording;
  for (const key of ['error_codes', 'legacy_error_prefixes', 'live_transcript']) delete contract[key];
  const app = repoWith(parent, 'wisply-ai', { 'Docs/mcp-contract.json': jsonBytes(contract) });
  const before = snapshot(copy);
  const result = syncVendor(copy, app, plugin);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^sync-vendor: Docs\/mcp-contract\.json at [0-9a-f]{7} isn't a contract this connector can load \(scopes\.recording\)\./);
  assert.match(result.stderr, /Nothing was changed\.\n$/);
  assert.deepEqual(snapshot(copy), before);
});

test('raycast PR 1\'s contract without DIST-A1 (no tool_descriptors) is refused, and nothing is written', (t) => {
  const { parent, copy, plugin } = workspace(t);
  const contract = mergedContract();
  delete contract.tool_descriptors;
  const app = repoWith(parent, 'wisply-ai', { 'Docs/mcp-contract.json': jsonBytes(contract) });
  const before = snapshot(copy);
  const result = syncVendor(copy, app, plugin);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /\(tool_descriptors\)/);
  assert.deepEqual(snapshot(copy), before);
});

test('a commit without the contract, or with a broken one, is refused too', (t) => {
  const { parent, copy, plugin } = workspace(t);
  const before = snapshot(copy);
  const empty = repoWith(parent, 'empty-app', { 'README.md': 'no contract here\n' });
  let result = syncVendor(copy, empty, plugin);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Docs\/mcp-contract\.json doesn't exist at [0-9a-f]{7}; nothing was changed/);
  const broken = repoWith(parent, 'broken-app', { 'Docs/mcp-contract.json': '{"schema": ' });
  result = syncVendor(copy, broken, plugin);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /\(not JSON\)/);
  assert.deepEqual(snapshot(copy), before);
});

test('--provisional keeps the transcribed fixture and says so', (t) => {
  const { parent, copy, plugin } = workspace(t);
  const app = repoWith(parent, 'wisply-ai', { 'Docs/mcp-contract.json': jsonBytes(mergedContract()) });
  const before = snapshot(copy);
  const result = syncVendor(copy, app, plugin, '--provisional');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /re-vendor without --provisional once it has tool_descriptors/);
  const after = snapshot(copy);
  assert.equal(after['contract/mcp-contract.json'], before['contract/mcp-contract.json']);
  const source = JSON.parse(after['contract/SOURCE.json']);
  assert.equal(source.provisional, true);
  assert.equal(source.sources[0].commit, `${app.commit.slice(0, 7)} (transcribed)`);
});

test('upstreamContractProblems is lib/contract.mjs\'s check on the upstream bytes', () => {
  assert.deepEqual(upstreamContractProblems(jsonBytes(mergedContract())), []);
  assert.deepEqual(upstreamContractProblems(jsonBytes(FIXTURE)), []);
  assert.deepEqual(upstreamContractProblems(Buffer.from('nope')), ['not JSON']);
  assert.deepEqual(upstreamContractProblems(jsonBytes({ ...FIXTURE, schema: 'other' })), ['schema']);
});
