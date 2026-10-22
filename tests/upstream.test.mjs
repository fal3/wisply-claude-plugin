// Drift checks against the upstream checkouts. They run only when
// WISPLY_PLUGIN_DIR (wisply-claude-plugin) and WISPLY_AI_DIR (wisply-ai)
// point at local checkouts, as in the agent containers:
//
//   WISPLY_AI_DIR=/home/user/wisply-ai WISPLY_PLUGIN_DIR=/home/user/wisply-claude-plugin npm test
//
// While contract/SOURCE.json is provisional (no Docs/mcp-contract.json with
// tool_descriptors upstream yet), the contract is checked against the Swift
// source it was transcribed from, at the commit SOURCE.json records, instead
// of byte for byte. A separate test says when the checkout's Swift source has
// moved on from that commit.
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
//
// A small reader for the switches in MCPToolCatalog.swift: it lexes the Swift
// subset the catalog uses and parses each `switch self { case .a, .b: return
// VALUE ... }` into member -> value, so every descriptor is compared with
// the Swift source as a whole (property set, types, descriptions, bounds,
// enums and `required`), not by searching for fragments. Anything outside
// that subset fails the test, so a new helper in the catalog shows up here.

const CATALOG = 'Wisply/Services/MCP/MCPToolCatalog.swift';
/** The wisply-ai commit the provisional fixture was transcribed from ("885cc75 (transcribed)"), or null. */
const TRANSCRIBED_AT = /^([0-9a-f]{7,40}) \(transcribed\)$/.exec(appSource.commit)?.[1] ?? null;
const transcriptionSkip = () => (!APP_DIR ? 'WISPLY_AI_DIR not set' : !appSource.provisional ? 'not provisional' : false);
/** A Swift source as of the transcription commit; fails when the checkout doesn't have that commit. */
const transcribedSource = (path) => {
  assert.ok(TRANSCRIBED_AT, `contract/SOURCE.json: "${appSource.commit}" doesn't name the transcription commit`);
  const bytes = gitShow(APP_DIR, TRANSCRIBED_AT, path);
  assert.ok(bytes, `${path} at ${TRANSCRIBED_AT}: not in the WISPLY_AI_DIR checkout (fetch wisply-ai's history)`);
  return bytes.toString('utf8');
};
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
 * JSON the helpers build.
 */
function parseSwitch(text) {
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
  const optionalNumber = () => (is('name', 'nil') ? (take('name', 'nil'), undefined) : take('number'));

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

test('app: the provisional descriptors are the Swift catalog\'s at the transcription commit, word for word', {
  skip: transcriptionSkip(),
}, () => {
  // At the recorded commit, not the checkout: a later catalog (raycast PR 1's tail_words) is drift, which the next
  // test reports in so many words, not a reason for this reader to fail.
  const swift = transcribedSource(CATALOG);
  const cases = [...between(swift, 'enum MCPToolName', 'var hasSideEffects').matchAll(/case (\w+) = "([a-z_]+)"/g)]
    .map((match) => ({ member: match[1], name: match[2] }));
  assert.deepEqual(cases.map((entry) => entry.name), [...contract.tools], 'tool names and order');
  const memberOf = new Map(cases.map((entry) => [entry.name, entry.member]));
  const switchOf = (start, end) => {
    const values = parseSwitch(between(swift, start, end));
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

  assertSourceFacts(transcribedSource, `at ${TRANSCRIBED_AT}`);
});

/** The token prefixes, default port and identity scheme the fixture takes from other Swift files. */
function assertSourceFacts(read, where) {
  const scopes = read('Wisply/Services/MCP/MCPTokenScope.swift');
  assert.ok(scopes.includes('case .full: return "wsp_"') && scopes.includes('case .connector: return "wspc_"'), `token prefixes ${where}`);
  const server = read('Wisply/Services/MCP/MCPServer.swift');
  const port = /static let defaultPort: UInt16 = ([0-9_]+)/.exec(server)?.[1];
  assert.equal(Number(port?.replaceAll('_', '')), contract.default_port, `default port ${where}`);
  const proof = read('Wisply/Services/MCP/MCPIdentityProof.swift');
  assert.ok(proof.includes(`static let scheme = "${contract.identity_scheme}"`), `identity scheme ${where}`);
}

test('app: the checkout\'s Swift sources still say what the transcription commit said', { skip: transcriptionSkip() }, () => {
  // The whole catalog (every descriptor comes from it), and the few facts taken from the other files.
  assert.ok(readFileSync(join(APP_DIR, CATALOG), 'utf8') === transcribedSource(CATALOG), `${CATALOG} changed since ` +
    `${TRANSCRIBED_AT}: update the provisional fixture (and the commit in contract/SOURCE.json) or re-vendor from ` +
    'wisply-ai (DIST-M5)');
  assertSourceFacts((path) => readFileSync(join(APP_DIR, path), 'utf8'), `in the checkout (changed since ${TRANSCRIBED_AT})`);
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
    }`);
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
  });
  for (const text of [
    'switch self { case .a: return boolean("x") }',
    'switch self { case .a: return schema(properties: [:], extra: 1) }',
    'switch self { case .a: return "x\\n" }',
    'switch self { case .a: return !x }',
    'switch self { case .a: return true case .a: return false }',
  ]) {
    assert.throws(() => parseSwitch(text), assert.AssertionError, text);
  }
});
