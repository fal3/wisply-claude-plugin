#!/usr/bin/env node
// Vendors the files this package copies from other repositories, at exact
// commits, records their sha256 in contract/SOURCE.json, then regenerates the
// data modules (scripts/gen-data.mjs).
//
//   node scripts/sync-vendor.mjs --app <wisply-ai dir> --app-commit <sha>
//                                --plugin <wisply-claude-plugin dir> --plugin-commit <sha>
//                                [--provisional]
//
// Files are read with `git show <commit>:<path>`, so what lands here is the
// file as of that commit, not whatever the checkout has on disk.
//
// Everything is read and checked first, and only then written, so a refusal
// leaves the tree as it was. Without --provisional, wisply-ai's
// Docs/mcp-contract.json replaces the fixture and SOURCE.json says
// provisional: false; the file must be one the connector can load
// (lib/contract-shape.mjs: tool_descriptors for every tool, and the three
// token scopes, wspr_ included). Re-vendor from a wisply-ai commit that has
// both raycast PR 1's keys and DIST-A1's descriptors.
//
// --provisional keeps the hand-transcribed contract/mcp-contract.json (until
// wisply-ai has such a file) and marks it provisional. tests/vendor.test.mjs
// refuses a provisional source when WISPLY_RELEASE=1, so nothing can be
// published from it.
//
// Without --provisional, SOURCE.json also says whether wisply-ai's main has
// the commit ("on_main": the --app checkout's refs/remotes/origin/main
// contains it; fetch first). A commit from an unmerged branch (DIST-A1
// before it merges, say) is vendored with "on_main": false, which
// tests/vendor.test.mjs refuses when WISPLY_RELEASE=1: run sync-vendor
// again from the main commit once the branch is merged.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
// The side-effect-free check, not lib/contract.mjs, which throws at import
// when the vendored copy is broken (the very tree a re-vendor repairs).
import { contractProblems } from '../lib/contract-shape.mjs';
import { ROOT, generate } from './gen-data.mjs';

export const SOURCE_FILE = 'contract/SOURCE.json';
export const VENDOR_SCHEMA = 'wisply-mcp-vendor-v1';
export const APP_REPOSITORY = 'github:fal3/wisply-ai';
export const PLUGIN_REPOSITORY = 'github:fal3/wisply-claude-plugin';

/** Local path -> path in the source repository. */
export const APP_FILES = Object.freeze({ 'contract/mcp-contract.json': 'Docs/mcp-contract.json' });
export const PLUGIN_FILES = Object.freeze({ 'lib/identity.mjs': 'lib/identity.mjs' });
export const TRANSCRIBED_FROM = 'Wisply/Services/MCP/MCPToolCatalog.swift';

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const git = (dir, args, stderr = 'inherit') =>
  execFileSync('git', ['-C', dir, ...args], { maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', stderr] });
const fullCommit = (dir, commit) => git(dir, ['rev-parse', '--verify', `${commit}^{commit}`]).toString('utf8').trim();
const existsAt = (dir, commit, path) => {
  try { git(dir, ['cat-file', '-e', `${commit}:${path}`], 'ignore'); return true; } catch { return false; }
};
/** The ref whose history decides "on_main": the remote's main, never a local branch someone may have committed to. */
export const MAIN_REF = 'refs/remotes/origin/main';
/** Whether `commit` is on the checkout's origin/main; false when there is no origin/main. */
const onMain = (dir, commit) => {
  try {
    git(dir, ['rev-parse', '--verify', '-q', `${MAIN_REF}^{commit}`], 'ignore');
    git(dir, ['merge-base', '--is-ancestor', commit, MAIN_REF], 'ignore');
    return true;
  } catch {
    return false;
  }
};

/** A refusal: printed as is, and nothing has been written. */
class Refusal extends Error {}

/** The file at `commit`, or a refusal when the commit doesn't have it. */
function readAt(dir, commit, path) {
  if (!existsAt(dir, commit, path)) throw new Refusal(`${path} doesn't exist at ${commit.slice(0, 7)}. Nothing was changed.`);
  return git(dir, ['show', `${commit}:${path}`]);
}

/**
 * Why wisply-ai's contract bytes can't replace the fixture, or [] when they can.
 * @param {Buffer} bytes
 * @returns {string[]}
 */
export function upstreamContractProblems(bytes) {
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    return ['not JSON'];
  }
  return contractProblems(parsed);
}

function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      app: { type: 'string' },
      'app-commit': { type: 'string' },
      plugin: { type: 'string' },
      'plugin-commit': { type: 'string' },
      provisional: { type: 'boolean', default: false },
    },
    strict: true,
  });
  for (const name of ['app', 'app-commit', 'plugin', 'plugin-commit']) {
    if (!values[name]) throw new Refusal(`--${name} is required. Nothing was changed.`);
  }

  // 1. Read and check everything.
  /** @type {[string, Buffer][]} local path, bytes */
  const writes = [];

  const pluginCommit = fullCommit(values.plugin, values['plugin-commit']);
  const pluginFiles = {};
  for (const [local, upstream] of Object.entries(PLUGIN_FILES)) {
    const bytes = readAt(values.plugin, pluginCommit, upstream);
    writes.push([local, bytes]);
    pluginFiles[local] = { upstream, sha256: sha256(bytes) };
  }

  const appCommit = fullCommit(values.app, values['app-commit']);
  const appFiles = {};
  for (const [local, upstream] of Object.entries(APP_FILES)) {
    if (values.provisional) {
      if (existsAt(values.app, appCommit, upstream)) {
        process.stderr.write(`note: ${upstream} exists at ${appCommit.slice(0, 7)}; re-vendor without --provisional ` +
          "once it has tool_descriptors and raycast PR 1's keys\n");
      }
      const bytes = readFileSync(join(ROOT, local));
      appFiles[local] = { upstream, transcribed_from: TRANSCRIBED_FROM, sha256: sha256(bytes) };
    } else {
      const bytes = readAt(values.app, appCommit, upstream);
      const problems = upstreamContractProblems(bytes);
      if (problems.length > 0) {
        throw new Refusal(`${upstream} at ${appCommit.slice(0, 7)} isn't a contract this connector can load ` +
          `(${problems.join(', ')}). It needs raycast PR 1's keys and DIST-A1's tool_descriptors: re-vendor from ` +
          'the wisply-ai commit on main that has both. Nothing was changed.');
      }
      writes.push([local, bytes]);
      appFiles[local] = { upstream, sha256: sha256(bytes) };
    }
  }

  const appOnMain = values.provisional ? null : onMain(values.app, appCommit);
  const source = {
    schema: VENDOR_SCHEMA,
    provisional: values.provisional,
    sources: [
      {
        repository: APP_REPOSITORY,
        commit: values.provisional ? `${appCommit.slice(0, 7)} (transcribed)` : appCommit,
        provisional: values.provisional,
        ...(values.provisional ? {} : { on_main: appOnMain }),
        files: appFiles,
      },
      { repository: PLUGIN_REPOSITORY, commit: pluginCommit, provisional: false, files: pluginFiles },
    ],
  };

  // 2. Only now write: the vendored files, SOURCE.json, the generated modules.
  try {
    for (const [local, bytes] of writes) writeFileSync(join(ROOT, local), bytes);
    writeFileSync(join(ROOT, SOURCE_FILE), `${JSON.stringify(source, null, 2)}\n`);
    for (const target of generate()) process.stdout.write(`wrote ${target}\n`);
  } catch (error) {
    throw new Refusal(`writing failed (${error instanceof Error ? error.message : String(error)}), so the tree may be ` +
      'partly vendored: restore it with git checkout -- contract lib/identity.mjs');
  }
  process.stdout.write(`wrote ${SOURCE_FILE}${values.provisional ? ' (provisional)' : ''}\n`);
  if (appOnMain === false) {
    process.stderr.write(`note: ${appCommit.slice(0, 7)} isn't on the app checkout's origin/main, so SOURCE.json says ` +
      '"on_main": false and WISPLY_RELEASE=1 refuses it: run sync-vendor again from the main commit once it is merged\n');
  }
}

/** Whether this file is the program node runs (not an import), with symlinks resolved on both sides. */
const isMain = () => {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};

if (isMain()) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    const text = error instanceof Refusal ? error.message
      : `${error instanceof Error ? error.message : String(error)} (stopped before writing anything)`;
    process.stderr.write(`sync-vendor: ${text}\n`);
    process.exitCode = 1;
  }
}
