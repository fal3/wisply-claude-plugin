#!/usr/bin/env node
// DIST-M6: `wisply-cloud`, the Agent Plugin for Cloud Connect's remote MCP server (https://www.wisply.ai/mcp).
//
// wisply-cloud is a separate, opt-in plugin in cloud-connect/plugin/. It is never a second server in the
// root mcp.json: Agent Plugins clients (Codex, Cursor, VS Code, GitHub Copilot CLI) load every server in an
// installed plugin's mcp.json and can start it as soon as the app starts, so a remote entry there would make
// local users' apps contact wisply.ai, Pro or not. `check` fails if the root plugin ever holds a remote server.
//
// The plugin stays unlisted ("dark") until Cloud Connect stage 4 (allow-list removed, the remote server
// open to every Pro account). Lighting lists it in the Codex marketplace (.agents/plugins/marketplace.json),
// adds its disclosure sections to README.md and SECURITY.md and records who approved it, in
// cloud-connect/LIT.json. cloud-connect/RUNBOOK.md has the whole procedure, including the listings.
//
//   node scripts/cloud-entry.mjs check
//       dark or lit; exit 1 if half-lit, drifted, lit without LIT.json, or the root plugin isn't local-only
//   node scripts/cloud-entry.mjs apply --confirm-cloud-connect-stage-4 --stage-4-date YYYY-MM-DD --approved-by NAME
//       lists the plugin, adds both sections, writes LIT.json (the date and name may be left out to re-sync
//       a repo that is already lit)
//   node scripts/cloud-entry.mjs remove
//       retract, for new installs only: unlists the plugin and removes the sections and LIT.json. Apps that
//       already installed wisply-cloud keep it; the kill switches for them are server-side (RUNBOOK.md).
//
// Dev-only (not in the npm package). No network, no child processes.

import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';

export const CLOUD_NAME = 'wisply-cloud';
export const LOCAL_NAME = 'wisply';
export const CLOUD_MCP_URL = 'https://www.wisply.ai/mcp';
export const AGENT_PLUGINS_PLUGIN_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
export const AGENT_PLUGINS_MCP_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json';
export const CONFIRM_FLAG = '--confirm-cloud-connect-stage-4';
export const CLOUD_PLUGIN_SOURCE = './cloud-connect/plugin';
export const PATHS = Object.freeze({
  pluginManifest: 'cloud-connect/plugin/plugin.json',
  pluginMcp: 'cloud-connect/plugin/mcp.json',
  marketplaceEntry: 'cloud-connect/marketplace-entry.json',
  readmeSection: 'cloud-connect/README-cloud.md',
  securitySection: 'cloud-connect/SECURITY-cloud.md',
  lit: 'cloud-connect/LIT.json',
  marketplace: '.agents/plugins/marketplace.json',
  readme: 'README.md',
  security: 'SECURITY.md',
  rootMcp: 'mcp.json',
  rootPlugin: 'plugin.json',
});
/** Stable markers around each generated block. Guidance goes on the note line inside the block. */
export const BLOCK_START = '<!-- wisply-cloud:start -->';
export const BLOCK_END = '<!-- wisply-cloud:end -->';
const MARKER_PREFIX = '<!-- wisply-cloud:';
export const SECTIONS = Object.freeze({
  readme: Object.freeze({
    target: PATHS.readme,
    source: PATHS.readmeSection,
    heading: '## Cloud',
    optIn: 'which you install only if you want it',
    /** The section goes before the first of these headings (outside fenced code), else at the end. */
    anchor: /^## (?:Privacy|Security|Troubleshooting|License)\b/,
  }),
  security: Object.freeze({
    target: PATHS.security,
    source: PATHS.securitySection,
    heading: '## The Wisply Cloud plugin (`wisply-cloud`)',
    optIn: "It's opt-in",
    anchor: /^## (?:If you think a token leaked|Release controls|If a bad release)\b/,
  }),
});
export const blockNote = (source) => `<!-- Generated from ${source} by scripts/cloud-entry.mjs. Edit that file, then re-run the apply command in cloud-connect/RUNBOOK.md. -->`;
const DISCLOSURE = 'is sent to the AI service that app uses';
const PLUGIN_FIELDS = ['$schema', 'name', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords'];
const TOKEN_LIKE_RE = /wsp[cr]?_[0-9a-f]{64}/;
const WISPLY_MCP_URL_RE = /[a-z][a-z0-9+.-]*:\/\/[^\s)>\]`'"]*wisply\.ai\/mcp\b[^\s)>\]`'"]*/gi;
const KEYWORD_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FIRST_STAGE_4_DATE = '2026-10-21';

export const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Problems with the staged plugin: cloud-connect/plugin/plugin.json and mcp.json. */
export function validateCloudPlugin({ manifest, mcp }) {
  return [...validatePluginManifest(manifest), ...validatePluginMcp(mcp)];
}

function validatePluginManifest(doc) {
  const where = PATHS.pluginManifest;
  if (!isPlainObject(doc)) return [`${where} is missing, isn't valid JSON or isn't a JSON object`];
  const problems = [];
  const extra = Object.keys(doc).filter((k) => !PLUGIN_FIELDS.includes(k));
  if (extra.length) problems.push(`${where} has fields outside the Agent Plugins 1.0.0 manifest: ${extra.join(', ')}`);
  if (doc.$schema !== AGENT_PLUGINS_PLUGIN_SCHEMA) problems.push(`${where} $schema must be ${AGENT_PLUGINS_PLUGIN_SCHEMA}`);
  if (doc.name !== CLOUD_NAME) problems.push(`${where} name must be ${CLOUD_NAME}`);
  if (typeof doc.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(doc.version)) problems.push(`${where} version must be x.y.z`);
  const description = typeof doc.description === 'string' ? doc.description : '';
  // The listing must say where the data comes from, and must not borrow the local plugin's wording.
  if (!description.includes('wisply.ai') || !description.includes('Cloud Connect')) problems.push(`${where} description must name Cloud Connect and wisply.ai`);
  if (/this Mac|127\.0\.0\.1|\blocal\b/i.test(description)) problems.push(`${where} description must not describe the plugin as local`);
  if (!isPlainObject(doc.author) || Object.keys(doc.author).some((k) => !['name', 'email', 'url'].includes(k))) problems.push(`${where} author must have only name, email and url`);
  if (doc.homepage !== 'https://www.wisply.ai/docs/cloud-connect') problems.push(`${where} homepage must be https://www.wisply.ai/docs/cloud-connect`);
  if (!Array.isArray(doc.keywords) || !doc.keywords.every((k) => typeof k === 'string' && KEYWORD_RE.test(k))) {
    problems.push(`${where} keywords must be lowercase and hyphenated`);
  } else {
    if (!doc.keywords.includes('cloud') || !doc.keywords.includes('remote')) problems.push(`${where} keywords must include cloud and remote`);
    if (doc.keywords.includes('local')) problems.push(`${where} keywords must not include local`);
  }
  return problems;
}

function validatePluginMcp(doc) {
  const where = PATHS.pluginMcp;
  if (!isPlainObject(doc)) return [`${where} is missing, isn't valid JSON or isn't a JSON object`];
  const problems = [];
  if (!sameKeys(doc, ['$schema', 'mcpServers'])) problems.push(`${where} must have exactly $schema and mcpServers`);
  if (doc.$schema !== AGENT_PLUGINS_MCP_SCHEMA) problems.push(`${where} $schema must be ${AGENT_PLUGINS_MCP_SCHEMA}`);
  if (!isPlainObject(doc.mcpServers) || !sameKeys(doc.mcpServers, [CLOUD_NAME])) {
    problems.push(`${where} mcpServers must hold exactly one server, ${CLOUD_NAME}`);
    return problems;
  }
  const entry = doc.mcpServers[CLOUD_NAME];
  // Closed streamable-http variant: {type, url, headers?}. No headers at all: Agent Plugins forbids
  // secrets in them and leaves OAuth to the client, and Wisply needs no fixed header.
  if (!isPlainObject(entry) || !sameKeys(entry, ['type', 'url'])) return [...problems, `${where} ${CLOUD_NAME} must have exactly type and url`];
  if (entry.type !== 'streamable-http') problems.push(`${where} type must be streamable-http`);
  if (entry.url !== CLOUD_MCP_URL) problems.push(`${where} url must be ${CLOUD_MCP_URL}`);
  let url = null;
  try { url = new URL(entry.url); } catch { problems.push(`${where} url is not an absolute URL`); }
  if (url) {
    if (url.protocol !== 'https:') problems.push(`${where} url must use https`);
    if (url.username || url.password || url.hash || url.search || url.port) problems.push(`${where} url must have no user info, fragment, query or port`);
    if (url.hostname !== 'www.wisply.ai') problems.push(`${where} url host must be www.wisply.ai (the apex redirects, and MCP clients must not depend on POST redirects)`);
  }
  if (String(entry.url).includes('${')) problems.push(`${where} url must not contain placeholders (clients never expand them in url)`);
  return problems;
}

/** Problems with the Codex marketplace entry that lighting adds. */
export function validateMarketplaceEntry(entry) {
  const where = PATHS.marketplaceEntry;
  if (!isPlainObject(entry)) return [`${where} is missing, isn't valid JSON or isn't a JSON object`];
  const problems = [];
  // No `policy`: Codex's default is AVAILABLE, so the plugin is never INSTALLED_BY_DEFAULT.
  if (!sameKeys(entry, ['name', 'source', 'category', 'description'])) problems.push(`${where} must have exactly name, source, category and description`);
  if (entry.name !== CLOUD_NAME) problems.push(`${where} name must be ${CLOUD_NAME}`);
  if (entry.source !== CLOUD_PLUGIN_SOURCE) problems.push(`${where} source must be ${CLOUD_PLUGIN_SOURCE}`);
  if (entry.category !== 'productivity') problems.push(`${where} category must be productivity`);
  const description = typeof entry.description === 'string' ? entry.description : '';
  if (!description.includes('wisply.ai')) problems.push(`${where} description must say the memos come from wisply.ai`);
  if (/this Mac|127\.0\.0\.1/i.test(description)) problems.push(`${where} description must not describe the plugin as local`);
  return problems;
}

/** Problems with a staged section (`kind` is 'readme' or 'security'). */
export function validateSection(text, kind) {
  const spec = SECTIONS[kind];
  const where = spec?.source ?? `section ${kind}`;
  if (!spec) return [`unknown section ${kind}`];
  if (typeof text !== 'string') return [`${where} is missing`];
  const problems = [];
  if (!text.startsWith(`${spec.heading}\n`)) problems.push(`${where} must start with "${spec.heading}"`);
  if (!text.endsWith('\n') || text.endsWith('\n\n')) problems.push(`${where} must end with exactly one newline`);
  if (!text.includes(`\`${CLOUD_NAME}\``)) problems.push(`${where} must name the ${CLOUD_NAME} plugin`);
  if (!text.includes(spec.optIn)) problems.push(`${where} must say the plugin is opt-in ("${spec.optIn}")`);
  if (!text.includes(CLOUD_MCP_URL)) problems.push(`${where} must show ${CLOUD_MCP_URL}`);
  const otherUrls = (text.match(WISPLY_MCP_URL_RE) ?? []).map((u) => u.replace(/[.,;:]+$/, '')).filter((u) => u !== CLOUD_MCP_URL);
  if (otherUrls.length) problems.push(`${where} may show the remote server only as ${CLOUD_MCP_URL} (found ${otherUrls.join(', ')})`);
  if (!text.includes(DISCLOSURE)) problems.push(`${where} must say that what the app reads ${DISCLOSURE}`);
  // Cloud Connect's Access history shows the last 100 events and keeps them for 90 days: never "every read".
  if (/Access history/.test(text) && (!/kept for 90 days/.test(text) || /\bevery\b[^.]*\bread/i.test(text))) {
    problems.push(`${where} must describe Access history as Cloud Connect does (recent reads, kept for 90 days)`);
  }
  if (TOKEN_LIKE_RE.test(text) || /\bBearer\b|\bAuthorization\b/.test(text)) problems.push(`${where} must not contain a token or an auth header`);
  if (text.includes(MARKER_PREFIX)) problems.push(`${where} must not contain the wisply-cloud markers`);
  return problems;
}

/** Problems with cloud-connect/LIT.json, the reviewable record of who lit the plugin, and when. */
export function validateLitRecord(doc) {
  const where = PATHS.lit;
  if (!isPlainObject(doc)) return [`${where} isn't valid JSON or isn't a JSON object`];
  const problems = [];
  if (!sameKeys(doc, ['stage4Date', 'approvedBy'])) problems.push(`${where} must have exactly stage4Date and approvedBy`);
  if (!isIsoDate(doc.stage4Date) || doc.stage4Date < FIRST_STAGE_4_DATE) problems.push(`${where} stage4Date must be a real date (YYYY-MM-DD), the day Cloud Connect reached stage 4`);
  if (typeof doc.approvedBy !== 'string' || !/^[^\p{Cc}]{1,100}$/u.test(doc.approvedBy) || doc.approvedBy.trim() !== doc.approvedBy || doc.approvedBy === '') {
    problems.push(`${where} approvedBy must name who approved lighting (1-100 characters)`);
  }
  return problems;
}

/** The root plugin is local-only: its mcp.json may hold only stdio servers, and never wisply-cloud. */
export function rootPluginProblems(rootMcpText) {
  if (rootMcpText == null) return [];
  let doc;
  try { doc = JSON.parse(rootMcpText); } catch { return [`${PATHS.rootMcp} is not valid JSON`]; }
  const servers = isPlainObject(doc?.mcpServers) ? doc.mcpServers : {};
  const problems = [];
  if (Object.hasOwn(servers, CLOUD_NAME)) problems.push(`${PATHS.rootMcp} must not hold ${CLOUD_NAME}: the remote server lives only in cloud-connect/plugin/`);
  for (const [name, server] of Object.entries(servers)) {
    if (!isPlainObject(server) || server.type !== 'stdio' || Object.hasOwn(server, 'url')) {
      problems.push(`${PATHS.rootMcp} server ${name} must be a stdio server: the root plugin is local-only`);
    }
  }
  return problems;
}

/** Finds the marked block. `body` is the text between the marker lines. */
export function findBlock(text) {
  if (typeof text !== 'string') return { count: 0, body: null, start: -1, end: -1 };
  const starts = occurrences(text, BLOCK_START);
  const ends = occurrences(text, BLOCK_END);
  const stray = occurrences(text, MARKER_PREFIX).length - starts.length - ends.length;
  if (starts.length !== ends.length || stray !== 0) return { count: -1, body: null, start: -1, end: -1 };
  if (starts.length !== 1) return { count: starts.length, body: null, start: -1, end: -1 };
  const start = starts[0];
  const bodyStart = start + BLOCK_START.length + 1;
  const end = ends[0];
  if (end < bodyStart || text[bodyStart - 1] !== '\n' || (start > 0 && text[start - 1] !== '\n')) return { count: -1, body: null, start: -1, end: -1 };
  return { count: 1, body: text.slice(bodyStart, end), start, end: end + BLOCK_END.length };
}

/** Index of the first line matching `re` outside fenced code blocks, or -1. */
export function findAnchor(text, re) {
  let fence = null;
  let offset = 0;
  for (const line of text.split('\n')) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = null;
    } else if (marker) {
      fence = marker;
    } else if (re.test(line)) {
      return offset;
    }
    offset += line.length + 1;
  }
  return -1;
}

/** The expected text between the markers for a section. */
export function blockBody(kind, sectionText) {
  return `${blockNote(SECTIONS[kind].source)}\n${sectionText}`;
}

/**
 * State of the repository: 'dark' (unlisted, no sections, no LIT.json), 'lit' (all of them, equal to the
 * staged files) or 'invalid' with problems.
 */
export function cloudState(repo) {
  const { staged } = repo;
  const problems = [
    ...validateCloudPlugin(staged),
    ...validateMarketplaceEntry(staged.entry),
    ...validateSection(staged.readmeSection, 'readme'),
    ...validateSection(staged.securitySection, 'security'),
    ...rootPluginProblems(repo.rootMcpText),
    ...rootParityProblems(repo.rootPluginText, staged.manifest),
  ];
  const parts = {};
  let marketplace = null;
  if (repo.marketplaceText != null) {
    try { marketplace = JSON.parse(repo.marketplaceText); } catch { problems.push(`${PATHS.marketplace} is not valid JSON`); }
  }
  const listed = Array.isArray(marketplace?.plugins) ? marketplace.plugins.filter((p) => p?.name === CLOUD_NAME) : [];
  if (listed.length > 1) problems.push(`${PATHS.marketplace} lists ${CLOUD_NAME} more than once`);
  if (listed.length === 1 && !isDeepStrictEqual(listed[0], staged.entry)) problems.push(`${PATHS.marketplace} ${CLOUD_NAME} differs from ${PATHS.marketplaceEntry}; run apply again`);
  parts[`${CLOUD_NAME} in ${PATHS.marketplace}`] = listed.length > 0;
  for (const [kind, spec] of Object.entries(SECTIONS)) {
    const text = kind === 'readme' ? repo.readmeText : repo.securityText;
    const block = findBlock(text);
    if (block.count === -1) problems.push(`${spec.target} has unmatched or malformed wisply-cloud markers`);
    if (block.count > 1) problems.push(`${spec.target} has more than one wisply-cloud block`);
    if (block.count === 1 && block.body !== blockBody(kind, kind === 'readme' ? staged.readmeSection : staged.securitySection)) {
      problems.push(`the ${spec.target} wisply-cloud block differs from ${spec.source}; run apply again`);
    }
    parts[`the ${spec.target} block`] = block.count >= 1;
  }
  let lit = null;
  if (repo.litText != null) {
    try { lit = JSON.parse(repo.litText); } catch { lit = undefined; }
    problems.push(...validateLitRecord(lit));
  }
  parts[PATHS.lit] = repo.litText != null;
  const present = Object.keys(parts).filter((k) => parts[k]);
  const missing = Object.keys(parts).filter((k) => !parts[k]);
  if (present.length && missing.length) problems.push(`half-lit: has ${present.join(', ')} but not ${missing.join(', ')}`);
  if (problems.length) return { state: 'invalid', problems };
  return present.length ? { state: 'lit', problems, lit } : { state: 'dark', problems };
}

/**
 * Lists the plugin and adds (or re-syncs) both sections and LIT.json. Throws when the repo isn't ready.
 * `record` is {stage4Date, approvedBy}; it may be omitted when a valid LIT.json already exists.
 */
export function applyCloudEntry(repo, record = {}) {
  const { staged } = repo;
  const stagedProblems = [
    ...validateCloudPlugin(staged),
    ...validateMarketplaceEntry(staged.entry),
    ...validateSection(staged.readmeSection, 'readme'),
    ...validateSection(staged.securitySection, 'security'),
  ];
  if (stagedProblems.length) throw new Error(`the staged files are invalid: ${stagedProblems.join('; ')}`);
  if (repo.marketplaceText == null) throw new Error(`${PATHS.marketplace} not found: the Agent Plugin and Codex marketplace (DIST-M3) must land first`);
  if (repo.readmeText == null) throw new Error(`${PATHS.readme} not found: DIST-M1 must land first`);
  if (repo.securityText == null) throw new Error(`${PATHS.security} not found: DIST-M1 must land first`);
  const rootProblems = [...rootPluginProblems(repo.rootMcpText), ...rootParityProblems(repo.rootPluginText, staged.manifest)];
  if (rootProblems.length) throw new Error(`${rootProblems.join('; ')}; nothing was changed`);

  let litText;
  if (record.stage4Date != null || record.approvedBy != null) {
    const doc = { stage4Date: record.stage4Date, approvedBy: record.approvedBy };
    const problems = validateLitRecord(doc);
    if (problems.length) throw new Error(`${problems.join('; ')}; nothing was changed`);
    litText = serialize(doc);
  } else {
    let existing = null;
    try { existing = repo.litText == null ? null : JSON.parse(repo.litText); } catch { existing = null; }
    if (repo.litText == null || validateLitRecord(existing).length) {
      throw new Error(`lighting needs --stage-4-date YYYY-MM-DD and --approved-by NAME (they go into ${PATHS.lit}); nothing was changed`);
    }
    litText = repo.litText;
  }

  const marketplace = parseMarketplace(repo.marketplaceText);
  const plugins = marketplace.plugins.filter((p) => p?.name !== CLOUD_NAME);
  const localIndex = plugins.findIndex((p) => p?.name === LOCAL_NAME);
  plugins.splice(localIndex + 1, 0, structuredClone(staged.entry));
  const marketplaceText = isDeepStrictEqual(plugins, marketplace.plugins) ? repo.marketplaceText : serialize({ ...marketplace, plugins });

  return {
    marketplaceText,
    readmeText: insertBlock(repo.readmeText, 'readme', staged.readmeSection),
    securityText: insertBlock(repo.securityText, 'security', staged.securitySection),
    litText,
  };
}

/** Retract (new installs only): unlists the plugin, removes both sections and LIT.json. */
export function removeCloudEntry(repo) {
  let marketplaceText = repo.marketplaceText;
  if (marketplaceText != null) {
    let doc;
    try { doc = JSON.parse(marketplaceText); } catch { throw new Error(`${PATHS.marketplace} is not valid JSON; nothing was changed`); }
    if (Array.isArray(doc?.plugins) && doc.plugins.some((p) => p?.name === CLOUD_NAME)) {
      marketplaceText = serialize({ ...doc, plugins: doc.plugins.filter((p) => p?.name !== CLOUD_NAME) });
    }
  }
  return {
    marketplaceText,
    readmeText: removeBlock(repo.readmeText, PATHS.readme),
    securityText: removeBlock(repo.securityText, PATHS.security),
    litText: null,
  };
}

function insertBlock(text, kind, sectionText) {
  const block = findBlock(text);
  const target = SECTIONS[kind].target;
  if (block.count !== 0 && block.count !== 1) throw new Error(`${target} has unmatched or repeated wisply-cloud markers; fix them by hand first`);
  const marked = `${BLOCK_START}\n${blockBody(kind, sectionText)}${BLOCK_END}\n`;
  if (block.count === 1) return text.slice(0, block.start) + marked.slice(0, -1) + text.slice(block.end);
  const at = findAnchor(text, SECTIONS[kind].anchor);
  return at === -1 ? `${text.replace(/\n*$/, '\n\n')}${marked}` : `${text.slice(0, at)}${marked}\n${text.slice(at)}`;
}

function removeBlock(text, target) {
  const block = findBlock(text);
  if (block.count === -1 || block.count > 1) throw new Error(`${target} has unmatched or repeated wisply-cloud markers; fix them by hand first`);
  if (block.count === 0) return text;
  const before = text.slice(0, block.start);
  const after = text.slice(block.end).replace(/^\n\n?/, '');
  return after === '' ? before.replace(/\n*$/, '\n') : before + after;
}

/** The staged plugin shares author, license and repository with the root plugin once DIST-M3 adds it. */
function rootParityProblems(rootPluginText, manifest) {
  if (rootPluginText == null || !isPlainObject(manifest)) return [];
  let root;
  try { root = JSON.parse(rootPluginText); } catch { return [`${PATHS.rootPlugin} is not valid JSON`]; }
  return ['author', 'license', 'repository']
    .filter((k) => !isDeepStrictEqual(root?.[k], manifest[k]))
    .map((k) => `${PATHS.pluginManifest} ${k} must equal ${PATHS.rootPlugin} ${k}`);
}

function parseMarketplace(text) {
  let doc;
  try { doc = JSON.parse(text); } catch { throw new Error(`${PATHS.marketplace} is not valid JSON; nothing was changed`); }
  if (!isPlainObject(doc) || !Array.isArray(doc.plugins)) throw new Error(`${PATHS.marketplace} must be a Codex marketplace with a plugins array; nothing was changed`);
  const local = doc.plugins.find((p) => p?.name === LOCAL_NAME);
  if (!local || (local.source !== './' && local.source !== '.')) {
    throw new Error(`${PATHS.marketplace} has no local ${LOCAL_NAME} plugin at "./"; ${CLOUD_NAME} is only ever listed next to it; nothing was changed`);
  }
  return doc;
}

export function readRepo(root = DEFAULT_ROOT) {
  const read = (rel) => (existsSync(join(root, rel)) ? readFileSync(join(root, rel), 'utf8') : null);
  const json = (rel) => {
    const text = read(rel);
    try { return text == null ? null : JSON.parse(text); } catch { return null; }
  };
  return {
    rootMcpText: read(PATHS.rootMcp),
    rootPluginText: read(PATHS.rootPlugin),
    marketplaceText: read(PATHS.marketplace),
    readmeText: read(PATHS.readme),
    securityText: read(PATHS.security),
    litText: read(PATHS.lit),
    staged: {
      manifest: json(PATHS.pluginManifest),
      mcp: json(PATHS.pluginMcp),
      entry: json(PATHS.marketplaceEntry),
      readmeSection: read(PATHS.readmeSection),
      securitySection: read(PATHS.securitySection),
    },
  };
}

const KEYS = { marketplaceText: PATHS.marketplace, readmeText: PATHS.readme, securityText: PATHS.security, litText: PATHS.lit };
/** Write order that leaves only the safe half behind if it stops: disclosures before the listing, unlisting first. */
export const WRITE_ORDER = Object.freeze({
  apply: Object.freeze(['readmeText', 'securityText', 'litText', 'marketplaceText']),
  remove: Object.freeze(['marketplaceText', 'readmeText', 'securityText', 'litText']),
});

/**
 * Writes `after` over `before`: every new file goes to a temporary file first (nothing changes if one
 * fails), then the renames and deletions run in `order`.
 */
export function writeRepo(root, before, after, order, fs = { writeFileSync, renameSync, unlinkSync, existsSync }) {
  const changes = order
    .filter((key) => after[key] !== before[key])
    .map((key) => ({ key, path: join(root, KEYS[key]), text: after[key], tmp: null }));
  try {
    for (const change of changes) {
      if (change.text == null) continue;
      change.tmp = `${change.path}.cloud-entry-${process.pid}.tmp`;
      fs.writeFileSync(change.tmp, change.text);
    }
  } catch (error) {
    cleanUp(changes, fs);
    throw new Error(`couldn't write ${error.path ?? 'a temporary file'} (${error.code ?? error.message}); nothing was changed`);
  }
  let done = 0;
  try {
    for (const change of changes) {
      if (change.text == null) {
        if (fs.existsSync(change.path)) fs.unlinkSync(change.path);
      } else {
        fs.renameSync(change.tmp, change.path);
        change.tmp = null;
      }
      done += 1;
    }
  } catch (error) {
    cleanUp(changes, fs);
    const left = changes.slice(done).map((c) => KEYS[c.key]).join(', ');
    throw new Error(`stopped before ${left} (${error.code ?? error.message}); run check and fix it`);
  }
}

function cleanUp(changes, fs) {
  for (const change of changes) {
    if (!change.tmp) continue;
    try { fs.unlinkSync(change.tmp); } catch { /* already gone */ }
    change.tmp = null;
  }
}

function parseArgs(argv) {
  const options = { command: null, flags: new Set(), values: {} };
  const takesValue = new Set(['--root', '--stage-4-date', '--approved-by']);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const eq = arg.indexOf('=');
    const name = arg.startsWith('--') && eq !== -1 ? arg.slice(0, eq) : arg;
    if (takesValue.has(name)) {
      const value = eq !== -1 && arg.startsWith('--') ? arg.slice(eq + 1) : argv[(i += 1)];
      if (value == null || value === '' || value.startsWith('--')) options.bad = `${name} needs a value`;
      else options.values[name] = value;
    } else if (arg.startsWith('--')) {
      if (arg !== CONFIRM_FLAG && arg !== '--help') options.bad = `unknown option: ${arg}`;
      options.flags.add(arg);
    } else if (options.command == null) {
      options.command = arg;
    } else {
      options.extra = arg;
    }
  }
  return options;
}

const USAGE = `usage: node scripts/cloud-entry.mjs check | apply ${CONFIRM_FLAG} --stage-4-date YYYY-MM-DD --approved-by NAME | remove  [--root <dir>]\n`;

export function main(argv, { root = DEFAULT_ROOT, out = process.stdout, err = process.stderr, fs } = {}) {
  const options = parseArgs(argv);
  if (options.values['--root'] != null) root = resolve(options.values['--root']);
  const command = options.command ?? 'check';
  if (options.flags.has('--help') || command === 'help') {
    out.write(USAGE);
    return 0;
  }
  if (options.bad || options.extra != null || !['check', 'apply', 'remove'].includes(command)) {
    err.write(`${options.bad ?? `unknown command: ${options.extra ?? command}`}\n${USAGE}`);
    return 2;
  }
  const repo = readRepo(root);
  try {
    if (command === 'apply') {
      if (!options.flags.has(CONFIRM_FLAG)) {
        err.write(`Refusing: once this is on main, every Codex user of the marketplace can install ${CLOUD_NAME}. Run apply only after `
          + `Cloud Connect stage 4 (allow-list removed, ${CLOUD_MCP_URL} open to every Pro account), with ${CONFIRM_FLAG} `
          + '--stage-4-date YYYY-MM-DD --approved-by NAME. See cloud-connect/RUNBOOK.md.\n');
        return 2;
      }
      const after = applyCloudEntry(repo, { stage4Date: options.values['--stage-4-date'], approvedBy: options.values['--approved-by'] });
      writeRepo(root, repo, after, WRITE_ORDER.apply, fs);
    } else if (command === 'remove') {
      writeRepo(root, repo, removeCloudEntry(repo), WRITE_ORDER.remove, fs);
    }
  } catch (error) {
    err.write(`${error.message}\n`);
    return 1;
  }
  const { state, problems, lit } = cloudState(readRepo(root));
  if (state === 'invalid') {
    for (const p of problems) err.write(`${p}\n`);
    return 1;
  }
  out.write(state === 'lit'
    ? `${CLOUD_NAME}: lit since ${lit.stage4Date} (approved by ${lit.approvedBy}): listed in ${PATHS.marketplace}; README.md and SECURITY.md have its sections\n`
    : `${CLOUD_NAME}: dark (the plugin is in cloud-connect/plugin/ but isn't listed; README.md and SECURITY.md don't have its sections)\n`);
  return 0;
}

function serialize(doc) {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
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
