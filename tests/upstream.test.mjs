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
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import contract, { contractProblems } from '../lib/contract.mjs';
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
  if (Object.hasOwn(upstream, 'tool_descriptors')) {
    // DIST-A1 is in this checkout. Re-vendor only once raycast PR 1's keys are there too: the connector can't load
    // a contract without the wspr_ scope, and sync-vendor refuses one (tests/sync-vendor.test.mjs).
    const problems = contractProblems(upstream);
    assert.deepEqual(problems, [], `wisply-ai's ${APP_CONTRACT} has tool_descriptors but the connector can't load it yet ` +
      `(${problems.join(', ')}): wait until raycast PR 1 and DIST-A1 are both on main, then re-vendor from that commit`);
    assert.fail(`wisply-ai's ${APP_CONTRACT} is final: re-vendor from its commit with npm run sync-vendor (without ` +
      '--provisional), then follow "Re-vendoring the contract" in SECURITY.md');
  }
  for (const key of Object.keys(upstream)) {
    assert.deepEqual(contract[key], upstream[key], `${key} drifted from wisply-ai: update the provisional fixture or re-vendor`);
  }
});

// The client templates are owned here (clients/mcp-clients.json); wisply-ai
// keeps a byte-identical copy for the Settings snippets (DIST-A1).
const APP_CLIENTS = 'Docs/mcp-clients.json';

test('app: Docs/mcp-clients.json is a byte-identical copy of clients/mcp-clients.json', {
  skip: !APP_DIR ? 'WISPLY_AI_DIR not set'
    : !existsSync(join(APP_DIR, APP_CLIENTS)) ? `no ${APP_CLIENTS} in wisply-ai yet (DIST-A1)` : false,
}, () => {
  assert.ok(local('clients/mcp-clients.json').equals(readFileSync(join(APP_DIR, APP_CLIENTS))),
    `${APP_CLIENTS} in wisply-ai differs from clients/mcp-clients.json: copy this file there (DIST-A1), or update it here first`);
});

// --- The transcription check (provisional only) -----------------------------
//
// A small reader for the switches in MCPToolCatalog.swift: it lexes the Swift
// subset the catalog uses and parses each `switch self { case .a, .b: return
// VALUE ... }` into member -> value, so every descriptor is compared with
// the Swift source as a whole (property set, types, descriptions, bounds,
// enums and `required`), not by searching for fragments. Anything outside
// that subset fails the test, so a new helper in the catalog shows up here.

const CATALOG = 'Wisply/Services/MCP/MCPToolCatalog.swift';
const between = (text, start, end) => {
  const from = text.indexOf(start);
  const to = text.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `${start} ... ${end} not found in ${CATALOG}`);
  return text.slice(from + start.length, to);
};

/** Tokens of the catalog's Swift subset. Comments and whitespace are dropped. */
function lexSwift(text) {
  const pattern = /\s+|\/\/[^\n]*|"((?:[^"\\\n]|\\.)*)"|([A-Za-z_][A-Za-z0-9_]*)|(-?[0-9]+)|([[\](),:.{}])/y;
  const tokens = [];
  while (pattern.lastIndex < text.length) {
    const at = pattern.lastIndex;
    const match = pattern.exec(text);
    assert.ok(match, `${CATALOG}: unexpected Swift: ${JSON.stringify(text.slice(at, at + 40))}`);
    if (match[1] !== undefined) {
      for (const [, escaped] of match[1].matchAll(/\\(.)/g)) {
        assert.ok(escaped === '"' || escaped === '\\', `${CATALOG}: only \\" and \\\\ escapes are read: ${match[1].slice(0, 40)}`);
      }
      tokens.push({ kind: 'string', value: match[1].replace(/\\(["\\])/g, '$1') });
    } else if (match[2] !== undefined) {
      tokens.push({ kind: 'name', value: match[2] });
    } else if (match[3] !== undefined) {
      tokens.push({ kind: 'number', value: Number(match[3]) });
    } else if (match[4] !== undefined) {
      tokens.push({ kind: 'punct', value: match[4] });
    }
  }
  return tokens;
}

/**
 * Parses the first `switch self { ... }` in `text` into Map(member -> value).
 * Values: true/false, a string literal, and the schema helpers:
 * schema(properties:required:), string(_:), integer(_:minimum:maximum:),
 * .object([...]), [k: v] dictionaries and [s, ...] arrays, which become the
 * JSON the helpers build. A bound may also name an integer constant
 * (`MCPLiveTranscript.maxTailWords`), looked up in `constants`
 * (swiftIntegerConstants).
 * @param {string} text
 * @param {Map<string, number>} [constants]
 */
function parseSwitch(text, constants = new Map()) {
  const tokens = lexSwift(text);
  let at = 0;
  const peek = (offset = 0) => tokens[at + offset];
  const is = (kind, value, offset = 0) => peek(offset)?.kind === kind && (value === undefined || peek(offset).value === value);
  const take = (kind, value) => {
    const token = tokens[at];
    assert.ok(token && token.kind === kind && (value === undefined || token.value === value),
      `${CATALOG}: expected ${value ?? kind}, found ${token ? JSON.stringify(token.value) : 'the end'}`);
    at += 1;
    return token.value;
  };
  const list = (close, item) => {
    const items = [];
    while (!is('punct', close)) {
      items.push(item());
      if (!is('punct', close)) take('punct', ',');
    }
    take('punct', close);
    return items;
  };
  const optionalNumber = () => {
    if (is('name', 'nil')) return (take('name', 'nil'), undefined);
    if (is('name') && is('punct', '.', 1) && is('name', undefined, 2)) {
      const key = `${take('name')}.${(take('punct', '.'), take('name'))}`;
      assert.ok(constants.has(key), `${CATALOG}: ${key} isn't an integer constant in Wisply/Services/MCP`);
      return constants.get(key);
    }
    return take('number');
  };

  function literal() {
    // [:] | [k: v, ...] | [s, ...]
    take('punct', '[');
    if (is('punct', ':')) {
      take('punct', ':');
      take('punct', ']');
      return {};
    }
    if (is('string') && is('punct', ':', 1)) {
      return Object.fromEntries(list(']', () => {
        const key = take('string');
        take('punct', ':');
        return [key, value()];
      }));
    }
    return list(']', value);
  }

  function value() {
    if (is('string')) return take('string');
    if (is('name', 'true') || is('name', 'false')) return take('name') === 'true';
    if (is('number')) return take('number');
    if (is('punct', '[')) return literal();
    if (is('punct', '.')) {
      take('punct', '.');
      take('name', 'object');
      take('punct', '(');
      const object = literal();
      take('punct', ')');
      return object;
    }
    const helper = take('name');
    take('punct', '(');
    if (helper === 'string') {
      const description = take('string');
      take('punct', ')');
      return { type: 'string', description };
    }
    if (helper === 'integer') {
      const description = take('string');
      take('punct', ',');
      take('name', 'minimum');
      take('punct', ':');
      const minimum = optionalNumber();
      take('punct', ',');
      take('name', 'maximum');
      take('punct', ':');
      const maximum = optionalNumber();
      take('punct', ')');
      return {
        type: 'integer', description,
        ...(minimum === undefined ? {} : { minimum }),
        ...(maximum === undefined ? {} : { maximum }),
      };
    }
    assert.equal(helper, 'schema', `${CATALOG}: unknown helper ${helper}(...)`);
    take('name', 'properties');
    take('punct', ':');
    const properties = literal();
    let required = [];
    if (is('punct', ',')) {
      take('punct', ',');
      take('name', 'required');
      take('punct', ':');
      required = literal();
    }
    take('punct', ')');
    // schema(properties:required:) adds "required" only when it isn't empty.
    return { type: 'object', properties, additionalProperties: false, ...(required.length > 0 ? { required } : {}) };
  }

  take('name', 'switch');
  take('name', 'self');
  take('punct', '{');
  const values = new Map();
  while (is('name', 'case')) {
    take('name', 'case');
    const members = list(':', () => {
      take('punct', '.');
      return take('name');
    });
    if (is('name', 'return')) take('name', 'return');
    const parsed = value();
    for (const member of members) {
      assert.ok(!values.has(member), `${CATALOG}: .${member} appears twice in one switch`);
      values.set(member, parsed);
    }
  }
  take('punct', '}');
  return values;
}

/**
 * `Type.name` -> value for every `static let name = <integer>` in the given
 * Swift sources, under the nearest enum, struct, class or extension above it.
 * @param {string[]} texts
 */
function swiftIntegerConstants(texts) {
  const constants = new Map();
  for (const text of texts) {
    const pattern = /\b(?:enum|struct|class|extension)\s+(\w+)|\bstatic let (\w+)(?:\s*:\s*\w+)?\s*=\s*(-?[0-9][0-9_]*)\b(?![ \t]*[.\w])/g;
    let type = null;
    for (const match of text.matchAll(pattern)) {
      if (match[1]) type = match[1];
      else if (type) constants.set(`${type}.${match[2]}`, Number(match[3].replaceAll('_', '')));
    }
  }
  return constants;
}

test('app: the provisional descriptors are the Swift catalog\'s, word for word', {
  skip: !APP_DIR ? 'WISPLY_AI_DIR not set' : !appSource.provisional ? 'not provisional' : false,
}, () => {
  const swift = readFileSync(join(APP_DIR, CATALOG), 'utf8');
  const cases = [...between(swift, 'enum MCPToolName', 'var hasSideEffects').matchAll(/case (\w+) = "([a-z_]+)"/g)]
    .map((match) => ({ member: match[1], name: match[2] }));
  assert.deepEqual(cases.map((entry) => entry.name), [...contract.tools], 'tool names and order');
  const memberOf = new Map(cases.map((entry) => [entry.name, entry.member]));
  const mcpFolder = join(APP_DIR, 'Wisply/Services/MCP');
  const constants = swiftIntegerConstants(readdirSync(mcpFolder).filter((name) => name.endsWith('.swift'))
    .map((name) => readFileSync(join(mcpFolder, name), 'utf8')));
  const switchOf = (start, end) => {
    const values = parseSwitch(between(swift, start, end), constants);
    assert.deepEqual([...values.keys()].sort(), cases.map((entry) => entry.member).sort(), `${start}: every tool exactly once`);
    return values;
  };
  const sideEffects = switchOf('var hasSideEffects: Bool {', 'var isAvailableToConnector: Bool {');
  const connector = switchOf('var isAvailableToConnector: Bool {', 'var returnsTranscriptContent: Bool {');
  const titles = switchOf('var title: String {', 'var description: String {');
  const descriptions = switchOf('var description: String {', 'var inputSchema: JSONValue {');
  const schemas = switchOf('var inputSchema: JSONValue {', '// MARK: - Schema helpers');
  assert.deepEqual(cases.filter((entry) => connector.get(entry.member) === true).map((entry) => entry.name),
    [...contract.scopes.connector.tools], 'connector scope');

  // How `descriptor` and the schema helpers build the JSON the reader assumes.
  const descriptorBody = between(swift, 'var descriptor: JSONValue {', 'var title: String {');
  for (const line of ['"name": .string(rawValue)', '"title": .string(title)', '"description": .string(description)',
    '"inputSchema": inputSchema', '"readOnlyHint": .bool(!hasSideEffects)', '"destructiveHint": .bool(false)',
    '"idempotentHint": .bool(!hasSideEffects)', '"openWorldHint": .bool(false)']) {
    assert.ok(descriptorBody.includes(line), `descriptor: ${line}`);
  }
  const helpers = swift.slice(swift.indexOf('// MARK: - Schema helpers'));
  for (const line of ['"type": "object"', '"properties": .object(properties)', '"additionalProperties": false',
    'if !required.isEmpty', '.object(["type": "string", "description": .string(description)])',
    'var object: [String: JSONValue] = ["type": "integer", "description": .string(description)]',
    'if let minimum { object["minimum"]', 'if let maximum { object["maximum"]']) {
    assert.ok(helpers.includes(line), `schema helpers: ${line}`);
  }

  for (const descriptor of contract.tool_descriptors) {
    const member = memberOf.get(descriptor.name);
    const side = sideEffects.get(member);
    assert.equal(typeof side, 'boolean', `${descriptor.name} side effects`);
    assert.deepEqual(Object.keys(descriptor), ['name', 'title', 'description', 'inputSchema', 'annotations'], descriptor.name);
    assert.equal(descriptor.title, titles.get(member), `${descriptor.name} title`);
    assert.equal(descriptor.description, descriptions.get(member), `${descriptor.name} description`);
    assert.deepEqual(descriptor.inputSchema, schemas.get(member), `${descriptor.name} inputSchema`);
    assert.deepEqual(descriptor.annotations, {
      title: titles.get(member), readOnlyHint: !side, destructiveHint: false, idempotentHint: !side, openWorldHint: false,
    }, `${descriptor.name} annotations`);
  }

  const scopes = readFileSync(join(APP_DIR, 'Wisply/Services/MCP/MCPTokenScope.swift'), 'utf8');
  assert.ok(scopes.includes('case .full: return "wsp_"') && scopes.includes('case .connector: return "wspc_"'), 'token prefixes');
  const server = readFileSync(join(APP_DIR, 'Wisply/Services/MCP/MCPServer.swift'), 'utf8');
  const port = /static let defaultPort: UInt16 = ([0-9_]+)/.exec(server)?.[1];
  assert.equal(Number(port?.replaceAll('_', '')), contract.default_port, 'default port');
  const proof = readFileSync(join(APP_DIR, 'Wisply/Services/MCP/MCPIdentityProof.swift'), 'utf8');
  assert.ok(proof.includes(`static let scheme = "${contract.identity_scheme}"`), 'identity scheme');
});

test('the Swift reader parses the catalog\'s shapes and rejects anything else', () => {
  const values = parseSwitch(`switch self {
    case .a, .b: // a comment
        return true
    case .c: return "Say \\"hi\\" \\\\ there"
    case .d:
        return schema(properties: [
            "n": integer("Count (1\u2013100).", minimum: 1, maximum: nil),
            "k": .object([ "type": "string", "enum": ["x", "y"], "description": "Kind." ]),
            "s": string("Text.")
        ], required: ["s"])
    case .e: return schema(properties: [:])
    case .f: return schema(properties: ["t": integer("Tail.", minimum: 1, maximum: Limits.maxTail)])
    }`, swiftIntegerConstants(['nonisolated extension Limits {\n    static let maxTail = 5_000\n    static let other: Int = 7\n}']));
  assert.deepEqual(Object.fromEntries(values), {
    a: true, b: true, c: 'Say "hi" \\ there',
    d: {
      type: 'object', additionalProperties: false, required: ['s'], properties: {
        n: { type: 'integer', description: 'Count (1\u2013100).', minimum: 1 },
        k: { type: 'string', enum: ['x', 'y'], description: 'Kind.' },
        s: { type: 'string', description: 'Text.' },
      },
    },
    e: { type: 'object', additionalProperties: false, properties: {} },
    f: { type: 'object', additionalProperties: false, properties: { t: { type: 'integer', description: 'Tail.', minimum: 1, maximum: 5000 } } },
  });
  assert.deepEqual([...swiftIntegerConstants(['enum A {\n static let x = 1_0\n static let y = 2.5\n}\nstruct B { static let z: Int = 3 }'])],
    [['A.x', 10], ['B.z', 3]]);
  for (const text of [
    'switch self { case .a: return boolean("x") }',
    'switch self { case .a: return schema(properties: [:], extra: 1) }',
    'switch self { case .a: return "x\\n" }',
    'switch self { case .a: return !x }',
    'switch self { case .a: return true case .a: return false }',
    'switch self { case .a: return integer("x", minimum: nil, maximum: Unknown.limit) }',
  ]) {
    assert.throws(() => parseSwitch(text), assert.AssertionError, text);
  }
});
