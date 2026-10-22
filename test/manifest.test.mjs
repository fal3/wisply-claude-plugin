// package.json, the lockfile and the build settings.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { COMMANDS } from '../out/test/extension.mjs';
import { PROVIDER_ID, SERVER_LABEL } from '../out/test/provider.mjs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));
const forks = JSON.parse(read('test/fork-versions.json'));

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const parse = (version) => {
  const match = SEMVER.exec(version);
  assert.ok(match, `not an exact version: ${version}`);
  return match.slice(1).map(Number);
};
const atMost = (a, b) => {
  const [x, y] = [parse(a), parse(b)];
  for (let index = 0; index < 3; index += 1) if (x[index] !== y[index]) return x[index] < y[index];
  return true;
};

test('identity: wisply.wisply, MIT, free, placeholder publisher until D6 is confirmed', () => {
  assert.equal(manifest.name, 'wisply');
  assert.equal(manifest.displayName, 'Wisply');
  assert.equal(manifest.publisher, 'wisply');
  assert.equal(manifest.license, 'MIT');
  assert.equal(manifest.pricing, 'Free');
  assert.equal(manifest.private, true, 'never published to npm');
  parse(manifest.version);
  assert.equal(manifest.repository.url, 'https://github.com/fal3/wisply-vscode');
  assert.ok(existsSync(new URL('../LICENSE', import.meta.url)));
});

test('the engine floor is ^1.93.0 and at most every fork base recorded (D19)', () => {
  assert.equal(manifest.engines.vscode, '^1.93.0');
  const floor = manifest.engines.vscode.slice(1);
  const versions = { ...forks.search, ...forks.recorded };
  assert.ok(Object.keys(versions).length > 0);
  for (const [editor, version] of Object.entries(versions)) {
    assert.ok(atMost(floor, version), `${editor} reports VS Code ${version}, below the floor ${floor}`);
  }
});

test('@types/vscode equals the engine floor (vsce refuses newer typings)', () => {
  assert.equal(manifest.devDependencies['@types/vscode'], manifest.engines.vscode.slice(1));
});

test('dev dependencies are exact; there are no runtime dependencies', () => {
  assert.equal(manifest.dependencies, undefined);
  assert.deepEqual(Object.keys(manifest.devDependencies).sort(),
    ['@types/node', '@types/vscode', '@vscode/vsce', 'esbuild', 'typescript']);
  for (const [name, version] of Object.entries(manifest.devDependencies)) assert.match(version, SEMVER, name);
  assert.equal(manifest.devDependencies['@vscode/vsce'], '4.0.0');
  assert.match(manifest.devDependencies['@types/node'], /^22\./);
});

test('the lockfile matches package.json', () => {
  assert.equal(lock.lockfileVersion, 3);
  assert.equal(lock.name, manifest.name);
  assert.equal(lock.version, manifest.version);
  assert.deepEqual(lock.packages[''].devDependencies, manifest.devDependencies);
  for (const [name, version] of Object.entries(manifest.devDependencies)) {
    assert.equal(lock.packages[`node_modules/${name}`]?.version, version, name);
  }
});

test('npm runs no install scripts here; only vsce\'s prepublish hook exists', () => {
  assert.match(read('.npmrc'), /^ignore-scripts=true$/m);
  const lifecycle = ['preinstall', 'install', 'postinstall', 'prepare', 'prepack', 'postpack', 'prepublish',
    'prepublishOnly', 'publish', 'postpublish', 'pretest', 'posttest'];
  for (const name of lifecycle) assert.equal(Object.hasOwn(manifest.scripts, name), false, name);
  assert.equal(manifest.scripts['vscode:prepublish'], 'node esbuild.mjs');
  assert.equal(manifest.scripts.package, 'vsce package --no-dependencies');
  assert.match(manifest.scripts.check, /typecheck.*test.*build.*package/);
});

test('runs on the Mac side, at startup, from the bundle', () => {
  assert.deepEqual(manifest.extensionKind, ['ui']);
  assert.deepEqual(manifest.activationEvents, ['onStartupFinished']);
  assert.equal(manifest.main, './dist/extension.js');
  assert.deepEqual(manifest.categories, ['AI', 'Chat', 'Other']);
  assert.equal(manifest.capabilities.virtualWorkspaces, true);
});

test('the MCP provider contribution matches the code', () => {
  assert.deepEqual(manifest.contributes.mcpServerDefinitionProviders, [{ id: PROVIDER_ID, label: SERVER_LABEL }]);
});

test('commands: the palette shows "Wisply: …" for each one the extension registers', () => {
  const titles = Object.fromEntries(manifest.contributes.commands.map((command) => [command.command, `${command.category}: ${command.title}`]));
  assert.deepEqual(titles, {
    [COMMANDS.setToken]: 'Wisply: Set Token…',
    [COMMANDS.forgetToken]: 'Wisply: Forget Token',
    [COMMANDS.checkConnection]: 'Wisply: Check Connection',
    [COMMANDS.storeTokenInKeychain]: 'Wisply: Store Token in the Mac Keychain…',
    [COMMANDS.openSetupGuide]: 'Wisply: Open Setup Guide',
  });
  assert.deepEqual(manifest.contributes.menus.commandPalette, [{ command: COMMANDS.storeTokenInKeychain, when: 'isMac' }]);
});

test('TypeScript is strict and only type-checks', () => {
  const config = JSON.parse(read('tsconfig.json'));
  assert.equal(config.compilerOptions.strict, true);
  assert.equal(config.compilerOptions.noEmit, true);
  assert.deepEqual(config.include, ['src/**/*.ts']);
});

test('nothing in the repository looks like a real token', () => {
  for (const path of ['package.json', 'package-lock.json', 'README.md', 'vendor/SOURCE.json', 'test/fork-versions.json']) {
    assert.doesNotMatch(read(path), /wsp[cr]?_[0-9a-f]{64}/, path);
  }
});
