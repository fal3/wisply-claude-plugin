// The Claude Desktop bundle (MCPB). Always: scripts/build-mcpb.mjs stages a
// self-contained bundle of tracked files only, whose server runs from any
// directory; the stage guard; the release checks (clean checkout at the tag,
// the tag's own files). With the pinned @anthropic-ai/mcpb 2.1.2 (tools/mcpb,
// `npm ci --ignore-scripts --prefix tools/mcpb`, or WISPLY_MCPB_LIB pointing
// to its dist/index.js, as the CI job `mcpb` does), also against the real
// library:
//
// - an empty optional token field reaches the connector as "" (so it falls
//   through to the Keychain item), which needs the manifest's `default: ""`;
//   without it the literal ${user_config.wisply_mcp_token} arrives, and the
//   connector still treats it as unset;
// - the manifest validates, and a pack/unpack round trip gives a bundle that
//   answers tools/list and a tool call through the identity check;
// - verifyBundle (the release gate) accepts a bundle built from the tag and
//   names every file that differs, is missing or was added.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import contract from '../lib/contract.mjs';
import { VERSION } from '../lib/constants.mjs';
import { resolveToken } from '../lib/token.mjs';
import {
  BUNDLE_ICON, BundleSourceError, ICON_PATH, MANIFEST_PATH, SUMS_FILE, STAGED_FILES, assertPacker, assertSafeStageDir, bundleFileName, isBundled, listFiles,
  packBundle, packerLib, refSource, releaseProblems, releaseTag, renderManifest, stageBundle, sumsLine, trackedSource,
  verifyBundle,
} from '../scripts/build-mcpb.mjs';
import { FAKE_TOKENS, startFakeWisply } from './fixtures/fake-wisply.mjs';
import { ROOT, readJson } from './helpers/repo.mjs';

const LIB = packerLib();
const needsLib = { skip: LIB ? false : 'the MCPB packer is not installed (npm ci --ignore-scripts --prefix tools/mcpb; CI job mcpb)' };
const manifest = readJson('mcpb/manifest.json');
const EXTENSION_PATH = '/Users/someone/Library/Application Support/Claude/Claude Extensions/wisply';
const PLACEHOLDER = '${user_config.wisply_mcp_token}';
const syntheticToken = () => `wspc_${'7'.repeat(64)}`;

const tempDir = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'wisply-mcpb-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
  '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** The files a bundle must hold: git's tracked shipped code, contract and license, plus the manifest and the icon. */
function expectedFiles() {
  const tracked = git(ROOT, 'ls-files').split('\n')
    .filter((path) => /^(bin|lib|contract|clients)\/[^/]+\.(mjs|json)$/.test(path) || STAGED_FILES.includes(path));
  return [...tracked, 'icon.png', 'manifest.json'].sort();
}

/**
 * A throwaway git repository holding this checkout's bundle sources, committed and tagged v<VERSION>,
 * plus files to add before the commit. Returns its root.
 */
function tagRepo(t, extra = {}) {
  const root = join(tempDir(t), 'wisply-mcp');
  mkdirSync(root, { recursive: true });
  for (const path of [...trackedSource(ROOT).paths, MANIFEST_PATH, ICON_PATH]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    copyFileSync(join(ROOT, path), join(root, path));
  }
  for (const [path, text] of Object.entries(extra)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  git(root, 'init', '--quiet');
  git(root, 'add', '--all');
  git(root, 'commit', '--quiet', '-m', 'release');
  git(root, 'tag', releaseTag(VERSION));
  return root;
}

/** Runs a bundle's server from an unrelated directory with a bare environment and returns its JSON-RPC answers. */
async function runBundled(bundleDir, { env = {}, lines }) {
  const child = spawn(process.execPath, [join(bundleDir, 'bin/wisply-mcp.mjs')], {
    cwd: tmpdir(),
    env: { PATH: process.env.PATH, HOME: tmpdir(), ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  for (const line of lines) child.stdin.write(`${JSON.stringify(line)}\n`);
  child.stdin.end();
  const [code] = await once(child, 'exit');
  assert.equal(code, 0, stderr);
  return stdout.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

const SESSION = [
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'mcpb-test', version: '1' } } },
  { jsonrpc: '2.0', method: 'notifications/initialized' },
  { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
];

test('build-mcpb stages exactly the shipped code, the contract, LICENSE, the manifest and the icon', (t) => {
  const stageDir = join(tempDir(t), 'mcpb');
  const files = stageBundle({ stageDir, contract, version: VERSION });
  assert.deepEqual(files, expectedFiles());
  assert.ok(files.includes('bin/wisply-mcp.mjs') && files.includes('contract/mcp-contract.mjs'));
  for (const file of files) assert.doesNotMatch(file, /^(tests|scripts|\.github|dist|node_modules)\//, file);
  assert.deepEqual(JSON.parse(readFileSync(join(stageDir, 'manifest.json'), 'utf8')), renderManifest(manifest, { contract, version: VERSION }));
  assert.deepEqual(readFileSync(join(stageDir, 'icon.png')), readFileSync(join(ROOT, 'mcpb/icon.png')));
  assert.equal(bundleFileName(VERSION), `wisply-mcp-${VERSION}.mcpb`);
});

test('build-mcpb refuses to stage into a source folder, the repository or a folder that holds it (it empties the stage first)', (t) => {
  // The guard alone for the real checkout, so a broken guard can never empty it.
  for (const stageDir of [join(ROOT, 'mcpb'), join(ROOT, 'lib'), join(ROOT, 'tests', 'mcpb'), join(ROOT, '..dist'), join(ROOT, 'distx')]) {
    assert.throws(() => assertSafeStageDir(ROOT, stageDir), /under dist\/ or outside the repository/, stageDir);
  }
  for (const stageDir of [ROOT, join(ROOT, '..'), join(ROOT, '..', '..'), '/']) {
    assert.throws(() => assertSafeStageDir(ROOT, stageDir), /must not be the repository or a folder that contains it/, stageDir);
  }
  for (const stageDir of [join(ROOT, 'dist'), join(ROOT, 'dist', 'mcpb'), join(tmpdir(), 'elsewhere', 'mcpb')]) {
    assert.doesNotThrow(() => assertSafeStageDir(ROOT, stageDir), stageDir);
  }
  // stageBundle runs the guard before it removes anything: a checkout at <x>/mcpb/wisply-mcp built with --out-dir <x>.
  const outer = tempDir(t);
  const root = join(outer, 'mcpb', 'wisply-mcp');
  mkdirSync(join(root, 'lib'), { recursive: true });
  writeFileSync(join(root, 'lib', 'keep.mjs'), '');
  assert.throws(() => stageBundle({ root, stageDir: join(outer, 'mcpb'), contract, version: VERSION }), /contains it/);
  assert.ok(existsSync(join(root, 'lib', 'keep.mjs')));
  assert.ok(existsSync(join(ROOT, 'mcpb/manifest.json')) && existsSync(join(ROOT, 'lib/bridge.mjs')));
});

test('only files git tracks reach a bundle: flat .mjs and .json in the staged folders, and LICENSE', (t) => {
  for (const path of ['bin/wisply-mcp.mjs', 'lib/bridge.mjs', 'contract/mcp-contract.json', 'clients/mcp-clients.json', 'LICENSE']) {
    assert.ok(isBundled(path), path);
  }
  for (const path of ['lib/nested/x.mjs', 'lib/notes.md', 'tests/bridge.test.mjs', 'scripts/build-mcpb.mjs', 'README.md', 'libx/a.mjs',
    MANIFEST_PATH, ICON_PATH]) {
    assert.equal(isBundled(path), false, path);
  }
  const root = tagRepo(t);
  writeFileSync(join(root, 'lib', 'untracked.mjs'), 'export const leaked = true;\n');
  const { paths } = trackedSource(root);
  assert.ok(paths.includes('lib/bridge.mjs'));
  assert.equal(paths.includes('lib/untracked.mjs'), false);
  const staged = stageBundle({ root, stageDir: join(dirname(root), 'stage'), contract, version: VERSION });
  assert.equal(staged.includes('lib/untracked.mjs'), false);
});

test('a release build needs a clean checkout at tag v<version>, and stages the tag\'s files', (t) => {
  const root = tagRepo(t);
  assert.deepEqual(releaseProblems(root, VERSION), []);
  assert.deepEqual(releaseProblems(root, '9.9.9'), ['HEAD is not at tag v9.9.9']);
  const committed = readFileSync(join(root, 'lib', 'bridge.mjs'));
  writeFileSync(join(root, 'lib', 'bridge.mjs'), 'export const tampered = true;\n');
  assert.deepEqual(releaseProblems(root, VERSION), ['the checkout has uncommitted or untracked files (git status)']);
  // The tag's objects, not the working tree.
  const atTag = refSource(root, releaseTag(VERSION));
  assert.deepEqual(atTag.read('lib/bridge.mjs'), committed);
  assert.equal(atTag.mode('bin/wisply-mcp.mjs'), 0o755);
  const stageDir = join(dirname(root), 'stage');
  stageBundle({ root, stageDir, contract, version: VERSION, source: atTag });
  assert.deepEqual(readFileSync(join(stageDir, 'lib', 'bridge.mjs')), committed);
  git(root, 'checkout', '--quiet', '--', 'lib/bridge.mjs');
  writeFileSync(join(root, 'stray.txt'), 'x');
  assert.deepEqual(releaseProblems(root, VERSION), ['the checkout has uncommitted or untracked files (git status)']);
  rmSync(join(root, 'stray.txt'));
  git(root, 'commit', '--quiet', '--allow-empty', '-m', 'after the tag');
  assert.deepEqual(releaseProblems(root, VERSION), [`HEAD is not at tag ${releaseTag(VERSION)}`]);
  assert.deepEqual(releaseProblems(join(dirname(root), 'not-a-repo'), VERSION), ['git could not read this checkout']);
});

/** Commits everything in a tagRepo again and moves its release tag there. */
function retag(root) {
  git(root, 'add', '--all');
  git(root, 'commit', '--quiet', '-m', 'retag');
  git(root, 'tag', '--force', releaseTag(VERSION));
}

test('a tracked symlink never reaches a bundle: the working-tree build, the tag build and the gate all stop', async (t) => {
  // readFileSync follows symlinks, so `lib/x.json -> ~/.npmrc` would copy that file's contents into a test
  // bundle; at the tag, git stores the link text as a 120000 blob, which would be staged as a 0644 file.
  const root = tagRepo(t);
  const outside = join(dirname(root), 'outside-secret.json');
  writeFileSync(outside, '{"secret": "not for the bundle"}\n');
  symlinkSync(outside, join(root, 'lib', 'x.json'));
  retag(root);
  assert.ok(isBundled('lib/x.json'));
  assert.match(git(root, 'ls-tree', releaseTag(VERSION), 'lib/x.json'), /^120000 blob /);
  assert.throws(() => trackedSource(root), (error) => error instanceof BundleSourceError && /lib\/x\.json is not a regular file/.test(error.message));
  const stageDir = join(dirname(root), 'stage');
  assert.throws(() => stageBundle({ root, stageDir, contract, version: VERSION }), /lib\/x\.json is not a regular file/);
  assert.equal(existsSync(stageDir), false, 'nothing is staged');
  assert.throws(() => refSource(root, releaseTag(VERSION)), /lib\/x\.json at v[\d.]+ is not a regular file \(mode 120000, blob\)/);
  // The gate names the symlink instead of claiming the tag is missing (refSource runs before the packer).
  assert.deepEqual(await verifyBundle({ file: join(root, 'none.mcpb'), version: VERSION, lib: null, root }),
    [`lib/x.json at ${releaseTag(VERSION)} is not a regular file (mode 120000, blob): the bundle takes regular files only`]);
});

test('a symlinked icon or manifest folder stops the build too', (t) => {
  const iconRoot = tagRepo(t);
  const icon = join(dirname(iconRoot), 'elsewhere.png');
  copyFileSync(join(ROOT, ICON_PATH), icon);
  rmSync(join(iconRoot, ICON_PATH));
  symlinkSync(icon, join(iconRoot, ICON_PATH));
  retag(iconRoot);
  assert.throws(() => refSource(iconRoot, releaseTag(VERSION)).read(ICON_PATH), /mcpb\/icon\.png at v[\d.]+ is not a regular file \(mode 120000/);
  assert.throws(() => stageBundle({ root: iconRoot, stageDir: join(dirname(iconRoot), 'stage'), contract, version: VERSION }),
    /mcpb\/icon\.png is not a regular file/);

  // The whole mcpb/ folder as a symlink: the file inside is regular, but it isn't at its own place.
  const dirRoot = tagRepo(t);
  const moved = join(dirname(dirRoot), 'mcpb-elsewhere');
  cpSync(join(dirRoot, 'mcpb'), moved, { recursive: true });
  rmSync(join(dirRoot, 'mcpb'), { recursive: true });
  symlinkSync(moved, join(dirRoot, 'mcpb'));
  assert.throws(() => stageBundle({ root: dirRoot, stageDir: join(dirname(dirRoot), 'stage'), contract, version: VERSION }),
    /mcpb\/manifest\.json is not a regular file of the checkout/);
});

test('the manifest\'s icon must be icon.png, and no staged path lands outside the stage', (t) => {
  assert.equal(BUNDLE_ICON, 'icon.png');
  assert.equal(manifest.icon, BUNDLE_ICON);
  const root = tagRepo(t);
  const escaped = join(dirname(root), 'escape.png');
  for (const icon of ['../escape.png', '/tmp/escape.png', 'img/icon.png', undefined]) {
    const doc = structuredClone(manifest);
    if (icon === undefined) delete doc.icon;
    else doc.icon = icon;
    writeFileSync(join(root, MANIFEST_PATH), `${JSON.stringify(doc, null, 2)}\n`);
    const stageDir = join(dirname(root), 'stage');
    assert.throws(() => stageBundle({ root, stageDir, contract, version: VERSION }),
      (error) => error instanceof BundleSourceError && /"icon" must be "icon\.png"/.test(error.message), String(icon));
    assert.equal(existsSync(escaped), false, String(icon));
  }
  // A source path that climbs out (git never lists one; the stage refuses it anyway, before emptying anything).
  const real = trackedSource(ROOT);
  const climbing = { ...real, paths: [...real.paths, '../outside.mjs'], read: (path) => (path === '../outside.mjs' ? Buffer.from('x') : real.read(path)), mode: () => 0o644 };
  const stageDir = join(tempDir(t), 'stage');
  mkdirSync(stageDir);
  writeFileSync(join(stageDir, 'keep'), '');
  assert.throws(() => stageBundle({ stageDir, contract, version: VERSION, source: climbing }), /\.\.\/outside\.mjs would be staged outside/);
  assert.ok(existsSync(join(stageDir, 'keep')), 'the stage is untouched');
  assert.equal(existsSync(join(dirname(stageDir), 'outside.mjs')), false);
});

test('release assets: the bundle, an unreleased name no gate accepts, and a SHA256SUMS line shasum -c reads', () => {
  assert.equal(bundleFileName(VERSION), `wisply-mcp-${VERSION}.mcpb`);
  assert.equal(bundleFileName(VERSION, { unreleased: true }), `wisply-mcp-${VERSION}-unreleased.mcpb`);
  assert.equal(SUMS_FILE, 'SHA256SUMS');
  assert.equal(sumsLine('a'.repeat(64), bundleFileName(VERSION)), `${'a'.repeat(64)}  wisply-mcp-${VERSION}.mcpb\n`);
});

test('the packer must be the pinned @anthropic-ai/mcpb 2.1.2', (t) => {
  assert.throws(() => assertPacker(null), /npm ci --ignore-scripts --prefix tools\/mcpb/);
  const fake = join(tempDir(t), 'node_modules', '@anthropic-ai', 'mcpb');
  mkdirSync(join(fake, 'dist'), { recursive: true });
  writeFileSync(join(fake, 'dist', 'index.js'), '');
  writeFileSync(join(fake, 'package.json'), JSON.stringify({ name: '@anthropic-ai/mcpb', version: '2.2.0' }));
  assert.throws(() => assertPacker(join(fake, 'dist', 'index.js')), /isn't @anthropic-ai\/mcpb 2\.1\.2/);
  assert.equal(packerLib({ WISPLY_MCPB_LIB: join(fake, 'dist', 'missing.js') }), null);
});

test('the staged server runs on its own, from another directory, with no package.json', async (t) => {
  const stageDir = join(tempDir(t), 'mcpb');
  stageBundle({ stageDir, contract, version: VERSION });
  assert.equal(existsSync(join(stageDir, 'package.json')), false);
  const [init, list] = await runBundled(stageDir, { lines: SESSION });
  assert.equal(init.result.serverInfo.name, 'wisply');
  assert.deepEqual(list.result.tools.map((tool) => tool.name), contract.scopes.connector.tools);
});

/** getMcpConfigForManifest from the real library, as Claude Desktop runs it at install. */
async function mcpConfig(manifestDoc, userConfig) {
  const { getMcpConfigForManifest } = await import(pathToFileURL(LIB).href);
  return getMcpConfigForManifest({
    manifest: manifestDoc, extensionPath: EXTENSION_PATH, systemDirs: {}, userConfig, pathSeparator: '/',
  });
}

/** resolveToken on macOS with that env, and whether it read the Keychain. */
async function resolveWith(env) {
  let keychainReads = 0;
  const stored = `wspc_${'8'.repeat(64)}`;
  const resolution = await resolveToken({ env, platform: 'darwin', readKeychain: async () => { keychainReads += 1; return stored; } });
  return { resolution, keychainReads, stored };
}

test('mcpb: an empty token field becomes "", and the connector falls through to the Keychain', needsLib, async () => {
  const config = await mcpConfig(manifest, {});
  assert.equal(config.command, 'node');
  assert.deepEqual(config.args, [`${EXTENSION_PATH}/bin/wisply-mcp.mjs`]);
  assert.deepEqual(config.env, { WISPLY_MCP_TOKEN: '' });
  const { resolution, keychainReads, stored } = await resolveWith(config.env);
  assert.equal(keychainReads, 1);
  assert.equal(resolution.token, stored);
  assert.equal(resolution.source, 'keychain');
  assert.equal(resolution.placeholderIgnored, false);
});

test('mcpb: a filled token field reaches the connector, which then never reads the Keychain', needsLib, async () => {
  const token = syntheticToken();
  const config = await mcpConfig(manifest, { wisply_mcp_token: token });
  assert.deepEqual(config.env, { WISPLY_MCP_TOKEN: token });
  const { resolution, keychainReads } = await resolveWith(config.env);
  assert.equal(keychainReads, 0);
  assert.equal(resolution.token, token);
  assert.equal(resolution.source, 'env');
});

test('mcpb: without default: "" the placeholder stays literal, and the connector still ignores it', needsLib, async () => {
  const withoutDefault = structuredClone(manifest);
  delete withoutDefault.user_config.wisply_mcp_token.default;
  const config = await mcpConfig(withoutDefault, {});
  assert.deepEqual(config.env, { WISPLY_MCP_TOKEN: PLACEHOLDER }, 'mcpb 2.1.2 keeps an unknown ${user_config.*} as written');
  const { resolution, keychainReads } = await resolveWith(config.env);
  assert.equal(keychainReads, 1);
  assert.equal(resolution.source, 'keychain');
  assert.equal(resolution.placeholderIgnored, true);
});

test('mcpb: the library validates mcpb/manifest.json (schema and icon)', needsLib, async () => {
  const { validateManifest } = await import(pathToFileURL(LIB).href);
  const lines = [];
  const original = { log: console.log, error: console.error };
  console.log = (...args) => lines.push(args.join(' '));
  console.error = console.log;
  try {
    assert.equal(validateManifest(join(ROOT, 'mcpb/manifest.json')), true, lines.join('\n'));
  } finally {
    Object.assign(console, original);
  }
});

test('mcpb: verifyBundle accepts the tag\'s bundle and names every difference', needsLib, async (t) => {
  const root = tagRepo(t);
  const dir = dirname(root);
  const pack = async (name, source) => {
    const stageDir = join(dir, `stage-${name}`);
    stageBundle({ root, stageDir, contract, version: VERSION, source });
    const file = join(dir, name, bundleFileName(VERSION));
    mkdirSync(dirname(file), { recursive: true });
    await packBundle({ stageDir, outFile: file, lib: LIB });
    return file;
  };
  const atTag = refSource(root, releaseTag(VERSION));
  const good = await pack('good', atTag);
  assert.deepEqual(await verifyBundle({ file: good, version: VERSION, lib: LIB, root }), []);
  const short = await pack('short', { ...atTag, paths: atTag.paths.filter((path) => path !== 'lib/messages.mjs') });
  assert.deepEqual(await verifyBundle({ file: short, version: VERSION, lib: LIB, root }), ['lib/messages.mjs is missing from the bundle']);

  // A working tree with a changed file and an extra tracked one (an --unreleased build): both are named.
  writeFileSync(join(root, 'lib', 'bridge.mjs'), 'export const tampered = true;\n');
  writeFileSync(join(root, 'lib', 'extra.mjs'), 'export {};\n');
  git(root, 'add', 'lib/extra.mjs');
  const bad = await pack('bad', trackedSource(root));
  assert.deepEqual((await verifyBundle({ file: bad, version: VERSION, lib: LIB, root })).sort(), [
    `lib/bridge.mjs differs from ${releaseTag(VERSION)}`,
    `lib/extra.mjs is in the bundle but not at ${releaseTag(VERSION)}`,
  ]);
  assert.deepEqual(await verifyBundle({ file: good, version: '9.9.9', lib: LIB, root }), ['tag v9.9.9 isn\'t in this checkout (git fetch --tags)']);
});

test('mcpb: pack and unpack give a bundle that answers tools/list and a call through the identity check', needsLib, async (t) => {
  const dir = tempDir(t);
  const stageDir = join(dir, 'mcpb');
  const staged = stageBundle({ stageDir, contract, version: VERSION });
  const outFile = join(dir, bundleFileName(VERSION));
  await packBundle({ stageDir, outFile, lib: LIB });
  const { unpackExtension } = await import(pathToFileURL(LIB).href);
  const unpacked = join(dir, 'unpacked');
  assert.equal(await unpackExtension({ mcpbPath: outFile, outputDir: unpacked, silent: true }), true);
  assert.deepEqual(listFiles(unpacked), staged);

  const fake = await startFakeWisply();
  t.after(fake.close);
  const answers = await runBundled(unpacked, {
    env: { WISPLY_MCP_PORT: String(fake.port), WISPLY_MCP_TOKEN: FAKE_TOKENS.connector },
    lines: [...SESSION, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_memos', arguments: { limit: 1 } } }],
  });
  assert.deepEqual(answers.map((answer) => answer.id), [1, 2, 3]);
  assert.deepEqual(answers[1].result.tools.map((tool) => tool.name), contract.scopes.connector.tools);
  assert.equal(answers[2].result.isError, false, JSON.stringify(answers[2].result));
});
