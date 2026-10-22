// src/settings.ts and the settings in package.json: user settings only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_SETTINGS, SETTING_IDS, affectsWisply, readSettings, sameSettings, validPort } from '../out/test/settings.mjs';
import { createFakeVscode } from './fixtures/fake-vscode.mjs';

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const properties = manifest.contributes.configuration.properties;
const restricted = manifest.capabilities.untrustedWorkspaces.restrictedConfigurations;

test('defaults: the contract port, setup_claude off', () => {
  assert.deepEqual({ ...DEFAULT_SETTINGS }, { port: 51771, allowClaudeSetup: false });
  assert.deepEqual({ ...readSettings(createFakeVscode()) }, { ...DEFAULT_SETTINGS });
});

test('only the user value (globalValue) is read, for every setting', () => {
  const vs = createFakeVscode({
    config: {
      port: { globalValue: 51772, workspaceValue: 1, workspaceFolderValue: 2, defaultValue: 51771 },
      'mcp.allowClaudeSetup': { globalValue: true, workspaceValue: false, workspaceFolderValue: false, defaultValue: false },
    },
  });
  assert.deepEqual({ ...readSettings(vs) }, { port: 51772, allowClaudeSetup: true });
  assert.ok(vs.log.some((entry) => entry.kind === 'getConfiguration' && entry.section === 'wisply'));
});

test('workspace and folder values are ignored, even when they are the only values', () => {
  const vs = createFakeVscode({
    config: {
      port: { workspaceValue: 51999, workspaceFolderValue: 52000 },
      'mcp.allowClaudeSetup': { workspaceValue: true, workspaceFolderValue: true },
    },
  });
  assert.deepEqual({ ...readSettings(vs) }, { ...DEFAULT_SETTINGS });
});

test('invalid user values fall back to the defaults', () => {
  for (const port of [1, 1023, 65536, 51771.5, '51772', null, true, Number.NaN]) {
    const vs = createFakeVscode({ config: { port: { globalValue: port } } });
    assert.equal(readSettings(vs).port, 51771, String(port));
  }
  for (const allow of ['true', 1, null, {}]) {
    const vs = createFakeVscode({ config: { 'mcp.allowClaudeSetup': { globalValue: allow } } });
    assert.equal(readSettings(vs).allowClaudeSetup, false, String(allow));
  }
  assert.equal(validPort(1024), 1024);
  assert.equal(validPort(65535), 65535);
});

test('a configuration that throws gives the defaults', () => {
  const throwing = { workspace: { getConfiguration() { throw new Error('boom'); } } };
  assert.deepEqual({ ...readSettings(throwing) }, { ...DEFAULT_SETTINGS });
  const inspectThrows = { workspace: { getConfiguration: () => ({ inspect() { throw new Error('boom'); } }) } };
  assert.deepEqual({ ...readSettings(inspectThrows) }, { ...DEFAULT_SETTINGS });
});

test('package.json declares exactly the settings the extension reads', () => {
  assert.deepEqual(Object.keys(properties).sort(), [...SETTING_IDS].sort());
});

test('every setting is local user settings only (application scope) and stays on this computer (ignoreSync)', () => {
  // `machine` would also take remote settings, which a repository can write
  // (a dev container's customizations.vscode.settings, Remote-SSH machine
  // settings), and inspect().globalValue merges them in. VS Code never reads
  // an application setting from remote settings.
  for (const [id, property] of Object.entries(properties)) {
    assert.equal(property.scope, 'application', `${id} has scope ${property.scope}`);
    assert.equal(property.ignoreSync, true, `${id} would be synced`);
    assert.match(property.markdownDescription, /only from your user settings on this computer: not from a workspace, a dev container or a remote machine/, id);
    assert.match(property.markdownDescription, /Settings Sync doesn't copy it/, id);
  }
  // The spec's guarantee in one line: a repository can't turn on setup_claude.
  assert.equal(properties['wisply.mcp.allowClaudeSetup'].scope, 'application');
});

test('Restricted Mode: limited, with every setting restricted', () => {
  const trust = manifest.capabilities.untrustedWorkspaces;
  assert.equal(trust.supported, 'limited');
  assert.equal(trust.description, 'In Restricted Mode, Wisply reads its settings only from your user settings.');
  assert.deepEqual([...restricted].sort(), Object.keys(properties).sort());
});

test('package.json defaults and bounds agree with the code', () => {
  assert.equal(properties['wisply.port'].default, DEFAULT_SETTINGS.port);
  assert.equal(properties['wisply.port'].minimum, 1024);
  assert.equal(properties['wisply.port'].maximum, 65535);
  assert.equal(properties['wisply.port'].type, 'integer');
  assert.equal(properties['wisply.mcp.allowClaudeSetup'].default, false);
  assert.equal(properties['wisply.mcp.allowClaudeSetup'].type, 'boolean');
});

test('change detection', () => {
  assert.equal(affectsWisply({ affectsConfiguration: (section) => section === 'wisply' }), true);
  assert.equal(affectsWisply({ affectsConfiguration: () => false }), false);
  assert.equal(sameSettings(DEFAULT_SETTINGS, { port: 51771, allowClaudeSetup: false }), true);
  assert.equal(sameSettings(DEFAULT_SETTINGS, { port: 51772, allowClaudeSetup: false }), false);
  assert.equal(sameSettings(DEFAULT_SETTINGS, { port: 51771, allowClaudeSetup: true }), false);
});
