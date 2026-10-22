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
// Without --provisional, wisply-ai's Docs/mcp-contract.json replaces the
// fixture, and SOURCE.json says provisional: false. The file must be one the
// connector can load (lib/contract.mjs contractProblems): it needs raycast
// PR 1's keys (the wspr_ scope among them) and DIST-A1's tool_descriptors,
// so re-vendor from a wisply-ai commit that has both, the DIST-A1 merge
// commit on main. Anything else is refused before a file is written.
//
// --provisional keeps the hand-transcribed contract/mcp-contract.json (until
// wisply-ai has that file) and marks it provisional. tests/vendor.test.mjs
// refuses a provisional source when WISPLY_RELEASE=1, so nothing can be
// published from it.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { contractProblems } from '../lib/contract.mjs';
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
    if (!values[name]) throw new Error(`--${name} is required`);
  }

  // Read and check everything first; write only once nothing can fail.
  /** @type {[string, Buffer][]} */
  const writes = [];

  const pluginCommit = fullCommit(values.plugin, values['plugin-commit']);
  const pluginFiles = {};
  for (const [local, upstream] of Object.entries(PLUGIN_FILES)) {
    const bytes = git(values.plugin, ['show', `${pluginCommit}:${upstream}`]);
    writes.push([local, bytes]);
    pluginFiles[local] = { upstream, sha256: sha256(bytes) };
  }

  const appCommit = fullCommit(values.app, values['app-commit']);
  const appFiles = {};
  for (const [local, upstream] of Object.entries(APP_FILES)) {
    if (values.provisional) {
      if (existsAt(values.app, appCommit, upstream)) {
        process.stderr.write(`note: ${upstream} exists at ${appCommit.slice(0, 7)}; re-vendor without --provisional ` +
          'once it has tool_descriptors and raycast PR 1\'s keys (SECURITY.md, "Re-vendoring the contract")\n');
      }
      const bytes = readFileSync(join(ROOT, local));
      appFiles[local] = { upstream, transcribed_from: TRANSCRIBED_FROM, sha256: sha256(bytes) };
    } else {
      if (!existsAt(values.app, appCommit, upstream)) {
        throw new Error(`${upstream} doesn't exist at ${appCommit.slice(0, 7)}; nothing was changed`);
      }
      const bytes = git(values.app, ['show', `${appCommit}:${upstream}`]);
      const problems = upstreamContractProblems(bytes);
      if (problems.length > 0) {
        throw new Error(`${upstream} at ${appCommit.slice(0, 7)} isn't a contract this connector can load ` +
          `(${problems.join(', ')}). It needs raycast PR 1's keys and DIST-A1's tool_descriptors: re-vendor from ` +
          'the wisply-ai commit on main that has both. Nothing was changed.');
      }
      writes.push([local, bytes]);
      appFiles[local] = { upstream, sha256: sha256(bytes) };
    }
  }

  const source = {
    schema: VENDOR_SCHEMA,
    provisional: values.provisional,
    sources: [
      {
        repository: APP_REPOSITORY,
        commit: values.provisional ? `${appCommit.slice(0, 7)} (transcribed)` : appCommit,
        provisional: values.provisional,
        files: appFiles,
      },
      { repository: PLUGIN_REPOSITORY, commit: pluginCommit, provisional: false, files: pluginFiles },
    ],
  };
  for (const [local, bytes] of writes) writeFileSync(join(ROOT, local), bytes);
  writeFileSync(join(ROOT, SOURCE_FILE), `${JSON.stringify(source, null, 2)}\n`);
  for (const target of generate()) process.stdout.write(`wrote ${target}\n`);
  process.stdout.write(`wrote ${SOURCE_FILE}${values.provisional ? ' (provisional)' : ''}\n`);
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
    process.stderr.write(`sync-vendor: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
