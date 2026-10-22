// DIST-M6: the Agent Plugin's remote entry `wisply-cloud` (staged in cloud-connect/, lit by
// scripts/cloud-entry.mjs after Cloud Connect stage 4). Optional upstream checks run when
// WISPLY_AI_DIR / WISPLY_WEB_DIR point at the app and web checkouts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ce from '../scripts/cloud-entry.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts', 'cloud-entry.mjs');
const repo = ce.readRepo(ROOT);
const { stagedDoc, sectionText } = repo;
const staged = { stagedDoc, sectionText };

// Root mcp.json as DIST-M3 specifies it (canonical 2-space formatting).
const M3_MCP = `${JSON.stringify({
  $schema: ce.AGENT_PLUGINS_MCP_SCHEMA,
  mcpServers: { wisply: { type: 'stdio', command: 'node', args: ['${PLUGIN_ROOT}/bin/wisply-mcp.mjs'] } },
}, null, 2)}\n`;
const README = '# Wisply MCP\n\nIntro.\n\n## Install\n\n| Client | Setup |\n|---|---|\n| Codex | `codex mcp add wisply -- npx -y @wisply/mcp@0` |\n\n## Privacy\n\nTalks only to 127.0.0.1.\n\n## License\n\nMIT\n';
const README_NO_ANCHOR = '# Wisply MCP\n\nIntro.\n\n## Install\n\nSteps.\n';

const SERVER_VARIANTS = {
  stdio: { required: ['type', 'command'], allowed: ['type', 'command', 'args', 'env', 'cwd'] },
  'streamable-http': { required: ['type', 'url'], allowed: ['type', 'url', 'headers'] },
};

function lit(mcpText = M3_MCP, readmeText = README) {
  return ce.applyCloudEntry({ mcpText, readmeText, ...staged });
}

function tmpRepo({ mcp = M3_MCP, readme = README } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wisply-cloud-entry-'));
  cpSync(join(ROOT, 'cloud-connect'), join(dir, 'cloud-connect'), { recursive: true });
  if (mcp != null) writeFileSync(join(dir, 'mcp.json'), mcp);
  if (readme != null) writeFileSync(join(dir, 'README.md'), readme);
  return dir;
}

function run(dir, ...args) {
  return spawnSync(process.execPath, [SCRIPT, ...args, '--root', dir], { encoding: 'utf8' });
}

function readOrNull(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

test('the staged entry is the spec entry: streamable-http to https://www.wisply.ai/mcp, nothing else', () => {
  assert.deepEqual(ce.validateStagedEntry(stagedDoc), []);
  assert.deepEqual(stagedDoc, {
    $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
    mcpServers: { 'wisply-cloud': { type: 'streamable-http', url: 'https://www.wisply.ai/mcp' } },
  });
});

test('staged-entry validation refuses headers, other transports, other URLs and extra servers', () => {
  const entry = stagedDoc.mcpServers['wisply-cloud'];
  const withEntry = (e) => ({ ...stagedDoc, mcpServers: { 'wisply-cloud': e } });
  const bad = {
    'headers (even empty)': withEntry({ ...entry, headers: {} }),
    'auth header': withEntry({ ...entry, headers: { Authorization: 'Bearer x' } }),
    sse: withEntry({ ...entry, type: 'sse' }),
    http: withEntry({ ...entry, url: 'http://www.wisply.ai/mcp' }),
    apex: withEntry({ ...entry, url: 'https://wisply.ai/mcp' }),
    placeholder: withEntry({ ...entry, url: 'https://www.wisply.ai/mcp?k=${env:TOKEN}' }),
    'user info': withEntry({ ...entry, url: 'https://u:p@www.wisply.ai/mcp' }),
    fragment: withEntry({ ...entry, url: 'https://www.wisply.ai/mcp#x' }),
    'extra server': { ...stagedDoc, mcpServers: { ...stagedDoc.mcpServers, wisply: { type: 'stdio', command: 'node' } } },
    'wrong schema': { ...stagedDoc, $schema: 'https://agent-plugins.org/schemas/1.1.0/mcp.schema.json' },
    'extra top-level key': { ...stagedDoc, version: '1' },
    'not an object': null,
  };
  for (const [name, doc] of Object.entries(bad)) {
    assert.notDeepEqual(ce.validateStagedEntry(doc), [], name);
  }
});

test('the staged README section follows its rules', () => {
  assert.deepEqual(ce.validateSection(sectionText), []);
  assert.ok(sectionText.includes('codex mcp login wisply-cloud'));
  const bad = {
    'no heading': sectionText.replace('## Cloud\n', '## Remote\n'),
    'apex URL': `${sectionText}- https://wisply.ai/mcp\n`,
    'http URL': `${sectionText}- http://www.wisply.ai/mcp\n`,
    'longer URL': `${sectionText}- https://www.wisply.ai/mcp/v2\n`,
    token: `${sectionText}- wspc_${'a'.repeat(64)}\n`,
    bearer: `${sectionText}- Authorization: Bearer x\n`,
    marker: `${sectionText}${ce.README_END}\n`,
    'no disclosure': sectionText.replace('is sent to the AI service that app uses', 'goes to the app'),
    'two trailing newlines': `${sectionText}\n`,
  };
  for (const [name, text] of Object.entries(bad)) {
    assert.notDeepEqual(ce.validateSection(text), [], name);
  }
  assert.deepEqual(ce.validateSection(sectionText.replace('remove that entry,', 'remove `https://www.wisply.ai/mcp`.')), []);
});

test('this repository is dark or lit, never half-lit or drifted', () => {
  const { state, problems } = ce.cloudState(repo);
  assert.deepEqual(problems, []);
  assert.ok(state === 'dark' || state === 'lit', state);
});

test('registry/cloud.server.json and the plugin entry name the same remote', (t) => {
  const path = join(ROOT, 'registry', 'cloud.server.json');
  if (!existsSync(path)) return t.skip('registry/cloud.server.json arrives with DIST-M3');
  const server = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(server.name, 'ai.wisply/cloud');
  assert.deepEqual(server.remotes, [{ type: 'streamable-http', url: stagedDoc.mcpServers['wisply-cloud'].url }]);
});

test('apply adds wisply-cloud after the local server and the section before Privacy', () => {
  const out = lit();
  const mcp = JSON.parse(out.mcpText);
  assert.deepEqual(Object.keys(mcp), ['$schema', 'mcpServers']);
  assert.deepEqual(Object.keys(mcp.mcpServers), ['wisply', 'wisply-cloud']);
  assert.deepEqual(mcp.mcpServers.wisply, JSON.parse(M3_MCP).mcpServers.wisply);
  assert.deepEqual(mcp.mcpServers['wisply-cloud'], stagedDoc.mcpServers['wisply-cloud']);
  for (const [name, server] of Object.entries(mcp.mcpServers)) {
    const variant = SERVER_VARIANTS[server.type];
    assert.ok(variant, `${name}: closed variant`);
    for (const key of variant.required) assert.ok(Object.hasOwn(server, key), `${name}.${key}`);
    for (const key of Object.keys(server)) assert.ok(variant.allowed.includes(key), `${name}.${key} allowed`);
  }
  const at = (s) => out.readmeText.indexOf(s);
  assert.ok(at('## Install') < at(ce.README_START) && at(ce.README_END) < at('## Privacy'));
  assert.ok(out.readmeText.includes(`${ce.README_START}\n${sectionText}${ce.README_END}\n\n## Privacy`));
  assert.deepEqual(ce.cloudState({ ...out, ...staged }), { state: 'lit', problems: [] });
  for (const text of [out.mcpText, out.readmeText]) {
    assert.ok(!/wsp[cr]?_[0-9a-f]{64}|\bBearer\b|\bAuthorization\b/.test(text), 'no secret in the lit files');
  }
  assert.ok(!out.mcpText.includes('headers'));
});

test('apply is idempotent and remove restores the original bytes', () => {
  for (const readme of [README, README_NO_ANCHOR]) {
    const once = lit(M3_MCP, readme);
    assert.deepEqual(lit(once.mcpText, once.readmeText), once);
    assert.deepEqual(ce.removeCloudEntry(once), { mcpText: M3_MCP, readmeText: readme });
  }
  assert.ok(lit(M3_MCP, README_NO_ANCHOR).readmeText.endsWith(`Steps.\n\n${ce.README_START}\n${sectionText}${ce.README_END}\n`));
  assert.deepEqual(ce.removeCloudEntry({ mcpText: M3_MCP, readmeText: README }), { mcpText: M3_MCP, readmeText: README });
  assert.deepEqual(ce.removeCloudEntry({ mcpText: null, readmeText: null }), { mcpText: null, readmeText: null });
});

test('remove keeps the data of a non-canonical mcp.json', () => {
  const compact = JSON.stringify(JSON.parse(M3_MCP));
  const round = ce.removeCloudEntry(lit(compact));
  assert.deepEqual(JSON.parse(round.mcpText), JSON.parse(compact));
  assert.equal(round.readmeText, README);
});

test('apply re-syncs a drifted entry or section', () => {
  const once = lit();
  const driftedMcp = once.mcpText.replace('https://www.wisply.ai/mcp', 'https://mcp.wisply.ai/mcp');
  const driftedReadme = once.readmeText.replace('Eight read-only tools', 'Nine read-only tools');
  assert.equal(ce.cloudState({ mcpText: driftedMcp, readmeText: once.readmeText, ...staged }).state, 'invalid');
  assert.equal(ce.cloudState({ mcpText: once.mcpText, readmeText: driftedReadme, ...staged }).state, 'invalid');
  assert.deepEqual(lit(driftedMcp, driftedReadme), once);
});

test('apply refuses when the repository is not ready, and on bad input', () => {
  const noLocal = `${JSON.stringify({ $schema: ce.AGENT_PLUGINS_MCP_SCHEMA, mcpServers: {} }, null, 2)}\n`;
  const cases = [
    [{ mcpText: null, readmeText: README }, /DIST-M3/],
    [{ mcpText: M3_MCP, readmeText: null }, /DIST-M1/],
    [{ mcpText: '{', readmeText: README }, /not valid JSON/],
    [{ mcpText: M3_MCP.replace('1.0.0', '9.9.9'), readmeText: README }, /Agent Plugins 1\.0\.0/],
    [{ mcpText: noLocal, readmeText: README }, /no local wisply server/],
    [{ mcpText: M3_MCP, readmeText: `${README}${ce.README_START}\n` }, /markers/],
    [{ mcpText: M3_MCP, readmeText: README, stagedDoc: { ...stagedDoc, $schema: 'x' } }, /staged files are invalid/],
  ];
  for (const [input, message] of cases) {
    assert.throws(() => ce.applyCloudEntry({ ...staged, ...input }), message);
  }
});

test('check refuses half-lit and broken states', () => {
  const once = lit();
  const cases = {
    'entry without section': { mcpText: once.mcpText, readmeText: README },
    'entry without README': { mcpText: once.mcpText, readmeText: null },
    'section without entry': { mcpText: M3_MCP, readmeText: once.readmeText },
    'entry without the local server': {
      mcpText: JSON.stringify({ $schema: ce.AGENT_PLUGINS_MCP_SCHEMA, mcpServers: { 'wisply-cloud': stagedDoc.mcpServers['wisply-cloud'] } }),
      readmeText: once.readmeText,
    },
    'two sections': { mcpText: once.mcpText, readmeText: `${once.readmeText}${ce.README_START}\n${sectionText}${ce.README_END}\n` },
    'stray marker': { mcpText: M3_MCP, readmeText: `${README}<!-- wisply-cloud:other -->\n` },
    'invalid mcp.json': { mcpText: '{', readmeText: README },
  };
  for (const [name, input] of Object.entries(cases)) {
    const result = ce.cloudState({ ...input, ...staged });
    assert.equal(result.state, 'invalid', name);
    assert.ok(result.problems.length > 0, name);
  }
  assert.deepEqual(ce.cloudState({ mcpText: null, readmeText: null, ...staged }), { state: 'dark', problems: [] });
  assert.deepEqual(ce.cloudState({ mcpText: M3_MCP, readmeText: README, ...staged }), { state: 'dark', problems: [] });
});

test('CLI: check, apply only with the stage-4 confirmation, remove', () => {
  const dir = tmpRepo();
  try {
    let r = run(dir);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /wisply-cloud: dark/);

    r = run(dir, 'apply');
    assert.equal(r.status, 2);
    assert.match(r.stderr, /Cloud Connect stage 4/);
    assert.equal(readFileSync(join(dir, 'mcp.json'), 'utf8'), M3_MCP);
    assert.equal(readFileSync(join(dir, 'README.md'), 'utf8'), README);

    r = run(dir, 'apply', ce.CONFIRM_FLAG);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /wisply-cloud: lit/);
    assert.deepEqual({ mcpText: readOrNull(join(dir, 'mcp.json')), readmeText: readOrNull(join(dir, 'README.md')) }, lit());
    assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith('.tmp')), []);

    r = run(dir, 'check');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /lit/);

    r = run(dir, 'remove');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /dark/);
    assert.equal(readFileSync(join(dir, 'mcp.json'), 'utf8'), M3_MCP);
    assert.equal(readFileSync(join(dir, 'README.md'), 'utf8'), README);

    writeFileSync(join(dir, 'mcp.json'), lit().mcpText);
    r = run(dir, 'check');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /half-lit/);

    assert.equal(run(dir, 'frobnicate').status, 2);
    assert.equal(run(dir, '--help').status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: apply before DIST-M3 changes nothing', () => {
  const dir = tmpRepo({ mcp: null });
  try {
    const r = run(dir, 'apply', ce.CONFIRM_FLAG);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /DIST-M3/);
    assert.equal(existsSync(join(dir, 'mcp.json')), false);
    assert.equal(readFileSync(join(dir, 'README.md'), 'utf8'), README);
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

test('upstream: wisply-web serves the remote MCP at the same origin and path (WISPLY_WEB_DIR)', (t) => {
  if (!process.env.WISPLY_WEB_DIR) return t.skip('WISPLY_WEB_DIR not set');
  const config = join(process.env.WISPLY_WEB_DIR, 'src', 'lib', 'cloud-connect', 'config.ts');
  if (!existsSync(config)) return t.skip('src/lib/cloud-connect/config.ts not in this wisply-web checkout yet (Cloud Connect W2)');
  const source = readFileSync(config, 'utf8');
  assert.match(source, /['"`]https:\/\/www\.wisply\.ai['"`]/);
  assert.match(source, /\/mcp[`'"]/);
  const route = join(process.env.WISPLY_WEB_DIR, 'src', 'app', 'mcp', 'route.ts');
  if (existsSync(join(process.env.WISPLY_WEB_DIR, 'src', 'app', 'mcp'))) assert.ok(existsSync(route), 'src/app/mcp/route.ts');
});
