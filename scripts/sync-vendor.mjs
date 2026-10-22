#!/usr/bin/env node
// Vendors the Wisply MCP connector and the plugin's shared helpers at exact
// commits, rebuilds the connector bundle, and records every sha256 in
// vendor/SOURCE.json.
//
//   node scripts/sync-vendor.mjs --mcp <wisply-mcp dir> --mcp-commit <rev> [--mcp-ref <branch>]
//                                --plugin <wisply-claude-plugin dir> --plugin-commit <rev>
//
// Files are read with `git show <commit>:<path>`, so what lands here is the
// file as of that commit, not whatever the checkout has on disk.
//
// --mcp-ref is recorded only after a check, because the release gate trusts
// a recorded "main" (scripts/release-gate.mjs):
//   - main: the checkout's origin must be github.com/fal3/wisply-mcp; origin's
//     main is fetched now, and the commit must be on refs/remotes/origin/main.
//     The checkout's own `main` never counts: it can hold commits nobody
//     pushed or reviewed. SOURCE.json then records the remote and the
//     origin/main tip it checked against.
//   - any other branch (interim snapshots, which the gate refuses anyway):
//     `git merge-base --is-ancestor` against that branch in the checkout.
// Refs and commits must look like git names (REF_RE): nothing that starts
// with "-" reaches git as an option.
//
//   vendor/wisply-mcp/   bin/wisply-mcp.mjs, lib/*.mjs, the generated data
//                        modules (contract/mcp-contract.mjs,
//                        clients/mcp-clients.mjs), contract/SOURCE.json and
//                        LICENSE, byte for byte. Kept as a tree because the
//                        modules import their siblings. The extension imports
//                        lib/scopes.mjs, lib/messages.mjs, lib/contract.mjs and
//                        the clients data from here; esbuild inlines them.
//   vendor/shared.mjs    the plugin's lib/shared.mjs (no imports), byte for byte
//   server/wisply-mcp.mjs  the single-file bundle of vendor/wisply-mcp/bin, with
//                        the editor texts of src/editor-messages.mjs
//                        (esbuild.mjs serverBundleOptions)
//
// The contract stays provisional while wisply-mcp's contract/SOURCE.json says
// so; test/vendor.test.mjs refuses a provisional contract when WISPLY_RELEASE=1.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  EDITOR_MESSAGES, ROOT, SERVER_BUNDLE, SERVER_ENTRY, SOURCE_FILE, VENDORED_MESSAGES, buildServerBundle,
} from '../esbuild.mjs';
import { MCP_REMOTE, MCP_REPOSITORY } from './release-gate.mjs';

export { MCP_REMOTE, MCP_REPOSITORY, SOURCE_FILE };
export const VENDOR_SCHEMA = 'wisply-vscode-vendor-v1';
/** origin URLs that are github.com/fal3/wisply-mcp (HTTPS or SSH). */
export const MCP_REMOTE_RE = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)fal3\/wisply-mcp(?:\.git)?\/?$/;
/** A branch name or commit as git spells it; never an option ("-..."), never "..". */
export const REF_RE = /^(?!-)(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9._/-]*$/;
export const PLUGIN_REPOSITORY = 'github:fal3/wisply-claude-plugin';
export const MCP_DIR = 'vendor/wisply-mcp';

/** Which wisply-mcp files are vendored (paths in that repository). */
export function isVendoredMcpPath(path) {
  return path === 'bin/wisply-mcp.mjs' || path === 'LICENSE' || path === 'contract/SOURCE.json' ||
    path === 'contract/mcp-contract.mjs' || path === 'clients/mcp-clients.mjs' ||
    /^lib\/[a-z0-9-]+\.mjs$/.test(path);
}

/** Local path -> path in the plugin repository. */
export const PLUGIN_FILES = Object.freeze({ 'vendor/shared.mjs': 'lib/shared.mjs' });

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const git = (dir, args) => execFileSync('git', ['-C', dir, ...args], {
  maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'],
});

/** Whether `value` can be passed to git as a ref or commit. */
export const validRef = (value) => typeof value === 'string' && REF_RE.test(value) && !value.endsWith('/') &&
  !value.endsWith('.lock');

function checkedRef(name, value) {
  if (!validRef(value)) throw new Error(`--${name} must be a branch name or a commit (got ${JSON.stringify(String(value).slice(0, 80))})`);
  return value;
}

const fullCommit = (dir, rev) => git(dir, ['rev-parse', '--verify', '--end-of-options', `${rev}^{commit}`]).toString('utf8').trim();

/**
 * Whether `commit` is on `ref` in the repository at `dir` (an ancestor of, or
 * equal to, the ref's tip). A ref that doesn't resolve, or that isn't a valid
 * name, counts as no.
 * @param {{env?: NodeJS.ProcessEnv}} [options]
 */
export function isOnRef(dir, commit, ref, { env = process.env } = {}) {
  if (!validRef(commit) || !validRef(ref)) return false;
  try {
    execFileSync('git', ['-C', dir, 'merge-base', '--is-ancestor', commit, `${ref}^{commit}`], { stdio: 'ignore', env });
    return true;
  } catch {
    return false;
  }
}

/**
 * Checks that `commit` is on fal3/wisply-mcp's main as GitHub has it: the
 * checkout's origin is that repository, origin's main is fetched now, and the
 * commit is on refs/remotes/origin/main. Throws with the reason otherwise.
 * @param {string} dir a wisply-mcp checkout
 * @param {string} commit a full commit
 * @param {{env?: NodeJS.ProcessEnv}} [options]
 * @returns {{remote: string, mainTip: string}}
 */
export function verifyOnUpstreamMain(dir, commit, { env = process.env } = {}) {
  const run = (args) => execFileSync('git', ['-C', dir, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  let url = '';
  try { url = run(['config', '--get', 'remote.origin.url']); } catch { url = ''; }
  if (!MCP_REMOTE_RE.test(url)) {
    throw new Error(`${dir} has ${url ? `origin ${url}` : 'no origin remote'}: --mcp-ref main needs a clone of ${MCP_REMOTE}`);
  }
  run(['fetch', '--quiet', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main']);
  const mainTip = run(['rev-parse', '--verify', 'refs/remotes/origin/main^{commit}']);
  if (!isOnRef(dir, commit, 'refs/remotes/origin/main', { env })) {
    throw new Error(`${commit.slice(0, 7)} is not on ${MCP_REMOTE} main (origin/main is ${mainTip.slice(0, 7)}): ` +
      'push and merge it first');
  }
  return { remote: MCP_REMOTE, mainTip };
}

function writeVendored(local, bytes) {
  const target = join(ROOT, local);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bytes);
  return { sha256: sha256(bytes) };
}

async function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      mcp: { type: 'string' },
      'mcp-commit': { type: 'string' },
      'mcp-ref': { type: 'string' },
      plugin: { type: 'string' },
      'plugin-commit': { type: 'string' },
    },
    strict: true,
  });
  for (const name of ['mcp', 'mcp-commit', 'plugin', 'plugin-commit']) {
    if (!values[name]) throw new Error(`--${name} is required`);
  }

  for (const name of ['mcp-commit', 'mcp-ref', 'plugin-commit']) {
    if (values[name] !== undefined) checkedRef(name, values[name]);
  }

  // wisply-mcp: a clean copy of the vendored files at the commit.
  const mcpCommit = fullCommit(values.mcp, values['mcp-commit']);
  const mcpRef = values['mcp-ref'];
  /** For main: the remote and the origin/main tip the commit was checked against. */
  let upstream = null;
  if (mcpRef === 'main') {
    const { remote, mainTip } = verifyOnUpstreamMain(values.mcp, mcpCommit);
    upstream = { remote, remote_main: mainTip };
  } else if (mcpRef && !isOnRef(values.mcp, mcpCommit, mcpRef)) {
    throw new Error(`${mcpCommit.slice(0, 7)} is not on ${mcpRef} in ${values.mcp}: pass the branch the commit is on`);
  }
  const paths = git(values.mcp, ['ls-tree', '-r', '--name-only', mcpCommit]).toString('utf8')
    .split('\n').filter(isVendoredMcpPath).sort();
  if (!paths.includes('bin/wisply-mcp.mjs') || !paths.includes('contract/mcp-contract.mjs')) {
    throw new Error(`${mcpCommit.slice(0, 7)} has no bin/wisply-mcp.mjs or contract/mcp-contract.mjs`);
  }
  rmSync(join(ROOT, MCP_DIR), { recursive: true, force: true });
  const mcpFiles = {};
  for (const path of paths) {
    const local = `${MCP_DIR}/${path}`;
    mcpFiles[local] = { upstream: path, ...writeVendored(local, git(values.mcp, ['show', `${mcpCommit}:${path}`])) };
  }
  const upstreamSource = JSON.parse(readFileSync(join(ROOT, MCP_DIR, 'contract/SOURCE.json'), 'utf8'));
  const contractProvisional = upstreamSource.provisional !== false;

  // The plugin's shared helpers.
  const pluginCommit = fullCommit(values.plugin, values['plugin-commit']);
  const pluginFiles = {};
  for (const [local, upstream] of Object.entries(PLUGIN_FILES)) {
    pluginFiles[local] = { upstream, ...writeVendored(local, git(values.plugin, ['show', `${pluginCommit}:${upstream}`])) };
  }

  const mcpSource = {
    repository: MCP_REPOSITORY,
    commit: mcpCommit,
    ...(mcpRef ? { ref: mcpRef } : {}),
    ...(upstream ?? {}),
    contract_provisional: contractProvisional,
    files: mcpFiles,
  };
  const bundle = await buildServerBundle({ source: mcpSource });
  const esbuildVersion = createRequire(import.meta.url)('esbuild/package.json').version;

  const source = {
    schema: VENDOR_SCHEMA,
    provisional: contractProvisional,
    sources: [
      mcpSource,
      { repository: PLUGIN_REPOSITORY, commit: pluginCommit, files: pluginFiles },
    ],
    bundle: {
      path: SERVER_BUNDLE,
      entry: SERVER_ENTRY,
      overlays: { [VENDORED_MESSAGES]: EDITOR_MESSAGES },
      esbuild: esbuildVersion,
      sha256: sha256(bundle),
    },
  };
  writeFileSync(join(ROOT, SOURCE_FILE), `${JSON.stringify(source, null, 2)}\n`);
  process.stdout.write(`vendored ${paths.length} files from ${MCP_REPOSITORY}@${mcpCommit.slice(0, 7)}` +
    ` and ${Object.keys(pluginFiles).length} from ${PLUGIN_REPOSITORY}@${pluginCommit.slice(0, 7)}\n`);
  process.stdout.write(`wrote ${SERVER_BUNDLE} and ${SOURCE_FILE}${contractProvisional ? ' (contract provisional)' : ''}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
