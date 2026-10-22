// The root manifests (Agent Plugin, Codex marketplace, Gemini CLI extension,
// MCPB bundle, Glama), the README's install matrix and llms-install.md: names,
// versions and the package agree everywhere, each file validates against its
// upstream schema, and none of them can carry a token.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import contract from '../lib/contract.mjs';
import {
  MCP_NAME, NPX_FLAGS, PACKAGE_NAME, PACKAGE_RANGE, PACKAGE_SPEC, SERVER_KEY, STANDARD_ENTRY as ENTRY, VERSION,
} from '../lib/constants.mjs';
import { SETUP_COMMAND } from '../lib/messages.mjs';
import { toolsFor } from '../lib/scopes.mjs';
import {
  MCPB_NAME, MCPB_VERSION, PACKER_DIR, bundleFileName, jsonText as buildJsonText, mcpbTools, releaseTag, renderManifest,
} from '../scripts/build-mcpb.mjs';
import { validate } from './helpers/json-schema.mjs';
import { KEYWORD_RE, ROOT, SECRET_LIKE, exists, jsonText, pngSize, readJson, readText } from './helpers/repo.mjs';

const pkg = readJson('package.json');
const plugin = readJson('plugin.json');
const mcp = readJson('mcp.json');
const marketplace = readJson('.agents/plugins/marketplace.json');
const gemini = readJson('gemini-extension.json');
const mcpb = readJson('mcpb/manifest.json');
const glama = readJson('glama.json');
const server = readJson('server.json');
const readme = readText('README.md');

const AGENT_PLUGIN_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
const AGENT_MCP_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json';
const REPO_URL = 'https://github.com/fal3/wisply-mcp';
/** The token-free entry every npm snippet and link runs (DIST-M1: npx's --prefix / and the exact version). */
const STANDARD_ENTRY = { command: ENTRY.command, args: [...ENTRY.args] };
const MANIFESTS = ['plugin.json', 'mcp.json', '.agents/plugins/marketplace.json', 'gemini-extension.json', 'mcpb/manifest.json',
  'glama.json', 'server.json', 'registry/cloud.server.json'];
const schema = (path) => readJson(`tests/schemas/${path}`);
/** What a token field must say: use the read-only token, and what a full-access one would allow. */
const TOKEN_FIELD = /read-only connector token \(wspc_\.\.\.\)[\s\S]*full-access token \(wsp_\.\.\.\) also works here, but it lets this AI app start and stop recordings/;

test('every manifest is canonical JSON (two-space indent, final newline)', () => {
  for (const path of MANIFESTS) assert.equal(readText(path), jsonText(readJson(path)), `${path}: rewrite it as JSON.stringify(doc, null, 2) + "\\n"`);
  assert.equal(jsonText({ a: [1] }), buildJsonText({ a: [1] }));
});

test('names, versions and the package agree with package.json and lib/constants.mjs', () => {
  assert.equal(pkg.name, PACKAGE_NAME);
  assert.equal(pkg.version, VERSION);
  assert.equal(plugin.name, SERVER_KEY);
  assert.equal(plugin.version, VERSION);
  assert.equal(gemini.name, SERVER_KEY);
  assert.equal(gemini.version, VERSION);
  assert.equal(mcpb.name, SERVER_KEY);
  assert.equal(mcpb.version, VERSION);
  assert.equal(server.name, pkg.mcpName);
  assert.equal(server.name, MCP_NAME);
  assert.equal(server.version, VERSION);
  const npm = server.packages.find((entry) => entry.registryType === 'npm');
  assert.equal(npm.identifier, PACKAGE_NAME);
  assert.equal(npm.version, VERSION);
  assert.deepEqual(Object.keys(mcp.mcpServers), [SERVER_KEY]);
  assert.deepEqual(Object.keys(gemini.mcpServers), [SERVER_KEY]);
  assert.deepEqual(marketplace.plugins.filter((entry) => entry.source === './').map((entry) => entry.name), [plugin.name]);
  // One description for the plugin listings, one for the registry and the bundle.
  assert.equal(gemini.description, plugin.description);
  assert.equal(mcpb.description, server.description);
  // One repository and one homepage.
  assert.equal(pkg.repository, 'github:fal3/wisply-mcp');
  assert.equal(plugin.repository, REPO_URL);
  assert.equal(server.repository.url, REPO_URL);
  assert.equal(mcpb.repository.url, REPO_URL);
  assert.equal(plugin.homepage, pkg.homepage);
  assert.equal(mcpb.homepage, pkg.homepage);
  assert.equal(server.websiteUrl, pkg.homepage);
  assert.equal(plugin.license, pkg.license);
  assert.equal(mcpb.license, pkg.license);
});

test('plugin.json and mcp.json validate against the Agent Plugins 1.0.0 schemas and target the same version', () => {
  assert.deepEqual(validate(schema('agent-plugins-1.0.0/plugin.schema.json'), plugin), []);
  assert.deepEqual(validate(schema('agent-plugins-1.0.0/mcp.schema.json'), mcp), []);
  // Spec section 10.1: mcp.json must target the plugin's version, and clients (Codex) recognize 1.0.0.
  assert.equal(plugin.$schema, AGENT_PLUGIN_SCHEMA);
  assert.equal(mcp.$schema, AGENT_MCP_SCHEMA);
});

test('plugin.json: only the spec fields, lowercase hyphenated keywords, a local-only description', () => {
  assert.deepEqual(Object.keys(plugin), ['$schema', 'name', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords']);
  assert.deepEqual(plugin.author, { name: 'Wisply', email: 'support@wisply.ai', url: 'https://www.wisply.ai' });
  for (const keyword of plugin.keywords) assert.match(keyword, KEYWORD_RE);
  assert.ok(plugin.keywords.includes('local'));
  assert.match(plugin.description, /this Mac/);
});

test('mcp.json: one local stdio server that runs the bundled bin, no env, no headers, no URL', () => {
  const entry = mcp.mcpServers[SERVER_KEY];
  assert.deepEqual(entry, { type: 'stdio', command: 'node', args: ['${PLUGIN_ROOT}/bin/wisply-mcp.mjs'] });
  assert.equal(`bin/wisply-mcp.mjs`, pkg.bin['wisply-mcp']);
  assert.ok(exists(pkg.bin['wisply-mcp']));
  // The root plugin stays local-only: the remote server is the separate wisply-cloud plugin (DIST-M6).
  for (const [name, server_] of Object.entries(mcp.mcpServers)) {
    assert.equal(server_.type, 'stdio', name);
    assert.equal(Object.hasOwn(server_, 'url') || Object.hasOwn(server_, 'headers') || Object.hasOwn(server_, 'env'), false, name);
  }
});

// DIST-M6 lists a second plugin, wisply-cloud, once Cloud Connect launches (scripts/cloud-entry.mjs checks it).
const CLOUD_PLUGIN = { name: 'wisply-cloud', source: './cloud-connect/plugin' };

test('.agents/plugins/marketplace.json: the Codex marketplace lists the root plugin at "./"', () => {
  assert.deepEqual(Object.keys(marketplace), ['name', 'interface', 'plugins']);
  assert.equal(marketplace.name, 'wisply');
  assert.deepEqual(marketplace.interface, { displayName: 'Wisply' });
  const [entry, ...others] = marketplace.plugins;
  for (const other of others) {
    assert.deepEqual({ name: other.name, source: other.source }, CLOUD_PLUGIN, 'only the wisply-cloud plugin may join the local one');
  }
  assert.deepEqual(Object.keys(entry), ['name', 'source', 'category', 'description']);
  assert.equal(entry.source, './');
  assert.equal(entry.category, 'productivity');
  assert.match(entry.description, /this Mac/);
  // No policy: Codex's default is AVAILABLE, never installed by default.
  assert.equal(Object.hasOwn(entry, 'policy'), false);
});

test('gemini-extension.json: the bundled bin, the token only as a sensitive setting, nothing else loaded', () => {
  assert.deepEqual(Object.keys(gemini), ['name', 'version', 'description', 'mcpServers', 'settings']);
  assert.match(gemini.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  assert.deepEqual(gemini.mcpServers[SERVER_KEY], {
    command: 'node', args: ['${extensionPath}/bin/wisply-mcp.mjs'], cwd: '${extensionPath}',
  });
  // Gemini passes extensions only HOME, PATH, TMPDIR and declared settings, so the token must be declared.
  assert.equal(gemini.settings.length, 1);
  const [setting] = gemini.settings;
  assert.deepEqual(Object.keys(setting), ['name', 'description', 'envVar', 'sensitive']);
  assert.equal(setting.envVar, 'WISPLY_MCP_TOKEN');
  assert.equal(setting.sensitive, true);
  assert.match(setting.description, /^Optional\./);
  assert.ok(setting.description.includes(SETUP_COMMAND), 'the setting names the setup command');
  // The connector accepts any Wisply token from the environment, so the field says what a full-access one allows.
  assert.match(setting.description, TOKEN_FIELD);
  // Gemini also loads GEMINI.md, hooks/hooks.json and agents/ from an extension's root. None may exist by accident.
  for (const path of ['GEMINI.md', 'hooks/hooks.json', 'agents']) assert.equal(exists(path), false, path);
});

test('mcpb/manifest.json validates against MCPB 0.3 and runs the bundled bin', () => {
  assert.deepEqual(validate(schema('mcpb-0.3/manifest.schema.json'), mcpb), []);
  assert.equal(mcpb.manifest_version, '0.3');
  assert.deepEqual(mcpb.server, {
    type: 'node',
    entry_point: 'bin/wisply-mcp.mjs',
    mcp_config: {
      command: 'node',
      args: ['${__dirname}/bin/wisply-mcp.mjs'],
      env: { WISPLY_MCP_TOKEN: '${user_config.wisply_mcp_token}' },
    },
  });
  assert.equal(mcpb.server.entry_point, pkg.bin['wisply-mcp']);
  assert.deepEqual(mcpb.compatibility, { platforms: ['darwin'], runtimes: { node: '>=20.0.0' } });
  assert.equal(pkg.engines.node, '>=20');
  for (const url of [mcpb.homepage, mcpb.documentation, mcpb.support, mcpb.author.url, ...mcpb.privacy_policies]) {
    assert.match(url, /^https:\/\/www\.wisply\.ai(\/|$)/);
  }
});

test('mcpb/manifest.json: the token field is optional, masked and defaults to "" (so an empty field reaches the Keychain fallback)', () => {
  assert.deepEqual(Object.keys(mcpb.user_config), ['wisply_mcp_token']);
  const field = mcpb.user_config.wisply_mcp_token;
  assert.equal(field.type, 'string');
  assert.equal(field.sensitive, true);
  assert.equal(field.required, false);
  // Without a default, mcpb leaves ${user_config.wisply_mcp_token} unreplaced (tests/mcpb-config.test.mjs).
  assert.equal(field.default, '');
  assert.ok(field.description.includes(SETUP_COMMAND));
  assert.match(field.description, TOKEN_FIELD);
});

test('mcpb/manifest.json: a provider-neutral long_description (the same bundle installs in any MCPB host)', () => {
  const text = mcpb.long_description;
  assert.match(text, /127\.0\.0\.1/);
  assert.match(text, /sent to the AI service it uses/);
  assert.doesNotMatch(text, /Anthropic|Claude|OpenAI|ChatGPT|Google|Gemini|Microsoft|Copilot|Cursor|Bedrock|Vertex/i);
});

test('mcpb/manifest.json: tools are what the bundle can serve, with their descriptors (node scripts/build-mcpb.mjs --sync)', () => {
  assert.deepEqual(mcpb.tools, mcpbTools(contract));
  // The widest token with the bundle's own flags: setup_claude needs --allow-claude-setup, which the bundle never
  // passes, so a listing that named it (Claude's directory, Smithery) would show a tool no client ever gets.
  assert.deepEqual(mcpb.tools.map((tool) => tool.name), toolsFor(contract, 'full'));
  assert.ok(!mcpb.tools.some((tool) => tool.name === 'setup_claude'));
  const config = JSON.stringify(mcpb.server.mcp_config);
  assert.doesNotMatch(config, /allow-claude-setup|ALLOW_CLAUDE_SETUP/);
  assert.deepEqual(Object.keys(mcpb.server.mcp_config.env), ['WISPLY_MCP_TOKEN']);
  assert.equal(mcpb.tools_generated, true, 'the tools a client sees depend on the token scope');
  assert.equal(readText('mcpb/manifest.json'), buildJsonText(renderManifest(mcpb, { contract, version: VERSION })));
});

test('the bundle icon is a 512x512 PNG next to the manifest', () => {
  assert.equal(mcpb.icon, 'icon.png');
  assert.deepEqual(pngSize(readFileSync(join(ROOT, 'mcpb', mcpb.icon))), { width: 512, height: 512 });
});

test('glama.json claims the repository for its maintainer only', () => {
  assert.deepEqual(glama, { $schema: 'https://glama.ai/mcp/schemas/server.json', maintainers: ['fal3'] });
});

test('no manifest, skill, command or install text can hold a token or an auth header', () => {
  const files = [...MANIFESTS, 'llms-install.md', 'README.md', 'skills/wisply-memos/SKILL.md',
    ...readdirSync(join(ROOT, 'commands/wisply')).map((name) => `commands/wisply/${name}`),
    'extras/cursor/README.md', 'extras/cursor/rules/wisply.mdc', 'extras/cursor/commands/wisply-recap.md'];
  for (const file of files) assert.doesNotMatch(readText(file), SECRET_LIKE, file);
  // And no config passes the token through a file: only the MCPB placeholder and the Gemini setting name it.
  for (const file of ['mcp.json', 'gemini-extension.json', 'server.json', 'llms-install.md']) {
    assert.doesNotMatch(readText(file), /"WISPLY_MCP_TOKEN"\s*:/, file);
  }
});

test('every npm command and entry in these files runs npx with --prefix / and the exact version', () => {
  // DIST-M1: without --prefix /, npx resolves the package from the open project (a planted node_modules or
  // .npmrc) before npm. tests/pack.test.mjs holds the README, SECURITY.md, the CHANGELOG and the design notes to
  // this; these are the rest of what this repository publishes. The skill keeps the design's text, which names
  // the package without a command (docs/design-differences.md), and is checked in tests/skills.test.mjs.
  const escaped = PACKAGE_NAME.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const npx = new RegExp(`\\bnpx((?: +-[\\w-]+(?: +/(?= ))?)*) +(${escaped}[^\\s\`"'),]*)`, 'g');
  const files = [...MANIFESTS, 'llms-install.md', ...readdirSync(join(ROOT, 'commands/wisply')).map((name) => `commands/wisply/${name}`),
    'extras/cursor/README.md', 'extras/cursor/rules/wisply.mdc', 'extras/cursor/commands/wisply-recap.md'];
  let seen = 0;
  for (const file of files) {
    const text = readText(file);
    for (const match of text.matchAll(npx)) {
      seen += 1;
      assert.equal(match[1].trim(), NPX_FLAGS.join(' '), `${file}: ${match[0]}`);
      assert.equal(match[2], PACKAGE_SPEC, `${file}: ${match[0]}`);
    }
    assert.doesNotMatch(text, new RegExp(`npx -y ${escaped}`), `${file}: npx without --prefix /`);
    assert.doesNotMatch(text, new RegExp(`"-y",\\s*"${escaped}`), `${file}: an entry without --prefix /`);
  }
  // server.json, gemini-extension.json, mcpb/manifest.json and llms-install.md (twice) name a command.
  assert.ok(seen >= 5, `only ${seen} npx commands found`);
});

test('the JSON Schema checker catches what the schemas forbid', () => {
  const pluginSchema = schema('agent-plugins-1.0.0/plugin.schema.json');
  const mcpSchema = schema('agent-plugins-1.0.0/mcp.schema.json');
  assert.notDeepEqual(validate(pluginSchema, { ...plugin, logo: 'x.png' }), []);
  assert.notDeepEqual(validate(pluginSchema, { ...plugin, name: 'Wisply' }), []);
  const { $schema, ...noSchema } = plugin;
  assert.notDeepEqual(validate(pluginSchema, noSchema), []);
  const withUrl = { ...mcp, mcpServers: { wisply: { ...mcp.mcpServers.wisply, url: 'https://example.com' } } };
  assert.notDeepEqual(validate(mcpSchema, withUrl), []);
  const reserved = { ...mcp, mcpServers: { wisply: { ...mcp.mcpServers.wisply, env: { PLUGIN_ROOT: '/x' } } } };
  assert.notDeepEqual(validate(mcpSchema, reserved), []);
  assert.notDeepEqual(validate(schema('mcpb-0.3/manifest.schema.json'), { ...mcpb, tools: [{ name: 'x', extra: 1 }] }), []);
  assert.throws(() => validate({ unknownKeyword: true }, {}), /unsupported keyword/);
});

test('the vendored schemas are unchanged copies (tests/schemas/SOURCE.json)', () => {
  const source = readJson('tests/schemas/SOURCE.json');
  const listed = [];
  for (const entry of source.sources) {
    assert.ok(entry.license && entry.commit && entry.repository);
    for (const [path, { sha256 }] of Object.entries(entry.files)) {
      listed.push(path);
      assert.equal(createHash('sha256').update(readFileSync(join(ROOT, path))).digest('hex'), sha256, path);
    }
  }
  const onDisk = readdirSync(join(ROOT, 'tests/schemas'), { withFileTypes: true }).filter((entry) => entry.isDirectory())
    .flatMap((dir) => readdirSync(join(ROOT, 'tests/schemas', dir.name)).map((name) => `tests/schemas/${dir.name}/${name}`));
  assert.deepEqual(listed.sort(), onDisk.sort());
});

test('ci.yml: the mcpb job installs only the pinned MCPB tool from its lockfile, without scripts, and runs the tests with it', () => {
  const ci = readText('.github/workflows/ci.yml');
  const jobsAt = ci.indexOf('\njobs:\n');
  assert.ok(jobsAt > 0);
  const blocks = {};
  let current = null;
  for (const line of ci.slice(jobsAt + 7).split('\n')) {
    const job = /^ {2}([a-z][a-z0-9-]*):$/.exec(line);
    if (job) blocks[(current = job[1])] = [];
    else if (current) blocks[current].push(line);
  }
  assert.deepEqual(Object.keys(blocks), ['test', 'mcpb']);
  for (const [name, lines] of Object.entries(blocks)) {
    const text = lines.join('\n');
    assert.match(text, /^ {4}if: \$\{\{ !github\.event\.repository\.private \}\}$/m, `${name}: skipped while private`);
    assert.match(text, /persist-credentials: false/, name);
    assert.match(text, /timeout-minutes: \d+/, name);
  }
  const mcpbJob = blocks.mcpb.join('\n');
  assert.ok(mcpbJob.includes(`run: npm ci --ignore-scripts --no-audit --no-fund --prefix ${PACKER_DIR}`));
  assert.ok(mcpbJob.includes(`run: WISPLY_MCPB_LIB=$PWD/${PACKER_DIR}/node_modules/${MCPB_NAME}/dist/index.js npm test`));
  assert.doesNotMatch(mcpbJob, /npm install|npx/, 'only npm ci from the lockfile');
  assert.doesNotMatch(blocks.test.join('\n'), /npm (ci|install)/);
  assert.match(readText('.gitignore'), /^dist\/$/m);
});

test('tools/mcpb pins the MCPB packer and its whole dependency tree, and the build never runs npx', () => {
  const tool = readJson(`${PACKER_DIR}/package.json`);
  assert.deepEqual(Object.keys(tool), ['name', 'version', 'private', 'description', 'license', 'dependencies']);
  assert.equal(tool.private, true);
  assert.deepEqual(tool.dependencies, { [MCPB_NAME]: MCPB_VERSION }, 'an exact version, no range');
  assert.equal(Object.hasOwn(tool, 'scripts'), false);
  const lock = readJson(`${PACKER_DIR}/package-lock.json`);
  assert.equal(lock.lockfileVersion, 3);
  assert.deepEqual(lock.packages[''].dependencies, tool.dependencies);
  assert.equal(lock.packages[`node_modules/${MCPB_NAME}`].version, MCPB_VERSION);
  const installed = Object.entries(lock.packages).filter(([path]) => path !== '');
  assert.ok(installed.length > 1);
  for (const [path, entry] of installed) {
    assert.match(entry.integrity ?? '', /^sha512-/, `${path}: integrity hash`);
    assert.equal(new URL(entry.resolved).origin, 'https://registry.npmjs.org', `${path}: from the npm registry`);
    assert.notEqual(entry.hasInstallScript, true, `${path}: no install script (installed with --ignore-scripts anyway)`);
  }
  // .gitignore ignores lockfiles except this one, so it stays committed.
  assert.match(readText('.gitignore'), /^!tools\/mcpb\/package-lock\.json$/m);
  assert.doesNotMatch(readText('scripts/build-mcpb.mjs'), /['"]npx['"]/, 'the build packs with the pinned copy, never npx');
  assert.equal(releaseTag(VERSION), `v${VERSION}`);
});

// --- README install matrix ------------------------------------------------------------------------

/** Every https link in the README, as URL objects. */
const links = [...readme.matchAll(/\]\((https:\/\/[^)\s]+)\)/g)].map((match) => new URL(match[1]));
const fromBase64 = (text) => JSON.parse(Buffer.from(text, 'base64').toString('utf8'));

test('README one-click links decode to the standard entry with the exact version', () => {
  const found = {};
  for (const url of links) {
    if (url.host === 'cursor.com' && url.pathname === '/en/install-mcp') {
      found.cursor = true;
      assert.equal(url.searchParams.get('name'), SERVER_KEY);
      assert.deepEqual(fromBase64(url.searchParams.get('config')), STANDARD_ENTRY);
    } else if (url.host === 'lmstudio.ai' && url.pathname === '/install-mcp') {
      found.lmStudio = true;
      assert.equal(url.searchParams.get('name'), SERVER_KEY);
      assert.deepEqual(fromBase64(url.searchParams.get('config')), STANDARD_ENTRY);
    } else if (url.host === 'insiders.vscode.dev' && url.pathname === '/redirect') {
      const inner = url.searchParams.get('url');
      const match = /^(vscode|vscode-insiders):mcp\/install\?(.+)$/.exec(inner);
      assert.ok(match, inner);
      found[match[1]] = true;
      assert.deepEqual(JSON.parse(decodeURIComponent(match[2])), { name: SERVER_KEY, ...STANDARD_ENTRY });
    } else if (url.host === 'block.github.io' && url.pathname === '/goose/extension') {
      found.goose = true;
      assert.equal(url.searchParams.get('cmd'), STANDARD_ENTRY.command);
      assert.deepEqual(url.searchParams.getAll('arg'), STANDARD_ENTRY.args);
      assert.equal(url.searchParams.get('id'), SERVER_KEY);
      assert.equal(url.searchParams.get('timeout'), '300');
      assert.equal(url.searchParams.has('env'), false);
    } else if (url.host === 'kiro.dev' && url.pathname === '/launch/mcp/add') {
      found.kiro = true;
      assert.equal(url.searchParams.get('name'), SERVER_KEY);
      assert.deepEqual(JSON.parse(url.searchParams.get('config')), STANDARD_ENTRY);
    }
  }
  assert.deepEqual(Object.keys(found).sort(), ['cursor', 'goose', 'kiro', 'lmStudio', 'vscode', 'vscode-insiders']);
});

test('README snippets run the exact version; the 0.x range appears only in the opt-in note', () => {
  for (const match of readme.matchAll(/@wisply\/mcp@[0-9][0-9.]*[0-9]|@wisply\/mcp@[0-9]/g)) {
    assert.ok([PACKAGE_SPEC, PACKAGE_RANGE].includes(match[0]), match[0]);
  }
  const rangeUses = readme.split(`\`${PACKAGE_RANGE}\``).length - 1;
  assert.equal(rangeUses, 1, 'the range is named once, in the Versions note');
  for (const encoded of readme.matchAll(/%40wisply%2Fmcp%40[0-9.]+/g)) {
    assert.equal(decodeURIComponent(encoded[0]), PACKAGE_SPEC);
  }
});

test('README covers every client the guide lists, and its JSON snippets parse', () => {
  const firstCells = readme.split('\n').filter((line) => line.startsWith('| ') && !line.startsWith('| App '))
    .map((line) => line.split(' | ')[0].slice(2).trim());
  for (const client of ['Claude Code', 'Claude Desktop', 'Cursor', 'VS Code', 'Windsurf', 'Zed', 'JetBrains', 'Codex',
    'Gemini CLI', 'GitHub Copilot CLI', 'Warp', 'Cline', 'Roo Code', 'Goose', 'LM Studio', 'Kiro', 'opencode', 'Amp',
    'Factory', 'Grok CLI']) {
    assert.ok(firstCells.some((cell) => cell.split(/, | \/ /).some((name) => name.startsWith(client))), client);
  }
  const snippets = [...readme.matchAll(/`(\{"[^`]*\})`/g)].map((match) => match[1]);
  assert.ok(snippets.length >= 10);
  for (const snippet of snippets) {
    const parsed = JSON.parse(snippet);
    const text = JSON.stringify(parsed);
    assert.ok(text.includes(PACKAGE_SPEC) || snippet === JSON.stringify(STANDARD_ENTRY), snippet);
    assert.doesNotMatch(text, /WISPLY_MCP_TOKEN/);
  }
  // The Gemini command keeps -y after --, or Gemini reads it as its own flag.
  assert.ok(readme.includes(`gemini mcp add --scope user wisply npx -- ${NPX_FLAGS.join(' ')} ${PACKAGE_SPEC}`));
});

test('README names the plugin, extension and bundle installs from this repository', () => {
  assert.ok(readme.includes('codex plugin marketplace add fal3/wisply-mcp'));
  assert.ok(readme.includes('copilot plugin install fal3/wisply-mcp'));
  assert.ok(readme.includes(`gemini extensions install ${REPO_URL}`));
  // Where the app takes a git ref, the README gives the release tag, so a push to main never reaches that install.
  assert.ok(readme.includes(`codex plugin marketplace add fal3/wisply-mcp --ref ${releaseTag(VERSION)}`));
  assert.ok(readme.includes(`gemini extensions install ${REPO_URL} --ref ${releaseTag(VERSION)}`));
  for (const match of readme.matchAll(/--ref (v[0-9][^\s`]*)/g)) assert.equal(match[1], releaseTag(VERSION), match[0]);
  assert.ok(readme.replace(/\s+/g, ' ').includes(`**Chat: Install Plugin From Source** with \`${REPO_URL}\``));
  assert.ok(readme.includes(`\`${bundleFileName(VERSION)}\``));
  for (const command of ['recap', 'live', 'find']) {
    assert.ok(readme.includes(`/wisply:${command}`), command);
    assert.ok(exists(`commands/wisply/${command}.toml`), command);
  }
});

test('llms-install.md: the setup command, the token-free entry and the keychain, never the token in chat', () => {
  const text = readText('llms-install.md');
  assert.ok(text.includes(SETUP_COMMAND));
  const json = /```json\n([\s\S]*?)```/.exec(text)[1];
  const entry = JSON.parse(json).mcpServers[SERVER_KEY];
  assert.deepEqual(entry, { type: 'stdio', ...STANDARD_ENTRY, disabled: false, autoApprove: [] });
  assert.match(text, /Never ask for the Wisply token in chat/);
  assert.match(text, /keychain/);
  assert.match(text, /127\.0\.0\.1/);
  assert.match(text, /sent to the AI service/);
});
