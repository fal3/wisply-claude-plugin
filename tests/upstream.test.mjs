// Drift checks against the upstream checkouts. They run only when
// WISPLY_PLUGIN_DIR (wisply-claude-plugin) and WISPLY_AI_DIR (wisply-ai)
// point at local checkouts, as in the agent containers:
//
//   WISPLY_AI_DIR=/home/user/wisply-ai WISPLY_PLUGIN_DIR=/home/user/wisply-claude-plugin npm test
//
// While contract/SOURCE.json is provisional (no Docs/mcp-contract.json with
// tool_descriptors upstream yet), the contract is checked against the Swift
// source it was transcribed from instead of byte for byte.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import contract from '../lib/contract.mjs';
import { MAX_RESPONSE_BYTES, PROTOCOL_VERSIONS } from '../lib/constants.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SOURCE = JSON.parse(readFileSync(join(ROOT, 'contract/SOURCE.json'), 'utf8'));
const PLUGIN_DIR = process.env.WISPLY_PLUGIN_DIR;
const APP_DIR = process.env.WISPLY_AI_DIR;
const sourceFor = (repository) => SOURCE.sources.find((source) => source.repository === repository);
const local = (path) => readFileSync(join(ROOT, path));
const gitShow = (dir, commit, path) => {
  try {
    return execFileSync('git', ['-C', dir, 'show', `${commit}:${path}`], { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024 });
  } catch {
    return null;
  }
};

test('plugin: vendored files equal the checkout and the recorded commit', { skip: PLUGIN_DIR ? false : 'WISPLY_PLUGIN_DIR not set' }, async () => {
  const source = sourceFor('github:fal3/wisply-claude-plugin');
  for (const [path, entry] of Object.entries(source.files)) {
    assert.ok(local(path).equals(readFileSync(join(PLUGIN_DIR, entry.upstream))), `${path} differs from the plugin checkout: run npm run sync-vendor`);
    const atCommit = gitShow(PLUGIN_DIR, source.commit, entry.upstream);
    if (atCommit) assert.ok(local(path).equals(atCommit), `${path} differs from ${source.commit}`);
  }
  // The plugin's read-only bridge and this connector agree on what a connector token reaches.
  const shared = await import(pathToFileURL(join(PLUGIN_DIR, 'lib/shared.mjs')).href);
  assert.deepEqual([...shared.READ_ONLY_TOOLS], [...contract.scopes.connector.tools]);
  assert.deepEqual([...shared.PROTOCOL_VERSIONS], [...PROTOCOL_VERSIONS]);
  assert.equal(shared.MAX_RESPONSE_BYTES, MAX_RESPONSE_BYTES);
});

const appSource = sourceFor('github:fal3/wisply-ai');
const APP_CONTRACT = 'Docs/mcp-contract.json';

test('app: the vendored contract equals Docs/mcp-contract.json', {
  skip: !APP_DIR ? 'WISPLY_AI_DIR not set' : appSource.provisional ? 'provisional contract (checked against the Swift source below)' : false,
}, () => {
  assert.ok(local('contract/mcp-contract.json').equals(readFileSync(join(APP_DIR, APP_CONTRACT))),
    'contract/mcp-contract.json differs from wisply-ai: run npm run sync-vendor');
  const atCommit = gitShow(APP_DIR, appSource.commit, APP_CONTRACT);
  if (atCommit) assert.ok(local('contract/mcp-contract.json').equals(atCommit), `differs from ${appSource.commit}`);
});

test('app: once wisply-ai has a contract, the provisional fixture still matches it', {
  skip: !APP_DIR ? 'WISPLY_AI_DIR not set'
    : !appSource.provisional ? 'not provisional'
      : !existsSync(join(APP_DIR, APP_CONTRACT)) ? `no ${APP_CONTRACT} in wisply-ai yet (raycast PR 1)` : false,
}, () => {
  const upstream = JSON.parse(readFileSync(join(APP_DIR, APP_CONTRACT), 'utf8'));
  assert.equal(Object.hasOwn(upstream, 'tool_descriptors'), false,
    'wisply-ai now has tool_descriptors (DIST-A1): re-vendor without --provisional (DIST-M5)');
  for (const key of Object.keys(upstream)) {
    assert.deepEqual(contract[key], upstream[key], `${key} drifted from wisply-ai: update the provisional fixture or re-vendor`);
  }
});

// --- The transcription check (provisional only) -----------------------------

const CATALOG = 'Wisply/Services/MCP/MCPToolCatalog.swift';
const swiftString = (value) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const between = (text, start, end) => {
  const from = text.indexOf(start);
  const to = text.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `${start} ... ${end} not found in ${CATALOG}`);
  return text.slice(from, to);
};

test('app: the provisional descriptors are the Swift catalog\'s, word for word', {
  skip: !APP_DIR ? 'WISPLY_AI_DIR not set' : !appSource.provisional ? 'not provisional' : false,
}, () => {
  const swift = readFileSync(join(APP_DIR, CATALOG), 'utf8');
  const enumBody = between(swift, 'enum MCPToolName', 'var hasSideEffects');
  const cases = [...enumBody.matchAll(/case (\w+) = "([a-z_]+)"/g)].map((match) => ({ member: match[1], name: match[2] }));
  assert.deepEqual(cases.map((entry) => entry.name), [...contract.tools], 'tool names and order');
  const nameOf = new Map(cases.map((entry) => [entry.member, entry.name]));
  const membersIn = (block) => {
    const line = /case ([^:]+):\s*(?:\/\/[^\n]*\n\s*)*return true/.exec(block);
    assert.ok(line, 'a "return true" case');
    return line[1].split(',').map((member) => nameOf.get(member.trim().replace(/^\./, '')));
  };
  const sideEffects = new Set(membersIn(between(swift, 'var hasSideEffects', 'var isAvailableToConnector')));
  const connector = membersIn(between(swift, 'var isAvailableToConnector', 'var returnsTranscriptContent'));
  assert.deepEqual(connector, [...contract.scopes.connector.tools], 'connector scope');

  for (const descriptor of contract.tool_descriptors) {
    assert.ok(swift.includes(`return ${swiftString(descriptor.title)}`), `${descriptor.name} title`);
    assert.ok(swift.includes(`return ${swiftString(descriptor.description)}`), `${descriptor.name} description`);
    assert.equal(descriptor.annotations.readOnlyHint, !sideEffects.has(descriptor.name), `${descriptor.name} side effects`);
    for (const [property, schema] of Object.entries(descriptor.inputSchema.properties)) {
      assert.ok(swift.includes(swiftString(property)), `${descriptor.name}.${property} name`);
      assert.ok(swift.includes(swiftString(schema.description)), `${descriptor.name}.${property} description`);
      for (const bound of ['minimum', 'maximum']) {
        if (schema[bound] !== undefined) assert.ok(swift.includes(`${bound}: ${schema[bound]}`), `${descriptor.name}.${property} ${bound}`);
      }
    }
  }
  assert.ok(swift.includes('], required: ["query"])'), 'search_transcripts requires query');
  assert.ok(swift.includes('"enum": ["calendar", "zoom_meeting", "task"]'), 'propose_follow_up kinds');

  const scopes = readFileSync(join(APP_DIR, 'Wisply/Services/MCP/MCPTokenScope.swift'), 'utf8');
  assert.ok(scopes.includes('case .full: return "wsp_"') && scopes.includes('case .connector: return "wspc_"'), 'token prefixes');
  const server = readFileSync(join(APP_DIR, 'Wisply/Services/MCP/MCPServer.swift'), 'utf8');
  const port = /static let defaultPort: UInt16 = ([0-9_]+)/.exec(server)?.[1];
  assert.equal(Number(port?.replaceAll('_', '')), contract.default_port, 'default port');
  const proof = readFileSync(join(APP_DIR, 'Wisply/Services/MCP/MCPIdentityProof.swift'), 'utf8');
  assert.ok(proof.includes(`static let scheme = "${contract.identity_scheme}"`), 'identity scheme');
});
