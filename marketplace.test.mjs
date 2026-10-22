// Checks that keep the self-hosted marketplace (.claude-plugin/marketplace.json)
// in step with the plugin manifest and the README's install lines, so
// `claude plugin marketplace add fal3/wisply-claude-plugin` always lists the
// plugin this repository actually holds.
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync, readdirSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const readJson = (path) => JSON.parse(readFileSync(join(ROOT, path), 'utf8'));

const marketplace = readJson('.claude-plugin/marketplace.json');
const plugin = readJson('.claude-plugin/plugin.json');
const pkg = readJson('package.json');
const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');

// Top-level and plugin-entry fields of the Claude Code marketplace schema
// (json.schemastore.org/claude-code-marketplace.json). `claude plugin validate
// --strict` is the judge; this list only catches a typo before it runs.
const MARKETPLACE_FIELDS = new Set([
  '$schema', 'name', 'version', 'description', 'owner', 'plugins',
  'forceRemoveDeletedPlugins', 'metadata', 'allowCrossMarketplaceDependenciesOn',
]);
const ENTRY_FIELDS = new Set([
  '$schema', 'name', 'version', 'description', 'author', 'homepage', 'repository',
  'license', 'keywords', 'dependencies', 'hooks', 'commands', 'agents', 'skills',
  'outputStyles', 'themes', 'channels', 'mcpServers', 'lspServers', 'monitors',
  'settings', 'userConfig', 'source', 'category', 'tags', 'strict',
]);
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function onlyEntry() {
  assert.equal(marketplace.plugins.length, 1, 'the marketplace lists exactly one plugin');
  return marketplace.plugins[0];
}

function githubSlug(url) {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9-]+\/[A-Za-z0-9._-]+)$/.exec(url);
  assert.ok(match, `repository is a plain GitHub URL: ${url}`);
  return match[1];
}

test('marketplace manifest has the schema, a kebab-case name and only known fields', () => {
  assert.equal(marketplace.$schema, 'https://json.schemastore.org/claude-code-marketplace.json');
  assert.match(marketplace.name, KEBAB);
  assert.deepEqual(Object.keys(marketplace).filter((key) => !MARKETPLACE_FIELDS.has(key)), []);
  assert.equal(typeof marketplace.owner?.name, 'string');
  assert.ok(marketplace.owner.name.length > 0);
  assert.ok(Array.isArray(marketplace.plugins));
  assert.match(marketplace.metadata?.version ?? '', /^\d+\.\d+\.\d+$/);
  assert.equal(marketplace.metadata.version, plugin.version, 'metadata.version moves with the plugin version');
  assert.ok((marketplace.metadata?.description ?? '').length > 0);
});

test('the plugin entry matches plugin.json', () => {
  const entry = onlyEntry();
  for (const field of ['name', 'version', 'description', 'license', 'repository', 'homepage']) {
    assert.equal(entry[field], plugin[field], `${field} differs between marketplace.json and plugin.json`);
  }
  assert.equal(entry.author?.name, plugin.author.name);
  assert.equal(entry.author?.email, plugin.author.email);
  assert.deepEqual(Object.keys(entry).filter((key) => !ENTRY_FIELDS.has(key)), []);
});

test('the plugin entry points at this repository root, which holds plugin.json', () => {
  const entry = onlyEntry();
  assert.equal(entry.source, './');
  // "./" is relative to the marketplace root: the folder that contains .claude-plugin/.
  assert.ok(existsSync(join(resolve(ROOT, entry.source), '.claude-plugin', 'plugin.json')));
  // Default strict mode: plugin.json stays the plugin's manifest; the entry adds nothing it lacks.
  assert.notEqual(entry.strict, false);
});

test('the owner email is the plugin author email', () => {
  assert.equal(marketplace.owner.email, plugin.author.email);
});

test('category and keywords are lowercase discovery tags', () => {
  const entry = onlyEntry();
  assert.equal(entry.category, 'productivity');
  assert.ok(Array.isArray(entry.keywords) && entry.keywords.length > 0);
  for (const keyword of entry.keywords) assert.match(keyword, KEBAB);
  assert.equal(new Set(entry.keywords).size, entry.keywords.length, 'no duplicate keywords');
});

test('package.json points at the same repository', () => {
  assert.equal(pkg.repository, `github:${githubSlug(plugin.repository)}`);
  assert.equal(pkg.version, plugin.version);
});

test('the README install lines name this marketplace and plugin', () => {
  const entry = onlyEntry();
  const slug = githubSlug(entry.repository);
  for (const line of [
    `/plugin install ${entry.name} --marketplace ${slug}`,
    `claude plugin install ${entry.name} --marketplace ${slug}`,
    `claude plugin marketplace add ${slug}`,
    `claude plugin install ${entry.name}@${marketplace.name}`,
  ]) {
    assert.ok(readme.includes(line), `README.md is missing: ${line}`);
  }
});

// The Codex marketplace (.agents/plugins/marketplace.json) and the Codex
// manifests have their own checks in codex.test.mjs.

test('npm test runs every root test file', () => {
  const script = pkg.scripts.test;
  const files = readdirSync(ROOT).filter((name) => name.endsWith('.test.mjs'));
  assert.ok(files.includes('marketplace.test.mjs'));
  for (const file of files) assert.ok(script.split(/\s+/).includes(file), `npm test skips ${file}`);
});
