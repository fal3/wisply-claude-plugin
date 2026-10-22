// DIST-M6: `wisply-cloud`, the separate opt-in Agent Plugin for Cloud Connect (cloud-connect/plugin/),
// listed by scripts/cloud-entry.mjs after Cloud Connect stage 4. Optional upstream checks run when
// WISPLY_AI_DIR / WISPLY_WEB_DIR point at the app and web checkouts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as realFs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ce from '../scripts/cloud-entry.mjs';

const { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } = realFs;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts', 'cloud-entry.mjs');
const repo = ce.readRepo(ROOT);
const { staged } = repo;
const RECORD = { stage4Date: '2027-02-01', approvedBy: 'Alex Fallah' };
const RECORD_ARGS = ['--stage-4-date', RECORD.stage4Date, '--approved-by', RECORD.approvedBy];

// Root files as DIST-M1 and DIST-M3 specify them (canonical 2-space JSON).
const json = (doc) => `${JSON.stringify(doc, null, 2)}\n`;
const M3_MCP = json({
  $schema: ce.AGENT_PLUGINS_MCP_SCHEMA,
  mcpServers: { wisply: { type: 'stdio', command: 'node', args: ['${PLUGIN_ROOT}/bin/wisply-mcp.mjs'] } },
});
const M3_PLUGIN = json({
  $schema: ce.AGENT_PLUGINS_PLUGIN_SCHEMA,
  name: 'wisply',
  version: '0.1.0',
  description: 'Use your Wisply meeting notes, action items and live transcript from the Wisply app on this Mac.',
  author: { name: 'Wisply', email: 'support@wisply.ai', url: 'https://www.wisply.ai' },
  homepage: 'https://www.wisply.ai/docs/mcp/install',
  repository: 'https://github.com/fal3/wisply-mcp',
  license: 'MIT',
  keywords: ['wisply', 'meetings', 'transcripts', 'voice-memos', 'mcp', 'macos', 'local'],
});
const LOCAL_ENTRY = { name: 'wisply', source: './', category: 'productivity', description: 'Your Wisply meeting notes in Codex, from the Wisply app on this Mac.' };
const M3_MARKETPLACE = json({ name: 'wisply', interface: { displayName: 'Wisply' }, plugins: [LOCAL_ENTRY] });
const README = '# Wisply MCP\n\nIntro.\n\n## Install\n\n| Client | Setup |\n|---|---|\n| Codex | `codex mcp add wisply -- npx -y @wisply/mcp@0.1.0` |\n\n## Privacy\n\nTalks only to 127.0.0.1.\n\n## License\n\nMIT\n';
const README_NO_ANCHOR = '# Wisply MCP\n\nIntro.\n\n## Install\n\nSteps.\n';
const README_FENCED = '# Wisply MCP\n\n## Install\n\n````markdown\n## License\n```\nnested\n```\n````\n\n~~~\n## Privacy\n~~~\n\n## Privacy\n\nLocal.\n';
const SECURITY = '# Security\n\n## Reporting a problem\n\nUse the Security tab.\n\n## What the connector protects, and what it doesn\'t\n\n**Network.** Only 127.0.0.1.\n\n## If you think a token leaked\n\n1. Regenerate it.\n';
const SECURITY_NO_ANCHOR = '# Security\n\n## Reporting a problem\n\nUse the Security tab.\n';

const SERVER_VARIANTS = {
  stdio: { required: ['type', 'command'], allowed: ['type', 'command', 'args', 'env', 'cwd'] },
  'streamable-http': { required: ['type', 'url'], allowed: ['type', 'url', 'headers'] },
};

function repoWith({ rootMcp = M3_MCP, rootPlugin = M3_PLUGIN, marketplace = M3_MARKETPLACE, readme = README, security = SECURITY, lit = null, stagedOverride = {} } = {}) {
  return {
    rootMcpText: rootMcp,
    rootPluginText: rootPlugin,
    marketplaceText: marketplace,
    readmeText: readme,
    securityText: security,
    litText: lit,
    staged: { ...staged, ...stagedOverride },
  };
}

/** The repo after apply, as the same shape readRepo returns. */
function litRepo(base = repoWith(), record = RECORD) {
  return { ...base, ...ce.applyCloudEntry(base, record) };
}

function files(r) {
  return { marketplaceText: r.marketplaceText, readmeText: r.readmeText, securityText: r.securityText, litText: r.litText };
}

function tmpRepo({ rootMcp = M3_MCP, rootPlugin = M3_PLUGIN, marketplace = M3_MARKETPLACE, readme = README, security = SECURITY } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wisply-cloud-entry-'));
  cpSync(join(ROOT, 'cloud-connect'), join(dir, 'cloud-connect'), { recursive: true });
  rmSync(join(dir, ce.PATHS.lit), { force: true });
  const put = (rel, text) => {
    if (text == null) return;
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  };
  put(ce.PATHS.rootMcp, rootMcp);
  put(ce.PATHS.rootPlugin, rootPlugin);
  put(ce.PATHS.marketplace, marketplace);
  put(ce.PATHS.readme, readme);
  put(ce.PATHS.security, security);
  return dir;
}

function run(dir, ...args) {
  return spawnSync(process.execPath, [SCRIPT, ...args, '--root', dir], { encoding: 'utf8' });
}

function onDisk(dir) {
  const read = (rel) => (existsSync(join(dir, rel)) ? readFileSync(join(dir, rel), 'utf8') : null);
  return { marketplaceText: read(ce.PATHS.marketplace), readmeText: read(ce.PATHS.readme), securityText: read(ce.PATHS.security), litText: read(ce.PATHS.lit) };
}

function tmpFiles(dir) {
  return readdirSync(dir, { recursive: true }).filter((f) => String(f).endsWith('.tmp'));
}

// --- the staged plugin and files -------------------------------------------------------------------

test('the staged plugin is a separate Agent Plugin with only the streamable-http entry', () => {
  assert.deepEqual(ce.validateCloudPlugin(staged), []);
  assert.deepEqual(staged.mcp, {
    $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
    mcpServers: { 'wisply-cloud': { type: 'streamable-http', url: 'https://www.wisply.ai/mcp' } },
  });
  assert.equal(staged.manifest.name, 'wisply-cloud');
  assert.equal(staged.manifest.$schema, 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
  assert.match(staged.manifest.description, /wisply\.ai/);
  assert.ok(staged.manifest.keywords.includes('remote') && !staged.manifest.keywords.includes('local'));
  // The plugin root holds nothing but the two manifests: no skill that skills.sh could list while dark.
  assert.deepEqual(readdirSync(join(ROOT, 'cloud-connect', 'plugin')).sort(), ['mcp.json', 'plugin.json']);
});

test('staged plugin validation refuses headers, other transports, other URLs, extra servers and local wording', () => {
  const entry = staged.mcp.mcpServers['wisply-cloud'];
  const withEntry = (e) => ({ ...staged, mcp: { ...staged.mcp, mcpServers: { 'wisply-cloud': e } } });
  const withManifest = (m) => ({ ...staged, manifest: { ...staged.manifest, ...m } });
  const bad = {
    'headers (even empty)': withEntry({ ...entry, headers: {} }),
    'auth header': withEntry({ ...entry, headers: { Authorization: 'Bearer x' } }),
    sse: withEntry({ ...entry, type: 'sse' }),
    http: withEntry({ ...entry, url: 'http://www.wisply.ai/mcp' }),
    apex: withEntry({ ...entry, url: 'https://wisply.ai/mcp' }),
    placeholder: withEntry({ ...entry, url: 'https://www.wisply.ai/mcp?k=${env:TOKEN}' }),
    'user info': withEntry({ ...entry, url: 'https://u:p@www.wisply.ai/mcp' }),
    fragment: withEntry({ ...entry, url: 'https://www.wisply.ai/mcp#x' }),
    'extra server': { ...staged, mcp: { ...staged.mcp, mcpServers: { ...staged.mcp.mcpServers, wisply: { type: 'stdio', command: 'node' } } } },
    'wrong mcp schema': { ...staged, mcp: { ...staged.mcp, $schema: 'https://agent-plugins.org/schemas/1.1.0/mcp.schema.json' } },
    'extra mcp key': { ...staged, mcp: { ...staged.mcp, version: '1' } },
    'no mcp.json': { ...staged, mcp: null },
    'plugin named wisply': withManifest({ name: 'wisply' }),
    'keyword local': withManifest({ keywords: [...staged.manifest.keywords, 'local'] }),
    'no remote keyword': withManifest({ keywords: ['wisply', 'cloud'] }),
    'uppercase keyword': withManifest({ keywords: [...staged.manifest.keywords, 'Cloud'] }),
    'local description': withManifest({ description: 'Your Wisply notes from the Wisply app on this Mac, via Cloud Connect on wisply.ai.' }),
    'description without wisply.ai': withManifest({ description: 'Wisply memos with Cloud Connect.' }),
    'extensions field': withManifest({ extensions: { 'com.github.copilot': {} } }),
    'wrong plugin schema': withManifest({ $schema: 'https://agent-plugins.org/schemas/1.1.0/plugin.schema.json' }),
    'bad version': withManifest({ version: '1' }),
    'no plugin.json': { ...staged, manifest: null },
  };
  for (const [name, input] of Object.entries(bad)) {
    assert.notDeepEqual(ce.validateCloudPlugin(input), [], name);
  }
});

test('the marketplace entry points at the plugin, is never installed by default and says wisply.ai', () => {
  assert.deepEqual(ce.validateMarketplaceEntry(staged.entry), []);
  assert.deepEqual(Object.keys(staged.entry).sort(), ['category', 'description', 'name', 'source']);
  assert.equal(staged.entry.source, './cloud-connect/plugin');
  const bad = {
    'installed by default': { ...staged.entry, policy: { installation: 'INSTALLED_BY_DEFAULT' } },
    'root source': { ...staged.entry, source: './' },
    'other name': { ...staged.entry, name: 'wisply' },
    'local description': { ...staged.entry, description: 'From the Wisply app on this Mac, via wisply.ai.' },
    'no wisply.ai': { ...staged.entry, description: 'Your Wisply Cloud memos.' },
    missing: null,
  };
  for (const [name, entry] of Object.entries(bad)) assert.notDeepEqual(ce.validateMarketplaceEntry(entry), [], name);
});

test('the staged README and SECURITY sections follow their rules', () => {
  assert.deepEqual(ce.validateSection(staged.readmeSection, 'readme'), []);
  assert.deepEqual(ce.validateSection(staged.securitySection, 'security'), []);
  assert.ok(staged.readmeSection.includes('codex mcp login wisply-cloud'));
  assert.ok(staged.readmeSection.includes('records are kept for 90 days'));
  for (const kind of ['readme', 'security']) {
    const text = kind === 'readme' ? staged.readmeSection : staged.securitySection;
    const bad = {
      'no heading': text.replace(/^## [^\n]+\n/, '## Remote\n'),
      'apex URL': `${text}- https://wisply.ai/mcp\n`,
      'http URL': `${text}- http://www.wisply.ai/mcp\n`,
      'longer URL': `${text}- https://www.wisply.ai/mcp/v2\n`,
      token: `${text}- wspc_${'a'.repeat(64)}\n`,
      bearer: `${text}- Authorization: Bearer x\n`,
      marker: `${text}${ce.BLOCK_END}\n`,
      'no disclosure': text.replace('is sent to the AI service that app uses', 'goes to the app'),
      'not opt-in': text.replace(ce.SECTIONS[kind].optIn, 'which comes with the plugin'),
      'every read': `${text}- Access history lists every read, kept for 90 days.\n`,
      'two trailing newlines': `${text}\n`,
    };
    for (const [name, input] of Object.entries(bad)) assert.notDeepEqual(ce.validateSection(input, kind), [], `${kind}: ${name}`);
  }
});

test('LIT.json validation: a real stage-4 date and an approver', () => {
  assert.deepEqual(ce.validateLitRecord(RECORD), []);
  for (const doc of [null, {}, { stage4Date: '2027-02-30', approvedBy: 'Alex' }, { stage4Date: '2026-01-01', approvedBy: 'Alex' },
    { stage4Date: '2027-02-01', approvedBy: '' }, { stage4Date: '2027-02-01', approvedBy: 'A\nB' }, { ...RECORD, note: 'x' }]) {
    assert.notDeepEqual(ce.validateLitRecord(doc), [], JSON.stringify(doc));
  }
});

// --- the repository ---------------------------------------------------------------------------------

test('CI gate: this repository is dark, or fully lit with a LIT.json record', () => {
  // Lighting is a reviewable change: cloudState accepts 'lit' only with cloud-connect/LIT.json naming the
  // stage-4 date and the approver, and every other mix of listed/unlisted parts is 'invalid'.
  const { state, problems } = ce.cloudState(repo);
  assert.deepEqual(problems, []);
  assert.ok(state === 'dark' || state === 'lit', state);
  assert.equal(existsSync(join(ROOT, ce.PATHS.lit)), state === 'lit');
});

test('the root plugin is local-only: its mcp.json never holds the remote server', () => {
  assert.deepEqual(ce.rootPluginProblems(repo.rootMcpText), []);
  assert.deepEqual(ce.rootPluginProblems(M3_MCP), []);
  const withCloud = json({ ...JSON.parse(M3_MCP), mcpServers: { ...JSON.parse(M3_MCP).mcpServers, 'wisply-cloud': staged.mcp.mcpServers['wisply-cloud'] } });
  const withOtherRemote = json({ ...JSON.parse(M3_MCP), mcpServers: { ...JSON.parse(M3_MCP).mcpServers, other: { type: 'streamable-http', url: 'https://example.com/mcp' } } });
  assert.notDeepEqual(ce.rootPluginProblems(withCloud), []);
  assert.notDeepEqual(ce.rootPluginProblems(withOtherRemote), []);
  assert.notDeepEqual(ce.rootPluginProblems('{'), []);
  for (const rootMcp of [withCloud, withOtherRemote]) {
    assert.equal(ce.cloudState(repoWith({ rootMcp })).state, 'invalid');
    assert.throws(() => ce.applyCloudEntry(repoWith({ rootMcp }), RECORD), /local-only|must not hold/);
  }
});

test('the cloud plugin shares author, license and repository with the root plugin (DIST-M3)', () => {
  assert.deepEqual(ce.cloudState(repoWith()), { state: 'dark', problems: [] });
  const other = json({ ...JSON.parse(M3_PLUGIN), license: 'Apache-2.0' });
  assert.match(ce.cloudState(repoWith({ rootPlugin: other })).problems.join('\n'), /license/);
});

test('registry/cloud.server.json and the plugin name the same remote', (t) => {
  const path = join(ROOT, 'registry', 'cloud.server.json');
  if (!existsSync(path)) return t.skip('registry/cloud.server.json arrives with DIST-M3');
  const server = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(server.name, 'ai.wisply/cloud');
  assert.deepEqual(server.remotes, [{ type: 'streamable-http', url: staged.mcp.mcpServers['wisply-cloud'].url }]);
});

// --- apply / remove ---------------------------------------------------------------------------------

test('apply lists wisply-cloud after the local plugin, adds both sections and LIT.json, and leaves the root plugin alone', () => {
  const base = repoWith();
  const out = ce.applyCloudEntry(base, RECORD);
  assert.deepEqual(Object.keys(out).sort(), ['litText', 'marketplaceText', 'readmeText', 'securityText']);
  const marketplace = JSON.parse(out.marketplaceText);
  assert.deepEqual(marketplace.plugins.map((p) => p.name), ['wisply', 'wisply-cloud']);
  assert.deepEqual(marketplace.plugins[0], LOCAL_ENTRY);
  assert.deepEqual(marketplace.plugins[1], staged.entry);
  assert.deepEqual({ ...marketplace, plugins: undefined }, { ...JSON.parse(M3_MARKETPLACE), plugins: undefined });
  for (const [name, server] of Object.entries(staged.mcp.mcpServers)) {
    const variant = SERVER_VARIANTS[server.type];
    assert.ok(variant, `${name}: closed variant`);
    for (const key of variant.required) assert.ok(Object.hasOwn(server, key), `${name}.${key}`);
    for (const key of Object.keys(server)) assert.ok(variant.allowed.includes(key), `${name}.${key} allowed`);
  }
  const block = (kind, text) => `${ce.BLOCK_START}\n${ce.blockNote(ce.SECTIONS[kind].source)}\n${text}${ce.BLOCK_END}\n`;
  assert.ok(out.readmeText.includes(`|\n\n${block('readme', staged.readmeSection)}\n## Privacy`));
  assert.ok(out.securityText.includes(`127.0.0.1.\n\n${block('security', staged.securitySection)}\n## If you think a token leaked`));
  assert.deepEqual(JSON.parse(out.litText), RECORD);
  const lit = ce.cloudState({ ...base, ...out });
  assert.equal(lit.state, 'lit', lit.problems.join('\n'));
  assert.deepEqual(lit.lit, RECORD);
  for (const text of Object.values(out)) {
    assert.ok(!/wsp[cr]?_[0-9a-f]{64}|\bBearer\b|\bAuthorization\b/.test(text), 'no secret in the lit files');
  }
});

test('the markers are stable and the guidance line names the runbook', () => {
  assert.equal(ce.BLOCK_START, '<!-- wisply-cloud:start -->');
  assert.equal(ce.BLOCK_END, '<!-- wisply-cloud:end -->');
  for (const kind of Object.keys(ce.SECTIONS)) {
    const note = ce.blockNote(ce.SECTIONS[kind].source);
    assert.ok(!note.includes('<!-- wisply-cloud:'), 'the note is not a marker');
    assert.match(note, /cloud-connect\/RUNBOOK\.md/);
  }
  // A lit file with an older guidance line is drift that apply repairs, not a stray marker.
  const once = litRepo();
  const oldNote = once.readmeText.replace(/<!-- Generated from [^\n]*-->/, '<!-- old guidance -->');
  const state = ce.cloudState({ ...once, readmeText: oldNote });
  assert.equal(state.state, 'invalid');
  assert.match(state.problems.join('\n'), /differs from cloud-connect\/README-cloud\.md; run apply again/);
  assert.deepEqual(files(litRepo({ ...once, readmeText: oldNote }, {})), files(once));
});

test('apply is idempotent and remove restores the original bytes', () => {
  for (const [readme, security] of [[README, SECURITY], [README_NO_ANCHOR, SECURITY_NO_ANCHOR], [README_FENCED, SECURITY]]) {
    const base = repoWith({ readme, security });
    const once = litRepo(base);
    assert.deepEqual(files(litRepo(once, RECORD)), files(once), 'same record');
    assert.deepEqual(files(litRepo(once, {})), files(once), 'keeps the existing LIT.json');
    assert.deepEqual(ce.removeCloudEntry(once), { marketplaceText: M3_MARKETPLACE, readmeText: readme, securityText: security, litText: null });
  }
  const noAnchor = litRepo(repoWith({ readme: README_NO_ANCHOR, security: SECURITY_NO_ANCHOR }));
  assert.ok(noAnchor.readmeText.endsWith(`Steps.\n\n${ce.BLOCK_START}\n${ce.blockBody('readme', staged.readmeSection)}${ce.BLOCK_END}\n`));
  assert.deepEqual(ce.removeCloudEntry(repoWith()), { marketplaceText: M3_MARKETPLACE, readmeText: README, securityText: SECURITY, litText: null });
  assert.deepEqual(ce.removeCloudEntry(repoWith({ marketplace: null, readme: null, security: null })), { marketplaceText: null, readmeText: null, securityText: null, litText: null });
});

test('the README anchor skips fenced code', () => {
  const out = litRepo(repoWith({ readme: README_FENCED }));
  const fenceEnd = out.readmeText.indexOf('~~~\n\n') + 5;
  const start = out.readmeText.indexOf(ce.BLOCK_START);
  assert.equal(start, fenceEnd, 'the block goes before the real "## Privacy", after both fences');
  assert.ok(out.readmeText.includes('````markdown\n## License\n```\nnested\n```\n````\n'), 'the fences are intact');
  assert.equal(ce.findAnchor(README_FENCED, ce.SECTIONS.readme.anchor), README_FENCED.lastIndexOf('## Privacy'));
  assert.equal(ce.findAnchor('```\n## License\n', ce.SECTIONS.readme.anchor), -1, 'an unclosed fence hides the rest');
});

test('remove keeps the data of a non-canonical marketplace.json', () => {
  const compact = JSON.stringify(JSON.parse(M3_MARKETPLACE));
  const round = ce.removeCloudEntry(litRepo(repoWith({ marketplace: compact })));
  assert.deepEqual(JSON.parse(round.marketplaceText), JSON.parse(compact));
  assert.equal(round.readmeText, README);
  assert.equal(round.securityText, SECURITY);
});

test('apply re-syncs a drifted entry or section', () => {
  const once = litRepo();
  const driftedMarketplace = once.marketplaceText.replace('./cloud-connect/plugin', './cloud');
  const driftedReadme = once.readmeText.replace('Eight read-only tools', 'Nine read-only tools');
  const driftedSecurity = once.securityText.replace('stop working at once', 'stop working');
  assert.equal(ce.cloudState({ ...once, marketplaceText: driftedMarketplace }).state, 'invalid');
  assert.equal(ce.cloudState({ ...once, readmeText: driftedReadme }).state, 'invalid');
  assert.equal(ce.cloudState({ ...once, securityText: driftedSecurity }).state, 'invalid');
  assert.deepEqual(files(litRepo({ ...once, marketplaceText: driftedMarketplace, readmeText: driftedReadme, securityText: driftedSecurity }, {})), files(once));
});

test('apply refuses when the repository is not ready, and on bad input', () => {
  const noLocal = json({ ...JSON.parse(M3_MARKETPLACE), plugins: [] });
  const cases = [
    [repoWith({ marketplace: null }), RECORD, /DIST-M3/],
    [repoWith({ readme: null }), RECORD, /README\.md not found: DIST-M1/],
    [repoWith({ security: null }), RECORD, /SECURITY\.md not found: DIST-M1/],
    [repoWith({ marketplace: '{' }), RECORD, /not valid JSON/],
    [repoWith({ marketplace: json({ name: 'wisply' }) }), RECORD, /plugins array/],
    [repoWith({ marketplace: noLocal }), RECORD, /no local wisply plugin/],
    [repoWith({ readme: `${README}${ce.BLOCK_START}\n` }), RECORD, /markers/],
    [repoWith({ stagedOverride: { mcp: { ...staged.mcp, $schema: 'x' } } }), RECORD, /staged files are invalid/],
    [repoWith(), {}, /--stage-4-date/],
    [repoWith({ lit: '{' }), {}, /--stage-4-date/],
    [repoWith(), { stage4Date: '2027-13-01', approvedBy: 'Alex' }, /stage4Date/],
    [repoWith(), { stage4Date: '2027-02-01' }, /approvedBy/],
  ];
  for (const [input, record, message] of cases) {
    assert.throws(() => ce.applyCloudEntry(input, record), message);
  }
});

test('check refuses half-lit and broken states', () => {
  const once = litRepo();
  const cases = {
    'listed without sections': { ...repoWith(), marketplaceText: once.marketplaceText, litText: once.litText },
    'sections without the listing': { ...once, marketplaceText: M3_MARKETPLACE },
    'lit without LIT.json (CI gate)': { ...once, litText: null },
    'LIT.json while dark': { ...repoWith(), litText: once.litText },
    'invalid LIT.json': { ...once, litText: json({ stage4Date: 'soon', approvedBy: 'Alex' }) },
    'README block only': { ...repoWith(), readmeText: once.readmeText },
    'SECURITY block only': { ...repoWith(), securityText: once.securityText },
    'listed twice': { ...once, marketplaceText: json({ ...JSON.parse(once.marketplaceText), plugins: [...JSON.parse(once.marketplaceText).plugins, staged.entry] }) },
    'two README blocks': { ...once, readmeText: `${once.readmeText}${ce.BLOCK_START}\n${ce.blockBody('readme', staged.readmeSection)}${ce.BLOCK_END}\n` },
    'stray marker': { ...repoWith(), readmeText: `${README}<!-- wisply-cloud:other -->\n` },
    'invalid marketplace.json': { ...repoWith(), marketplaceText: '{' },
    'remote server in the root mcp.json': { ...once, rootMcpText: json({ $schema: ce.AGENT_PLUGINS_MCP_SCHEMA, mcpServers: { wisply: JSON.parse(M3_MCP).mcpServers.wisply, 'wisply-cloud': staged.mcp.mcpServers['wisply-cloud'] } }) },
  };
  for (const [name, input] of Object.entries(cases)) {
    const result = ce.cloudState(input);
    assert.equal(result.state, 'invalid', name);
    assert.ok(result.problems.length > 0, name);
  }
  assert.match(ce.cloudState(cases['lit without LIT.json (CI gate)']).problems.join('\n'), /half-lit: .* but not cloud-connect\/LIT\.json/);
  assert.deepEqual(ce.cloudState(repoWith({ rootMcp: null, rootPlugin: null, marketplace: null, readme: null, security: null })), { state: 'dark', problems: [] });
  assert.deepEqual(ce.cloudState(repoWith()), { state: 'dark', problems: [] });
});

// --- writing ------------------------------------------------------------------------------------------

/** fs that fails the call `fail(op, path)` names, otherwise the real one. */
function failingFs(fail) {
  const wrap = (op) => (path, ...rest) => {
    if (fail(op, String(path))) throw Object.assign(new Error(`injected ${op} failure`), { code: 'EIO', path: String(path) });
    return realFs[op](path, ...rest);
  };
  return { writeFileSync: wrap('writeFileSync'), renameSync: wrap('renameSync'), unlinkSync: wrap('unlinkSync'), existsSync: realFs.existsSync };
}

test('apply writes the listing last: a failure leaves the disclosures without the listing, never the reverse', () => {
  const dir = tmpRepo();
  try {
    const before = ce.readRepo(dir);
    const after = ce.applyCloudEntry(before, RECORD);
    const fs = failingFs((op, path) => op === 'renameSync' && path.includes('marketplace.json'));
    assert.throws(() => ce.writeRepo(dir, before, after, ce.WRITE_ORDER.apply, fs), /stopped before \.agents\/plugins\/marketplace\.json/);
    const now = onDisk(dir);
    assert.equal(now.marketplaceText, M3_MARKETPLACE, 'not listed');
    assert.equal(now.readmeText, after.readmeText);
    assert.equal(now.securityText, after.securityText);
    assert.deepEqual(tmpFiles(dir), []);
    const state = ce.cloudState(ce.readRepo(dir));
    assert.equal(state.state, 'invalid');
    assert.match(state.problems.join('\n'), /half-lit: .* but not wisply-cloud in \.agents\/plugins\/marketplace\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed temporary write changes nothing', () => {
  const dir = tmpRepo();
  try {
    const before = ce.readRepo(dir);
    const after = ce.applyCloudEntry(before, RECORD);
    const fs = failingFs((op, path) => op === 'writeFileSync' && path.includes('SECURITY.md'));
    assert.throws(() => ce.writeRepo(dir, before, after, ce.WRITE_ORDER.apply, fs), /nothing was changed/);
    assert.deepEqual(onDisk(dir), { marketplaceText: M3_MARKETPLACE, readmeText: README, securityText: SECURITY, litText: null });
    assert.deepEqual(tmpFiles(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('remove unlists first: a failure leaves the disclosures in place, never the listing', () => {
  const dir = tmpRepo();
  try {
    assert.equal(run(dir, 'apply', ce.CONFIRM_FLAG, ...RECORD_ARGS).status, 0);
    const before = ce.readRepo(dir);
    const after = ce.removeCloudEntry(before);
    const fs = failingFs((op, path) => op === 'renameSync' && path.includes('README.md'));
    assert.throws(() => ce.writeRepo(dir, before, after, ce.WRITE_ORDER.remove, fs), /stopped before README\.md/);
    const now = onDisk(dir);
    assert.equal(now.marketplaceText, M3_MARKETPLACE, 'unlisted');
    assert.equal(now.readmeText, before.readmeText, 'the disclosure stays');
    assert.deepEqual(tmpFiles(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: check, apply only with the stage-4 confirmation and record, remove', () => {
  const dir = tmpRepo();
  try {
    let r = run(dir);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /wisply-cloud: dark/);

    r = run(dir, 'apply');
    assert.equal(r.status, 2);
    assert.match(r.stderr, /Cloud Connect stage 4/);
    assert.match(r.stderr, /--confirm-cloud-connect-stage-4 --stage-4-date YYYY-MM-DD --approved-by NAME/);
    r = run(dir, 'apply', ce.CONFIRM_FLAG);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--stage-4-date/);
    r = run(dir, 'apply', '--confirm-cloud-connect-stage4', ...RECORD_ARGS);
    assert.equal(r.status, 2, 'a mistyped confirmation is an unknown option');
    assert.deepEqual(onDisk(dir), { marketplaceText: M3_MARKETPLACE, readmeText: README, securityText: SECURITY, litText: null });

    r = run(dir, 'apply', ce.CONFIRM_FLAG, ...RECORD_ARGS);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /wisply-cloud: lit since 2027-02-01 \(approved by Alex Fallah\)/);
    assert.deepEqual(onDisk(dir), files(litRepo()));
    assert.equal(readFileSync(join(dir, ce.PATHS.rootMcp), 'utf8'), M3_MCP, 'the root plugin is untouched');
    assert.equal(readFileSync(join(dir, ce.PATHS.rootPlugin), 'utf8'), M3_PLUGIN);
    assert.deepEqual(tmpFiles(dir), []);

    r = run(dir, 'apply', ce.CONFIRM_FLAG);
    assert.equal(r.status, 0, `re-sync keeps the record: ${r.stderr}`);
    r = run(dir, 'check');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /lit/);

    r = run(dir, 'remove');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /dark/);
    assert.deepEqual(onDisk(dir), { marketplaceText: M3_MARKETPLACE, readmeText: README, securityText: SECURITY, litText: null });

    writeFileSync(join(dir, ce.PATHS.marketplace), litRepo().marketplaceText);
    r = run(dir, 'check');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /half-lit/);

    assert.equal(run(dir, 'frobnicate').status, 2);
    assert.equal(run(dir, 'check', 'extra').status, 2);
    assert.equal(run(dir, '--help').status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: apply before DIST-M3 changes nothing', () => {
  const dir = tmpRepo({ rootMcp: null, rootPlugin: null, marketplace: null });
  try {
    const r = run(dir, 'apply', ce.CONFIRM_FLAG, ...RECORD_ARGS);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /DIST-M3/);
    assert.deepEqual(onDisk(dir), { marketplaceText: null, readmeText: README, securityText: SECURITY, litText: null });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the flip script stays offline and spawns nothing', () => {
  const source = readFileSync(SCRIPT, 'utf8');
  for (const forbidden of [/from 'node:(?:http|https|net|tls|dgram|child_process)'/, /\bfetch\(/, /\bimport\(/, /\beval\(/]) {
    assert.ok(!forbidden.test(source), String(forbidden));
  }
});

// --- upstream (optional) --------------------------------------------------------------------------------

/** True when config.ts defines MCP_RESOURCE as `${origin}/mcp` (PRM_URL also ends in /mcp, so match the name). */
function definesMcpResource(source) {
  return /\bMCP_RESOURCE\b[^=\n]*=\s*`\$\{[^}]+\}\/mcp`/.test(source);
}

/** The tool names of the `mcp.*` audit actions in audit.ts. */
function auditedMcpTools(source) {
  const list = /\bAUDIT_ACTIONS\b[^=]*=\s*\[([\s\S]*?)\]/.exec(source)?.[1] ?? '';
  return [...list.matchAll(/['"`]mcp\.([a-z_]+)['"`]/g)].map((m) => m[1]).sort();
}

/** The cloud tool names in the README section's Tools row. */
function readmeCloudTools(sectionText) {
  const row = sectionText.split('\n').find((line) => line.startsWith('| Tools |')) ?? '';
  const cells = row.split('|').map((c) => c.trim()).filter(Boolean);
  return [...(cells.at(-1) ?? '').matchAll(/`([a-z_]+)`/g)].map((m) => m[1]).sort();
}

test('upstream parsers: strict MCP_RESOURCE match and the audited tool list', () => {
  const config = "export const cloudOrigin = () => process.env.CLOUD_PUBLIC_ORIGIN ?? 'https://www.wisply.ai';\n"
    + 'export const MCP_RESOURCE = `${cloudOrigin()}/mcp`;\nexport const PRM_URL = `${cloudOrigin()}/.well-known/oauth-protected-resource/mcp`;\n';
  assert.ok(definesMcpResource(config));
  assert.ok(!definesMcpResource(config.replace('`${cloudOrigin()}/mcp`;', '`${cloudOrigin()}/api/mcp`;')), 'a moved MCP_RESOURCE fails even though PRM_URL ends in /mcp');
  const audit = "export const AUDIT_ACTIONS = ['mcp.list_memos','mcp.search_memos','mcp.get_memo','mcp.get_transcript','mcp.get_action_items',"
    + "'mcp.search','mcp.fetch','mcp.get_account_status','api.list_memos','grant.created'] as const;";
  assert.deepEqual(auditedMcpTools(audit), readmeCloudTools(staged.readmeSection));
  assert.equal(readmeCloudTools(staged.readmeSection).length, 8);
  assert.match(staged.readmeSection, /Eight read-only tools/);
});

function findFile(dir, name, depth = 6) {
  if (depth < 0 || !existsSync(dir)) return null;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.') || entry.name === 'DerivedData') continue;
    const path = join(dir, entry.name);
    if (entry.isFile() && entry.name === name) return path;
    if (entry.isDirectory()) {
      const found = findFile(path, name, depth - 1);
      if (found) return found;
    }
  }
  return null;
}

test('upstream: the app pins the same Cloud Connect MCP URL (WISPLY_AI_DIR)', (t) => {
  if (!process.env.WISPLY_AI_DIR) return t.skip('WISPLY_AI_DIR not set');
  const path = findFile(join(process.env.WISPLY_AI_DIR, 'Wisply'), 'CloudConnectConfiguration.swift');
  if (!path) return t.skip('CloudConnectConfiguration.swift not in this wisply-ai checkout yet (Cloud Connect app PRs)');
  assert.match(readFileSync(path, 'utf8'), /mcpServerURL\s*=\s*"https:\/\/www\.wisply\.ai\/mcp"/);
});

test('upstream: wisply-web serves the remote MCP at the same origin and path, with the same tools (WISPLY_WEB_DIR)', (t) => {
  if (!process.env.WISPLY_WEB_DIR) return t.skip('WISPLY_WEB_DIR not set');
  const lib = join(process.env.WISPLY_WEB_DIR, 'src', 'lib', 'cloud-connect');
  const config = join(lib, 'config.ts');
  if (!existsSync(config)) return t.skip('src/lib/cloud-connect/config.ts not in this wisply-web checkout yet (Cloud Connect W2)');
  const source = readFileSync(config, 'utf8');
  assert.match(source, /['"`]https:\/\/www\.wisply\.ai['"`]/);
  assert.ok(definesMcpResource(source), 'MCP_RESOURCE = `${origin}/mcp`');
  const audit = join(lib, 'audit.ts');
  if (existsSync(audit)) assert.deepEqual(auditedMcpTools(readFileSync(audit, 'utf8')), readmeCloudTools(staged.readmeSection));
  const route = join(process.env.WISPLY_WEB_DIR, 'src', 'app', 'mcp', 'route.ts');
  if (existsSync(join(process.env.WISPLY_WEB_DIR, 'src', 'app', 'mcp'))) assert.ok(existsSync(route), 'src/app/mcp/route.ts');
});
