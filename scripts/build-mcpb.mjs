#!/usr/bin/env node
// Builds the MCPB bundle (Claude Desktop's double-click install; also the
// MCP Registry's "mcpb" package and the Smithery upload) from this checkout.
//
//   node scripts/build-mcpb.mjs               the release build: only from a clean checkout at tag v<version>.
//                                             Stages the tag's files in dist/mcpb/, packs
//                                             dist/wisply-mcp-<version>.mcpb and writes dist/SHA256SUMS
//   node scripts/build-mcpb.mjs --unreleased  the same from any checkout, as dist/wisply-mcp-<version>-unreleased.mcpb
//                                             (a name no release gate accepts)
//   node scripts/build-mcpb.mjs --stage-only  stage dist/mcpb/ only
//   node scripts/build-mcpb.mjs --check       exit 1 if mcpb/manifest.json's version or tools are out of date
//   node scripts/build-mcpb.mjs --sync        rewrite mcpb/manifest.json's version and tools
//   --out-dir <dir>                           instead of dist/
//
// The bundle holds the tracked .mjs and .json files of bin/, lib/, contract/
// and clients/ (once it exists), LICENSE, the manifest and its icon: the same
// code as the npm package, run by the host's own Node ("command": "node"). It
// never runs npx and never fetches anything. Only files git tracks are
// staged, so nothing untracked in a working tree reaches a bundle. The
// manifest's tools array lists the contract tools the bundle's own config can
// reach (setup_claude needs --allow-claude-setup, which the bundle never
// passes); tools_generated is true because the tools a client sees depend on
// the token's scope.
//
// Packing uses the pinned @anthropic-ai/mcpb 2.1.2 in tools/mcpb, installed
// with `npm ci --ignore-scripts --prefix tools/mcpb` from its committed
// package-lock.json (exact versions and integrity hashes for every
// dependency), or the copy WISPLY_MCPB_LIB points to (its dist/index.js).
// Never npx: an unpinned dependency tree must not run while the release
// asset is written. Zip entries carry the build time, so every build has a
// new sha256: build the release asset once and never rebuild it
// (SECURITY.md, "Release controls"). verifyBundle checks a built or
// downloaded bundle against the tag, byte for byte.
//
// Dev-only: not in the npm package.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CLAUDE_SETUP_TOOL } from '../lib/constants.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const MCPB_NAME = '@anthropic-ai/mcpb';
export const MCPB_VERSION = '2.1.2';
/** The pinned packer's folder (package.json and package-lock.json are committed; node_modules isn't). */
export const PACKER_DIR = 'tools/mcpb';
export const PACKER_INSTALL = `npm ci --ignore-scripts --prefix ${PACKER_DIR}`;
export const MANIFEST_PATH = 'mcpb/manifest.json';
export const ICON_PATH = 'mcpb/icon.png';
/** Directories copied into the bundle (flat; only .mjs and .json files). clients/ arrives with DIST-M4. */
export const STAGED_DIRS = Object.freeze(['bin', 'lib', 'contract', 'clients']);
/** Single files copied into the bundle, besides the manifest and the icon. */
export const STAGED_FILES = Object.freeze(['LICENSE']);
/** The second release asset. Also what makes Gemini CLI install the tag's source (README, "Releasing the bundle"). */
export const SUMS_FILE = 'SHA256SUMS';
const DATA_FILE = /\.(mjs|json)$/;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

/** The release tag for a version. */
export const releaseTag = (version) => `v${version}`;

/** The bundle's file name for a version; an --unreleased build gets a name no release gate accepts. */
export const bundleFileName = (version, { unreleased = false } = {}) => `wisply-mcp-${version}${unreleased ? '-unreleased' : ''}.mcpb`;

/** One SHA256SUMS line, in the format `shasum -a 256 -c` reads. */
export const sumsLine = (sha, fileName) => `${sha}  ${fileName}\n`;

/** Canonical JSON text, as every manifest in this repository is written. */
export const jsonText = (value) => `${JSON.stringify(value, null, 2)}\n`;

/**
 * The manifest's tools array: the contract tools the bundle can offer, in contract order, with their
 * descriptors' descriptions. setup_claude is left out: the bundle never starts the connector with
 * --allow-claude-setup, so a listing that named it would promise a tool no client ever gets.
 * @param {{tool_descriptors: {name: string, description: string}[]}} contract
 */
export function mcpbTools(contract) {
  return contract.tool_descriptors
    .filter(({ name }) => name !== CLAUDE_SETUP_TOOL)
    .map(({ name, description }) => ({ name, description }));
}

/**
 * The manifest with its version and tools brought up to date. Key order is kept.
 * @param {Record<string, unknown>} manifest
 * @param {{contract: object, version: string}} options
 */
export function renderManifest(manifest, { contract, version }) {
  return { ...manifest, version, tools: mcpbTools(contract) };
}

/** package.json's version, and the contract the connector ships with. */
export async function currentInputs(root = ROOT) {
  const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const { default: contract } = await import(pathToFileURL(join(root, 'lib/contract.mjs')).href);
  return { version, contract };
}

/** git in `root`, with fixed arguments; a Buffer unless encoding is given. */
function git(root, args, { encoding } = {}) {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: encoding ?? 'buffer', maxBuffer: GIT_MAX_BUFFER, stdio: ['ignore', 'pipe', 'pipe'],
  });
}

const nulList = (buffer) => buffer.toString('utf8').split('\0').filter(Boolean);

/** Whether a repository path goes into the bundle (besides the manifest and the icon). */
export function isBundled(path) {
  if (STAGED_FILES.includes(path)) return true;
  const slash = path.indexOf('/');
  return slash > 0 && STAGED_DIRS.includes(path.slice(0, slash)) && !path.slice(slash + 1).includes('/') && DATA_FILE.test(path);
}

/**
 * The bundle's sources in a working tree: the files git tracks, read from disk.
 * @returns {{paths: string[], read: (path: string) => Buffer, mode: (path: string) => number}}
 */
export function trackedSource(root = ROOT) {
  const paths = nulList(git(root, ['ls-files', '-z', '--', ...STAGED_DIRS, ...STAGED_FILES])).filter(isBundled).sort();
  return {
    paths,
    read: (path) => readFileSync(join(root, path)),
    mode: (path) => statSync(join(root, path)).mode & 0o777,
  };
}

/**
 * The bundle's sources at a git ref (the release tag), read from git's objects, not the working tree.
 * @returns {{paths: string[], read: (path: string) => Buffer, mode: (path: string) => number}}
 */
export function refSource(root, ref) {
  const modes = new Map();
  for (const line of nulList(git(root, ['ls-tree', '-r', '-z', '--full-tree', ref, '--', ...STAGED_DIRS, ...STAGED_FILES]))) {
    const match = /^(\d{6}) blob [0-9a-f]+\t(.+)$/.exec(line);
    if (match && isBundled(match[2])) modes.set(match[2], match[1] === '100755' ? 0o755 : 0o644);
  }
  return {
    paths: [...modes.keys()].sort(),
    read: (path) => git(root, ['show', `${ref}:${path}`]),
    mode: (path) => modes.get(path) ?? 0o644,
  };
}

/**
 * Every file of the bundle, by its path in the bundle: the sources, manifest.json and the icon.
 * @param {{paths: string[], read: (path: string) => Buffer, mode: (path: string) => number}} source
 * @param {{manifestText: (committed: string) => string}} options turns the committed manifest into the bundle's
 * @returns {Map<string, {data: Buffer, mode: number}>}
 */
export function bundleEntries(source, { manifestText }) {
  const entries = new Map();
  for (const path of source.paths) entries.set(path, { data: source.read(path), mode: source.mode(path) });
  const text = manifestText(source.read(MANIFEST_PATH).toString('utf8'));
  entries.set('manifest.json', { data: Buffer.from(text, 'utf8'), mode: 0o644 });
  entries.set(JSON.parse(text).icon, { data: source.read(ICON_PATH), mode: 0o644 });
  return entries;
}

/** Whether `child` is `parent` or inside it. */
const within = (parent, child) => {
  const rel = relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

/**
 * The stage is emptied first, so it must never be (or contain) a source folder, and never the repository
 * or a folder that holds it: only dist/ inside the repository, or a folder outside it that doesn't contain it.
 */
export function assertSafeStageDir(root, stageDir) {
  const repo = resolve(root);
  const stage = resolve(stageDir);
  if (within(stage, repo)) {
    throw new Error(`The stage directory must not be the repository or a folder that contains it: ${stageDir}`);
  }
  if (within(repo, stage) && !within(join(repo, 'dist'), stage)) {
    throw new Error(`The stage directory must be under dist/ or outside the repository: ${stageDir}`);
  }
}

/**
 * Copies what the bundle needs into `stageDir` (emptied first) and writes its manifest.json.
 * @param {{root?: string, stageDir: string, contract: object, version: string,
 *   source?: ReturnType<typeof trackedSource>}} options source: the working tree's tracked files by default
 * @returns {string[]} the staged files, relative to stageDir, sorted
 */
export function stageBundle({ root = ROOT, stageDir, contract, version, source }) {
  assertSafeStageDir(root, stageDir);
  const entries = bundleEntries(source ?? trackedSource(root), {
    manifestText: (committed) => jsonText(renderManifest(JSON.parse(committed), { contract, version })),
  });
  rmSync(stageDir, { recursive: true, force: true });
  mkdirSync(stageDir, { recursive: true });
  for (const [path, { data, mode }] of entries) {
    mkdirSync(dirname(join(stageDir, path)), { recursive: true });
    writeFileSync(join(stageDir, path), data);
    chmodSync(join(stageDir, path), mode);
  }
  return listFiles(stageDir);
}

/** Every regular file under dir, relative and sorted. */
export function listFiles(dir, base = dir) {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => (entry.isDirectory() ? listFiles(join(dir, entry.name), base) : [relative(base, join(dir, entry.name))]))
    .sort();
}

/**
 * Why this checkout can't make a release build: anything uncommitted or untracked (ignored files such as
 * dist/ and tools/mcpb/node_modules don't count), or HEAD not at tag v<version>. Empty when it can.
 * @returns {string[]}
 */
export function releaseProblems(root, version) {
  const problems = [];
  try {
    if (git(root, ['status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' }).trim() !== '') {
      problems.push('the checkout has uncommitted or untracked files (git status)');
    }
    const tags = git(root, ['tag', '--points-at', 'HEAD'], { encoding: 'utf8' }).split('\n').map((tag) => tag.trim());
    if (!tags.includes(releaseTag(version))) problems.push(`HEAD is not at tag ${releaseTag(version)}`);
  } catch {
    problems.push('git could not read this checkout');
  }
  return problems;
}

/** The default packer: tools/mcpb's copy, installed by PACKER_INSTALL. */
export const defaultPackerLib = (root = ROOT) => join(root, PACKER_DIR, 'node_modules', MCPB_NAME, 'dist/index.js');

/**
 * The packer to use: WISPLY_MCPB_LIB, else tools/mcpb's copy; null when neither is installed.
 * @param {Record<string, string|undefined>} [env]
 */
export function packerLib(env = process.env, root = ROOT) {
  const lib = env.WISPLY_MCPB_LIB ? resolve(env.WISPLY_MCPB_LIB) : defaultPackerLib(root);
  return existsSync(lib) ? lib : null;
}

/**
 * The packer's dist/index.js, after checking it is @anthropic-ai/mcpb 2.1.2. Throws with the install command.
 * @param {string|null} lib
 */
export function assertPacker(lib) {
  if (!lib) throw new Error(`The pinned MCPB packer isn't installed: run ${PACKER_INSTALL}`);
  let pkg = null;
  try { pkg = JSON.parse(readFileSync(join(dirname(lib), '..', 'package.json'), 'utf8')); } catch { /* checked below */ }
  if (pkg?.name !== MCPB_NAME || pkg?.version !== MCPB_VERSION) {
    throw new Error(`${lib} isn't ${MCPB_NAME} ${MCPB_VERSION}: run ${PACKER_INSTALL}`);
  }
  return lib;
}

/**
 * Packs the staged directory with the pinned @anthropic-ai/mcpb, which validates the manifest first.
 * @param {{stageDir: string, outFile: string, lib: string}} options lib: path to mcpb's dist/index.js
 */
export async function packBundle({ stageDir, outFile, lib }) {
  const { packExtension } = await import(pathToFileURL(assertPacker(lib)).href);
  rmSync(outFile, { force: true });
  const ok = await packExtension({ extensionPath: stageDir, outputPath: outFile, silent: true });
  if (!ok || !existsSync(outFile)) throw new Error(`mcpb pack failed for ${stageDir}`);
}

export const sha256File = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

/**
 * Compares a bundle with what the release build makes from tag v<version>: the same files, byte for byte,
 * with the tag's committed manifest (the release build refuses to run unless it is already rendered) and
 * icon. For the release gate (WISPLY_MCPB_FILE), on the asset downloaded back from the draft release.
 * @param {{file: string, version: string, lib: string|null, root?: string}} options
 * @returns {Promise<string[]>} the differences; empty when the bundle is exactly the tag's
 */
export async function verifyBundle({ file, version, lib, root = ROOT }) {
  const tag = releaseTag(version);
  let expected;
  try {
    expected = bundleEntries(refSource(root, tag), { manifestText: (committed) => committed });
  } catch {
    return [`tag ${tag} isn't in this checkout (git fetch --tags)`];
  }
  const { unpackExtension } = await import(pathToFileURL(assertPacker(lib)).href);
  const dir = mkdtempSync(join(tmpdir(), 'wisply-mcpb-verify-'));
  try {
    if (!(await unpackExtension({ mcpbPath: file, outputDir: dir, silent: true }))) return [`${basename(file)} doesn't unpack`];
    const found = listFiles(dir);
    const problems = [];
    for (const path of found) if (!expected.has(path)) problems.push(`${path} is in the bundle but not at ${tag}`);
    for (const [path, { data }] of expected) {
      if (!found.includes(path)) problems.push(`${path} is missing from the bundle`);
      else if (!readFileSync(join(dir, path)).equals(data)) problems.push(`${path} differs from ${tag}`);
    }
    return problems;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const options = { mode: 'release', outDir: join(ROOT, 'dist') };
  const modes = { '--stage-only': 'stage', '--unreleased': 'unreleased', '--check': 'check', '--sync': 'sync' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (Object.hasOwn(modes, arg)) options.mode = modes[arg];
    else if (arg === '--out-dir' && argv[i + 1]) options.outDir = resolve(argv[(i += 1)]);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

async function main(argv) {
  const options = parseArgs(argv);
  const { version, contract } = await currentInputs();
  const manifestPath = join(ROOT, MANIFEST_PATH);
  const current = readFileSync(manifestPath, 'utf8');
  const expected = jsonText(renderManifest(JSON.parse(current), { contract, version }));
  if (options.mode === 'check' || options.mode === 'sync') {
    if (current === expected) return 0;
    if (options.mode === 'check') {
      process.stderr.write(`${MANIFEST_PATH} is out of date: run node scripts/build-mcpb.mjs --sync\n`);
      return 1;
    }
    writeFileSync(manifestPath, expected);
    process.stdout.write(`wrote ${MANIFEST_PATH}\n`);
    return 0;
  }
  if (current !== expected) {
    process.stderr.write(`${MANIFEST_PATH} is out of date: run node scripts/build-mcpb.mjs --sync first\n`);
    return 1;
  }
  const release = options.mode === 'release';
  if (release) {
    const problems = releaseProblems(ROOT, version);
    if (problems.length > 0) {
      process.stderr.write(`Not a release build: ${problems.join('; ')}.\n` +
        `Check out tag ${releaseTag(version)} in a clean clone, or use --unreleased for a test bundle.\n`);
      return 1;
    }
  }
  // Fail before staging when the pinned packer is missing.
  const lib = options.mode === 'stage' ? null : assertPacker(packerLib());
  const stageDir = join(options.outDir, 'mcpb');
  // A release stages from the tag's objects, so nothing on disk but the tag reaches the asset.
  const source = release ? refSource(ROOT, releaseTag(version)) : undefined;
  const files = stageBundle({ stageDir, contract, version, source });
  process.stdout.write(`staged ${files.length} files in ${relative(process.cwd(), stageDir) || '.'}\n`);
  if (options.mode === 'stage') return 0;
  const outFile = join(options.outDir, bundleFileName(version, { unreleased: !release }));
  await packBundle({ stageDir, outFile, lib });
  const sha = sha256File(outFile);
  process.stdout.write(`${relative(process.cwd(), outFile)}\nsha256 ${sha}\n`);
  if (release) {
    const sumsPath = join(options.outDir, SUMS_FILE);
    writeFileSync(sumsPath, sumsLine(sha, basename(outFile)));
    process.stdout.write(`${relative(process.cwd(), sumsPath)}: upload it with the bundle, and paste its line into the release notes\n`);
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
