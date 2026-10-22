#!/usr/bin/env node
// The release gate. vsce and ovsx run it before they package or publish
// (package.json "vscode:prepublish"), so nothing provisional reaches a store.
//
// It refuses while
//   - vendor/SOURCE.json is provisional (the connector's contract is), or the
//     connector wasn't vendored from fal3/wisply-mcp main (sync-vendor
//     records "main" only after it checked the commit is on main), or
//   - a name or link that ships in the package isn't final yet (FINAL below).
//
// `npm run package` (local builds and `npm run check`) sets
// WISPLY_DEV_PACKAGE=1 and writes wisply-dev.vsix: the gate then lists the
// problems as a warning and lets the build through. Never publish that file.
// Publish with `vsce publish` / `ovsx publish` (each runs this gate), or
// build the file with `npm run package:release`.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, SOURCE_FILE } from '../esbuild.mjs';

export const MCP_REPOSITORY = 'github:fal3/wisply-mcp';
export const DEV_PACKAGE_ENV = 'WISPLY_DEV_PACKAGE';

/**
 * Placeholders that ship in the package. Each becomes true in the change
 * that makes it final; Alex owns both.
 */
export const FINAL = Object.freeze({
  /** package.json "publisher" ("wisply"): registered on the VS Code Marketplace and Open VSX (spec D6). */
  publisher: false,
  /** SETUP_GUIDE_URL (src/extension.ts) and package.json "homepage": live with the wisply.ai install page. */
  setupGuide: false,
});

/**
 * What stops a release, as sentences; empty when nothing does.
 * @param {{source: any, final?: Record<string, boolean>}} input vendor/SOURCE.json, and FINAL
 * @returns {string[]}
 */
export function releaseProblems({ source, final = FINAL }) {
  const problems = [];
  const mcp = Array.isArray(source?.sources) ? source.sources.find((entry) => entry?.repository === MCP_REPOSITORY) : null;
  if (!mcp) {
    problems.push(`${SOURCE_FILE} has no ${MCP_REPOSITORY} source.`);
  } else {
    if (source.provisional !== false || mcp.contract_provisional !== false) {
      problems.push(`${SOURCE_FILE} is provisional: re-vendor from wisply-mcp main once its contract is final (DIST-M5).`);
    }
    if (mcp.ref !== 'main') {
      problems.push(`The connector was vendored from ${mcp.ref ?? 'an unnamed ref'}, not main: ` +
        'npm run sync-vendor -- --mcp-ref main ... (README, "Vendored code").');
    }
  }
  if (final.publisher !== true) problems.push('The publisher ID "wisply" is a placeholder (scripts/release-gate.mjs FINAL.publisher).');
  if (final.setupGuide !== true) problems.push('The setup guide link isn\'t live yet (scripts/release-gate.mjs FINAL.setupGuide).');
  return problems;
}

function main() {
  const source = JSON.parse(readFileSync(join(ROOT, SOURCE_FILE), 'utf8'));
  const problems = releaseProblems({ source });
  if (problems.length === 0) return;
  const list = problems.map((problem) => `  - ${problem}\n`).join('');
  if (process.env[DEV_PACKAGE_ENV] === '1') {
    process.stderr.write(`Development package, not for publishing:\n${list}`);
    return;
  }
  process.stderr.write(`Not releasable:\n${list}Build a development package with npm run package instead.\n`);
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
