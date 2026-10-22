// vendor/ and server/wisply-mcp.mjs against vendor/SOURCE.json, and, with
// WISPLY_MCP_DIR and WISPLY_PLUGIN_DIR set, against the source repositories.
// With WISPLY_RELEASE=1 a provisional contract (or a branch other than main)
// fails, so nothing is published from it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MCP_DIR, MCP_REPOSITORY, PLUGIN_FILES, PLUGIN_REPOSITORY, SOURCE_FILE, VENDOR_SCHEMA, isVendoredMcpPath,
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
});

test('the vendored connector has what the extension and the bundle need', () => {
  const upstream = Object.values(mcp.files).map((entry) => entry.upstream);
  for (const path of ['bin/wisply-mcp.mjs', 'lib/bridge.mjs', 'lib/cli.mjs', 'lib/token.mjs', 'lib/scopes.mjs',
    'lib/messages.mjs', 'lib/contract.mjs', 'lib/constants.mjs', 'lib/identity.mjs', 'contract/mcp-contract.mjs',
    'contract/SOURCE.json', 'clients/mcp-clients.mjs', 'LICENSE']) {
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

test('release: refused while the contract is provisional or the source isn\'t main', { skip: process.env.WISPLY_RELEASE !== '1' }, () => {
  assert.equal(source.provisional, false, 'vendor/SOURCE.json is provisional: re-vendor from wisply-mcp main after DIST-M5');
  assert.equal(mcp.ref, 'main', 'vendor from fal3/wisply-mcp main (npm run sync-vendor -- --mcp-ref main)');
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
});
