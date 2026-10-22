#!/usr/bin/env node
// DIST-M6: the Agent Plugin's remote server entry `wisply-cloud` (Cloud Connect).
//
// Agent Plugins clients (Codex, Cursor, VS Code, GitHub Copilot CLI) load MCP servers only from the
// root mcp.json (Agent Plugins 1.0.0 section 7.2.1), so the entry can't sit there while Cloud Connect
// is dark: every plugin user would get a server that can't connect. The entry and the README "Cloud"
// section are therefore staged in cloud-connect/ and lit by one command, in the release that follows
// Cloud Connect stage 4 (allow-list removed, https://www.wisply.ai/mcp open to every Pro account):
//
//   node scripts/cloud-entry.mjs check                                    dark or lit; exit 1 if half-lit
//   node scripts/cloud-entry.mjs apply --confirm-cloud-connect-stage-4    adds the entry and the section
//   node scripts/cloud-entry.mjs remove                                   kill switch: takes both out
//
// No network, no child processes. tests/cloud-entry.test.mjs pins the staged files and the repo state.

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';

export const CLOUD_SERVER_KEY = 'wisply-cloud';
export const LOCAL_SERVER_KEY = 'wisply';
export const CLOUD_MCP_URL = 'https://www.wisply.ai/mcp';
export const AGENT_PLUGINS_MCP_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json';
export const CONFIRM_FLAG = '--confirm-cloud-connect-stage-4';
export const STAGED_ENTRY_PATH = 'cloud-connect/wisply-cloud.mcp.json';
export const STAGED_SECTION_PATH = 'cloud-connect/README-cloud.md';
export const README_START = '<!-- wisply-cloud:start (edit cloud-connect/README-cloud.md, then run node scripts/cloud-entry.mjs apply) -->';
export const README_END = '<!-- wisply-cloud:end -->';
/** The section goes before the first of these headings, else at the end of the README. */
export const README_ANCHOR_RE = /^## (?:Privacy|Security|Troubleshooting|License)\b/m;
const TOKEN_LIKE_RE = /wsp[cr]?_[0-9a-f]{64}/;
const WISPLY_MCP_URL_RE = /[a-z][a-z0-9+.-]*:\/\/[^\s)>\]`'"]*wisply\.ai\/mcp\b[^\s)>\]`'"]*/gi;

export const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Problems with the staged Agent Plugins document (an mcp.json holding only wisply-cloud). */
export function validateStagedEntry(doc) {
  const problems = [];
  if (!isPlainObject(doc)) return [`${STAGED_ENTRY_PATH} is missing, isn't valid JSON or isn't a JSON object`];
  if (!sameKeys(doc, ['$schema', 'mcpServers'])) problems.push('the staged file must have exactly $schema and mcpServers');
  if (doc.$schema !== AGENT_PLUGINS_MCP_SCHEMA) problems.push(`$schema must be ${AGENT_PLUGINS_MCP_SCHEMA}`);
  if (!isPlainObject(doc.mcpServers) || !sameKeys(doc.mcpServers, [CLOUD_SERVER_KEY])) {
    problems.push(`mcpServers must hold exactly one server, ${CLOUD_SERVER_KEY}`);
    return problems;
  }
  const entry = doc.mcpServers[CLOUD_SERVER_KEY];
  // Closed streamable-http variant: {type, url, headers?}. No headers at all: Agent Plugins forbids
  // secrets in them and leaves OAuth to the client, and Wisply needs no fixed header.
  if (!isPlainObject(entry) || !sameKeys(entry, ['type', 'url'])) return [...problems, 'the entry must have exactly type and url'];
  if (entry.type !== 'streamable-http') problems.push('type must be streamable-http');
  if (entry.url !== CLOUD_MCP_URL) problems.push(`url must be ${CLOUD_MCP_URL}`);
  let url = null;
  try { url = new URL(entry.url); } catch { problems.push('url is not an absolute URL'); }
  if (url) {
    if (url.protocol !== 'https:') problems.push('url must use https');
    if (url.username || url.password || url.hash || url.search || url.port) problems.push('url must have no user info, fragment, query or port');
    if (url.hostname !== 'www.wisply.ai') problems.push('url host must be www.wisply.ai (the apex redirects, and MCP clients must not depend on POST redirects)');
  }
  if (String(entry.url).includes('${')) problems.push('url must not contain placeholders (clients never expand them in url)');
  return problems;
}

/** Problems with the staged README section. */
export function validateSection(text) {
  const problems = [];
  if (typeof text !== 'string' || !text.startsWith('## Cloud\n')) problems.push('the section must start with "## Cloud"');
  if (typeof text !== 'string') return problems;
  if (!text.endsWith('\n') || text.endsWith('\n\n')) problems.push('the section must end with exactly one newline');
  if (!text.includes(`\`${CLOUD_SERVER_KEY}\``)) problems.push(`the section must name the ${CLOUD_SERVER_KEY} server`);
  if (!text.includes(CLOUD_MCP_URL)) problems.push(`the section must show ${CLOUD_MCP_URL}`);
  const otherUrls = (text.match(WISPLY_MCP_URL_RE) ?? []).map((u) => u.replace(/[.,;:]+$/, '')).filter((u) => u !== CLOUD_MCP_URL);
  if (otherUrls.length) problems.push(`the section may show the remote server only as ${CLOUD_MCP_URL} (found ${otherUrls.join(', ')})`);
  if (!text.includes('is sent to the AI service that app uses')) problems.push('the section must say that what the app reads is sent to its AI service');
  if (TOKEN_LIKE_RE.test(text) || /\bBearer\b|\bAuthorization\b/.test(text)) problems.push('the section must not contain a token or an auth header');
  if (text.includes(README_START) || text.includes(README_END) || text.includes('<!-- wisply-cloud:')) problems.push('the section must not contain the README markers');
  return problems;
}

/** Finds the marked block. `body` is the text between the marker lines. */
export function findBlock(readmeText) {
  if (typeof readmeText !== 'string') return { count: 0, body: null, start: -1, end: -1 };
  const starts = occurrences(readmeText, README_START);
  const ends = occurrences(readmeText, README_END);
  const stray = occurrences(readmeText, '<!-- wisply-cloud:').length - starts.length - ends.length;
  if (starts.length !== ends.length || stray !== 0) return { count: -1, body: null, start: -1, end: -1 };
  if (starts.length !== 1) return { count: starts.length, body: null, start: -1, end: -1 };
  const start = starts[0];
  const bodyStart = start + README_START.length + 1;
  const end = ends[0];
  if (end < bodyStart || readmeText[bodyStart - 1] !== '\n') return { count: -1, body: null, start: -1, end: -1 };
  return { count: 1, body: readmeText.slice(bodyStart, end), start, end: end + README_END.length };
}

/**
 * State of the repository: 'dark' (no entry, no section), 'lit' (both, equal to the staged files)
 * or 'invalid' with problems. `mcpText`/`readmeText` are null when the file doesn't exist.
 */
export function cloudState({ mcpText, readmeText, stagedDoc, sectionText }) {
  const problems = [...validateStagedEntry(stagedDoc), ...validateSection(sectionText)];
  let mcp = null;
  if (mcpText != null) {
    try { mcp = JSON.parse(mcpText); } catch { problems.push('mcp.json is not valid JSON'); }
  }
  const servers = isPlainObject(mcp?.mcpServers) ? mcp.mcpServers : {};
  const hasEntry = Object.hasOwn(servers, CLOUD_SERVER_KEY);
  const block = findBlock(readmeText);
  if (block.count === -1) problems.push('README.md has unmatched or malformed wisply-cloud markers');
  if (block.count > 1) problems.push('README.md has more than one Cloud section');
  if (hasEntry) {
    const staged = stagedDoc?.mcpServers?.[CLOUD_SERVER_KEY];
    if (!isDeepStrictEqual(servers[CLOUD_SERVER_KEY], staged)) problems.push(`mcp.json ${CLOUD_SERVER_KEY} differs from ${STAGED_ENTRY_PATH}; run apply again`);
    if (!Object.hasOwn(servers, LOCAL_SERVER_KEY)) problems.push(`mcp.json has ${CLOUD_SERVER_KEY} but lost the local ${LOCAL_SERVER_KEY} server`);
  }
  if (block.count === 1 && block.body !== sectionText) problems.push(`the README Cloud section differs from ${STAGED_SECTION_PATH}; run apply again`);
  if (hasEntry && block.count === 0) problems.push(`half-lit: mcp.json has ${CLOUD_SERVER_KEY} but README.md has no Cloud section`);
  if (!hasEntry && block.count === 1) problems.push(`half-lit: README.md has the Cloud section but mcp.json has no ${CLOUD_SERVER_KEY}`);
  if (problems.length) return { state: 'invalid', problems };
  return { state: hasEntry ? 'lit' : 'dark', problems };
}

/** Adds (or re-syncs) the entry and the section. Throws when the repo isn't ready for it. */
export function applyCloudEntry({ mcpText, readmeText, stagedDoc, sectionText }) {
  const staged = [...validateStagedEntry(stagedDoc), ...validateSection(sectionText)];
  if (staged.length) throw new Error(`the staged files are invalid: ${staged.join('; ')}`);
  if (mcpText == null) throw new Error('mcp.json not found: the Agent Plugin (DIST-M3) must land first');
  if (readmeText == null) throw new Error('README.md not found: DIST-M1 must land first');
  const mcp = parseMcp(mcpText);
  if (!Object.hasOwn(mcp.mcpServers, LOCAL_SERVER_KEY)) throw new Error(`mcp.json has no local ${LOCAL_SERVER_KEY} server; the cloud entry is only ever added next to it`);
  const servers = { ...mcp.mcpServers };
  servers[CLOUD_SERVER_KEY] = structuredClone(stagedDoc.mcpServers[CLOUD_SERVER_KEY]);
  const block = findBlock(readmeText);
  if (block.count !== 0 && block.count !== 1) throw new Error('README.md has unmatched or repeated wisply-cloud markers; fix them by hand first');
  const marked = `${README_START}\n${sectionText}${README_END}\n`;
  let readme;
  if (block.count === 1) {
    readme = readmeText.slice(0, block.start) + marked.slice(0, -1) + readmeText.slice(block.end);
  } else {
    const anchor = README_ANCHOR_RE.exec(readmeText);
    readme = anchor
      ? `${readmeText.slice(0, anchor.index)}${marked}\n${readmeText.slice(anchor.index)}`
      : `${readmeText.replace(/\n*$/, '\n\n')}${marked}`;
  }
  return { mcpText: serialize({ ...mcp, mcpServers: servers }), readmeText: readme };
}

/** Kill switch: removes the entry and the section; the rest of both files is kept. */
export function removeCloudEntry({ mcpText, readmeText }) {
  let mcpOut = mcpText;
  if (mcpText != null) {
    const mcp = parseMcp(mcpText);
    if (Object.hasOwn(mcp.mcpServers, CLOUD_SERVER_KEY)) {
      const servers = { ...mcp.mcpServers };
      delete servers[CLOUD_SERVER_KEY];
      mcpOut = serialize({ ...mcp, mcpServers: servers });
    }
  }
  let readmeOut = readmeText;
  const block = findBlock(readmeText);
  if (block.count === -1 || block.count > 1) throw new Error('README.md has unmatched or repeated wisply-cloud markers; fix them by hand first');
  if (block.count === 1) {
    const before = readmeText.slice(0, block.start);
    const after = readmeText.slice(block.end).replace(/^\n\n?/, '');
    readmeOut = after === '' ? before.replace(/\n*$/, '\n') : before + after;
  }
  return { mcpText: mcpOut, readmeText: readmeOut };
}

export function readRepo(root = DEFAULT_ROOT) {
  const read = (rel) => (existsSync(join(root, rel)) ? readFileSync(join(root, rel), 'utf8') : null);
  const stagedText = read(STAGED_ENTRY_PATH);
  let stagedDoc = null;
  try { stagedDoc = stagedText == null ? null : JSON.parse(stagedText); } catch { stagedDoc = null; }
  return { mcpText: read('mcp.json'), readmeText: read('README.md'), stagedDoc, sectionText: read(STAGED_SECTION_PATH) };
}

export function main(argv, { root = DEFAULT_ROOT, out = process.stdout, err = process.stderr } = {}) {
  const args = [...argv];
  const rootIndex = args.indexOf('--root');
  if (rootIndex !== -1) {
    root = resolve(args[rootIndex + 1] ?? '.');
    args.splice(rootIndex, 2);
  }
  const command = args.find((a) => !a.startsWith('--')) ?? 'check';
  const flags = new Set(args.filter((a) => a.startsWith('--')));
  if (flags.has('--help') || command === 'help') {
    out.write(`usage: node scripts/cloud-entry.mjs [check | apply ${CONFIRM_FLAG} | remove] [--root <dir>]\n`);
    return 0;
  }
  const repo = readRepo(root);
  try {
    if (command === 'apply') {
      if (!flags.has(CONFIRM_FLAG)) {
        err.write(`Refusing: ${CLOUD_SERVER_KEY} reaches every plugin user as soon as this is on main. Run apply only in the release `
          + `that follows Cloud Connect stage 4 (allow-list removed, ${CLOUD_MCP_URL} open to every Pro account), with ${CONFIRM_FLAG}.\n`);
        return 2;
      }
      writeRepo(root, repo, applyCloudEntry(repo));
    } else if (command === 'remove') {
      writeRepo(root, repo, removeCloudEntry(repo));
    } else if (command !== 'check') {
      err.write(`unknown command: ${command}\n`);
      return 2;
    }
  } catch (error) {
    err.write(`${error.message}\n`);
    return 1;
  }
  const { state, problems } = cloudState(readRepo(root));
  if (state === 'invalid') {
    for (const p of problems) err.write(`${p}\n`);
    return 1;
  }
  out.write(state === 'lit'
    ? `${CLOUD_SERVER_KEY}: lit (mcp.json has the entry for ${CLOUD_MCP_URL}; README.md has the Cloud section)\n`
    : `${CLOUD_SERVER_KEY}: dark (staged in cloud-connect/; mcp.json and README.md don't have it)\n`);
  return 0;
}

function writeRepo(root, before, after) {
  if (after.mcpText !== before.mcpText && after.mcpText != null) atomicWrite(join(root, 'mcp.json'), after.mcpText);
  if (after.readmeText !== before.readmeText && after.readmeText != null) atomicWrite(join(root, 'README.md'), after.readmeText);
}

function atomicWrite(path, text) {
  const tmp = `${path}.cloud-entry-${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

function parseMcp(text) {
  let mcp;
  try { mcp = JSON.parse(text); } catch { throw new Error('mcp.json is not valid JSON; nothing was changed'); }
  if (!isPlainObject(mcp) || mcp.$schema !== AGENT_PLUGINS_MCP_SCHEMA || !isPlainObject(mcp.mcpServers)) {
    throw new Error(`mcp.json must be an Agent Plugins 1.0.0 file (${AGENT_PLUGINS_MCP_SCHEMA}) with mcpServers; nothing was changed`);
  }
  return mcp;
}

function serialize(doc) {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sameKeys(object, keys) {
  const actual = Object.keys(object).sort();
  return actual.length === keys.length && [...keys].sort().every((k, i) => k === actual[i]);
}

function occurrences(text, needle) {
  const found = [];
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + needle.length)) found.push(i);
  return found;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
