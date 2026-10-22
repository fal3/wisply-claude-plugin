#!/usr/bin/env node
// Builds the MCPB bundle (Claude Desktop's double-click install; also the
// MCP Registry's "mcpb" package and the Smithery upload) from this checkout.
//
//   node scripts/build-mcpb.mjs               stage dist/mcpb/, pack dist/wisply-mcp-<version>.mcpb, print its sha256
//   node scripts/build-mcpb.mjs --stage-only  stage dist/mcpb/ only
//   node scripts/build-mcpb.mjs --check       exit 1 if mcpb/manifest.json's version or tools are out of date
//   node scripts/build-mcpb.mjs --sync        rewrite mcpb/manifest.json's version and tools
//   --out-dir <dir>                           instead of dist/
//
// The bundle holds bin/, lib/, contract/, clients/ (once it exists), LICENSE,
// the manifest and its icon: the same code as the npm package, run by the
// host's own Node ("command": "node"). It never runs npx and never fetches
// anything. The manifest's tools array lists every contract tool, from the
// contract's descriptors; tools_generated is true because the tools a client
// sees depend on the token's scope.
//
// Packing uses @anthropic-ai/mcpb 2.1.2: the copy WISPLY_MCPB_LIB points to
// (its dist/index.js, as CI installs it), else
// `npx -y @anthropic-ai/mcpb@2.1.2 pack`. Zip entries carry the build time,
// so every build has a new sha256: build the release asset once (README,
// "Releasing the bundle") and never rebuild it.
//
// Dev-only: not in the npm package.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const MCPB_PACKAGE = '@anthropic-ai/mcpb@2.1.2';
export const MANIFEST_PATH = 'mcpb/manifest.json';
export const ICON_PATH = 'mcpb/icon.png';
/** Directories copied into the bundle (flat; only .mjs and .json files). clients/ arrives with DIST-M4. */
export const STAGED_DIRS = Object.freeze(['bin', 'lib', 'contract', 'clients']);
/** Single files copied into the bundle, besides the manifest and the icon. */
export const STAGED_FILES = Object.freeze(['LICENSE']);
const DATA_FILE = /\.(mjs|json)$/;

/** The bundle's file name for a version. */
export const bundleFileName = (version) => `wisply-mcp-${version}.mcpb`;

/** Canonical JSON text, as every manifest in this repository is written. */
export const jsonText = (value) => `${JSON.stringify(value, null, 2)}\n`;

/**
 * The manifest's tools array: every contract tool, in contract order, with its descriptor's description.
 * @param {{tool_descriptors: {name: string, description: string}[]}} contract
 */
export function mcpbTools(contract) {
  return contract.tool_descriptors.map(({ name, description }) => ({ name, description }));
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

/**
 * Copies what the bundle needs into `stageDir` (emptied first) and writes its manifest.json.
 * @param {{root?: string, stageDir: string, contract: object, version: string}} options
 * @returns {string[]} the staged files, relative to stageDir, sorted
 */
export function stageBundle({ root = ROOT, stageDir, contract, version }) {
  // The stage is emptied first, so it must never be (or contain) a source folder.
  const inRepo = relative(resolve(root), resolve(stageDir));
  if (!inRepo.startsWith('..') && !isAbsolute(inRepo) && !(inRepo === 'dist' || inRepo.startsWith(`dist${sep}`))) {
    throw new Error(`The stage directory must be under dist/ or outside the repository: ${stageDir}`);
  }
  rmSync(stageDir, { recursive: true, force: true });
  mkdirSync(stageDir, { recursive: true });
  const copy = (from, to) => {
    mkdirSync(dirname(join(stageDir, to)), { recursive: true });
    copyFileSync(join(root, from), join(stageDir, to));
    chmodSync(join(stageDir, to), statSync(join(root, from)).mode & 0o777);
  };
  for (const dir of STAGED_DIRS) {
    if (!existsSync(join(root, dir))) continue;
    for (const name of readdirSync(join(root, dir)).sort()) {
      if (DATA_FILE.test(name) && statSync(join(root, dir, name)).isFile()) copy(`${dir}/${name}`, `${dir}/${name}`);
    }
  }
  for (const file of STAGED_FILES) copy(file, file);
  const manifest = renderManifest(JSON.parse(readFileSync(join(root, MANIFEST_PATH), 'utf8')), { contract, version });
  writeFileSync(join(stageDir, 'manifest.json'), jsonText(manifest));
  copy(ICON_PATH, manifest.icon);
  return listFiles(stageDir);
}

/** Every regular file under dir, relative and sorted. */
export function listFiles(dir, base = dir) {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => (entry.isDirectory() ? listFiles(join(dir, entry.name), base) : [relative(base, join(dir, entry.name))]))
    .sort();
}

/**
 * Packs the staged directory with @anthropic-ai/mcpb 2.1.2, which validates the manifest first.
 * @param {{stageDir: string, outFile: string, lib?: string}} options lib: path to mcpb's dist/index.js
 */
export async function packBundle({ stageDir, outFile, lib }) {
  rmSync(outFile, { force: true });
  if (lib) {
    const { packExtension } = await import(pathToFileURL(resolve(lib)).href);
    const ok = await packExtension({ extensionPath: stageDir, outputPath: outFile, silent: true });
    if (!ok) throw new Error(`mcpb pack failed for ${stageDir}`);
  } else {
    // Without install scripts, like the CI job: packing needs none.
    execFileSync('npx', ['-y', MCPB_PACKAGE, 'pack', stageDir, outFile], {
      stdio: 'inherit', env: { ...process.env, npm_config_ignore_scripts: 'true' },
    });
  }
  if (!existsSync(outFile)) throw new Error(`mcpb pack wrote no ${outFile}`);
}

export const sha256File = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

function parseArgs(argv) {
  const options = { mode: 'build', outDir: join(ROOT, 'dist') };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--stage-only') options.mode = 'stage';
    else if (arg === '--check') options.mode = 'check';
    else if (arg === '--sync') options.mode = 'sync';
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
  const stageDir = join(options.outDir, 'mcpb');
  const files = stageBundle({ stageDir, contract, version });
  process.stdout.write(`staged ${files.length} files in ${relative(process.cwd(), stageDir) || '.'}\n`);
  if (options.mode === 'stage') return 0;
  const outFile = join(options.outDir, bundleFileName(version));
  await packBundle({ stageDir, outFile, lib: process.env.WISPLY_MCPB_LIB || undefined });
  process.stdout.write(`${relative(process.cwd(), outFile)}\nsha256 ${sha256File(outFile)}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
