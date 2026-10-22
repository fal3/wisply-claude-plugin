#!/usr/bin/env node
// The release gate. vsce and ovsx run it before they package or publish
// (package.json "vscode:prepublish"), so nothing provisional reaches a store.
//
// It refuses while
//   - vendor/SOURCE.json is provisional (the connector's contract is), or the
//     connector or the skill wasn't vendored from fal3/wisply-mcp main as
//     GitHub has it (sync-vendor records "main" only after it fetched
//     origin/main from that repository and found the commit on it), or
//   - a file that ships, or that the bundle is built from, isn't what
//     SOURCE.json records (integrityProblems: every recorded sha256, the
//     packaged skill as editorSkill() of the vendored one, and the bundle as
//     a rebuild from vendor/ and src/editor-messages.mjs gives it), or the
//     checkout has uncommitted changes (worktreeProblems), so what is
//     published is what the recorded commits and this repository's history
//     hold, or
//   - a name, link or address that ships in the package isn't final yet
//     (FINAL below), or the package names more than one mailbox
//     (contactProblems: package.json, README.md and SECURITY.md all name
//     SUPPORT_EMAIL), or
//   - README.md, which becomes the Marketplace and Open VSX page, still
//     carries draft text (DRAFT_MARKERS) or a {PLACEHOLDER} (the Wisply
//     versions App Store Connect confirms: {READ_MIN}, {RECORDING_MIN}).
//
// There is no way to turn it into a warning. A development package
// (`npm run package`, scripts/package-dev.mjs) never runs it: it is built
// from a copy of the manifest with another name and a prerelease version, so
// no store takes it as this extension (vsce publish refuses prerelease
// versions outright).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, SOURCE_FILE, buildServerBundle } from '../esbuild.mjs';
import { SKILL_PACKAGED, SKILL_VENDORED, editorSkill } from './skill.mjs';

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
  /**
   * package.json "bugs" (www.wisply.ai/support) is live, and SUPPORT_EMAIL
   * (support@wisply.ai) is read: package.json "author.email" and the
   * vulnerability-report address in SECURITY.md, which the stores show.
   */
  support: false,
});

/** The one mailbox the package names: package.json author.email, README.md and SECURITY.md (contactProblems). */
export const SUPPORT_EMAIL = 'support@wisply.ai';

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

/** Every e-mail address in a text, each once, in order. */
export function mailboxes(text) {
  return [...new Set(String(text ?? '').match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g) ?? [])];
}

/**
 * Where the package names a mailbox other than SUPPORT_EMAIL, as sentences:
 * package.json author.email, and any address in README.md or SECURITY.md.
 * One mailbox, so FINAL.support confirms the one the stores show.
 * @param {{manifest: any, readme?: string, security?: string}} input
 * @returns {string[]}
 */
export function contactProblems({ manifest, readme = '', security = '' }) {
  const problems = [];
  if (manifest?.author?.email !== SUPPORT_EMAIL) {
    problems.push(`package.json author.email is ${JSON.stringify(manifest?.author?.email ?? null)}, not ${SUPPORT_EMAIL}.`);
  }
  for (const [file, text] of [['README.md', readme], ['SECURITY.md', security]]) {
    const other = mailboxes(text).filter((address) => address !== SUPPORT_EMAIL);
    if (other.length > 0) problems.push(`${file} names ${other.join(', ')}: use ${SUPPORT_EMAIL}, the one mailbox FINAL.support confirms.`);
  }
  if (!mailboxes(security).includes(SUPPORT_EMAIL)) problems.push(`SECURITY.md doesn't say where to report a vulnerability (${SUPPORT_EMAIL}).`);
  return problems;
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
/** A path SOURCE.json may record: relative, inside the repository. */
const SAFE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/;

/**
 * Every file SOURCE.json records with its sha256: each source's vendored
 * files, the vendored skill, the packaged skill and the bundle.
 * @param {any} source vendor/SOURCE.json
 * @returns {{path: string, sha256: unknown}[]}
 */
export function recordedFiles(source) {
  const files = [];
  for (const entry of Array.isArray(source?.sources) ? source.sources : []) {
    for (const [path, file] of Object.entries(entry?.files ?? {})) files.push({ path, sha256: file?.sha256 });
  }
  for (const [path, file] of Object.entries(source?.skill?.files ?? {})) files.push({ path, sha256: file?.sha256 });
  if (source?.skill?.packaged) files.push({ path: source.skill.packaged.path, sha256: source.skill.packaged.sha256 });
  if (source?.bundle) files.push({ path: source.bundle.path, sha256: source.bundle.sha256 });
  return files;
}

/**
 * Whether the files that ship, and the ones the bundle is built from, are
 * what SOURCE.json records, as sentences; empty when they are. The tests
 * check the same (test/vendor.test.mjs, test/skill.test.mjs,
 * test/bundle.test.mjs), but vsce runs only this gate, so it checks again.
 * @param {{source: any, read: (path: string) => Uint8Array, rebuild?: () => Promise<Uint8Array>, esbuildVersion?: string}} input
 *   `read` returns a file's bytes (it may throw); `rebuild` builds the
 *   bundle from vendor/ and src/editor-messages.mjs without writing it
 * @returns {Promise<string[]>}
 */
export async function integrityProblems({ source, read, rebuild, esbuildVersion }) {
  const problems = [];
  const bytesOf = (path) => {
    if (!SAFE_PATH.test(path)) {
      problems.push(`${SOURCE_FILE} records ${JSON.stringify(path)}, which isn't a path inside this repository.`);
      return null;
    }
    try {
      return read(path);
    } catch {
      problems.push(`${path} is missing (${SOURCE_FILE} records it).`);
      return null;
    }
  };
  const files = recordedFiles(source);
  if (files.length === 0) problems.push(`${SOURCE_FILE} records no files.`);
  for (const { path, sha256: recorded } of files) {
    const bytes = bytesOf(path);
    if (bytes && sha256(bytes) !== recorded) {
      problems.push(`${path} isn't the file ${SOURCE_FILE} records (sha256 differs): re-vendor with npm run sync-vendor, never edit it by hand.`);
    }
  }
  const packaged = source?.skill?.packaged;
  if (packaged?.path !== SKILL_PACKAGED || packaged?.from !== SKILL_VENDORED) {
    problems.push(`${SOURCE_FILE} doesn't record ${SKILL_PACKAGED} as made from ${SKILL_VENDORED}.`);
  } else {
    const vendored = bytesOf(SKILL_VENDORED);
    const shipped = bytesOf(SKILL_PACKAGED);
    if (vendored && shipped) {
      let expected = null;
      try {
        expected = editorSkill(Buffer.from(vendored).toString('utf8'));
      } catch (error) {
        problems.push(`${SKILL_VENDORED} can't be packaged: ${error.message}.`);
      }
      if (expected !== null && expected !== Buffer.from(shipped).toString('utf8')) {
        problems.push(`${SKILL_PACKAGED} isn't ${SKILL_VENDORED} with only its compatibility line replaced (scripts/skill.mjs).`);
      }
    }
  }
  if (rebuild && source?.bundle?.path) {
    if (esbuildVersion !== undefined && source.bundle.esbuild !== esbuildVersion) {
      problems.push(`The bundle was built with esbuild ${source.bundle.esbuild}, but ${esbuildVersion} is installed: npm ci.`);
    } else {
      const shipped = bytesOf(source.bundle.path);
      let built = null;
      try {
        built = await rebuild();
      } catch (error) {
        problems.push(`The bundle couldn't be rebuilt from vendor/: ${error.message}`);
      }
      if (shipped && built && sha256(shipped) !== sha256(built)) {
        problems.push(`${source.bundle.path} isn't what vendor/ and src/editor-messages.mjs build: run node esbuild.mjs --server and commit it.`);
      }
    }
  }
  return problems;
}

/**
 * Uncommitted changes, as sentences: a release is built from a clean
 * checkout of its tag, so everything that ships is in the history.
 * @param {string} root
 * @param {(root: string) => string} [status] `git status --porcelain` (for tests)
 * @returns {string[]}
 */
export function worktreeProblems(root, status = gitStatus) {
  let output;
  try {
    output = status(root);
  } catch {
    return ['This isn\'t a git checkout (or git isn\'t installed): publish from a clean checkout of the release tag.'];
  }
  const changed = String(output).split('\n').filter((line) => line.trim() !== '');
  if (changed.length === 0) return [];
  return [`The checkout has ${changed.length} uncommitted change${changed.length === 1 ? '' : 's'} (${changed[0].slice(3)}` +
    `${changed.length > 1 ? ', ...' : ''}): publish from a clean checkout of the release tag.`];
}

function gitStatus(root) {
  return execFileSync('git', ['-C', root, 'status', '--porcelain', '--untracked-files=all'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

/**
 * What stops a release, as sentences; empty when nothing does.
 * @param {{source: any, final?: Record<string, boolean>, readme?: string, manifest?: any, security?: string}} input
 *   vendor/SOURCE.json, FINAL, README.md's text, and (for contactProblems)
 *   package.json and SECURITY.md's text
 * @returns {string[]}
 */
export function releaseProblems({ source, final = FINAL, readme = '', manifest, security }) {
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
    problems.push(`The support page and the mailbox (${SUPPORT_EMAIL}, in package.json and SECURITY.md) aren't confirmed yet ` +
      '(scripts/release-gate.mjs FINAL.support).');
  }
  const markers = draftMarkers(readme);
  if (markers.length > 0) {
    problems.push(`README.md is the store page but still reads as a draft (${markers.join(', ')}): ` +
      'replace it with the store README.');
  }
  const left = placeholders(readme);
  if (left.length > 0) problems.push(`README.md still has ${left.join(', ')}: fill them in from App Store Connect.`);
  if (manifest !== undefined || security !== undefined) problems.push(...contactProblems({ manifest, readme, security }));
  return problems;
}

async function main() {
  const text = (path) => readFileSync(join(ROOT, path), 'utf8');
  const source = JSON.parse(text(SOURCE_FILE));
  const problems = [
    ...releaseProblems({ source, readme: text('README.md'), manifest: JSON.parse(text('package.json')), security: text('SECURITY.md') }),
    ...await integrityProblems({
      source,
      read: (path) => readFileSync(join(ROOT, path)),
      rebuild: () => buildServerBundle({ write: false }),
      esbuildVersion: createRequire(import.meta.url)('esbuild/package.json').version,
    }),
    ...worktreeProblems(ROOT),
  ];
  if (problems.length === 0) return;
  const list = problems.map((problem) => `  - ${problem}\n`).join('');
  process.stderr.write(`Not releasable:\n${list}For a local test build, run npm run package instead (wisply-dev.vsix).\n`);
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
