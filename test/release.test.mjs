// scripts/release-gate.mjs: vsce and ovsx run it (vscode:prepublish) before
// they package or publish. It refuses this tree until the vendored connector
// and the skill come from fal3/wisply-mcp main (checked against GitHub's
// main) with a final contract, every placeholder is final and README.md is
// the store README with nothing left to fill in. It can't be turned into a
// warning. scripts/package-dev.mjs builds the development package, which no
// store takes as this extension.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DRAFT_MARKERS, FINAL, MCP_REMOTE, checkedAgainstGitHub, draftMarkers, placeholders, releaseProblems,
} from '../scripts/release-gate.mjs';
import { DEV_DISPLAY_SUFFIX, DEV_PACKAGE_FILE, DEV_SUFFIX, devManifest, packageDev } from '../scripts/package-dev.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const GATE = join(ROOT, 'scripts/release-gate.mjs');
const source = JSON.parse(readFileSync(join(ROOT, 'vendor/SOURCE.json'), 'utf8'));
const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const ALL_FINAL = Object.freeze({ publisher: true, setupGuide: true, repositories: true, support: true });
const STORE_README = '# Wisply for VS Code\n\nUse your Wisply meeting notes in your editor\'s AI chat.\n';
const MAIN_TIP = 'a'.repeat(40);
const FROM_GITHUB_MAIN = Object.freeze({ ref: 'main', remote: MCP_REMOTE, remote_main: MAIN_TIP });

const withMcp = (base, change) => ({
  ...base,
  sources: base.sources.map((entry) => (entry.repository === 'github:fal3/wisply-mcp' ? change(entry) : entry)),
});
const releasable = () => withMcp({ ...source, provisional: false, skill: { ...source.skill, ...FROM_GITHUB_MAIN } },
  (entry) => ({ ...entry, ...FROM_GITHUB_MAIN, contract_provisional: false }));
const ready = (overrides = {}) => releaseProblems({ source: releasable(), final: ALL_FINAL, readme: STORE_README, ...overrides });

test('this tree is not releasable: provisional, connector and skill not from main, every placeholder, unfilled README', () => {
  const problems = releaseProblems({ source, readme });
  assert.equal(problems.length, 8, problems.join('\n'));
  assert.match(problems[0], /provisional/);
  assert.match(problems[1], /^The connector .*not main/);
  assert.match(problems[2], /^The skill .*not main/);
  assert.match(problems[3], /publisher/);
  assert.match(problems[4], /setup guide/);
  assert.match(problems[5], /fal3\/wisply-vscode and github\.com\/fal3\/wisply-mcp/);
  assert.match(problems[6], /support page and mailbox/);
  assert.equal(problems[7], 'README.md still has {READ_MIN}, {RECORDING_MIN}: fill them in from App Store Connect.');
  assert.deepEqual({ ...FINAL }, { publisher: false, setupGuide: false, repositories: false, support: false });
});

test('each check on its own', () => {
  assert.deepEqual(ready(), []);
  assert.equal(ready({ source: withMcp(releasable(), (entry) => ({ ...entry, ref: 'claude/distribution-3' })) }).length, 1);
  const noRef = withMcp(releasable(), (entry) => {
    const { ref: _ref, ...rest } = entry;
    return rest;
  });
  assert.match(ready({ source: noRef })[0], /an unnamed ref/);
  assert.equal(ready({ source: { ...releasable(), provisional: true } }).length, 1);
  for (const key of Object.keys(ALL_FINAL)) {
    assert.equal(ready({ final: { ...ALL_FINAL, [key]: false } }).length, 1, key);
  }
  assert.match(ready({ source: { ...releasable(), sources: [] } })[0], /no github:fal3\/wisply-mcp source/);
  assert.match(ready({ source: { ...releasable(), skill: { ...releasable().skill, ref: 'claude/distribution-4' } } })[0],
    /^The skill was vendored from claude\/distribution-4, not main/);
  const { skill: _skill, ...noSkill } = releasable();
  assert.match(ready({ source: noSkill })[0], /has no skill/);
  assert.match(ready({ source: { ...releasable(), skill: { ...releasable().skill, repository: 'github:someone/else' } } })[0],
    /has no skill from github:fal3\/wisply-mcp/);
});

test('the store README can\'t keep a {PLACEHOLDER}', () => {
  assert.deepEqual(ready({ readme: `${STORE_README}Wisply 3.4 or later; {"json": 1}; \${x}\n` }), []);
  assert.equal(ready({ readme: `${STORE_README}Wisply {READ_MIN} or later\n` }).length, 1);
  assert.deepEqual(placeholders('{A} {B_2} {A} {lower} {} {"k": 1}'), ['{A}', '{B_2}']);
  assert.deepEqual(placeholders(readme), ['{READ_MIN}', '{RECORDING_MIN}']);
});

test('"main" counts only as checked against GitHub\'s main (sync-vendor records the remote and its tip)', () => {
  const localMain = withMcp(releasable(), (entry) => {
    const { remote: _remote, remote_main: _tip, ...rest } = entry;
    return rest;
  });
  assert.match(ready({ source: localMain })[0], /wasn't checked against https:\/\/github\.com\/fal3\/wisply-mcp/);
  assert.equal(ready({ source: withMcp(releasable(), (entry) => ({ ...entry, remote: 'https://github.com/someone/fork' })) }).length, 1);
  assert.equal(ready({ source: withMcp(releasable(), (entry) => ({ ...entry, remote_main: 'main' })) }).length, 1);
  // The skill is held to the same rule.
  const { remote: _remote, remote_main: _tip, ...localSkill } = releasable().skill;
  assert.match(ready({ source: { ...releasable(), skill: localSkill } })[0], /^The skill's main wasn't checked against/);
  assert.equal(ready({ source: { ...releasable(), skill: { ...releasable().skill, remote_main: 'main' } } }).length, 1);
  assert.equal(checkedAgainstGitHub({ remote: MCP_REMOTE, remote_main: MAIN_TIP }), true);
  assert.equal(checkedAgainstGitHub(undefined), false);
  assert.equal(MCP_REMOTE, 'https://github.com/fal3/wisply-mcp');
});

test('the store page can\'t be a draft', () => {
  assert.deepEqual(draftMarkers(STORE_README), []);
  for (const draft of ['> **Not published yet.**', 'an interim snapshot', 'This holds DIST-V1.', 'from claude/distribution-3']) {
    assert.equal(draftMarkers(`${STORE_README}${draft}\n`).length, 1, draft);
    assert.equal(ready({ readme: `${STORE_README}${draft}\n` }).length, 1, draft);
  }
  assert.ok(DRAFT_MARKERS.length >= 4);
  // This README is the store README: no draft text, only the two versions to fill in.
  assert.deepEqual(draftMarkers(readme), []);
});

test('as vscode:prepublish: refuses, and there is no environment variable that turns it into a warning', () => {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME ?? '/tmp' };
  for (const extra of [{}, { WISPLY_DEV_PACKAGE: '1' }, { WISPLY_RELEASE: '0' }]) {
    const refused = spawnSync(process.execPath, [GATE], { env: { ...env, ...extra }, encoding: 'utf8' });
    assert.equal(refused.status, 1, JSON.stringify(extra));
    assert.match(refused.stderr, /^Not releasable:\n/);
    assert.match(refused.stderr, /npm run package instead \(wisply-dev\.vsix\)/);
  }
  assert.equal(readFileSync(GATE, 'utf8').includes('process.env'), false, 'the gate reads no environment');
});

test('the development manifest is another extension with a prerelease version and no scripts', () => {
  const dev = devManifest(manifest);
  assert.equal(dev.name, 'wisply-dev');
  assert.equal(dev.displayName, 'Wisply (development build)');
  assert.equal(dev.version, `${manifest.version}-dev`);
  assert.equal(dev.publisher, manifest.publisher);
  assert.equal(dev.scripts, undefined, 'no vscode:prepublish runs in the copy, so the gate keeps no bypass');
  assert.equal(dev.devDependencies, undefined);
  assert.deepEqual(dev.contributes, manifest.contributes);
  assert.equal(DEV_SUFFIX, '-dev');
  assert.equal(DEV_DISPLAY_SUFFIX, ' (development build)');
  assert.equal(DEV_PACKAGE_FILE, 'wisply-dev.vsix');
});

test('the development .vsix can\'t be published as this extension: vsce refuses it before any network call', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'wisply-dev-vsix-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const out = join(dir, 'dev.vsix');
  let logged = '';
  await packageDev({ out, build: false, log: (text) => { logged += text; } });
  assert.match(logged, /^Development package \(wisply\.wisply-dev\), not releasable:\n/);

  const { readVSIXPackage } = createRequire(import.meta.url)('@vscode/vsce/out/zip.js');
  const vsix = await readVSIXPackage(out);
  assert.equal(vsix.manifest.name, 'wisply-dev');
  assert.equal(vsix.manifest.version, '0.1.0-dev');
  assert.equal(vsix.manifest.displayName, 'Wisply (development build)');
  assert.equal(vsix.manifest.scripts, undefined);
  const identity = vsix.xmlManifest.PackageManifest.Metadata[0].Identity[0].$;
  assert.deepEqual({ id: identity.Id, version: identity.Version, publisher: identity.Publisher },
    { id: 'wisply-dev', version: '0.1.0-dev', publisher: manifest.publisher });
  assert.notEqual(`${identity.Publisher}.${identity.Id}`, `${manifest.publisher}.${manifest.name}`);

  // vsce publish --packagePath validates the manifest before it asks for any credential.
  const vsce = join(ROOT, 'node_modules/@vscode/vsce/vsce');
  const publish = spawnSync(process.execPath, [vsce, 'publish', '--packagePath', out, '-p', 'not-a-token'], {
    cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dir },
  });
  assert.notEqual(publish.status, 0);
  assert.match(publish.stderr + publish.stdout, /doesn't support prerelease versions: '0\.1\.0-dev'/);
});
