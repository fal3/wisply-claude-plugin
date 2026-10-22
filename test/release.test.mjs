// scripts/release-gate.mjs: vsce and ovsx run it (vscode:prepublish) before
// they package or publish. It refuses this tree until the vendored connector
// comes from wisply-mcp main with a final contract and every placeholder is
// final; a development package (WISPLY_DEV_PACKAGE=1) only warns.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEV_PACKAGE_ENV, FINAL, releaseProblems } from '../scripts/release-gate.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const GATE = join(ROOT, 'scripts/release-gate.mjs');
const source = JSON.parse(readFileSync(join(ROOT, 'vendor/SOURCE.json'), 'utf8'));
const ALL_FINAL = Object.freeze({ publisher: true, setupGuide: true });

const releasable = () => ({
  ...source,
  provisional: false,
  sources: source.sources.map((entry) => (entry.repository === 'github:fal3/wisply-mcp'
    ? { ...entry, ref: 'main', contract_provisional: false } : entry)),
});

test('this tree is not releasable: provisional, not from main, placeholder publisher and link', () => {
  const problems = releaseProblems({ source });
  assert.equal(problems.length, 4, problems.join('\n'));
  assert.match(problems[0], /provisional/);
  assert.match(problems[1], /not main/);
  assert.match(problems[2], /publisher/);
  assert.match(problems[3], /setup guide/);
  assert.deepEqual({ ...FINAL }, { publisher: false, setupGuide: false });
});

test('each check on its own', () => {
  assert.deepEqual(releaseProblems({ source: releasable(), final: ALL_FINAL }), []);
  const fromBranch = releasable();
  fromBranch.sources = fromBranch.sources.map((entry) => (entry.repository === 'github:fal3/wisply-mcp'
    ? { ...entry, ref: 'claude/distribution-3' } : entry));
  assert.equal(releaseProblems({ source: fromBranch, final: ALL_FINAL }).length, 1);
  const noRef = releasable();
  noRef.sources = noRef.sources.map((entry) => {
    if (entry.repository !== 'github:fal3/wisply-mcp') return entry;
    const { ref: _ref, ...rest } = entry;
    return rest;
  });
  assert.match(releaseProblems({ source: noRef, final: ALL_FINAL })[0], /an unnamed ref/);
  assert.equal(releaseProblems({ source: { ...releasable(), provisional: true }, final: ALL_FINAL }).length, 1);
  assert.equal(releaseProblems({ source: releasable(), final: { publisher: true, setupGuide: false } }).length, 1);
  assert.equal(releaseProblems({ source: releasable(), final: { publisher: false, setupGuide: true } }).length, 1);
  assert.match(releaseProblems({ source: { sources: [] }, final: ALL_FINAL })[0], /no github:fal3\/wisply-mcp source/);
});

test('as vscode:prepublish: refuses, and a development package only warns', () => {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME ?? '/tmp' };
  const refused = spawnSync(process.execPath, [GATE], { env, encoding: 'utf8' });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /^Not releasable:\n/);
  assert.match(refused.stderr, /npm run package/);
  const dev = spawnSync(process.execPath, [GATE], { env: { ...env, [DEV_PACKAGE_ENV]: '1' }, encoding: 'utf8' });
  assert.equal(dev.status, 0, dev.stderr);
  assert.match(dev.stderr, /^Development package, not for publishing:\n/);
  assert.equal(DEV_PACKAGE_ENV, 'WISPLY_DEV_PACKAGE');
});
