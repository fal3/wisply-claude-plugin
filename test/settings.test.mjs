// src/settings.ts and the settings in package.json: user settings only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_SETTINGS, KEYS, NOT_SYNCED, SCOPES, SETTING_IDS, affectsWisply, readSettings, sameServerSettings, sameSettings,
  updateUserSetting, validPort, validQuoteFormat, validQuoteWords,
} from '../out/test/settings.mjs';
import { createFakeVscode } from './fixtures/fake-vscode.mjs';

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const properties = manifest.contributes.configuration.properties;
const restricted = manifest.capabilities.untrustedWorkspaces.restrictedConfigurations;

const DEFAULTS = Object.freeze({ port: 51771, allowClaudeSetup: false, statusBarEnabled: true, quoteWords: 80, quoteFormat: 'markdown' });

test('defaults: the contract port, setup_claude off, the status item on, 80-word Markdown quotes', () => {
  assert.deepEqual({ ...DEFAULT_SETTINGS }, DEFAULTS);
  assert.deepEqual({ ...readSettings(createFakeVscode()) }, DEFAULTS);
});

test('only the user value (globalValue) is read, for every setting', () => {
  const vs = createFakeVscode({
    config: {
      port: { globalValue: 51772, workspaceValue: 1, workspaceFolderValue: 2, defaultValue: 51771 },
      'mcp.allowClaudeSetup': { globalValue: true, workspaceValue: false, workspaceFolderValue: false, defaultValue: false },
      'statusBar.enabled': { globalValue: false, workspaceValue: true, workspaceFolderValue: true, defaultValue: true },
      'quote.words': { globalValue: 120, workspaceValue: 400, workspaceFolderValue: 10, defaultValue: 80 },
      'quote.format': { globalValue: 'plain', workspaceValue: 'markdown', workspaceFolderValue: 'markdown', defaultValue: 'markdown' },
    },
  });
  assert.deepEqual({ ...readSettings(vs) },
    { port: 51772, allowClaudeSetup: true, statusBarEnabled: false, quoteWords: 120, quoteFormat: 'plain' });
  assert.ok(vs.log.some((entry) => entry.kind === 'getConfiguration' && entry.section === 'wisply'));
});

test('workspace and folder values are ignored, even when they are the only values', () => {
  const vs = createFakeVscode({
    config: {
      port: { workspaceValue: 51999, workspaceFolderValue: 52000 },
      'mcp.allowClaudeSetup': { workspaceValue: true, workspaceFolderValue: true },
      'statusBar.enabled': { workspaceValue: false, workspaceFolderValue: false },
      'quote.words': { workspaceValue: 400, workspaceFolderValue: 400 },
      'quote.format': { workspaceValue: 'plain', workspaceFolderValue: 'plain' },
    },
  });
  assert.deepEqual({ ...readSettings(vs) }, DEFAULTS);
});

test('invalid user values fall back to the defaults; word counts are kept within 10-400', () => {
  for (const port of [1, 1023, 65536, 51771.5, '51772', null, true, Number.NaN]) {
    const vs = createFakeVscode({ config: { port: { globalValue: port } } });
    assert.equal(readSettings(vs).port, 51771, String(port));
  }
  for (const allow of ['true', 1, null, {}]) {
    const vs = createFakeVscode({ config: { 'mcp.allowClaudeSetup': { globalValue: allow } } });
    assert.equal(readSettings(vs).allowClaudeSetup, false, String(allow));
  }
  // Only an explicit false hides the status item.
  for (const enabled of ['false', 0, null, {}, undefined]) {
    const vs = createFakeVscode({ config: { 'statusBar.enabled': { globalValue: enabled } } });
    assert.equal(readSettings(vs).statusBarEnabled, true, String(enabled));
  }
  for (const [words, expected] of [[9, 10], [0, 10], [-5, 10], [401, 400], [10_000, 400], [79.6, 80], [10, 10], [400, 400],
    ['120', 80], [null, 80], [Number.NaN, 80], [Number.POSITIVE_INFINITY, 80], [true, 80]]) {
    const vs = createFakeVscode({ config: { 'quote.words': { globalValue: words } } });
    assert.equal(readSettings(vs).quoteWords, expected, String(words));
  }
  for (const format of ['Markdown', 'html', '', null, 1]) {
    const vs = createFakeVscode({ config: { 'quote.format': { globalValue: format } } });
    assert.equal(readSettings(vs).quoteFormat, 'markdown', String(format));
  }
  assert.equal(validPort(1024), 1024);
  assert.equal(validPort(65535), 65535);
  assert.equal(validQuoteWords(250), 250);
  assert.equal(validQuoteFormat('plain'), 'plain');
  assert.equal(validQuoteFormat('constructor'), null);
});

test('a configuration that throws gives the defaults', () => {
  const throwing = { workspace: { getConfiguration() { throw new Error('boom'); } } };
  assert.deepEqual({ ...readSettings(throwing) }, DEFAULTS);
  const inspectThrows = { workspace: { getConfiguration: () => ({ inspect() { throw new Error('boom'); } }) } };
  assert.deepEqual({ ...readSettings(inspectThrows) }, DEFAULTS);
});

test('package.json declares exactly the settings the extension reads', () => {
  assert.deepEqual(Object.keys(properties).sort(), [...SETTING_IDS].sort());
  assert.deepEqual(Object.keys(KEYS).sort(), Object.keys(DEFAULTS).sort());
});

test('every setting is local user settings only (application scope); the connector\'s two stay on this computer', () => {
  // `machine` would also take remote settings, which a repository can write
  // (a dev container's customizations.vscode.settings, Remote-SSH machine
  // settings), and inspect().globalValue merges them in. VS Code never reads
  // an application setting from remote settings.
  for (const [name, key] of Object.entries(KEYS)) {
    const id = `wisply.${key}`;
    const property = properties[id];
    assert.equal(property.scope, 'application', `${id} has scope ${property.scope}`);
    assert.equal(property.scope, SCOPES[name], id);
    assert.equal(property.ignoreSync === true, NOT_SYNCED.includes(name), `${id} ignoreSync`);
  }
  // The spec's guarantee in one line: a repository can't turn on setup_claude,
  // and turning it on for one Mac doesn't turn it on in every synced editor.
  for (const id of ['wisply.port', 'wisply.mcp.allowClaudeSetup']) {
    assert.equal(properties[id].scope, 'application', id);
    assert.equal(properties[id].ignoreSync, true, `${id} would be synced`);
    assert.match(properties[id].markdownDescription, /only from your user settings on this computer: not from a workspace, a dev container or a remote machine/, id);
    assert.match(properties[id].markdownDescription, /Settings Sync doesn't copy it/, id);
  }
  // Display settings may sync: they only change what this editor shows and inserts.
  for (const id of ['wisply.statusBar.enabled', 'wisply.quote.words', 'wisply.quote.format']) {
    assert.equal(properties[id].ignoreSync, undefined, id);
    assert.doesNotMatch(properties[id].markdownDescription, /Settings Sync/, id);
  }
});

test('Restricted Mode: limited, with every setting restricted', () => {
  const trust = manifest.capabilities.untrustedWorkspaces;
  assert.equal(trust.supported, 'limited');
  assert.equal(trust.description, 'In Restricted Mode, Wisply reads its settings only from your user settings.');
  assert.deepEqual([...restricted].sort(), Object.keys(properties).sort());
  assert.deepEqual(restricted, ['wisply.port', 'wisply.mcp.allowClaudeSetup', 'wisply.statusBar.enabled',
    'wisply.quote.words', 'wisply.quote.format']);
});

test('package.json defaults and bounds agree with the code', () => {
  assert.equal(properties['wisply.port'].default, DEFAULT_SETTINGS.port);
  assert.equal(properties['wisply.port'].minimum, 1024);
  assert.equal(properties['wisply.port'].maximum, 65535);
  assert.equal(properties['wisply.port'].type, 'integer');
  assert.equal(properties['wisply.mcp.allowClaudeSetup'].default, false);
  assert.equal(properties['wisply.mcp.allowClaudeSetup'].type, 'boolean');
  assert.equal(properties['wisply.statusBar.enabled'].default, DEFAULT_SETTINGS.statusBarEnabled);
  assert.equal(properties['wisply.statusBar.enabled'].type, 'boolean');
  assert.equal(properties['wisply.quote.words'].default, DEFAULT_SETTINGS.quoteWords);
  assert.equal(properties['wisply.quote.words'].type, 'integer');
  assert.equal(properties['wisply.quote.words'].minimum, 10);
  assert.equal(properties['wisply.quote.words'].maximum, 400);
  assert.equal(properties['wisply.quote.format'].default, DEFAULT_SETTINGS.quoteFormat);
  assert.deepEqual(properties['wisply.quote.format'].enum, ['markdown', 'plain']);
  assert.equal(properties['wisply.quote.format'].enumDescriptions.length, 2);
  for (const [id, property] of Object.entries(properties)) {
    assert.match(property.markdownDescription, /only from your user settings/, id);
  }
});

test('change detection: any setting, and the connector\'s own two', () => {
  assert.equal(affectsWisply({ affectsConfiguration: (section) => section === 'wisply' }), true);
  assert.equal(affectsWisply({ affectsConfiguration: () => false }), false);
  assert.equal(sameSettings(DEFAULT_SETTINGS, { ...DEFAULTS }), true);
  for (const [key, value] of Object.entries({ port: 51772, allowClaudeSetup: true, statusBarEnabled: false, quoteWords: 81, quoteFormat: 'plain' })) {
    assert.equal(sameSettings(DEFAULT_SETTINGS, { ...DEFAULTS, [key]: value }), false, key);
    assert.equal(sameServerSettings(DEFAULT_SETTINGS, { ...DEFAULTS, [key]: value }), !['port', 'allowClaudeSetup'].includes(key), key);
  }
});

test('updateUserSetting writes the user settings only', async () => {
  const vs = createFakeVscode();
  await updateUserSetting(vs, 'statusBar.enabled', false);
  assert.deepEqual(vs.configuration.updates, [{ key: 'statusBar.enabled', value: false, target: 1 }]);
  assert.equal(readSettings(vs).statusBarEnabled, false);
});
