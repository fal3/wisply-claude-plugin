// The vendored contract's shape: tools, scopes, descriptors, codes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import contract, { CONTRACT_SCHEMA, contractProblems, defaultPort, descriptorFor, scopes, tools } from '../lib/contract.mjs';
import { DEFAULT_PORT } from '../lib/constants.mjs';
import { IDENTITY_SCHEME } from '../lib/identity.mjs';
import { scopeOfToken, toolsFor } from '../lib/scopes.mjs';

const raw = JSON.parse(readFileSync(new URL('../contract/mcp-contract.json', import.meta.url), 'utf8'));
const SIDE_EFFECTS = new Set(['start_recording', 'stop_recording', 'propose_follow_up', 'setup_claude']);
const SCHEMA_TYPES = new Set(['string', 'integer', 'number', 'boolean', 'array', 'object']);

test('header fields', () => {
  assert.deepEqual(contractProblems(contract), []);
  assert.equal(contract.schema, CONTRACT_SCHEMA);
  assert.equal(contract.identity_scheme, IDENTITY_SCHEME);
  assert.equal(contract.default_port, 51771);
  assert.equal(defaultPort, DEFAULT_PORT);
  assert.equal(tools.length, 9);
  assert.equal(new Set(tools).size, tools.length);
  for (const tool of tools) assert.match(tool, /^[a-z][a-z_]*[a-z]$/);
});

test('scopes: prefixes match the token shapes, tools stay in contract order', () => {
  assert.deepEqual(Object.keys(scopes).sort(), ['connector', 'full', 'recording']);
  assert.deepEqual(Object.fromEntries(Object.entries(scopes).map(([name, scope]) => [name, scope.prefix])),
    { full: 'wsp_', connector: 'wspc_', recording: 'wspr_' });
  for (const [name, scope] of Object.entries(scopes)) {
    assert.equal(scopeOfToken(`${scope.prefix}${'ab'.repeat(32)}`), name);
    assert.deepEqual(scope.tools, tools.filter((tool) => scope.tools.includes(tool)), `${name} keeps contract order`);
    assert.deepEqual(toolsFor(contract, name, { allowClaudeSetup: true }), [...scope.tools]);
  }
  assert.deepEqual(scopes.full.tools, tools);
  assert.deepEqual(scopes.connector.tools, ['list_memos', 'search_transcripts', 'get_live_transcript', 'get_action_items']);
  assert.deepEqual(scopes.recording.tools, ['start_recording', 'stop_recording', 'propose_follow_up']);
  assert.deepEqual(toolsFor(contract, 'nope'), []);
  assert.deepEqual(toolsFor(contract, null), []);
  assert.deepEqual(toolsFor(contract, '__proto__'), []);
});

test('every tool has a descriptor that is a closed JSON Schema object', () => {
  assert.deepEqual(contract.tool_descriptors.map((descriptor) => descriptor.name), tools);
  for (const descriptor of contract.tool_descriptors) {
    const { name, title, description, inputSchema, annotations } = descriptor;
    assert.deepEqual(Object.keys(descriptor), ['name', 'title', 'description', 'inputSchema', 'annotations'], name);
    assert.equal(descriptorFor(name), descriptor);
    assert.ok(title.length > 0 && description.length > 20, name);
    assert.equal(inputSchema.type, 'object', name);
    assert.equal(inputSchema.additionalProperties, false, name);
    assert.ok(inputSchema.properties && typeof inputSchema.properties === 'object' && !Array.isArray(inputSchema.properties), name);
    for (const [property, schema] of Object.entries(inputSchema.properties)) {
      assert.ok(SCHEMA_TYPES.has(schema.type), `${name}.${property}`);
      assert.equal(typeof schema.description, 'string', `${name}.${property}`);
      if (schema.minimum !== undefined && schema.maximum !== undefined) assert.ok(schema.minimum <= schema.maximum);
      if (schema.enum) assert.ok(schema.enum.every((value) => typeof value === 'string'));
    }
    for (const required of inputSchema.required ?? []) assert.ok(Object.hasOwn(inputSchema.properties, required), `${name} requires ${required}`);
    assert.deepEqual(Object.keys(annotations), ['title', 'readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']);
    assert.equal(annotations.title, title);
    assert.equal(annotations.readOnlyHint, !SIDE_EFFECTS.has(name), name);
    assert.equal(annotations.idempotentHint, annotations.readOnlyHint, name);
    assert.equal(annotations.destructiveHint, false);
    assert.equal(annotations.openWorldHint, false);
  }
  for (const tool of scopes.connector.tools) assert.equal(descriptorFor(tool).annotations.readOnlyHint, true, tool);
  assert.deepEqual(descriptorFor('search_transcripts').inputSchema.required, ['query']);
});

test('error codes and legacy prefixes', () => {
  assert.equal(new Set(contract.error_codes).size, contract.error_codes.length);
  for (const code of contract.error_codes) assert.match(code, /^[a-z][a-z_]*$/);
  assert.equal(contract.error_codes.at(-1), 'internal');
  for (const [prefix, code] of contract.legacy_error_prefixes) {
    assert.equal(typeof prefix, 'string');
    assert.ok(contract.error_codes.includes(code), code);
  }
  assert.ok(Number.isInteger(contract.live_transcript.max_tail_words) && contract.live_transcript.max_tail_words > 0);
});

test('the loaded contract is the JSON file, deep-frozen', () => {
  assert.deepEqual(contract, raw);
  assert.ok(Object.isFrozen(contract));
  assert.ok(Object.isFrozen(contract.tool_descriptors[0].inputSchema.properties.limit));
  assert.ok(Object.isFrozen(contract.scopes.connector.tools));
});

test('contractProblems catches broken contracts', () => {
  const clone = () => structuredClone(raw);
  const broken = {
    'not an object': () => null,
    'another schema': (c) => { c.schema = 'v2'; return c; },
    'another identity scheme': (c) => { c.identity_scheme = 'x'; return c; },
    'a privileged port': (c) => { c.default_port = 80; return c; },
    'duplicate tools': (c) => { c.tools.push('list_memos'); return c; },
    'a scope tool not in tools': (c) => { c.scopes.connector.tools.push('rm_rf'); return c; },
    'a missing scope': (c) => { delete c.scopes.recording; return c; },
    'a missing descriptor': (c) => { c.tool_descriptors.pop(); return c; },
    'descriptors out of order': (c) => { c.tool_descriptors.reverse(); return c; },
    'a descriptor without a schema': (c) => { delete c.tool_descriptors[0].inputSchema; return c; },
    'no descriptors': (c) => { delete c.tool_descriptors; return c; },
  };
  for (const [label, breakIt] of Object.entries(broken)) {
    assert.notDeepEqual(contractProblems(breakIt(clone())), [], label);
  }
});
