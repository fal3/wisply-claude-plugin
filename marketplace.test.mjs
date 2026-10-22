// Checks that keep this repository's two self-hosted marketplaces in step
// with the plugin manifest and with every install line in the README:
// Claude Code's (.claude-plugin/marketplace.json, named `wisply`) and
// Codex's (.agents/plugins/marketplace.json, named after this repository).
// So `claude plugin marketplace add fal3/wisply-claude-plugin` and
// `codex plugin marketplace add fal3/wisply-claude-plugin` always list the
// plugin this repository actually holds, under the id the README gives for
// that client.
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync, readdirSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const readJson = (path) => JSON.parse(readFileSync(join(ROOT, path), 'utf8'));

const marketplace = readJson('.claude-plugin/marketplace.json');
const codexMarketplace = readJson('.agents/plugins/marketplace.json');
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
const RELEASE_TAG = /^v\d+\.\d+\.\d+$/;
const COMMIT_SHA = /^[0-9a-f]{40}$/;
// Claude Code's marketplace name, which the plugin's Claude Code id
// (wisply-local@wisply) and the directory submission use.
const CLAUDE_MARKETPLACE = 'wisply';
// Wisply's own Codex marketplace (fal3/wisply-mcp, the Agent Plugin) is also
// named `wisply`, and Codex refuses a second marketplace with a name it
// already has. So this repository's Codex marketplace takes another name, and
// a person can add both.
const AGENT_PLUGIN_MARKETPLACE = 'wisply';
// Ids the README uses for a copy that isn't installed from a marketplace.
const ID_PLACEHOLDERS = new Set(['<marketplace>', 'inline']);

function onlyEntry() {
  assert.equal(marketplace.plugins.length, 1, 'the marketplace lists exactly one plugin');
  return marketplace.plugins[0];
}

function githubSlug(url) {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9-]+\/[A-Za-z0-9._-]+)$/.exec(url);
  assert.ok(match, `repository is a plain GitHub URL: ${url}`);
  return match[1];
}

const repoName = (url) => githubSlug(url).split('/')[1];

// Every command the README shows: each line of a fenced code block and each
// inline code span, split at pipes and `&&`, with trailing comments removed.
function readmeCommands() {
  const snippets = [];
  let fenced = false;
  for (const line of readme.split('\n')) {
    if (line.trimStart().startsWith('```')) { fenced = !fenced; continue; }
    if (fenced) snippets.push(line);
    else for (const [, code] of line.matchAll(/`([^`]+)`/g)) snippets.push(code);
  }
  return snippets
    .flatMap((snippet) => snippet.split(/\s+(?:\||&&)\s+/))
    .map((command) => command.replace(/\s+#.*$/, '').trim())
    .filter((command) => /^(?:claude|codex|\/plugin)\s/.test(command));
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

test('the Codex marketplace has its own name, so Wisply\'s Agent Plugin marketplace can be added beside it', () => {
  assert.deepEqual(Object.keys(codexMarketplace).filter((key) => !['name', 'interface', 'plugins'].includes(key)), []);
  assert.match(codexMarketplace.name, KEBAB);
  assert.notEqual(codexMarketplace.name, AGENT_PLUGIN_MARKETPLACE);
  assert.equal(codexMarketplace.name, repoName(plugin.repository), 'named after this repository');
  // Claude Code reads only .claude-plugin/marketplace.json, where the name stays `wisply`.
  assert.equal(marketplace.name, CLAUDE_MARKETPLACE);
  assert.notEqual(codexMarketplace.name, marketplace.name, 'the two clients use different ids');
  assert.equal(typeof codexMarketplace.interface?.displayName, 'string');
});

test('the Codex marketplace lists this plugin from the repository root, and pins anything else', () => {
  const own = codexMarketplace.plugins.filter((entry) => entry.source === './');
  assert.equal(own.length, 1, 'this plugin, once');
  assert.equal(own[0].name, plugin.name);
  assert.equal(own[0].name, onlyEntry().name, 'the same plugin name as in Claude Code');
  assert.equal(own[0].category, 'Productivity');
  for (const entry of codexMarketplace.plugins.filter((item) => item.source !== './')) {
    // A plugin from another Wisply repository must pin a release tag and its
    // full commit, so Codex never installs an unreviewed default branch.
    assert.match(entry.name ?? '', KEBAB);
    assert.notEqual(entry.name, plugin.name);
    assert.equal(entry.source?.source, 'url', `${entry.name}: a remote source`);
    assert.match(entry.source.url, /^https:\/\/github\.com\/fal3\/[A-Za-z0-9._-]+$/);
    assert.notEqual(repoName(entry.source.url), repoName(plugin.repository));
    assert.match(entry.source.ref ?? '', RELEASE_TAG, `${entry.name}: pinned to a release tag`);
    assert.match(entry.source.sha ?? '', COMMIT_SHA, `${entry.name}: pinned to the tag's full commit`);
  }
});

test('the README gives the Codex install lines with this marketplace\'s Codex name', () => {
  const slug = githubSlug(plugin.repository);
  for (const line of [
    `codex plugin marketplace add ${slug}`,
    `codex plugin add ${plugin.name}@${codexMarketplace.name}`,
    `codex plugin remove ${plugin.name}@${codexMarketplace.name}`,
    `codex plugin marketplace remove ${codexMarketplace.name}`,
    `codex plugin marketplace upgrade ${codexMarketplace.name}`,
  ]) {
    assert.ok(readme.includes(line), `README.md is missing: ${line}`);
  }
});

test('every README command uses the plugin id and marketplace name of its own client', () => {
  // `codex plugin add wisply-local@wisply` fails with "plugin `wisply-local`
  // was not found in marketplace `wisply`": that is the Claude Code id.
  const commands = readmeCommands();
  const expected = {claude: marketplace.name, codex: codexMarketplace.name};
  const seen = {claude: 0, codex: 0};
  for (const command of commands) {
    const client = command.startsWith('codex') ? 'codex' : 'claude';
    for (const [, name] of command.matchAll(/(?:^|\s)[a-z0-9-]+@(\S+)/g)) {
      if (client === 'claude' && ID_PLACEHOLDERS.has(name)) continue;
      assert.equal(name, expected[client], `${command}: a ${client} id ends in @${expected[client]}`);
      seen[client] += 1;
    }
    const managed = /\bplugin marketplace (?:update|upgrade|remove) (\S+)/.exec(command);
    if (managed) {
      assert.equal(managed[1], expected[client], `${command}: the ${client} marketplace is ${expected[client]}`);
      seen[client] += 1;
    }
    for (const [, id] of command.matchAll(/(?:^|\s)([a-z0-9-]+)@\S+/g)) {
      assert.equal(id, plugin.name, `${command}: the plugin is ${plugin.name}`);
    }
  }
  // The check found the install, update and removal lines for both clients.
  assert.ok(seen.claude >= 3, `Claude Code ids checked: ${seen.claude}`);
  assert.ok(seen.codex >= 5, `Codex ids checked: ${seen.codex}`);
});

test('npm test runs every root test file', () => {
  const script = pkg.scripts.test;
  const files = readdirSync(ROOT).filter((name) => name.endsWith('.test.mjs'));
  assert.ok(files.includes('marketplace.test.mjs'));
  for (const file of files) assert.ok(script.split(/\s+/).includes(file), `npm test skips ${file}`);
});
