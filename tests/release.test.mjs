// The release gate (DIST-M5): `WISPLY_RELEASE=1 npm test` passes only on the
// tree to publish. Alex runs it before the first, hand-made publish; the
// release workflow runs it before it stages every later version. This file
// checks the release change itself (tests/helpers/release.mjs); the contract
// is tests/vendor.test.mjs's, the recorded checks, the npm name and "private"
// are tests/release-checks.test.mjs's, and "published" is
// tests/clients.test.mjs's.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { clientsFile } from '../lib/clients.mjs';
import { VERSION } from '../lib/constants.mjs';
import { isDate, releaseProblems, topSection } from './helpers/release.mjs';
import { readJson, readText, ROOT } from './helpers/repo.mjs';

const tree = (env = process.env) => ({
  version: VERSION,
  pkg: readJson('package.json'),
  clients: clientsFile,
  changelog: readText('CHANGELOG.md'),
  env,
});

test('the CHANGELOG opens with this version ("Unreleased" until the release change dates it)', () => {
  const section = topSection(readText('CHANGELOG.md'));
  assert.equal('problem' in section ? section.problem : null, null);
  assert.equal(section.version, VERSION, 'a version bump opens its CHANGELOG section');
  assert.ok(section.date === 'Unreleased' || isDate(section.date), section.date);
});

test('this tree is the one to release (WISPLY_RELEASE=1)', { skip: process.env.WISPLY_RELEASE === '1' ? false : 'WISPLY_RELEASE is not 1' }, () => {
  const problems = releaseProblems(tree());
  assert.deepEqual(problems, [], `not releasable:\n- ${problems.join('\n- ')}`);
});

test('the release gate fails on this tree exactly while it isn\'t releasable, and says why', { skip: process.env.WISPLY_RELEASE === '1' }, () => {
  // Outside a release run, so GitHub's variables (a branch build in ci.yml) don't count here or in the child.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GITHUB_')));
  delete env.NODE_TEST_CONTEXT;
  const problems = releaseProblems(tree({}));
  const result = spawnSync(process.execPath, ['--test', fileURLToPath(import.meta.url)],
    { cwd: ROOT, env: { ...env, WISPLY_RELEASE: '1' }, encoding: 'utf8' });
  assert.equal(result.status === 0, problems.length === 0, result.stdout.slice(-3000));
  for (const problem of problems) assert.ok(result.stdout.includes(problem.slice(0, 60)), `the failure names: ${problem}`);
});

test('releaseProblems: a releasable tree passes, and each missing step is named', () => {
  const good = {
    version: '1.2.3',
    pkg: { version: '1.2.3' },
    clients: { package_spec: '@wisply/mcp@1.2.3' },
    changelog: '# Changelog\n\nIntro.\n\n## 1.2.3 - 2026-11-02\n\n- The release gate refuses a provisional contract.\n\n' +
      '## 1.2.2 - 2026-10-30\n\n- The contract is provisional.\n',
    env: {},
  };
  assert.deepEqual(releaseProblems(good), []);
  assert.deepEqual(releaseProblems({ ...good, env: { GITHUB_ACTIONS: 'true', GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v1.2.3' } }), []);

  const changelog = (heading, body = '- Things.') => `# Changelog\n\n${heading}\n\n${body}\n`;
  const cases = [
    [{ pkg: { version: '1.2.4' } }, /package\.json is 1\.2\.4/],
    [{ clients: { package_spec: '@wisply/mcp@1.2.2' } }, /package_spec is @wisply\/mcp@1\.2\.2/],
    [{ changelog: changelog('## 1.2.3 - Unreleased') }, /give "## 1\.2\.3" its release date/],
    [{ changelog: changelog('## 1.2.3 - 2026-02-30') }, /first section must be|release date/],
    [{ changelog: changelog('## 1.2.2 - 2026-10-30') }, /first section is 1\.2\.2, not 1\.2\.3/],
    [{ changelog: changelog('## Unreleased') }, /the first section must be/],
    [{ changelog: '# Changelog\n\nNothing yet.\n' }, /no version section/],
    [{ changelog: changelog('## 1.2.3 - 2026-11-02', '- The contract is provisional.') }, /still says the contract is provisional/],
    [{ changelog: changelog('## 1.2.3 - 2026-11-02', '- SOURCE.json says `"on_main": false`.') }, /isn't from wisply-ai's main/],
    [{ env: { GITHUB_ACTIONS: 'true', GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v1.2.4' } }, /must run for tag v1\.2\.3, not tag v1\.2\.4/],
    [{ env: { GITHUB_ACTIONS: 'true', GITHUB_REF_TYPE: 'branch', GITHUB_REF_NAME: 'main' } }, /must run for tag v1\.2\.3, not branch main/],
  ];
  for (const [change, expected] of cases) {
    const problems = releaseProblems({ ...good, ...change });
    assert.equal(problems.length, 1, `${JSON.stringify(change)}: ${problems.join(' | ')}`);
    assert.match(problems[0], expected);
  }
  assert.equal(isDate('2026-02-28'), true);
  assert.equal(isDate('2026-02-29'), false);
  assert.equal(isDate('2026-13-01'), false);
});
