// What npm would publish, and the package's shape: no dependencies, no
// lifecycle scripts, and names that agree everywhere.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import contract from '../lib/contract.mjs';
import { PACKAGE_NAME, PACKAGE_SPEC, VERSION } from '../lib/constants.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const LIFECYCLE = ['preinstall', 'install', 'postinstall', 'prepare', 'preprepare', 'postprepare', 'prepack', 'postpack',
  'prepublish', 'prepublishOnly', 'publish', 'postpublish', 'preuninstall', 'uninstall', 'postuninstall',
  'preversion', 'version', 'postversion', 'dependencies'];

/** The files `npm pack --dry-run` would put in the tarball. */
function packedFiles() {
  const npm = process.env.npm_execpath;
  const [command, args] = npm && npm.endsWith('.js')
    ? [process.execPath, [npm, 'pack', '--dry-run', '--json', '--ignore-scripts']]
    : ['npm', ['pack', '--dry-run', '--json', '--ignore-scripts']];
  const output = execFileSync(command, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const [report] = JSON.parse(output);
  return report.files.map((file) => file.path).sort();
}

test('the tarball holds only bin, lib, contract, clients, README, LICENSE and package.json', () => {
  const files = packedFiles();
  const allowed = /^(bin\/[^/]+\.mjs|lib\/[^/]+\.mjs|contract\/[^/]+\.(json|mjs)|clients\/[^/]+\.(json|mjs)|README\.md|LICENSE|package\.json)$/;
  for (const file of files) assert.match(file, allowed);
  for (const required of ['bin/wisply-mcp.mjs', 'lib/bridge.mjs', 'lib/identity.mjs', 'lib/contract.mjs', 'lib/messages.mjs',
    'contract/mcp-contract.json', 'contract/mcp-contract.mjs', 'contract/SOURCE.json', 'README.md', 'LICENSE', 'package.json']) {
    assert.ok(files.includes(required), required);
  }
  for (const file of files) {
    assert.ok(!/^(tests|scripts|\.github)\//.test(file), file);
    assert.doesNotMatch(readFileSync(join(ROOT, file), 'utf8'), /wsp[cr]?_[0-9a-f]{64}/, `${file} contains a token-shaped string`);
  }
});

test('no dependencies and no lifecycle scripts', () => {
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'bundleDependencies', 'bundledDependencies']) {
    assert.equal(Object.hasOwn(pkg, field), false, field);
  }
  for (const script of LIFECYCLE) assert.equal(Object.hasOwn(pkg.scripts ?? {}, script), false, script);
  assert.deepEqual(Object.keys(pkg.scripts).sort(), ['check', 'gen-data', 'sync-vendor', 'test']);
  assert.equal(pkg.scripts.check, 'npm test && npm pack --dry-run');
});

test('package.json, the constants and the README agree', () => {
  assert.equal(pkg.name, PACKAGE_NAME);
  assert.equal(pkg.version, VERSION);
  assert.equal(PACKAGE_SPEC, `${PACKAGE_NAME}@${VERSION.split('.')[0]}`);
  assert.equal(pkg.type, 'module');
  assert.deepEqual(pkg.bin, { 'wisply-mcp': 'bin/wisply-mcp.mjs' });
  assert.equal(pkg.mcpName, 'ai.wisply/local');
  assert.deepEqual(pkg.engines, { node: '>=20' });
  assert.deepEqual(pkg.files, ['bin', 'lib', 'contract', 'clients', 'README.md', 'LICENSE']);
  assert.equal(pkg.license, 'MIT');
  assert.equal(pkg.repository, 'github:fal3/wisply-mcp');
  assert.equal(pkg.homepage, 'https://www.wisply.ai/docs/mcp/install');
  assert.match(readFileSync(join(ROOT, 'LICENSE'), 'utf8'), /^MIT License/);

  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  assert.ok(readme.includes(`"args": ["-y", "${PACKAGE_SPEC}"]`), 'README shows the standard entry');
  assert.ok(readme.includes(`npx -y ${PACKAGE_SPEC}`));
  for (const tool of contract.tools) assert.ok(readme.includes(`\`${tool}\``), `README names ${tool}`);
  assert.ok(!readme.includes('@wisply/mcp@latest'));
});

test('the bin is an executable node script', () => {
  const bin = join(ROOT, pkg.bin['wisply-mcp']);
  assert.match(readFileSync(bin, 'utf8'), /^#!\/usr\/bin\/env node\n/);
  assert.ok((statSync(bin).mode & 0o111) !== 0, 'chmod +x bin/wisply-mcp.mjs');
});

test('CI is read-only, SHA-pinned and installs nothing', () => {
  const ci = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');
  assert.match(ci, /^permissions:\n {2}contents: read\n/m);
  const uses = [...ci.matchAll(/uses:\s*(\S+)/g)].map((match) => match[1]);
  assert.ok(uses.length >= 2);
  for (const action of uses) assert.match(action, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, action);
  assert.match(ci, /persist-credentials: false/);
  assert.match(ci, /if: \$\{\{ !github\.event\.repository\.private \}\}/);
  assert.match(ci, /run: npm run check/);
  assert.doesNotMatch(ci, /npm (ci|install)|secrets\.|pull_request_target|id-token/);
  assert.match(readFileSync(join(ROOT, '.github/dependabot.yml'), 'utf8'), /package-ecosystem: github-actions/);
});
