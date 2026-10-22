// Vendored files match contract/SOURCE.json, and a provisional contract, or
// one vendored from a wisply-ai commit that isn't on its main yet, can't be
// released.
//
// This file reads only the tree: "on_main" and the sha256 values are what
// contract/SOURCE.json says. tests/upstream.test.mjs checks them against real
// checkouts of wisply-ai and the plugin, and the maintainer's release check
// (WISPLY_RELEASE=1 outside GitHub Actions) fails without those checkouts.
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
    // wisply-ai's entry says whether its main had the commit when it was vendored (scripts/sync-vendor.mjs).
    if (source.repository === 'github:fal3/wisply-ai' && !source.provisional) {
      assert.equal(typeof source.on_main, 'boolean', 'run npm run sync-vendor: it records "on_main"');
    } else {
      assert.equal(Object.hasOwn(source, 'on_main'), false, source.repository);
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

const APP = SOURCE.sources.find((source) => source.repository === 'github:fal3/wisply-ai');
/** Released only from wisply-ai's main: the contract Wisply's own Mac CI has pinned to its Swift source. */
const releasable = () => SOURCE.provisional === false && APP?.on_main === true;

const RELEASE = process.env.WISPLY_RELEASE === '1';

test('a provisional contract is never released (WISPLY_RELEASE=1)', { skip: RELEASE ? false : 'WISPLY_RELEASE is not 1' }, () => {
  assert.equal(SOURCE.provisional, false,
    'contract/SOURCE.json says provisional: re-vendor with npm run sync-vendor (SECURITY.md, "Re-vendoring the contract")');
});

test('a contract from a wisply-ai commit that main doesn\'t have is never released (WISPLY_RELEASE=1)', {
  skip: !RELEASE ? 'WISPLY_RELEASE is not 1' : SOURCE.provisional ? 'provisional: the test above refuses it' : false,
}, () => {
  assert.equal(APP.on_main, true, `contract/SOURCE.json: wisply-ai ${APP.commit.slice(0, 7)} wasn't on its main when ` +
    'it was vendored ("on_main": false): once it is merged, run npm run sync-vendor again from the main commit ' +
    '(SECURITY.md, "Re-vendoring the contract")');
});

test('the release check really fails while the source is provisional or not on main', { skip: RELEASE }, () => {
  const env = { ...process.env, WISPLY_RELEASE: '1' };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['--test', fileURLToPath(import.meta.url)], { cwd: ROOT, env, encoding: 'utf8' });
  assert.equal(result.status === 0, releasable(), result.stdout.slice(-2000));
});
