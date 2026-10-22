// What npm would publish, and the package's shape: no dependencies, no
// lifecycle scripts, and names that agree everywhere.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import contract from '../lib/contract.mjs';
import {
  MCP_NAME, NPX_COMMAND, NPX_FLAGS, PACKAGE_NAME, PACKAGE_RANGE, PACKAGE_SPEC, STANDARD_ENTRY, VERSION,
} from '../lib/constants.mjs';

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
    'contract/mcp-contract.json', 'contract/mcp-contract.mjs', 'contract/SOURCE.json', 'README.md', 'LICENSE', 'package.json']) {
    assert.ok(files.includes(required), required);
  }
  for (const file of files) {
    assert.ok(!/^(tests|scripts|\.github)\//.test(file), file);
    assert.doesNotMatch(readFileSync(join(ROOT, file), 'utf8'), /wsp[cr]?_[0-9a-f]{64}/, `${file} contains a token-shaped string`);
  }
});

test('npm refuses to publish while the contract is provisional ("private": true)', () => {
  // npm publish refuses a private package without running any script, so a
  // plain `npm publish` can't ship the provisional contract. Dropping the flag
  // is the explicit release step, together with the re-vendored contract (DIST-M5).
  assert.equal(pkg.private === true, SOURCE.provisional, 'package.json "private" must equal contract/SOURCE.json "provisional"');
  if (!SOURCE.provisional) assert.equal(Object.hasOwn(pkg, 'private'), false, 'remove "private" rather than setting it to false');
});

test('docs/design-differences.md re-derives the design\'s one-click links from STANDARD_ENTRY', () => {
  // The same constructions that reproduce the design's own links from its old entry ["-y", "@wisply/mcp@0"].
  const links = (args) => {
    const entry = JSON.stringify({ command: 'npx', args });
    const base64 = encodeURIComponent(Buffer.from(entry).toString('base64'));
    const vscode = encodeURIComponent(JSON.stringify({ name: 'wisply', command: 'npx', args }));
    return [
      `https://cursor.com/en/install-mcp?name=wisply&config=${base64}`,
      `https://lmstudio.ai/install-mcp?name=wisply&config=${base64}`,
      `https://insiders.vscode.dev/redirect?url=${encodeURIComponent(`vscode:mcp/install?${vscode}`)}`,
      `https://kiro.dev/launch/mcp/add?name=wisply&config=${encodeURIComponent(entry)}`,
      `cmd=npx&${args.map((arg) => `arg=${encodeURIComponent(arg)}`).join('&')}`,
    ];
  };
  const design = links(['-y', '@wisply/mcp@0']);
  assert.ok(design[0].endsWith('config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkB3aXNwbHkvbWNwQDAiXX0%3D'));
  assert.ok(design[2].endsWith('%252C%2522%2540wisply%252Fmcp%25400%2522%255D%257D'));
  assert.ok(design[3].endsWith('config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40wisply%2Fmcp%400%22%5D%7D'));
  const text = readFileSync(join(ROOT, 'docs/design-differences.md'), 'utf8');
  for (const link of links([...STANDARD_ENTRY.args])) assert.ok(text.includes(`\`${link}\``) || text.includes(`\`${link}\` (`), link);
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
  // The registry name is a placeholder like the package name (constants.mjs MCP_NAME; docs/release-checks.json).
  assert.equal(pkg.mcpName, MCP_NAME);
  assert.deepEqual(pkg.engines, { node: '>=20' });
  assert.deepEqual(pkg.files, ['bin', 'lib', 'contract', 'clients', 'README.md', 'LICENSE']);
  assert.equal(pkg.license, 'MIT');
  assert.equal(pkg.repository, 'github:fal3/wisply-mcp');
  assert.equal(pkg.homepage, 'https://www.wisply.ai/docs/mcp/install');
  assert.match(readFileSync(join(ROOT, 'LICENSE'), 'utf8'), /^MIT License/);

  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  assert.ok(readme.includes(`{ "command": "npx", "args": ["-y", "--prefix", "/", "${PACKAGE_SPEC}"] }`), 'README shows the standard entry');
  assert.ok(readme.includes(`-- ${NPX_COMMAND}\``), 'README shows the Claude Code command');
  for (const tool of contract.tools) assert.ok(readme.includes(`\`${tool}\``), `README names ${tool}`);
  assert.ok(!readme.includes('@wisply/mcp@latest'));
  // The range appears only in the opt-in note, never in a snippet.
  assert.ok(!readme.includes(`"${PACKAGE_RANGE}"`) && !readme.includes(`/ ${PACKAGE_RANGE} `) && !readme.includes(`/ ${PACKAGE_RANGE}\``),
    'README snippets run the exact version');
});

test('the standard entry and every command people are told to run use npx\'s --prefix / and the exact version', () => {
  // Without --prefix /, npx resolves the package from the folder the AI app starts it in (the open project's
  // node_modules and .npmrc) before it asks npm, so a cloned project could run its own @wisply/mcp with the token.
  assert.deepEqual([...NPX_FLAGS], ['-y', '--prefix', '/']);
  assert.equal(NPX_COMMAND, `npx -y --prefix / ${PACKAGE_SPEC}`);
  assert.deepEqual(JSON.parse(JSON.stringify(STANDARD_ENTRY)), { command: 'npx', args: ['-y', '--prefix', '/', PACKAGE_SPEC] });

  const escaped = PACKAGE_NAME.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  // Any npx run or global install of the package, in prose or in a JSON args array.
  const npx = new RegExp(`\\bnpx((?: +-[\\w-]+(?: +/(?= ))?)*) +(${escaped}[^\\s\`"'),]*)`, 'g');
  const args = new RegExp(`"args": \\[([^\\]]*)"(${escaped}[^"]*)"`, 'g');
  const install = new RegExp(`\\bnpm (?:i|install) -g +(${escaped}[^\\s\`"'),]*)`, 'g');
  for (const file of ['README.md', 'SECURITY.md', 'CHANGELOG.md', 'docs/design-differences.md']) {
    const text = readFileSync(join(ROOT, file), 'utf8');
    let seen = 0;
    for (const match of text.matchAll(npx)) {
      seen += 1;
      // Gemini CLI's `gemini mcp add ... npx -- -y ...` puts dash arguments after `--` (the design's S1).
      assert.ok(['-y --prefix /', '-- -y --prefix /'].includes(match[1].trim()), `${file}: ${match[0]}`);
      // `@wisply/mcp@<version>` is how the docs write "this release's version" in general.
      assert.ok([PACKAGE_SPEC, `${PACKAGE_NAME}@<version>`].includes(match[2]), `${file}: ${match[0]}`);
    }
    for (const match of text.matchAll(args)) {
      assert.equal(match[1], '"-y", "--prefix", "/", ', `${file}: ${match[0]}`);
      assert.equal(match[2], PACKAGE_SPEC, `${file}: ${match[0]}`);
    }
    for (const match of text.matchAll(install)) assert.equal(match[1], PACKAGE_SPEC, `${file}: ${match[0]}`);
    assert.doesNotMatch(text, new RegExp(`npx -y ${escaped}`), `${file}: npx without --prefix /`);
    if (file === 'README.md') assert.ok(seen > 0);
  }

  // In messages.mjs, npx reaches a text only through NPX_COMMAND (npx's flags and the pinned spec).
  const source = readFileSync(join(ROOT, 'lib/messages.mjs'), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/^import .*$/gm, '');
  assert.match(code, /export const SETUP_COMMAND = `\$\{NPX_COMMAND\} setup`;/);
  assert.doesNotMatch(code, /\$\{(PACKAGE_SPEC|PACKAGE_NAME|PACKAGE_RANGE)\}|\bnpx\b/);
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
