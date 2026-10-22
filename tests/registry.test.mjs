// The MCP Registry entries: server.json (ai.wisply/local) and
// registry/cloud.server.json (ai.wisply/cloud). Besides the 2025-12-11
// schema, this repeats offline what the official registry checks at publish
// time (modelcontextprotocol/registry internal/validators @11b7b0e), and holds
// the release gates for the bundle's sha256:
//
//   WISPLY_REGISTRY_RELEASE=1                       refuses the all-zero fileSha256 placeholder
//   WISPLY_MCPB_FILE=<the asset downloaded back from the draft release>
//                                                   fileSha256 must equal that file's sha256, and the file must
//                                                   unpack to exactly the files of tag v<version> (verifyBundle,
//                                                   with the pinned packer in tools/mcpb)
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PACKAGE_NAME, VERSION } from '../lib/constants.mjs';
import { bundleFileName, packerLib, verifyBundle } from '../scripts/build-mcpb.mjs';
import { validate } from './helpers/json-schema.mjs';
import { ROOT, exists, readJson } from './helpers/repo.mjs';

const SCHEMA_URL = 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json';
const PUBLISHER_KEY = 'io.modelcontextprotocol.registry/publisher-provided';
const PLACEHOLDER_SHA = '0'.repeat(64);
const CLOUD_URL = 'https://www.wisply.ai/mcp';
const registrySchema = readJson('tests/schemas/mcp-registry-2025-12-11/server.schema.json');
const pkg = readJson('package.json');
const local = readJson('server.json');
const cloud = readJson('registry/cloud.server.json');
const npmPackage = local.packages.find((entry) => entry.registryType === 'npm');
const mcpbPackage = local.packages.find((entry) => entry.registryType === 'mcpb');

// internal/validators/registries/mcpb.go isValidGitHubReleaseURL
const GITHUB_RELEASE_PATH = /^\/([a-zA-Z0-9]([a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?)\/([a-zA-Z0-9._-]+)\/releases\/download\/([^/]+)\/([^/]+)$/;
// internal/validators/validators.go looksLikeVersionRange (the common forms)
const VERSION_RANGE = /^[\^~<>=]|\|\||\s-\s|(^|\.)[xX*](\.|$)/;

/** Offline copies of the registry's semantic checks for one server.json. */
function registryProblems(doc) {
  const problems = [];
  const name = /^([a-zA-Z0-9][a-zA-Z0-9.-]*[a-zA-Z0-9])\/([a-zA-Z0-9][a-zA-Z0-9._-]*[a-zA-Z0-9])$/.exec(doc.name ?? '');
  if (!name) problems.push('name must be namespace/name');
  if (doc.$schema !== SCHEMA_URL) problems.push('$schema');
  if (typeof doc.title === 'string' && doc.title.trim() === '') problems.push('title is only whitespace');
  if (doc.version === 'latest' || VERSION_RANGE.test(doc.version ?? '')) problems.push('version looks like a range');
  if (doc.websiteUrl !== undefined && new URL(doc.websiteUrl).protocol !== 'https:') problems.push('websiteUrl');
  for (const icon of doc.icons ?? []) if (new URL(icon.src).protocol !== 'https:') problems.push('icon src must be https');
  if (doc.repository && !/^https:\/\/github\.com\/[^/]+\/[^/]+$/.test(doc.repository.url)) problems.push('repository url');
  if (doc._meta !== undefined) {
    // Only this key survives publishing, and it is capped at 4 KB.
    if (Object.keys(doc._meta).some((key) => key !== PUBLISHER_KEY)) problems.push('_meta keys other than publisher-provided are dropped');
    if (Buffer.byteLength(JSON.stringify(doc._meta[PUBLISHER_KEY] ?? {})) > 4096) problems.push('_meta over 4 KB');
  }
  for (const entry of doc.packages ?? []) {
    if (/\s/.test(entry.identifier)) problems.push('identifier has spaces');
    if (entry.version !== undefined && (entry.version === 'latest' || VERSION_RANGE.test(entry.version))) problems.push('package version');
    if (entry.transport?.type === 'stdio' && entry.transport.url) problems.push('stdio transport with a url');
    if (entry.registryType === 'npm') {
      if (!entry.version) problems.push('npm package needs a version');
      if (entry.fileSha256 !== undefined) problems.push('npm package must not have fileSha256');
      if (entry.registryBaseUrl !== undefined && entry.registryBaseUrl !== 'https://registry.npmjs.org') problems.push('npm registryBaseUrl');
    } else if (entry.registryType === 'mcpb') {
      if (!/^[a-f0-9]{64}$/.test(entry.fileSha256 ?? '')) problems.push('mcpb needs fileSha256');
      if (entry.registryBaseUrl !== undefined) problems.push('mcpb must not have registryBaseUrl');
      const url = new URL(entry.identifier);
      if (url.protocol !== 'https:' || !['github.com', 'www.github.com'].includes(url.host) || !GITHUB_RELEASE_PATH.test(url.pathname)) {
        problems.push('mcpb identifier must be a GitHub release asset');
      }
      if (!entry.identifier.toLowerCase().includes('mcp')) problems.push('mcpb identifier must contain "mcp"');
    } else {
      problems.push(`unexpected registryType ${entry.registryType}`);
    }
  }
  for (const remote of doc.remotes ?? []) {
    if (!['streamable-http', 'sse'].includes(remote.type) || !/^https:\/\//.test(remote.url ?? '')) problems.push('remote');
  }
  return problems;
}

test('both entries validate against the 2025-12-11 server.json schema', () => {
  assert.deepEqual(validate(registrySchema, local), []);
  assert.deepEqual(validate(registrySchema, cloud), []);
  assert.equal(local.$schema, SCHEMA_URL);
  assert.equal(cloud.$schema, SCHEMA_URL);
});

test('both entries pass the registry\'s publish-time checks that can run offline', () => {
  assert.deepEqual(registryProblems(local), []);
  assert.deepEqual(registryProblems(cloud), []);
});

test('the offline checks catch what the registry refuses', () => {
  const broken = structuredClone(local);
  broken.version = '^0.1.0';
  broken._meta.other = {};
  broken.packages[0].fileSha256 = PLACEHOLDER_SHA;
  broken.packages[1].identifier = 'https://example.com/wisply.mcpb';
  assert.deepEqual(registryProblems(broken), [
    'version looks like a range',
    '_meta keys other than publisher-provided are dropped',
    'npm package must not have fileSha256',
    'mcpb identifier must be a GitHub release asset',
  ]);
});

test('ai.wisply/local: the DNS namespace, the npm package and its mcpName', () => {
  // DNS authentication on wisply.ai grants ai.wisply.*; npm ownership is mcpName in the published version.
  assert.equal(local.name, 'ai.wisply/local');
  assert.equal(pkg.mcpName, local.name);
  assert.ok(local.description.length <= 100);
  assert.ok(local.title.length <= 100);
  assert.deepEqual(local.packages.map((entry) => entry.registryType), ['npm', 'mcpb']);
  assert.equal(npmPackage.identifier, PACKAGE_NAME);
  assert.equal(npmPackage.version, VERSION);
  assert.equal(npmPackage.runtimeHint, 'npx');
  assert.deepEqual(npmPackage.transport, { type: 'stdio' });
  assert.deepEqual(mcpbPackage.transport, { type: 'stdio' });
});

test('ai.wisply/local: the token is an optional secret, and nothing sets its value', () => {
  assert.deepEqual(npmPackage.environmentVariables.map((variable) => variable.name), ['WISPLY_MCP_TOKEN']);
  const [token] = npmPackage.environmentVariables;
  assert.equal(token.isSecret, true);
  assert.equal(token.isRequired, false);
  for (const key of ['value', 'default', 'choices']) assert.equal(Object.hasOwn(token, key), false, key);
  assert.match(token.description, /setup/);
  assert.equal(Object.hasOwn(mcpbPackage, 'environmentVariables'), false, 'the bundle asks for the token itself (user_config)');
});

test('ai.wisply/local: the MCPB asset is this version\'s release asset of fal3/wisply-mcp', () => {
  assert.equal(mcpbPackage.identifier,
    `https://github.com/fal3/wisply-mcp/releases/download/v${VERSION}/${bundleFileName(VERSION)}`);
  assert.ok(mcpbPackage.identifier.includes('mcp'));
  assert.equal(Object.hasOwn(mcpbPackage, 'version'), false);
});

test('ai.wisply/local: publisher metadata says it needs Wisply for Mac', () => {
  const meta = local._meta[PUBLISHER_KEY];
  assert.deepEqual(meta['ai.wisply'].platforms, ['macOS']);
  assert.match(meta['ai.wisply'].requires, /Wisply for Mac/);
  assert.equal(meta['com.github'].serverDisplayName, local.title);
});

test('fileSha256 is the placeholder until the release, and the release gate refuses it (WISPLY_REGISTRY_RELEASE=1)', () => {
  assert.match(mcpbPackage.fileSha256, /^[a-f0-9]{64}$/);
  if (process.env.WISPLY_REGISTRY_RELEASE === '1') {
    assert.notEqual(mcpbPackage.fileSha256, PLACEHOLDER_SHA,
      'build the bundle once from the release tag (npm run build:mcpb), upload it, then put its sha256 in server.json');
  }
});

test('with WISPLY_MCPB_FILE, fileSha256 is that file\'s sha256 and the file is exactly the tag\'s bundle', { skip: process.env.WISPLY_MCPB_FILE ? false : 'WISPLY_MCPB_FILE not set' }, async () => {
  const file = resolve(process.env.WISPLY_MCPB_FILE);
  assert.ok(file.endsWith(`/${bundleFileName(VERSION)}`), `${file} is not ${bundleFileName(VERSION)}`);
  const sha = createHash('sha256').update(readFileSync(file)).digest('hex');
  assert.equal(mcpbPackage.fileSha256, sha, 'server.json fileSha256 must equal the uploaded bundle\'s sha256');
  // The hash only says which file was uploaded; this says the file holds the tag's code and nothing else.
  assert.deepEqual(await verifyBundle({ file, version: VERSION, lib: packerLib() }), [],
    'the bundle must unpack to exactly the files of the release tag');
});

test('the release gate really fails on the placeholder', { skip: process.env.WISPLY_REGISTRY_RELEASE === '1' }, () => {
  const env = { ...process.env, WISPLY_REGISTRY_RELEASE: '1' };
  delete env.NODE_TEST_CONTEXT;
  delete env.WISPLY_MCPB_FILE;
  const result = spawnSync(process.execPath, ['--test', fileURLToPath(import.meta.url)], { cwd: ROOT, env, encoding: 'utf8' });
  assert.equal(result.status === 0, mcpbPackage.fileSha256 !== PLACEHOLDER_SHA, result.stdout.slice(-2000));
});

test('ai.wisply/cloud: the remote entry for Cloud Connect, with no package', () => {
  assert.deepEqual(Object.keys(cloud), ['$schema', 'name', 'title', 'description', 'websiteUrl', 'version', 'remotes']);
  assert.equal(cloud.name, 'ai.wisply/cloud');
  assert.equal(cloud.title, 'Wisply Cloud');
  assert.ok(cloud.description.length <= 100);
  assert.match(cloud.description, /Cloud Connect/);
  assert.equal(cloud.websiteUrl, 'https://www.wisply.ai/docs/cloud-connect');
  assert.deepEqual(cloud.remotes, [{ type: 'streamable-http', url: CLOUD_URL }]);
  assert.equal(Object.hasOwn(cloud, 'packages'), false);
  assert.match(cloud.version, /^\d+\.\d+\.\d+$/);
});

test('ai.wisply/cloud names the same remote as the wisply-cloud plugin, once DIST-M6 is here', (t) => {
  if (!exists('cloud-connect/plugin/mcp.json')) return t.skip('cloud-connect/plugin/mcp.json arrives with DIST-M6');
  const plugin = readJson('cloud-connect/plugin/mcp.json');
  assert.deepEqual(cloud.remotes, [{ type: 'streamable-http', url: plugin.mcpServers['wisply-cloud'].url }]);
});
