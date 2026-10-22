// test/integration/: the VS Code smoke test can't run here (no desktop, and
// the proxy refuses update.code.visualstudio.com), so this checks only that
// its files load, that the launcher refuses to start off macOS, and that the
// profile it creates keeps the test away from a real Wisply.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { MAC_ONLY, ROOT, SUITE, userSettings } from './integration/run.mjs';

test('the suite and the launcher are valid JavaScript', () => {
  for (const file of [SUITE, join(ROOT, 'test/integration/run.mjs')]) {
    const checked = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    assert.equal(checked.status, 0, checked.stderr);
  }
});

test('off macOS the launcher stops before it downloads anything', { skip: process.platform === 'darwin' }, () => {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME ?? '/tmp' };
  const result = spawnSync(process.execPath, [join(ROOT, 'test/integration/run.mjs')], { env, encoding: 'utf8', timeout: 20_000 });
  assert.equal(result.status, 2, result.stderr);
  assert.equal(result.stderr, MAC_ONLY);
});

test('the test profile turns the status item off, uses another port and never autostarts MCP servers', () => {
  const settings = userSettings(40000);
  assert.equal(settings['wisply.statusBar.enabled'], false);
  assert.equal(settings['wisply.port'], 40000);
  assert.equal(settings['chat.mcp.autostart'], 'never');
});
