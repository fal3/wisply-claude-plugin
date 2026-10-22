#!/usr/bin/env node
// Vendors the Wisply MCP connector and the plugin's shared helpers at exact
// commits, rebuilds the connector bundle, and records every sha256 in
// vendor/SOURCE.json.
//
//   node scripts/sync-vendor.mjs --mcp <wisply-mcp dir> --mcp-commit <rev> [--mcp-ref <branch>]
//                                --plugin <wisply-claude-plugin dir> --plugin-commit <rev>
//
// Files are read with `git show <commit>:<path>`, so what lands here is the
// file as of that commit, not whatever the checkout has on disk. --mcp-ref
// is recorded only after `git merge-base --is-ancestor` confirms the commit
// is on that branch in the given repository: the release gate trusts a
// recorded "main" (scripts/release-gate.mjs).
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

export { SOURCE_FILE };
export const VENDOR_SCHEMA = 'wisply-vscode-vendor-v1';
export const MCP_REPOSITORY = 'github:fal3/wisply-mcp';
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
const fullCommit = (dir, rev) => git(dir, ['rev-parse', '--verify', `${rev}^{commit}`]).toString('utf8').trim();

/**
 * Whether `commit` is on `ref` in the repository at `dir` (an ancestor of, or
 * equal to, the ref's tip). A ref that doesn't resolve counts as no.
 */
export function isOnRef(dir, commit, ref) {
  try {
    execFileSync('git', ['-C', dir, 'merge-base', '--is-ancestor', commit, `${ref}^{commit}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
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

  // wisply-mcp: a clean copy of the vendored files at the commit.
  const mcpCommit = fullCommit(values.mcp, values['mcp-commit']);
  const mcpRef = values['mcp-ref'];
  if (mcpRef && !isOnRef(values.mcp, mcpCommit, mcpRef)) {
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
