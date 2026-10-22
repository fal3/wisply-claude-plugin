// vendor/ and server/wisply-mcp.mjs against vendor/SOURCE.json, and, with
// WISPLY_MCP_DIR and WISPLY_PLUGIN_DIR set, against the source repositories.
// With WISPLY_RELEASE=1 everything the release gate refuses fails here too
// (scripts/release-gate.mjs: a provisional contract, a branch other than
// main, a placeholder name or link).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EDITOR_MESSAGES, VENDORED_MESSAGES } from '../esbuild.mjs';
import { releaseProblems } from '../scripts/release-gate.mjs';
import {
  MCP_DIR, MCP_REMOTE, MCP_REMOTE_RE, MCP_REPOSITORY, PLUGIN_FILES, PLUGIN_REPOSITORY, SOURCE_FILE, VENDOR_SCHEMA, isOnRef,
  isVendoredMcpPath, validRef, verifyOnUpstreamMain,
} from '../scripts/sync-vendor.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const source = JSON.parse(readFileSync(join(ROOT, SOURCE_FILE), 'utf8'));
const mcp = source.sources.find((entry) => entry.repository === MCP_REPOSITORY);
const plugin = source.sources.find((entry) => entry.repository === PLUGIN_REPOSITORY);
const sha256 = (path) => createHash('sha256').update(readFileSync(join(ROOT, path))).digest('hex');

function walk(dir) {
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`;
    return entry.isDirectory() ? walk(path) : [path];
  });
}

test('SOURCE.json names both sources at full commits', () => {
  assert.equal(source.schema, VENDOR_SCHEMA);
  assert.ok(mcp && plugin);
  assert.match(mcp.commit, /^[0-9a-f]{40}$/);
  assert.match(plugin.commit, /^[0-9a-f]{40}$/);
  assert.equal(source.sources.length, 2);
});

test('every vendored file matches its recorded sha256, and every file in vendor/ is recorded', () => {
  const recorded = { ...mcp.files, ...plugin.files };
  for (const [path, entry] of Object.entries(recorded)) assert.equal(sha256(path), entry.sha256, path);
  const onDisk = walk('vendor').filter((path) => path !== SOURCE_FILE).sort();
  assert.deepEqual(onDisk, Object.keys(recorded).sort());
  for (const [path, entry] of Object.entries(mcp.files)) {
    assert.equal(path, `${MCP_DIR}/${entry.upstream}`);
    assert.ok(isVendoredMcpPath(entry.upstream), entry.upstream);
  }
  assert.deepEqual(Object.fromEntries(Object.entries(plugin.files).map(([path, entry]) => [path, entry.upstream])), { ...PLUGIN_FILES });
});

test('the bundle matches its recorded sha256 and esbuild version, and names its commit', () => {
  assert.equal(source.bundle.path, 'server/wisply-mcp.mjs');
  assert.equal(source.bundle.entry, `${MCP_DIR}/bin/wisply-mcp.mjs`);
  assert.equal(sha256(source.bundle.path), source.bundle.sha256);
  const installed = createRequire(import.meta.url)('esbuild/package.json').version;
  assert.equal(source.bundle.esbuild, installed, 'the bundle was built with another esbuild: re-run npm run sync-vendor');
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(manifest.devDependencies.esbuild, installed);
  assert.match(readFileSync(join(ROOT, source.bundle.path), 'utf8').split('\n')[1], new RegExp(`${MCP_REPOSITORY} at ${mcp.commit}`));
  // The one file the bundle takes from outside vendor/, recorded.
  assert.deepEqual(source.bundle.overlays, { [VENDORED_MESSAGES]: EDITOR_MESSAGES });
});

test('the vendored connector has what the extension and the bundle need', () => {
  const upstream = Object.values(mcp.files).map((entry) => entry.upstream);
  for (const path of ['bin/wisply-mcp.mjs', 'lib/bridge.mjs', 'lib/cli.mjs', 'lib/token.mjs', 'lib/scopes.mjs',
    'lib/messages.mjs', 'lib/contract.mjs', 'lib/constants.mjs', 'lib/identity.mjs', 'contract/mcp-contract.mjs',
    'contract/SOURCE.json', 'LICENSE']) {
    assert.ok(upstream.includes(path), path);
  }
});

test('the provisional flag follows the connector\'s own contract source', () => {
  const upstreamSource = JSON.parse(readFileSync(join(ROOT, MCP_DIR, 'contract/SOURCE.json'), 'utf8'));
  assert.equal(mcp.contract_provisional, upstreamSource.provisional !== false);
  assert.equal(source.provisional, mcp.contract_provisional);
});

test('vendor/shared.mjs stands alone (no imports)', () => {
  assert.doesNotMatch(readFileSync(join(ROOT, 'vendor/shared.mjs'), 'utf8'), /^\s*import\s/m);
});

test('the vendored connector is the reviewed DIST-M2 state or later: the Keychain item is replaced, not merged (-U)', async () => {
  const { WRITE_ARGS, securityEnv } = await import('../vendor/wisply-mcp/lib/token.mjs');
  assert.equal(WRITE_ARGS.includes('-U'), false);
  assert.equal(typeof securityEnv, 'function');
  const constants = await import('../vendor/wisply-mcp/lib/constants.mjs');
  assert.equal(typeof constants.PACKAGE_NAME_FINAL, 'boolean', 'the package name gate exists');
});

test('release: refused while anything the release gate checks isn\'t final', { skip: process.env.WISPLY_RELEASE !== '1' }, () => {
  assert.deepEqual(releaseProblems({ source, readme: readFileSync(join(ROOT, 'README.md'), 'utf8') }), []);
});

test('isOnRef: a commit on the branch, the tip itself, and one that isn\'t', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'wisply-ref-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const run = (...args) => execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid',
      GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid', GIT_CONFIG_NOSYSTEM: '1', HOME: dir },
  }).trim();
  run('init', '-q', '-b', 'main');
  const commit = (name) => {
    writeFileSync(join(dir, name), name);
    run('add', name);
    run('commit', '-q', '-m', name);
    return run('rev-parse', 'HEAD');
  };
  const first = commit('a');
  const second = commit('b');
  run('checkout', '-q', '-b', 'feature', first);
  const side = commit('c');
  assert.equal(isOnRef(dir, first, 'main'), true);
  assert.equal(isOnRef(dir, second, 'main'), true);
  assert.equal(isOnRef(dir, side, 'main'), false);
  assert.equal(isOnRef(dir, side, 'feature'), true);
  assert.equal(isOnRef(dir, first, 'no-such-branch'), false);
});

const upstreamSkip = !process.env.WISPLY_MCP_DIR || !process.env.WISPLY_PLUGIN_DIR;

test('upstream: the vendored bytes are the files at the recorded commits, and none is missing', { skip: upstreamSkip }, () => {
  const show = (dir, commit, path) => execFileSync('git', ['-C', dir, 'show', `${commit}:${path}`], { maxBuffer: 32 * 1024 * 1024 });
  for (const [path, entry] of Object.entries(mcp.files)) {
    assert.ok(show(process.env.WISPLY_MCP_DIR, mcp.commit, entry.upstream).equals(readFileSync(join(ROOT, path))), path);
  }
  for (const [path, entry] of Object.entries(plugin.files)) {
    assert.ok(show(process.env.WISPLY_PLUGIN_DIR, plugin.commit, entry.upstream).equals(readFileSync(join(ROOT, path))), path);
  }
  const tree = execFileSync('git', ['-C', process.env.WISPLY_MCP_DIR, 'ls-tree', '-r', '--name-only', mcp.commit], { encoding: 'utf8' })
    .split('\n').filter(isVendoredMcpPath).sort();
  assert.deepEqual(Object.values(mcp.files).map((entry) => entry.upstream).sort(), tree);
  assert.equal(relative(ROOT, join(ROOT, MCP_DIR)), 'vendor/wisply-mcp');
  // A recorded main is a claim the release gate trusts: the commit has to be
  // on the origin/main tip sync-vendor checked against.
  if (mcp.ref === 'main') {
    assert.equal(mcp.remote, MCP_REMOTE);
    assert.ok(isOnRef(process.env.WISPLY_MCP_DIR, mcp.commit, mcp.remote_main), `${mcp.commit} is not on ${mcp.remote_main}`);
  }
});

test('sync-vendor passes git only names: nothing that starts with "-", no "..", no empty value', () => {
  for (const good of ['main', 'claude/distribution-3', 'b0869896e4f3028f12255134799f1a7b40ec40fe', 'refs/remotes/origin/main', 'v0.1.0']) {
    assert.equal(validRef(good), true, good);
  }
  for (const bad of ['', '-x', '--upload-pack=touch /tmp/x', '--output=/tmp/x', 'a..b', 'main/', 'x.lock', 'a b', 'a;b', '$(id)', undefined, 1]) {
    assert.equal(validRef(bad), false, String(bad));
  }
  // isOnRef refuses such a value before git sees it.
  assert.equal(isOnRef(ROOT, '--all', 'main'), false);
  assert.equal(isOnRef(ROOT, 'HEAD', '--output=/dev/null'), false);
});

test('origin must be github.com/fal3/wisply-mcp for --mcp-ref main', () => {
  for (const url of ['https://github.com/fal3/wisply-mcp', 'https://github.com/fal3/wisply-mcp.git', 'git@github.com:fal3/wisply-mcp.git',
    'ssh://git@github.com/fal3/wisply-mcp']) {
    assert.ok(MCP_REMOTE_RE.test(url), url);
  }
  for (const url of ['https://github.com/fal3/wisply-claude-plugin', 'https://github.com/someone/wisply-mcp',
    'https://github.com/fal3/wisply-mcp-fork', '/home/user/wisply-mcp', 'https://example.com/fal3/wisply-mcp']) {
    assert.equal(MCP_REMOTE_RE.test(url), false, url);
  }
});

test('verifyOnUpstreamMain: only a commit on GitHub\'s main counts, never the checkout\'s own main', (t) => {
  // "GitHub" is a local bare repository here: a global git config rewrites
  // the github.com URL to it (url.<path>.insteadOf), so origin's configured
  // URL is the real one and nothing touches the network.
  const dir = mkdtempSync(join(tmpdir(), 'wisply-upstream-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const globalConfig = join(dir, 'gitconfig');
  const bare = join(dir, 'upstream.git');
  const env = {
    PATH: process.env.PATH, HOME: dir, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid',
  };
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env }).trim();
  writeFileSync(globalConfig, `[url "${bare}"]\n\tinsteadOf = ${MCP_REMOTE}\n[init]\n\tdefaultBranch = main\n`);
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare], { env });

  const work = join(dir, 'work');
  execFileSync('git', ['init', '-q', '-b', 'main', work], { env });
  git(work, 'remote', 'add', 'origin', MCP_REMOTE);
  const commit = (name) => {
    writeFileSync(join(work, name), name);
    git(work, 'add', name);
    git(work, 'commit', '-q', '-m', name);
    return git(work, 'rev-parse', 'HEAD');
  };
  const pushed = commit('a');
  git(work, 'push', '-q', 'origin', 'main');
  const localOnly = commit('b');

  assert.equal(isOnRef(work, localOnly, 'main'), true, 'the local main has it...');
  assert.throws(() => verifyOnUpstreamMain(work, localOnly, { env }), /is not on https:\/\/github\.com\/fal3\/wisply-mcp main/,
    '...but GitHub\'s main doesn\'t');
  assert.deepEqual(verifyOnUpstreamMain(work, pushed, { env }), { remote: MCP_REMOTE, mainTip: pushed });

  // A checkout of another repository, or none at all, is refused before any fetch.
  git(work, 'remote', 'set-url', 'origin', 'https://github.com/fal3/wisply-claude-plugin');
  assert.throws(() => verifyOnUpstreamMain(work, pushed, { env }), /has origin https:\/\/github\.com\/fal3\/wisply-claude-plugin/);
  git(work, 'remote', 'remove', 'origin');
  assert.throws(() => verifyOnUpstreamMain(work, pushed, { env }), /has no origin remote/);
});
