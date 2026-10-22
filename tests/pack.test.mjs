// What npm would publish, and the package's shape: no dependencies, no
// lifecycle scripts, and names that agree everywhere.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import contract from '../lib/contract.mjs';
import { NPX_COMMAND, PACKAGE_NAME, PACKAGE_NAME_FINAL, PACKAGE_RANGE, PACKAGE_SPEC, VERSION } from '../lib/constants.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const SOURCE = JSON.parse(readFileSync(join(ROOT, 'contract/SOURCE.json'), 'utf8'));
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
    'lib/cli.mjs', 'lib/clients.mjs', 'contract/mcp-contract.json', 'contract/mcp-contract.mjs', 'contract/SOURCE.json',
    'clients/mcp-clients.json', 'clients/mcp-clients.mjs', 'README.md', 'LICENSE', 'package.json']) {
    assert.ok(files.includes(required), required);
  }
  for (const file of files) {
    assert.ok(!/^(tests|scripts|\.github)\//.test(file), file);
    assert.doesNotMatch(readFileSync(join(ROOT, file), 'utf8'), /wsp[cr]?_[0-9a-f]{64}/, `${file} contains a token-shaped string`);
  }
});

test('npm refuses to publish until the contract is final and the name is Wisply\'s ("private": true)', () => {
  // npm publish refuses a private package without running any script, so a
  // plain `npm publish` can't ship a provisional contract or an npm name
  // nobody owns yet. The two are separate facts with separate changes: the
  // re-vendor from wisply-ai (DIST-M5's follow-up) clears the first, the npm
  // organization (Alex, G-NPM) the second, and dropping the flag is the
  // explicit release step once both hold.
  const publishable = !SOURCE.provisional && PACKAGE_NAME_FINAL;
  assert.equal(pkg.private === true, !publishable,
    'package.json "private" must be true exactly while contract/SOURCE.json is provisional or PACKAGE_NAME_FINAL is false');
  if (publishable) assert.equal(Object.hasOwn(pkg, 'private'), false, 'remove "private" rather than setting it to false');
});

test('a publishable package.json needs the final package name', () => {
  // Messages may name the package through npx only once Wisply owns the name
  // on npm (lib/messages.mjs COMMAND_PREFIX). Owning it doesn't make the
  // package publishable on its own: "private" stays until the contract is final too.
  assert.equal(typeof PACKAGE_NAME_FINAL, 'boolean');
  if (pkg.private !== true) assert.equal(PACKAGE_NAME_FINAL, true, 'a publishable package.json needs PACKAGE_NAME_FINAL');
});

test('every npx or npm install of the package in the docs and messages runs the pinned version', () => {
  // The exact version, as every snippet. The 0.x range is only ever a version to write, never a command.
  // (tests/clients.test.mjs also requires npx's --prefix / before the package.)
  const escaped = PACKAGE_NAME.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const command = new RegExp(`\\b(?:npx(?: -y)?(?: --prefix /)?|npm (?:i|install) -g) (${escaped}[^\\s\`"'),]*)`, 'g');
  for (const file of ['README.md', 'SECURITY.md', 'CHANGELOG.md', 'docs/design-differences.md', 'llms-install.md']) {
    const text = readFileSync(join(ROOT, file), 'utf8');
    for (const match of text.matchAll(command)) {
      // `@wisply/mcp@<version>` is how the docs write "this release's version" in general.
      assert.ok([PACKAGE_SPEC, `${PACKAGE_NAME}@<version>`].includes(match[1]), `${file}: ${match[0]}`);
    }
  }
  // In messages.mjs, npx reaches a text only through COMMAND_PREFIX (NPX_COMMAND: npx's flags and the pinned
  // spec), and only once the name is final.
  const source = readFileSync(join(ROOT, 'lib/messages.mjs'), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/^import .*$/gm, '');
  assert.equal(code.split('NPX_COMMAND').length - 1, 1, 'NPX_COMMAND is used once, in COMMAND_PREFIX');
  assert.match(code, /export const COMMAND_PREFIX = PACKAGE_NAME_FINAL \? NPX_COMMAND : 'wisply-mcp';/);
  assert.doesNotMatch(code, /\$\{(PACKAGE_SPEC|PACKAGE_NAME)\}|\bnpx\b/);
  assert.doesNotMatch(source, /npx -y @wisply/);
  assert.equal(NPX_COMMAND, `npx -y --prefix / ${PACKAGE_SPEC}`);
});

test('no dependencies and no lifecycle scripts', () => {
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'bundleDependencies', 'bundledDependencies']) {
    assert.equal(Object.hasOwn(pkg, field), false, field);
  }
  for (const script of LIFECYCLE) assert.equal(Object.hasOwn(pkg.scripts ?? {}, script), false, script);
  assert.deepEqual(Object.keys(pkg.scripts).sort(), ['build:mcpb', 'check', 'gen-data', 'sync-vendor', 'test']);
  assert.equal(pkg.scripts['build:mcpb'], 'node scripts/build-mcpb.mjs');
  assert.equal(pkg.scripts.check, 'npm test && npm pack --dry-run');
});

test('package.json, the constants and the README agree', () => {
  assert.equal(pkg.name, PACKAGE_NAME);
  assert.equal(pkg.version, VERSION);
  // Snippets pin the exact version; the 0.x range is only ever an opt-in.
  assert.equal(PACKAGE_SPEC, `${PACKAGE_NAME}@${VERSION}`);
  assert.match(VERSION, /^\d+\.\d+\.\d+$/);
  assert.equal(PACKAGE_RANGE, `${PACKAGE_NAME}@${VERSION.split('.')[0]}`);
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
  assert.ok(readme.includes(`"args": ["-y", "--prefix", "/", "${PACKAGE_SPEC}"]`), 'README shows the standard entry');
  assert.ok(readme.includes(NPX_COMMAND));
  for (const tool of contract.tools) assert.ok(readme.includes(`\`${tool}\``), `README names ${tool}`);
  assert.ok(!readme.includes('@wisply/mcp@latest'));
  // The range appears only in the opt-in note, never in a snippet.
  assert.ok(!readme.includes(`"${PACKAGE_RANGE}"`) && !readme.includes(`/ ${PACKAGE_RANGE} `) && !readme.includes(`/ ${PACKAGE_RANGE}\``),
    'README snippets run the exact version');
});

test('the bin is an executable node script', () => {
  const bin = join(ROOT, pkg.bin['wisply-mcp']);
  assert.match(readFileSync(bin, 'utf8'), /^#!\/usr\/bin\/env node\n/);
  assert.ok((statSync(bin).mode & 0o111) !== 0, 'chmod +x bin/wisply-mcp.mjs');
});

// The one install CI may run: the pinned MCPB tool for the bundle checks, from tools/mcpb's lockfile, outside the
// package and without its scripts (job mcpb; tests/manifests.test.mjs checks the job and the lockfile).
const MCPB_INSTALL = 'npm ci --ignore-scripts --no-audit --no-fund --prefix tools/mcpb';

test('CI is read-only, SHA-pinned and installs nothing but the pinned MCPB tool', () => {
  const workflow = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');
  assert.equal(workflow.split(MCPB_INSTALL).length - 1, 1, 'exactly one pinned MCPB install');
  const ci = workflow.replace(MCPB_INSTALL, '');
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
