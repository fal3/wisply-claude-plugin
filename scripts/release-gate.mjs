#!/usr/bin/env node
// The release gate. vsce and ovsx run it before they package or publish
// (package.json "vscode:prepublish"), so nothing provisional reaches a store.
//
// It refuses while
//   - vendor/SOURCE.json is provisional (the connector's contract is), or the
//     connector or the skill wasn't vendored from fal3/wisply-mcp main as
//     GitHub has it (sync-vendor records "main" only after it fetched
//     origin/main from that repository and found the commit on it), or
//   - a name, link or address that ships in the package isn't final yet
//     (FINAL below), or
//   - README.md, which becomes the Marketplace and Open VSX page, still
//     carries draft text (DRAFT_MARKERS) or a {PLACEHOLDER} (the Wisply
//     versions App Store Connect confirms: {READ_MIN}, {RECORDING_MIN}).
//
// There is no way to turn it into a warning. A development package
// (`npm run package`, scripts/package-dev.mjs) never runs it: it is built
// from a copy of the manifest with another name and a prerelease version, so
// no store takes it as this extension (vsce publish refuses prerelease
// versions outright).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, SOURCE_FILE } from '../esbuild.mjs';

export const MCP_REPOSITORY = 'github:fal3/wisply-mcp';
/** The repository whose main the release must come from (scripts/sync-vendor.mjs checks origin against it). */
export const MCP_REMOTE = 'https://github.com/fal3/wisply-mcp';

/**
 * Placeholders that ship in the package. Each becomes true in the change
 * that makes it final; Alex owns all four.
 */
export const FINAL = Object.freeze({
  /** package.json "publisher" ("wisply"): registered on the VS Code Marketplace and Open VSX (spec D6). */
  publisher: false,
  /** SETUP_GUIDE_URL (src/extension.ts) and package.json "homepage": live with the wisply.ai install page. */
  setupGuide: false,
  /**
   * package.json "repository" (github.com/fal3/wisply-vscode) and the
   * connector source the README and the bundle banner name
   * (github.com/fal3/wisply-mcp): both repositories exist and are public, so
   * store reviewers and users can read the code that runs.
   */
  repositories: false,
  /** package.json "bugs" (www.wisply.ai/support) is live and "author.email" (support@wisply.ai) is read. */
  support: false,
});

/** Text that marks README.md as a draft: the store page must not show it. */
export const DRAFT_MARKERS = Object.freeze([
  /Not published yet/i,
  /\binterim\b/i,
  /\bDIST-[A-Z]+\d/,
  /\bclaude\//,
]);

/**
 * The draft markers README.md still holds, as their patterns.
 * @param {string} readme
 * @returns {string[]}
 */
export function draftMarkers(readme) {
  return DRAFT_MARKERS.filter((marker) => marker.test(readme)).map((marker) => String(marker));
}

/**
 * The {PLACEHOLDER}s left in a text, each once, in order.
 * @param {string} text
 * @returns {string[]}
 */
export function placeholders(text) {
  return [...new Set(String(text ?? '').match(/\{[A-Z][A-Z0-9_]*\}/g) ?? [])];
}

/**
 * Whether a recorded "main" was checked against GitHub's main: sync-vendor
 * records the remote and the origin/main tip it fetched only then.
 * @param {{remote?: unknown, remote_main?: unknown}} entry a SOURCE.json source or skill record
 */
export function checkedAgainstGitHub(entry) {
  return entry?.remote === MCP_REMOTE && /^[0-9a-f]{40}$/.test(String(entry?.remote_main ?? ''));
}

/**
 * What stops a release, as sentences; empty when nothing does.
 * @param {{source: any, final?: Record<string, boolean>, readme?: string}} input
 *   vendor/SOURCE.json, FINAL, and README.md's text
 * @returns {string[]}
 */
export function releaseProblems({ source, final = FINAL, readme = '' }) {
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
        'npm run sync-vendor -- --mcp-ref main ... (DEVELOPMENT.md, "Vendored code").');
    } else if (!checkedAgainstGitHub(mcp)) {
      problems.push(`The connector's main wasn't checked against ${MCP_REMOTE}: re-run npm run sync-vendor ` +
        '-- --mcp-ref main ... with a clone whose origin is that repository (it fetches origin/main).');
    }
  }
  const skill = source?.skill;
  if (!skill || skill.repository !== MCP_REPOSITORY) {
    problems.push(`${SOURCE_FILE} has no skill from ${MCP_REPOSITORY}.`);
  } else if (skill.ref !== 'main') {
    problems.push(`The skill was vendored from ${skill.ref ?? 'an unnamed ref'}, not main: ` +
      'npm run sync-vendor -- --mcp-ref main ... (DEVELOPMENT.md, "Vendored code").');
  } else if (!checkedAgainstGitHub(skill)) {
    problems.push(`The skill's main wasn't checked against ${MCP_REMOTE}: re-run npm run sync-vendor ` +
      '-- --mcp-ref main ... with a clone whose origin is that repository (it fetches origin/main).');
  }
  if (final.publisher !== true) problems.push('The publisher ID "wisply" is a placeholder (scripts/release-gate.mjs FINAL.publisher).');
  if (final.setupGuide !== true) problems.push('The setup guide link isn\'t live yet (scripts/release-gate.mjs FINAL.setupGuide).');
  if (final.repositories !== true) {
    problems.push('github.com/fal3/wisply-vscode and github.com/fal3/wisply-mcp aren\'t public yet ' +
      '(scripts/release-gate.mjs FINAL.repositories).');
  }
  if (final.support !== true) {
    problems.push('The support page and mailbox in package.json aren\'t live yet (scripts/release-gate.mjs FINAL.support).');
  }
  const markers = draftMarkers(readme);
  if (markers.length > 0) {
    problems.push(`README.md is the store page but still reads as a draft (${markers.join(', ')}): ` +
      'replace it with the store README.');
  }
  const left = placeholders(readme);
  if (left.length > 0) problems.push(`README.md still has ${left.join(', ')}: fill them in from App Store Connect.`);
  return problems;
}

function main() {
  const source = JSON.parse(readFileSync(join(ROOT, SOURCE_FILE), 'utf8'));
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  const problems = releaseProblems({ source, readme });
  if (problems.length === 0) return;
  const list = problems.map((problem) => `  - ${problem}\n`).join('');
  process.stderr.write(`Not releasable:\n${list}For a local test build, run npm run package instead (wisply-dev.vsix).\n`);
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
