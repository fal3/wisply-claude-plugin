// Drift checks against the upstream checkouts. They run only when
// WISPLY_PLUGIN_DIR (wisply-claude-plugin) and WISPLY_AI_DIR (wisply-ai)
// point at local checkouts, as in the agent containers:
//
//   WISPLY_AI_DIR=/home/user/wisply-ai WISPLY_PLUGIN_DIR=/home/user/wisply-claude-plugin npm test
//
// The vendored contract is wisply-ai's Docs/mcp-contract.json at the commit
// contract/SOURCE.json records, byte for byte. That commit may be on an
// unmerged branch (DIST-M5 vendored it from DIST-A1 before DIST-A1 merged):
// SOURCE.json's "on_main" says so, a test here checks the claim against the
// checkout's origin/main, and WISPLY_RELEASE=1 refuses "on_main": false
// (tests/vendor.test.mjs).
//
// "on_main" and the sha256 values are what the tree says about itself, so
// the maintainer's release check can't take them on trust: with
// WISPLY_RELEASE=1 outside GitHub Actions, both checkouts are required (a
// missing one fails, it isn't skipped), each must have github.com/fal3/<repo>
// as its origin and an origin/main, and each recorded commit must be on that
// origin/main ("on_main": true checked, the plugin commit too). The release
// workflow can't check out the private wisply-ai, so there these checks
// skip and "on_main" is the reviewed tree's claim (SECURITY.md, "Release
// controls").
//
// The checkout's contract must be the vendored one. When WISPLY_AI_DIR is an
// unmerged branch (a lane's worktree), a difference that only the branch's own
// commits bring is listed and the test is skipped: it reaches this repository
// through a re-vendor once it is on main. A difference main already has fails,
// on any checkout.
//
// While SOURCE.json is provisional (a fixture transcribed by hand), the
// contract is checked against the Swift source it was transcribed from
// instead; those tests skip once it isn't.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import contract, { contractProblems } from '../lib/contract.mjs';
import { MAX_RESPONSE_BYTES, PROTOCOL_VERSIONS } from '../lib/constants.mjs';
import { MAIN_REF, originMatches, originOf } from '../scripts/sync-vendor.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SOURCE = JSON.parse(readFileSync(join(ROOT, 'contract/SOURCE.json'), 'utf8'));
const PLUGIN_DIR = process.env.WISPLY_PLUGIN_DIR;
const APP_DIR = process.env.WISPLY_AI_DIR;
const RELEASE = process.env.WISPLY_RELEASE === '1';
/** The release workflow: the one place the release check runs without the private wisply-ai checked out. */
const IN_RELEASE_WORKFLOW = process.env.GITHUB_ACTIONS === 'true';
const sourceFor = (repository) => SOURCE.sources.find((source) => source.repository === repository);
const local = (path) => readFileSync(join(ROOT, path));
/** git's stdout, or null when git fails (or exits 1, as `merge-base --is-ancestor` does for "no"). */
const git = (dir, args, input) => {
  try {
    return execFileSync('git', ['-C', dir, ...args], {
      input, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    return null;
  }
};
const gitShow = (dir, commit, path) => git(dir, ['show', `${commit}:${path}`]);
const gitLine = (dir, args, input) => git(dir, args, input)?.toString('utf8').trim() || null;

/**
 * Where a wisply-ai checkout left main, when its HEAD is a commit main doesn't have (an unmerged branch):
 * { base, ref, branch }. null when HEAD is on main, or when git can't tell (no main ref), so every drift counts.
 * @param {string} dir
 */
function unmergedBranch(dir) {
  const head = gitLine(dir, ['rev-parse', '--verify', '-q', 'HEAD^{commit}']);
  const ref = ['refs/remotes/origin/main', 'refs/heads/main']
    .find((name) => gitLine(dir, ['rev-parse', '--verify', '-q', `${name}^{commit}`]));
  if (!head || !ref || git(dir, ['merge-base', '--is-ancestor', head, ref]) !== null) return null;
  const base = gitLine(dir, ['merge-base', head, ref]);
  if (!base) return null;
  return {
    base,
    ref: ref.replace(/^refs\/(?:remotes\/|heads\/)/, ''),
    branch: gitLine(dir, ['symbolic-ref', '-q', '--short', 'HEAD']) ?? `detached HEAD ${head.slice(0, 7)}`,
  };
}

test('plugin: vendored files equal the checkout and the recorded commit', { skip: PLUGIN_DIR ? false : 'WISPLY_PLUGIN_DIR not set' }, async () => {
  const source = sourceFor('github:fal3/wisply-claude-plugin');
  for (const [path, entry] of Object.entries(source.files)) {
    assert.ok(local(path).equals(readFileSync(join(PLUGIN_DIR, entry.upstream))), `${path} differs from the plugin checkout: run npm run sync-vendor`);
    const atCommit = gitShow(PLUGIN_DIR, source.commit, entry.upstream);
    if (atCommit) assert.ok(local(path).equals(atCommit), `${path} differs from ${source.commit}`);
  }
  // The plugin's read-only bridge and this connector agree on what a connector token reaches.
  const shared = await import(pathToFileURL(join(PLUGIN_DIR, 'lib/shared.mjs')).href);
  assert.deepEqual([...shared.READ_ONLY_TOOLS], [...contract.scopes.connector.tools]);
  assert.deepEqual([...shared.PROTOCOL_VERSIONS], [...PROTOCOL_VERSIONS]);
  assert.equal(shared.MAX_RESPONSE_BYTES, MAX_RESPONSE_BYTES);
});

const appSource = sourceFor('github:fal3/wisply-ai');
const APP_CONTRACT = 'Docs/mcp-contract.json';
const APP_BRANCH = APP_DIR ? unmergedBranch(APP_DIR) : null;
/** A file in the WISPLY_AI_DIR checkout, or null. */
const readCheckout = (path) => {
  try {
    return readFileSync(join(APP_DIR, path), 'utf8');
  } catch {
    return null;
  }
};
/** A file in wisply-ai at `commit`, or null. */
const readAt = (commit) => (path) => gitShow(APP_DIR, commit, path)?.toString('utf8') ?? null;

/**
 * Fails with what `check` finds wrong in the checkout, unless the checkout is an unmerged branch and none of it
 * is at the commit where the branch left main: then it all comes from the branch's own commits, which reach the
 * fixture through the re-vendor once they are on main, so the test lists it and is skipped.
 * @param {Pick<import('node:test').TestContext, 'diagnostic' | 'skip'>} t
 * @param {(read: (path: string) => string | null) => string[]} check
 * @param {string} advice
 * @param {{ read?: (path: string) => string | null, branch?: ReturnType<typeof unmergedBranch>,
 *   readBase?: (commit: string) => (path: string) => string | null }} [checkout] the WISPLY_AI_DIR checkout by default
 */
function failOnDriftFromMain(t, check, advice, { read = readCheckout, branch = APP_BRANCH, readBase = readAt } = {}) {
  const differences = check(read);
  if (differences.length === 0) return;
  if (branch && check(readBase(branch.base)).length === 0) {
    for (const difference of differences) t.diagnostic(difference);
    t.skip(`${differences.length} difference(s), all from ${branch.branch}'s commits, which aren't on ` +
      `${branch.ref} (it left ${branch.ref} at ${branch.base.slice(0, 7)}): once they are, ${advice}`);
    return;
  }
  assert.fail(`${differences.join('; ')}: ${advice}`);
}

const vendoredSkip = () => (!APP_DIR ? 'WISPLY_AI_DIR not set'
  : appSource.provisional ? 'provisional contract (checked against the Swift source below)' : false);
const VENDORED_AT = appSource.provisional ? null : appSource.commit.slice(0, 7);

test('app: the vendored contract is Docs/mcp-contract.json at the commit contract/SOURCE.json records', { skip: vendoredSkip() }, () => {
  const atCommit = gitShow(APP_DIR, appSource.commit, APP_CONTRACT);
  assert.ok(atCommit, `${APP_CONTRACT} at ${VENDORED_AT}: not in the WISPLY_AI_DIR checkout (fetch that commit, or the ` +
    'branch it is on)');
  assert.ok(local('contract/mcp-contract.json').equals(atCommit),
    `contract/mcp-contract.json differs from ${APP_CONTRACT} at ${VENDORED_AT}: run npm run sync-vendor`);
});

/**
 * How the contract file read through `read` differs from the vendored one: [] when it is the same, or when there
 * is none (wisply-ai's main before raycast PR 1 and DIST-A1).
 * @param {(path: string) => string | null} read
 */
function vendoredDrift(read) {
  const text = read(APP_CONTRACT);
  if (text === null || text === local('contract/mcp-contract.json').toString('utf8')) return [];
  return [`${APP_CONTRACT} isn't the vendored contract (wisply-ai ${VENDORED_AT ?? appSource.commit})`];
}

test('app: the checkout\'s Docs/mcp-contract.json is the vendored contract', { skip: vendoredSkip() }, (t) => {
  failOnDriftFromMain(t, vendoredDrift, 're-vendor from its commit on main (npm run sync-vendor)');
});

test('app: "on_main" in contract/SOURCE.json says whether wisply-ai\'s origin/main has the vendored commit', { skip: vendoredSkip() }, (t) => {
  if (!gitLine(APP_DIR, ['rev-parse', '--verify', '-q', `${MAIN_REF}^{commit}`])) {
    t.skip('no origin/main in the WISPLY_AI_DIR checkout');
    return;
  }
  const onMain = git(APP_DIR, ['merge-base', '--is-ancestor', appSource.commit, MAIN_REF]) !== null;
  if (appSource.on_main === true) {
    assert.ok(onMain, `contract/SOURCE.json says "on_main": true, but origin/main doesn't have ${VENDORED_AT}: fetch ` +
      'wisply-ai, or re-vendor from its main');
  } else if (onMain) {
    t.todo(`origin/main has ${VENDORED_AT} now: run npm run sync-vendor again so contract/SOURCE.json says "on_main": true`);
  } else {
    t.todo(`${VENDORED_AT} isn't on origin/main yet ("on_main": false, vendored from an unmerged branch): once it is ` +
      'merged, run npm run sync-vendor again from the main commit. WISPLY_RELEASE=1 refuses the contract until then.');
  }
});

// --- The maintainer's release check against real checkouts --------------------

/**
 * What the maintainer's release check (WISPLY_RELEASE=1 outside GitHub Actions) finds wrong with the vendored
 * sources, judged against real checkouts; [] when nothing is. A checkout: the variable that names it, the
 * repository, commit, "provisional" and "on_main" contract/SOURCE.json records, and what git says there (its origin
 * URL, whether it has an origin/main, and whether that has the commit). The bytes are the tests above (they run
 * whenever the variables are set); a provisional source and "on_main": false are tests/vendor.test.mjs's to refuse,
 * so neither is named twice.
 * @param {{ variable: string, dir?: string, repository: string, commit: string, provisional?: boolean,
 *   claimsOnMain?: boolean, origin?: string | null, hasMain?: boolean, onMain?: boolean }[]} checkouts
 * @returns {string[]}
 */
function releaseSourceProblems(checkouts) {
  const problems = [];
  for (const checkout of checkouts) {
    const where = checkout.repository.replace(/^github:/, 'github.com/');
    if (checkout.provisional) continue;
    if (!checkout.dir) {
      problems.push(`${checkout.variable} isn't set: the release check compares the vendored files and the recorded ` +
        `commit with a checkout of ${where} (git fetch origin main there first): ${checkout.variable}=<checkout> ` +
        'WISPLY_RELEASE=1 npm test');
    } else if (!originMatches(checkout.origin, checkout.repository)) {
      problems.push(`${checkout.variable}: the checkout's origin isn't ${where} (git remote get-url origin), so its ` +
        'origin/main says nothing about that repository');
    } else if (!checkout.hasMain) {
      problems.push(`${checkout.variable}: the checkout has no origin/main: git fetch origin main`);
    } else if (!checkout.onMain && checkout.claimsOnMain !== false) {
      const short = String(checkout.commit).slice(0, 7);
      problems.push(checkout.claimsOnMain === true
        ? `contract/SOURCE.json says "on_main": true, but origin/main in ${checkout.variable} doesn't have ${short}: ` +
          'git fetch origin main there, or re-vendor from a main commit (npm run sync-vendor)'
        : `${where} ${short} (contract/SOURCE.json) isn't on origin/main in ${checkout.variable}: git fetch origin ` +
          'main there, or re-vendor from a main commit (npm run sync-vendor)');
    }
  }
  return problems;
}

/** What git says about a checkout, for releaseSourceProblems. */
function checkoutFacts(variable, dir, source) {
  const facts = { variable, dir, repository: source.repository, commit: source.commit, provisional: source.provisional,
    claimsOnMain: source.on_main };
  if (!dir) return facts;
  return {
    ...facts,
    origin: originOf(dir),
    hasMain: gitLine(dir, ['rev-parse', '--verify', '-q', `${MAIN_REF}^{commit}`]) !== null,
    onMain: /^[0-9a-f]{40}$/.test(source.commit) && git(dir, ['merge-base', '--is-ancestor', source.commit, MAIN_REF]) !== null,
  };
}

const RELEASE_SOURCES_TEST = 'the release check compares the vendored sources with real checkouts of wisply-ai and the plugin';

test(`${RELEASE_SOURCES_TEST} (WISPLY_RELEASE=1)`, {
  skip: !RELEASE ? 'WISPLY_RELEASE is not 1'
    : IN_RELEASE_WORKFLOW ? 'the release workflow can\'t check out the private wisply-ai: the maintainer\'s release ' +
      'check with WISPLY_AI_DIR and WISPLY_PLUGIN_DIR, before the tag, compares the sources (SECURITY.md, "Release controls")'
      : false,
}, () => {
  const problems = releaseSourceProblems([
    checkoutFacts('WISPLY_AI_DIR', APP_DIR, appSource),
    checkoutFacts('WISPLY_PLUGIN_DIR', PLUGIN_DIR, sourceFor('github:fal3/wisply-claude-plugin')),
  ]);
  assert.deepEqual(problems, [], `not releasable:\n- ${problems.join('\n- ')}`);
});

test('releaseSourceProblems: real checkouts on main pass, and each missing piece is named once', () => {
  const app = {
    variable: 'WISPLY_AI_DIR', dir: '/wisply-ai', repository: 'github:fal3/wisply-ai', commit: 'a'.repeat(40), provisional: false,
    claimsOnMain: true, origin: 'https://github.com/fal3/wisply-ai.git', hasMain: true, onMain: true,
  };
  const plugin = { ...app, variable: 'WISPLY_PLUGIN_DIR', dir: '/plugin', repository: 'github:fal3/wisply-claude-plugin',
    commit: 'b'.repeat(40), claimsOnMain: undefined, origin: 'git@github.com:fal3/wisply-claude-plugin.git' };
  assert.deepEqual(releaseSourceProblems([app, plugin]), []);
  const cases = [
    [{ dir: undefined }, /^WISPLY_AI_DIR isn't set: the release check compares/],
    [{ origin: 'https://github.com/someone/wisply-ai.git' }, /^WISPLY_AI_DIR: the checkout's origin isn't github\.com\/fal3\/wisply-ai/],
    [{ origin: null }, /origin isn't github\.com\/fal3\/wisply-ai/],
    [{ hasMain: false, onMain: false }, /^WISPLY_AI_DIR: the checkout has no origin\/main: git fetch origin main$/],
    // A hand-flipped "on_main", or one written from a stale or forged origin/main.
    [{ onMain: false }, /^contract\/SOURCE\.json says "on_main": true, but origin\/main in WISPLY_AI_DIR doesn't have aaaaaaa/],
  ];
  for (const [change, expected] of cases) {
    const problems = releaseSourceProblems([{ ...app, ...change }, plugin]);
    assert.equal(problems.length, 1, `${JSON.stringify(change)}: ${problems.join(' | ')}`);
    assert.match(problems[0], expected);
  }
  // The plugin records no "on_main": its commit must be on its main all the same.
  assert.deepEqual(releaseSourceProblems([app, { ...plugin, onMain: false }]),
    [`github.com/fal3/wisply-claude-plugin bbbbbbb (contract/SOURCE.json) isn't on origin/main in WISPLY_PLUGIN_DIR: git fetch ` +
      'origin main there, or re-vendor from a main commit (npm run sync-vendor)']);
  assert.equal(releaseSourceProblems([app, { ...plugin, dir: '' }]).length, 1);
  // tests/vendor.test.mjs refuses these; named once, there.
  assert.deepEqual(releaseSourceProblems([{ ...app, claimsOnMain: false, onMain: false }, plugin]), []);
  assert.deepEqual(releaseSourceProblems([{ ...app, provisional: true, dir: undefined }, plugin]), []);
});

test('without both checkouts the maintainer\'s release check fails and names them; the release workflow skips it', { skip: RELEASE }, () => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GITHUB_') &&
    !['WISPLY_AI_DIR', 'WISPLY_PLUGIN_DIR', 'NODE_TEST_CONTEXT'].includes(name)));
  const run = (extra) => spawnSync(process.execPath, ['--test', `--test-name-pattern=${RELEASE_SOURCES_TEST}`,
    fileURLToPath(import.meta.url)], { cwd: ROOT, env: { ...env, WISPLY_RELEASE: '1', ...extra }, encoding: 'utf8' });
  const local = run({});
  assert.notEqual(local.status, 0, local.stdout.slice(-2000));
  assert.match(local.stdout, /WISPLY_AI_DIR isn't set/);
  assert.match(local.stdout, /WISPLY_PLUGIN_DIR isn't set/);
  const workflow = run({ GITHUB_ACTIONS: 'true' });
  assert.equal(workflow.status, 0, workflow.stdout.slice(-2000));
  assert.match(workflow.stdout, /# SKIP the release workflow can't check out the private wisply-ai/);
});

const isJSONObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * How wisply-ai's contract differs from the fixture, key by key (and scope by scope, descriptor by descriptor),
 * for the keys wisply-ai's file has.
 * @param {Record<string, unknown>} upstream
 */
function contractDifferences(upstream) {
  const differences = [];
  for (const key of Object.keys(upstream)) {
    if (isDeepStrictEqual(contract[key], upstream[key])) continue;
    const theirs = upstream[key];
    if (key === 'scopes' && isJSONObject(theirs)) {
      for (const scope of new Set([...Object.keys(contract.scopes), ...Object.keys(theirs)])) {
        if (isDeepStrictEqual(contract.scopes[scope], theirs[scope])) continue;
        const what = theirs[scope] === undefined ? 'is missing in wisply-ai'
          : contract.scopes[scope] === undefined ? 'is new in wisply-ai' : 'differs';
        differences.push(`scopes.${scope} ${what}`);
      }
    } else if (key === 'tool_descriptors' && Array.isArray(theirs)) {
      const names = (list) => list.map((descriptor) => descriptor?.name);
      if (!isDeepStrictEqual(names(theirs), names(contract.tool_descriptors))) differences.push('tool_descriptors: names or order');
      for (const descriptor of theirs) {
        const ours = contract.tool_descriptors.find((entry) => entry.name === descriptor?.name);
        if (ours && !isDeepStrictEqual(ours, descriptor)) differences.push(`tool_descriptors: ${descriptor.name}`);
      }
    } else {
      differences.push(key);
    }
  }
  return differences.map((difference) => `${APP_CONTRACT}: ${difference}`);
}

/** What makes the provisional fixture out of date against wisply-ai's contract file, read through `read`. */
function contractDrift(read) {
  const text = read(APP_CONTRACT);
  if (text === null) return [];
  let upstream;
  try {
    upstream = JSON.parse(text);
  } catch {
    return [`${APP_CONTRACT} isn't JSON`];
  }
  if (!isJSONObject(upstream)) return [`${APP_CONTRACT} isn't a JSON object`];
  // With DIST-A1's tool_descriptors and raycast PR 1's keys, the file is the contract itself: re-vendor it.
  const final = Object.hasOwn(upstream, 'tool_descriptors') && contractProblems(upstream).length === 0;
  return [
    ...(final ? [`${APP_CONTRACT} is one the connector can load: re-vendor from its commit (npm run sync-vendor, without --provisional)`] : []),
    ...contractDifferences(upstream),
  ];
}

test('app: once wisply-ai has a contract, the provisional fixture still matches it', {
  skip: !APP_DIR ? 'WISPLY_AI_DIR not set'
    : !appSource.provisional ? 'not provisional'
      : !existsSync(join(APP_DIR, APP_CONTRACT)) ? `no ${APP_CONTRACT} in wisply-ai yet (raycast PR 1)` : false,
}, (t) => {
  let upstream = null;
  try {
    upstream = JSON.parse(readFileSync(join(APP_DIR, APP_CONTRACT), 'utf8'));
  } catch {
    // contractDrift says so.
  }
  if (isJSONObject(upstream) && Object.hasOwn(upstream, 'tool_descriptors') && contractProblems(upstream).length > 0) {
    // DIST-A1 without raycast PR 1: sync-vendor refuses the file (no wspr_ scope), so only its keys are compared.
    t.diagnostic(`${APP_CONTRACT} has tool_descriptors but can't be vendored yet (${contractProblems(upstream).join(', ')}): ` +
      'that takes raycast PR 1 and DIST-A1 on one wisply-ai main commit');
  }
  failOnDriftFromMain(t, contractDrift, 'update the provisional fixture to match, or re-vendor (DIST-M5)');
});

// The client templates are owned here (clients/mcp-clients.json); wisply-ai
// keeps a byte-for-byte copy for the Settings snippets (DIST-A1), pinned to a
// commit of this file (MCPClientSnippetsTests.vendoredClients). A copy of an
// earlier commit is that older version: harmless while it says "published":
// false, because Wisply renders nothing from it, and out of date once it
// says true.
const CLIENTS = 'clients/mcp-clients.json';
const APP_CLIENTS = 'Docs/mcp-clients.json';

/**
 * The commit here that brought clients/mcp-clients.json to `bytes`, and how many other versions of it came after
 * (0: the newest committed one, so only uncommitted changes differ); or null when no commit here has it.
 * @param {Buffer} bytes
 */
function clientsVersionOf(bytes) {
  const blob = gitLine(ROOT, ['hash-object', '--stdin'], bytes);
  const commits = gitLine(ROOT, ['rev-list', '--full-history', 'HEAD', '--', CLIENTS])?.split('\n') ?? [];
  const blobs = commits.map((commit) => gitLine(ROOT, ['rev-parse', '--verify', '-q', `${commit}:${CLIENTS}`]));
  const newest = blob ? blobs.indexOf(blob) : -1;
  if (newest < 0) return null;
  return { commit: commits[blobs.lastIndexOf(blob)], newer: new Set(blobs.slice(0, newest)).size };
}

test('app: Docs/mcp-clients.json is clients/mcp-clients.json as of a commit here, and the current one once published', {
  skip: !APP_DIR ? 'WISPLY_AI_DIR not set'
    : !existsSync(join(APP_DIR, APP_CLIENTS)) ? `no ${APP_CLIENTS} in wisply-ai yet (DIST-A1)` : false,
}, (t) => {
  const copy = readFileSync(join(APP_DIR, APP_CLIENTS));
  if (local(CLIENTS).equals(copy)) return;
  const found = clientsVersionOf(copy);
  assert.ok(found, `${APP_CLIENTS} in wisply-ai isn't ${CLIENTS} as of any commit here: copy this file there byte ` +
    'for byte (DIST-A1), or make the change here first');
  let published;
  try {
    ({ published } = JSON.parse(copy.toString('utf8')));
  } catch {
    // Not JSON: no commit here has such a file, so `found` is null above.
  }
  const at = found.commit.slice(0, 7);
  assert.equal(published, false, `${APP_CLIENTS} in wisply-ai is ${CLIENTS} as of ${at}, and it ` +
    `${published === true ? 'says "published": true' : 'doesn\'t say "published": false'}, so Wisply shows those ` +
    'setups, not the current ones: copy this file there (DIST-A1)');
  const since = found.newer === 0 ? 'changed here since, not committed yet' : `${found.newer} newer version(s) here`;
  t.todo(`${APP_CLIENTS} in wisply-ai is ${CLIENTS} as of ${at} (${since}). Wisply renders nothing from it while it ` +
    'says "published": false; copy this file there and update MCPClientSnippetsTests.vendoredClients before the ' +
    'copy says true (DIST-A1)');
});

// --- The transcription check (provisional only) -----------------------------
//
// A small reader for the switches in MCPToolCatalog.swift: it lexes the Swift
// subset the catalog uses and parses each `switch self { case .a, .b: return
// VALUE ... }` into member -> value, so every descriptor is compared with
// the Swift source as a whole (property set, types, descriptions, bounds,
// enums and `required`), not by searching for fragments. Anything outside
// that subset fails the test, so a new helper in the catalog shows up here.

const CATALOG = 'Wisply/Services/MCP/MCPToolCatalog.swift';
/** The wisply-ai commit the provisional fixture was transcribed from ("885cc75 (transcribed)"), or null. */
const TRANSCRIBED_AT = /^([0-9a-f]{7,40}) \(transcribed\)$/.exec(appSource.commit)?.[1] ?? null;
const transcriptionSkip = () => (!APP_DIR ? 'WISPLY_AI_DIR not set' : !appSource.provisional ? 'not provisional' : false);
/** A Swift source as of the transcription commit; fails when the checkout doesn't have that commit. */
const transcribedSource = (path) => {
  assert.ok(TRANSCRIBED_AT, `contract/SOURCE.json: "${appSource.commit}" doesn't name the transcription commit`);
  const bytes = gitShow(APP_DIR, TRANSCRIBED_AT, path);
  assert.ok(bytes, `${path} at ${TRANSCRIBED_AT}: not in the WISPLY_AI_DIR checkout (fetch wisply-ai's history)`);
  return bytes.toString('utf8');
};
const between = (text, start, end) => {
  const from = text.indexOf(start);
  const to = text.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `${start} ... ${end} not found in ${CATALOG}`);
  return text.slice(from + start.length, to);
};

/** Tokens of the catalog's Swift subset. Comments and whitespace are dropped. */
function lexSwift(text) {
  const pattern = /\s+|\/\/[^\n]*|"((?:[^"\\\n]|\\.)*)"|([A-Za-z_][A-Za-z0-9_]*)|(-?[0-9]+)|([[\](),:.{}])/y;
  const tokens = [];
  while (pattern.lastIndex < text.length) {
    const at = pattern.lastIndex;
    const match = pattern.exec(text);
    assert.ok(match, `${CATALOG}: unexpected Swift: ${JSON.stringify(text.slice(at, at + 40))}`);
    if (match[1] !== undefined) {
      for (const [, escaped] of match[1].matchAll(/\\(.)/g)) {
        assert.ok(escaped === '"' || escaped === '\\', `${CATALOG}: only \\" and \\\\ escapes are read: ${match[1].slice(0, 40)}`);
      }
      tokens.push({ kind: 'string', value: match[1].replace(/\\(["\\])/g, '$1') });
    } else if (match[2] !== undefined) {
      tokens.push({ kind: 'name', value: match[2] });
    } else if (match[3] !== undefined) {
      tokens.push({ kind: 'number', value: Number(match[3]) });
    } else if (match[4] !== undefined) {
      tokens.push({ kind: 'punct', value: match[4] });
    }
  }
  return tokens;
}

/**
 * Parses the first `switch self { ... }` in `text` into Map(member -> value).
 * Values: true/false, a string literal, and the schema helpers:
 * schema(properties:required:), string(_:), integer(_:minimum:maximum:),
 * .object([...]), [k: v] dictionaries and [s, ...] arrays, which become the
 * JSON the helpers build. A bound may also name an integer constant
 * (`MCPLiveTranscript.maxTailWords`), looked up in `constants`
 * (swiftIntegerConstants).
 * @param {string} text
 * @param {Map<string, number>} [constants]
 */
function parseSwitch(text, constants = new Map()) {
  const tokens = lexSwift(text);
  let at = 0;
  const peek = (offset = 0) => tokens[at + offset];
  const is = (kind, value, offset = 0) => peek(offset)?.kind === kind && (value === undefined || peek(offset).value === value);
  const take = (kind, value) => {
    const token = tokens[at];
    assert.ok(token && token.kind === kind && (value === undefined || token.value === value),
      `${CATALOG}: expected ${value ?? kind}, found ${token ? JSON.stringify(token.value) : 'the end'}`);
    at += 1;
    return token.value;
  };
  const list = (close, item) => {
    const items = [];
    while (!is('punct', close)) {
      items.push(item());
      if (!is('punct', close)) take('punct', ',');
    }
    take('punct', close);
    return items;
  };
  const optionalNumber = () => {
    if (is('name', 'nil')) return (take('name', 'nil'), undefined);
    if (is('name') && is('punct', '.', 1) && is('name', undefined, 2)) {
      const key = `${take('name')}.${(take('punct', '.'), take('name'))}`;
      assert.ok(constants.has(key), `${CATALOG}: ${key} isn't an integer constant in Wisply/Services/MCP`);
      return constants.get(key);
    }
    return take('number');
  };

  function literal() {
    // [:] | [k: v, ...] | [s, ...]
    take('punct', '[');
    if (is('punct', ':')) {
      take('punct', ':');
      take('punct', ']');
      return {};
    }
    if (is('string') && is('punct', ':', 1)) {
      return Object.fromEntries(list(']', () => {
        const key = take('string');
        take('punct', ':');
        return [key, value()];
      }));
    }
    return list(']', value);
  }

  function value() {
    if (is('string')) return take('string');
    if (is('name', 'true') || is('name', 'false')) return take('name') === 'true';
    if (is('number')) return take('number');
    if (is('punct', '[')) return literal();
    if (is('punct', '.')) {
      take('punct', '.');
      take('name', 'object');
      take('punct', '(');
      const object = literal();
      take('punct', ')');
      return object;
    }
    const helper = take('name');
    take('punct', '(');
    if (helper === 'string') {
      const description = take('string');
      take('punct', ')');
      return { type: 'string', description };
    }
    if (helper === 'integer') {
      const description = take('string');
      take('punct', ',');
      take('name', 'minimum');
      take('punct', ':');
      const minimum = optionalNumber();
      take('punct', ',');
      take('name', 'maximum');
      take('punct', ':');
      const maximum = optionalNumber();
      take('punct', ')');
      return {
        type: 'integer', description,
        ...(minimum === undefined ? {} : { minimum }),
        ...(maximum === undefined ? {} : { maximum }),
      };
    }
    assert.equal(helper, 'schema', `${CATALOG}: unknown helper ${helper}(...)`);
    take('name', 'properties');
    take('punct', ':');
    const properties = literal();
    let required = [];
    if (is('punct', ',')) {
      take('punct', ',');
      take('name', 'required');
      take('punct', ':');
      required = literal();
    }
    take('punct', ')');
    // schema(properties:required:) adds "required" only when it isn't empty.
    return { type: 'object', properties, additionalProperties: false, ...(required.length > 0 ? { required } : {}) };
  }

  take('name', 'switch');
  take('name', 'self');
  take('punct', '{');
  const values = new Map();
  while (is('name', 'case')) {
    take('name', 'case');
    const members = list(':', () => {
      take('punct', '.');
      return take('name');
    });
    if (is('name', 'return')) take('name', 'return');
    const parsed = value();
    for (const member of members) {
      assert.ok(!values.has(member), `${CATALOG}: .${member} appears twice in one switch`);
      values.set(member, parsed);
    }
  }
  take('punct', '}');
  return values;
}

/**
 * `Type.name` -> value for every `static let name = <integer>` in the given
 * Swift sources, under the nearest enum, struct, class or extension above it.
 * @param {string[]} texts
 */
function swiftIntegerConstants(texts) {
  const constants = new Map();
  for (const text of texts) {
    const pattern = /\b(?:enum|struct|class|extension)\s+(\w+)|\bstatic let (\w+)(?:\s*:\s*\w+)?\s*=\s*(-?[0-9][0-9_]*)\b(?![ \t]*[.\w])/g;
    let type = null;
    for (const match of text.matchAll(pattern)) {
      if (match[1]) type = match[1];
      else if (type) constants.set(`${type}.${match[2]}`, Number(match[3].replaceAll('_', '')));
    }
  }
  return constants;
}

const MCP_FOLDER = 'Wisply/Services/MCP';
/** The integer constants (swiftIntegerConstants) of every Swift file in Wisply/Services/MCP at the transcription commit. */
const transcribedConstants = () => {
  const names = gitLine(APP_DIR, ['ls-tree', '--name-only', `${TRANSCRIBED_AT}:${MCP_FOLDER}`])?.split('\n') ?? [];
  return swiftIntegerConstants(names.filter((name) => name.endsWith('.swift'))
    .map((name) => transcribedSource(`${MCP_FOLDER}/${name}`)));
};

test('app: the provisional descriptors are the Swift catalog\'s at the transcription commit, word for word', {
  skip: transcriptionSkip(),
}, () => {
  // At the recorded commit, not the checkout: a later catalog (raycast PR 1's tail_words) is drift, which the next
  // test reports in so many words, not a reason for this reader to fail.
  const swift = transcribedSource(CATALOG);
  const cases = [...between(swift, 'enum MCPToolName', 'var hasSideEffects').matchAll(/case (\w+) = "([a-z_]+)"/g)]
    .map((match) => ({ member: match[1], name: match[2] }));
  assert.deepEqual(cases.map((entry) => entry.name), [...contract.tools], 'tool names and order');
  const memberOf = new Map(cases.map((entry) => [entry.name, entry.member]));
  const constants = transcribedConstants();
  const switchOf = (start, end) => {
    const values = parseSwitch(between(swift, start, end), constants);
    assert.deepEqual([...values.keys()].sort(), cases.map((entry) => entry.member).sort(), `${start}: every tool exactly once`);
    return values;
  };
  const sideEffects = switchOf('var hasSideEffects: Bool {', 'var isAvailableToConnector: Bool {');
  const connector = switchOf('var isAvailableToConnector: Bool {', 'var returnsTranscriptContent: Bool {');
  const titles = switchOf('var title: String {', 'var description: String {');
  const descriptions = switchOf('var description: String {', 'var inputSchema: JSONValue {');
  const schemas = switchOf('var inputSchema: JSONValue {', '// MARK: - Schema helpers');
  assert.deepEqual(cases.filter((entry) => connector.get(entry.member) === true).map((entry) => entry.name),
    [...contract.scopes.connector.tools], 'connector scope');

  // How `descriptor` and the schema helpers build the JSON the reader assumes.
  const descriptorBody = between(swift, 'var descriptor: JSONValue {', 'var title: String {');
  for (const line of ['"name": .string(rawValue)', '"title": .string(title)', '"description": .string(description)',
    '"inputSchema": inputSchema', '"readOnlyHint": .bool(!hasSideEffects)', '"destructiveHint": .bool(false)',
    '"idempotentHint": .bool(!hasSideEffects)', '"openWorldHint": .bool(false)']) {
    assert.ok(descriptorBody.includes(line), `descriptor: ${line}`);
  }
  const helpers = swift.slice(swift.indexOf('// MARK: - Schema helpers'));
  for (const line of ['"type": "object"', '"properties": .object(properties)', '"additionalProperties": false',
    'if !required.isEmpty', '.object(["type": "string", "description": .string(description)])',
    'var object: [String: JSONValue] = ["type": "integer", "description": .string(description)]',
    'if let minimum { object["minimum"]', 'if let maximum { object["maximum"]']) {
    assert.ok(helpers.includes(line), `schema helpers: ${line}`);
  }

  for (const descriptor of contract.tool_descriptors) {
    const member = memberOf.get(descriptor.name);
    const side = sideEffects.get(member);
    assert.equal(typeof side, 'boolean', `${descriptor.name} side effects`);
    assert.deepEqual(Object.keys(descriptor), ['name', 'title', 'description', 'inputSchema', 'annotations'], descriptor.name);
    assert.equal(descriptor.title, titles.get(member), `${descriptor.name} title`);
    assert.equal(descriptor.description, descriptions.get(member), `${descriptor.name} description`);
    assert.deepEqual(descriptor.inputSchema, schemas.get(member), `${descriptor.name} inputSchema`);
    assert.deepEqual(descriptor.annotations, {
      title: titles.get(member), readOnlyHint: !side, destructiveHint: false, idempotentHint: !side, openWorldHint: false,
    }, `${descriptor.name} annotations`);
  }

  assert.deepEqual(sourceFactProblems(transcribedSource), [], `at ${TRANSCRIBED_AT}`);
});

/**
 * Which of the token prefixes, default port and identity scheme the fixture takes from other Swift files those
 * files no longer say, read through `read` (path -> text, or null).
 */
function sourceFactProblems(read) {
  const problems = [];
  const scopes = read('Wisply/Services/MCP/MCPTokenScope.swift') ?? '';
  if (!scopes.includes('case .full: return "wsp_"') || !scopes.includes('case .connector: return "wspc_"')) {
    problems.push('the token prefixes in MCPTokenScope.swift');
  }
  const port = /static let defaultPort: UInt16 = ([0-9_]+)/.exec(read('Wisply/Services/MCP/MCPServer.swift') ?? '')?.[1];
  if (Number(port?.replaceAll('_', '')) !== contract.default_port) problems.push('the default port in MCPServer.swift');
  const proof = read('Wisply/Services/MCP/MCPIdentityProof.swift') ?? '';
  if (!proof.includes(`static let scheme = "${contract.identity_scheme}"`)) problems.push('the identity scheme in MCPIdentityProof.swift');
  return problems;
}

test('app: the checkout\'s Swift sources still say what the transcription commit said', { skip: transcriptionSkip() }, (t) => {
  // The whole catalog (every descriptor comes from it), and the few facts taken from the other files.
  failOnDriftFromMain(t, (read) => [
    ...(read(CATALOG) === transcribedSource(CATALOG) ? [] : [`${CATALOG} changed since ${TRANSCRIBED_AT}`]),
    ...sourceFactProblems(read).map((problem) => `${problem} changed since ${TRANSCRIBED_AT}`),
  ], 'update the provisional fixture (and the commit in contract/SOURCE.json) or re-vendor from wisply-ai (DIST-M5)');
});

test('drift fails on main, and on a branch that left main with it; drift only a branch brings is listed and skipped', () => {
  const calls = [];
  const t = { diagnostic: (message) => calls.push(['diagnostic', message]), skip: (message) => calls.push(['skip', message]) };
  const check = (read) => (read('catalog') === 'old' ? [] : ['catalog changed']);
  const lane = { base: 'b'.repeat(40), ref: 'origin/main', branch: 'claude/lane' };
  const file = (text) => () => text;

  failOnDriftFromMain(t, check, 'fix it', { read: file('old'), branch: lane, readBase: () => file('new') });
  failOnDriftFromMain(t, check, 'fix it', { read: file('old'), branch: null });
  assert.deepEqual(calls, [], 'no drift: nothing to say');
  assert.throws(() => failOnDriftFromMain(t, check, 'fix it', { read: file('new'), branch: null }),
    { message: 'catalog changed: fix it' }, 'on main (or git can\'t tell)');
  assert.throws(() => failOnDriftFromMain(t, check, 'fix it', { read: file('new'), branch: lane, readBase: () => file('new') }),
    { message: 'catalog changed: fix it' }, 'main already has it');
  assert.deepEqual(calls, []);
  failOnDriftFromMain(t, check, 'fix it', { read: file('new'), branch: lane, readBase: () => file('old') });
  assert.deepEqual(calls, [['diagnostic', 'catalog changed'], ['skip', '1 difference(s), all from claude/lane\'s commits, ' +
    'which aren\'t on origin/main (it left origin/main at bbbbbbb): once they are, fix it']]);

  // The contract comparison names each scope and descriptor, and a loadable file asks for the re-vendor.
  const upstream = structuredClone(contract);
  assert.deepEqual(contractDrift(file(JSON.stringify(upstream))), [
    `${APP_CONTRACT} is one the connector can load: re-vendor from its commit (npm run sync-vendor, without --provisional)`,
  ]);
  delete upstream.scopes.recording;
  upstream.tool_descriptors.find((descriptor) => descriptor.name === 'setup_claude').description += ' Changed.';
  delete upstream.error_codes;
  assert.deepEqual(contractDrift(file(JSON.stringify(upstream))), [
    `${APP_CONTRACT}: scopes.recording is missing in wisply-ai`, `${APP_CONTRACT}: tool_descriptors: setup_claude`,
  ], 'DIST-A1 without raycast PR 1: compared key by key, never re-vendored');
  delete upstream.tool_descriptors;
  assert.deepEqual(contractDrift(file(JSON.stringify(upstream))), [`${APP_CONTRACT}: scopes.recording is missing in wisply-ai`]);
  assert.deepEqual(contractDrift(file(null)), []);
  assert.deepEqual(contractDrift(file('{')), [`${APP_CONTRACT} isn't JSON`]);
  assert.deepEqual(contractDrift(file('null')), [`${APP_CONTRACT} isn't a JSON object`]);

  // The vendored contract: the same bytes, or no file yet, is no drift; anything else is listed on a lane
  // whose base has no contract (main before DIST-A1 merges), and fails where main has another one.
  const vendored = local('contract/mcp-contract.json').toString('utf8');
  assert.deepEqual(vendoredDrift(file(vendored)), []);
  assert.deepEqual(vendoredDrift(file(null)), []);
  assert.equal(vendoredDrift(file(`${vendored} `)).length, 1);
  calls.length = 0;
  failOnDriftFromMain(t, vendoredDrift, 're-vendor', { read: file('{}'), branch: lane, readBase: () => file(null) });
  assert.equal(calls.at(-1)[0], 'skip');
  assert.throws(() => failOnDriftFromMain(t, vendoredDrift, 're-vendor', { read: file('{}'), branch: lane, readBase: () => file('[]') }),
    /isn't the vendored contract/);
  assert.throws(() => failOnDriftFromMain(t, vendoredDrift, 're-vendor', { read: file('{}'), branch: null }), /isn't the vendored contract/);
});

test('the Swift reader parses the catalog\'s shapes and rejects anything else', () => {
  const values = parseSwitch(`switch self {
    case .a, .b: // a comment
        return true
    case .c: return "Say \\"hi\\" \\\\ there"
    case .d:
        return schema(properties: [
            "n": integer("Count (1\u2013100).", minimum: 1, maximum: nil),
            "k": .object([ "type": "string", "enum": ["x", "y"], "description": "Kind." ]),
            "s": string("Text.")
        ], required: ["s"])
    case .e: return schema(properties: [:])
    case .f: return schema(properties: ["t": integer("Tail.", minimum: 1, maximum: Limits.maxTail)])
    }`, swiftIntegerConstants(['nonisolated extension Limits {\n    static let maxTail = 5_000\n    static let other: Int = 7\n}']));
  assert.deepEqual(Object.fromEntries(values), {
    a: true, b: true, c: 'Say "hi" \\ there',
    d: {
      type: 'object', additionalProperties: false, required: ['s'], properties: {
        n: { type: 'integer', description: 'Count (1\u2013100).', minimum: 1 },
        k: { type: 'string', enum: ['x', 'y'], description: 'Kind.' },
        s: { type: 'string', description: 'Text.' },
      },
    },
    e: { type: 'object', additionalProperties: false, properties: {} },
    f: { type: 'object', additionalProperties: false, properties: { t: { type: 'integer', description: 'Tail.', minimum: 1, maximum: 5000 } } },
  });
  assert.deepEqual([...swiftIntegerConstants(['enum A {\n static let x = 1_0\n static let y = 2.5\n}\nstruct B { static let z: Int = 3 }'])],
    [['A.x', 10], ['B.z', 3]]);
  for (const text of [
    'switch self { case .a: return boolean("x") }',
    'switch self { case .a: return schema(properties: [:], extra: 1) }',
    'switch self { case .a: return "x\\n" }',
    'switch self { case .a: return !x }',
    'switch self { case .a: return true case .a: return false }',
    'switch self { case .a: return integer("x", minimum: nil, maximum: Unknown.limit) }',
  ]) {
    assert.throws(() => parseSwitch(text), assert.AssertionError, text);
  }
});
