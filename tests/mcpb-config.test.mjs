// The Claude Desktop bundle (MCPB). Always: scripts/build-mcpb.mjs stages a
// self-contained bundle whose server runs from any directory. With
// WISPLY_MCPB_LIB pointing to @anthropic-ai/mcpb 2.1.2's dist/index.js (CI job
// `mcpb`), also against the real library:
//
// - an empty optional token field reaches the connector as "" (so it falls
//   through to the Keychain item), which needs the manifest's `default: ""`;
//   without it the literal ${user_config.wisply_mcp_token} arrives, and the
//   connector still treats it as unset;
// - the manifest validates, and a pack/unpack round trip gives a bundle that
//   answers tools/list and a tool call through the identity check.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import contract from '../lib/contract.mjs';
import { VERSION } from '../lib/constants.mjs';
import { resolveToken } from '../lib/token.mjs';
import { STAGED_DIRS, bundleFileName, listFiles, packBundle, renderManifest, stageBundle } from '../scripts/build-mcpb.mjs';
import { FAKE_TOKENS, startFakeWisply } from './fixtures/fake-wisply.mjs';
import { ROOT, exists, readJson } from './helpers/repo.mjs';

const LIB = process.env.WISPLY_MCPB_LIB ? resolve(process.env.WISPLY_MCPB_LIB) : null;
const needsLib = { skip: LIB ? false : 'WISPLY_MCPB_LIB not set (CI job mcpb sets it)' };
const manifest = readJson('mcpb/manifest.json');
const EXTENSION_PATH = '/Users/someone/Library/Application Support/Claude/Claude Extensions/wisply';
const PLACEHOLDER = '${user_config.wisply_mcp_token}';
const syntheticToken = () => `wspc_${'7'.repeat(64)}`;

const tempDir = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'wisply-mcpb-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

/** The files a bundle must hold: the shipped code, the contract, the license, the manifest and the icon. */
function expectedFiles() {
  const files = ['LICENSE', 'icon.png', 'manifest.json'];
  for (const dir of STAGED_DIRS) {
    if (!exists(dir)) continue;
    files.push(...listFiles(join(ROOT, dir)).filter((name) => /\.(mjs|json)$/.test(name)).map((name) => `${dir}/${name}`));
  }
  return files.sort();
}

/** Runs a bundle's server from an unrelated directory with a bare environment and returns its JSON-RPC answers. */
async function runBundled(bundleDir, { env = {}, lines }) {
  const child = spawn(process.execPath, [join(bundleDir, 'bin/wisply-mcp.mjs')], {
    cwd: tmpdir(),
    env: { PATH: process.env.PATH, HOME: tmpdir(), ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  for (const line of lines) child.stdin.write(`${JSON.stringify(line)}\n`);
  child.stdin.end();
  const [code] = await once(child, 'exit');
  assert.equal(code, 0, stderr);
  return stdout.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

const SESSION = [
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'mcpb-test', version: '1' } } },
  { jsonrpc: '2.0', method: 'notifications/initialized' },
  { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
];

test('build-mcpb stages exactly the shipped code, the contract, LICENSE, the manifest and the icon', (t) => {
  const stageDir = join(tempDir(t), 'mcpb');
  const files = stageBundle({ stageDir, contract, version: VERSION });
  assert.deepEqual(files, expectedFiles());
  assert.ok(files.includes('bin/wisply-mcp.mjs') && files.includes('contract/mcp-contract.mjs'));
  for (const file of files) assert.doesNotMatch(file, /^(tests|scripts|\.github|dist|node_modules)\//, file);
  assert.deepEqual(JSON.parse(readFileSync(join(stageDir, 'manifest.json'), 'utf8')), renderManifest(manifest, { contract, version: VERSION }));
  assert.deepEqual(readFileSync(join(stageDir, 'icon.png')), readFileSync(join(ROOT, 'mcpb/icon.png')));
  assert.equal(bundleFileName(VERSION), `wisply-mcp-${VERSION}.mcpb`);
});

test('build-mcpb refuses to stage into a source folder (it empties the stage first)', () => {
  for (const stageDir of [ROOT, join(ROOT, 'mcpb'), join(ROOT, 'lib'), join(ROOT, 'tests', 'mcpb')]) {
    assert.throws(() => stageBundle({ stageDir, contract, version: VERSION }), /under dist\/ or outside the repository/, stageDir);
  }
  assert.ok(existsSync(join(ROOT, 'mcpb/manifest.json')) && existsSync(join(ROOT, 'lib/bridge.mjs')));
});

test('the staged server runs on its own, from another directory, with no package.json', async (t) => {
  const stageDir = join(tempDir(t), 'mcpb');
  stageBundle({ stageDir, contract, version: VERSION });
  assert.equal(existsSync(join(stageDir, 'package.json')), false);
  const [init, list] = await runBundled(stageDir, { lines: SESSION });
  assert.equal(init.result.serverInfo.name, 'wisply');
  assert.deepEqual(list.result.tools.map((tool) => tool.name), contract.scopes.connector.tools);
});

/** getMcpConfigForManifest from the real library, as Claude Desktop runs it at install. */
async function mcpConfig(manifestDoc, userConfig) {
  const { getMcpConfigForManifest } = await import(pathToFileURL(LIB).href);
  return getMcpConfigForManifest({
    manifest: manifestDoc, extensionPath: EXTENSION_PATH, systemDirs: {}, userConfig, pathSeparator: '/',
  });
}

/** resolveToken on macOS with that env, and whether it read the Keychain. */
async function resolveWith(env) {
  let keychainReads = 0;
  const stored = `wspc_${'8'.repeat(64)}`;
  const resolution = await resolveToken({ env, platform: 'darwin', readKeychain: async () => { keychainReads += 1; return stored; } });
  return { resolution, keychainReads, stored };
}

test('mcpb: an empty token field becomes "", and the connector falls through to the Keychain', needsLib, async () => {
  const config = await mcpConfig(manifest, {});
  assert.equal(config.command, 'node');
  assert.deepEqual(config.args, [`${EXTENSION_PATH}/bin/wisply-mcp.mjs`]);
  assert.deepEqual(config.env, { WISPLY_MCP_TOKEN: '' });
  const { resolution, keychainReads, stored } = await resolveWith(config.env);
  assert.equal(keychainReads, 1);
  assert.equal(resolution.token, stored);
  assert.equal(resolution.source, 'keychain');
  assert.equal(resolution.placeholderIgnored, false);
});

test('mcpb: a filled token field reaches the connector, which then never reads the Keychain', needsLib, async () => {
  const token = syntheticToken();
  const config = await mcpConfig(manifest, { wisply_mcp_token: token });
  assert.deepEqual(config.env, { WISPLY_MCP_TOKEN: token });
  const { resolution, keychainReads } = await resolveWith(config.env);
  assert.equal(keychainReads, 0);
  assert.equal(resolution.token, token);
  assert.equal(resolution.source, 'env');
});

test('mcpb: without default: "" the placeholder stays literal, and the connector still ignores it', needsLib, async () => {
  const withoutDefault = structuredClone(manifest);
  delete withoutDefault.user_config.wisply_mcp_token.default;
  const config = await mcpConfig(withoutDefault, {});
  assert.deepEqual(config.env, { WISPLY_MCP_TOKEN: PLACEHOLDER }, 'mcpb 2.1.2 keeps an unknown ${user_config.*} as written');
  const { resolution, keychainReads } = await resolveWith(config.env);
  assert.equal(keychainReads, 1);
  assert.equal(resolution.source, 'keychain');
  assert.equal(resolution.placeholderIgnored, true);
});

test('mcpb: the library validates mcpb/manifest.json (schema and icon)', needsLib, async () => {
  const { validateManifest } = await import(pathToFileURL(LIB).href);
  const lines = [];
  const original = { log: console.log, error: console.error };
  console.log = (...args) => lines.push(args.join(' '));
  console.error = console.log;
  try {
    assert.equal(validateManifest(join(ROOT, 'mcpb/manifest.json')), true, lines.join('\n'));
  } finally {
    Object.assign(console, original);
  }
});

test('mcpb: pack and unpack give a bundle that answers tools/list and a call through the identity check', needsLib, async (t) => {
  const dir = tempDir(t);
  const stageDir = join(dir, 'mcpb');
  const staged = stageBundle({ stageDir, contract, version: VERSION });
  const outFile = join(dir, bundleFileName(VERSION));
  await packBundle({ stageDir, outFile, lib: LIB });
  const { unpackExtension } = await import(pathToFileURL(LIB).href);
  const unpacked = join(dir, 'unpacked');
  assert.equal(await unpackExtension({ mcpbPath: outFile, outputDir: unpacked, silent: true }), true);
  assert.deepEqual(listFiles(unpacked), staged);

  const fake = await startFakeWisply();
  t.after(fake.close);
  const answers = await runBundled(unpacked, {
    env: { WISPLY_MCP_PORT: String(fake.port), WISPLY_MCP_TOKEN: FAKE_TOKENS.connector },
    lines: [...SESSION, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_memos', arguments: { limit: 1 } } }],
  });
  assert.deepEqual(answers.map((answer) => answer.id), [1, 2, 3]);
  assert.deepEqual(answers[1].result.tools.map((tool) => tool.name), contract.scopes.connector.tools);
  assert.equal(answers[2].result.isError, false, JSON.stringify(answers[2].result));
});
