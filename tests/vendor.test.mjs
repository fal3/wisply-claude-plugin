// Vendored files match contract/SOURCE.json, and a provisional contract
// can't be released.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SOURCE = JSON.parse(readFileSync(join(ROOT, 'contract/SOURCE.json'), 'utf8'));
const sha256 = (path) => createHash('sha256').update(readFileSync(join(ROOT, path))).digest('hex');

test('SOURCE.json records every vendored file with its sha256', () => {
  assert.equal(SOURCE.schema, 'wisply-mcp-vendor-v1');
  assert.equal(typeof SOURCE.provisional, 'boolean');
  assert.equal(SOURCE.provisional, SOURCE.sources.some((source) => source.provisional === true));
  const listed = [];
  for (const source of SOURCE.sources) {
    assert.match(source.repository, /^github:fal3\/[a-z-]+$/);
    assert.equal(typeof source.provisional, 'boolean');
    if (source.provisional) {
      assert.match(source.commit, /^[0-9a-f]{7} \(transcribed\)$/);
    } else {
      assert.match(source.commit, /^[0-9a-f]{40}$/);
    }
    for (const [path, entry] of Object.entries(source.files)) {
      listed.push(path);
      assert.ok(existsSync(join(ROOT, path)), path);
      assert.equal(typeof entry.upstream, 'string');
      assert.equal(sha256(path), entry.sha256, `${path} changed without npm run sync-vendor`);
    }
  }
  assert.deepEqual(listed.sort(), ['contract/mcp-contract.json', 'lib/identity.mjs']);
});

test('a provisional contract is never released (WISPLY_RELEASE=1)', () => {
  if (process.env.WISPLY_RELEASE !== '1') return;
  assert.equal(SOURCE.provisional, false,
    'contract/SOURCE.json says provisional: re-vendor from the DIST-A1 merge commit with npm run sync-vendor (DIST-M5)');
});

test('the release check really fails while the source is provisional', { skip: process.env.WISPLY_RELEASE === '1' }, () => {
  const env = { ...process.env, WISPLY_RELEASE: '1' };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['--test', fileURLToPath(import.meta.url)], { cwd: ROOT, env, encoding: 'utf8' });
  assert.equal(result.status === 0, !SOURCE.provisional, result.stdout.slice(-2000));
});
