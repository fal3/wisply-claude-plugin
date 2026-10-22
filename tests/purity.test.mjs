// Static rules for the shipped code (bin/ and lib/): what it may import, the
// only network it may reach, where it may write, and plain ASCII.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOST } from '../lib/constants.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FILES = [
  ...readdirSync(join(ROOT, 'lib')).filter((name) => name.endsWith('.mjs')).map((name) => `lib/${name}`),
  ...readdirSync(join(ROOT, 'bin')).filter((name) => name.endsWith('.mjs')).map((name) => `bin/${name}`),
];
const source = Object.fromEntries(FILES.map((file) => [file, readFileSync(join(ROOT, file), 'utf8')]));
// Code without comments, so prose about (say) HTTP_PROXY doesn't count.
const code = Object.fromEntries(Object.entries(source).map(([file, text]) => [file, text
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/\s\/\/ .*$/gm, '')]));

/** Node built-ins each file may import. Anything else (and any package) is refused. */
const BUILTINS = {
  'node:crypto': ['lib/identity.mjs', 'lib/scopes.mjs'],
  'node:http': ['lib/loopback.mjs'],
  'node:readline': ['bin/wisply-mcp.mjs'],
  // The Keychain (DIST-M2) and the CLI (DIST-M2, DIST-M4) are the only places that may start programs or touch files.
  'node:child_process': ['lib/token.mjs', 'lib/cli.mjs'],
  'node:fs': ['lib/cli.mjs', 'lib/clients.mjs'],
  'node:fs/promises': ['lib/cli.mjs', 'lib/clients.mjs'],
  'node:os': ['lib/cli.mjs', 'lib/clients.mjs'],
  'node:path': ['lib/cli.mjs', 'lib/clients.mjs'],
};

const importsOf = (text) => [...text.matchAll(/^\s*(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/gm)].map((match) => match[1]);

test('imports: relative files and a few node: built-ins, per file', () => {
  for (const file of FILES) {
    for (const specifier of importsOf(code[file])) {
      if (specifier.startsWith('./') || specifier.startsWith('../')) continue;
      assert.ok(Object.hasOwn(BUILTINS, specifier), `${file} imports ${specifier}`);
      assert.ok(BUILTINS[specifier].includes(file), `${file} may not import ${specifier}`);
    }
  }
});

test('no dynamic code: no import(), require(), eval or new Function', () => {
  for (const file of FILES) {
    assert.doesNotMatch(code[file], /\bimport\s*\(/, `${file}: dynamic import`);
    assert.doesNotMatch(code[file], /\brequire\s*\(/, `${file}: require`);
    assert.doesNotMatch(code[file], /\beval\s*\(|\bnew\s+Function\s*\(/, `${file}: eval`);
  }
});

test('network: only node:http in lib/loopback.mjs, only to HOST, which is 127.0.0.1', () => {
  assert.equal(HOST, '127.0.0.1');
  assert.match(source['lib/constants.mjs'], /^export const HOST = '127\.0\.0\.1';$/m);
  for (const file of FILES) {
    assert.doesNotMatch(code[file], /\bfetch\s*\(|\bWebSocket\b|\bEventSource\b|XMLHttpRequest|navigator\./, `${file}: web network API`);
    assert.doesNotMatch(code[file], /\bnet\.(connect|createConnection)|\btls\.|\bdgram\b|\bdns\./, `${file}: socket API`);
    if (file !== 'lib/loopback.mjs') assert.doesNotMatch(code[file], /\bhttp\.(request|get|Agent)\b/, `${file}: http`);
    for (const match of code[file].matchAll(/https?:\/\/[^\s'"`)]*/g)) {
      const url = match[0];
      const ok = url.startsWith('http://127.0.0.1') || url.startsWith('https://www.wisply.ai/');
      assert.ok(ok, `${file}: URL ${url}`);
    }
  }
  const loopback = code['lib/loopback.mjs'];
  assert.deepEqual([...loopback.matchAll(/\bhost:\s*([^,\n}]+)/g)].map((match) => match[1].trim()), ['HOST']);
  assert.match(loopback, /new http\.Agent\(\{ keepAlive: false \}\)/);
  assert.doesNotMatch(loopback, /globalAgent|maxRedirects|follow/);
});

test('the vendored identity.mjs is used only for expectedProof, newNonce and IDENTITY_SCHEME', () => {
  const allowed = new Set(['expectedProof', 'newNonce', 'IDENTITY_SCHEME']);
  for (const file of FILES) {
    for (const match of code[file].matchAll(/import\s*\{([^}]*)\}\s*from\s*['"](?:\.\.\/lib|\.)\/identity\.mjs['"]/g)) {
      for (const name of match[1].split(',').map((part) => part.trim().split(/\s+as\s+/)[0]).filter(Boolean)) {
        assert.ok(allowed.has(name), `${file} imports ${name} from identity.mjs`);
      }
    }
    assert.doesNotMatch(code[file], /import\s+\*\s+as\s+\w+\s+from\s+['"](?:\.\.\/lib|\.)\/identity\.mjs['"]/, file);
    if (file !== 'lib/identity.mjs') {
      assert.doesNotMatch(code[file], /\b(proofMatches|tokenScope)\b/, `${file} uses proofMatches/tokenScope`);
    }
  }
});

test('output: stdout only from bin, stderr only from lib/debug.mjs and bin, no console', () => {
  for (const file of FILES) {
    assert.doesNotMatch(code[file], /\bconsole\./, `${file}: console`);
    if (file.startsWith('lib/')) assert.doesNotMatch(code[file], /process\.stdout/, `${file}: stdout`);
    if (file.startsWith('lib/') && file !== 'lib/debug.mjs') assert.doesNotMatch(code[file], /process\.stderr/, `${file}: stderr`);
  }
});

test('every shipped file is ASCII, lib/messages.mjs included', () => {
  for (const file of FILES) {
    const offset = source[file].search(/[^\x00-\x7f]/);
    assert.equal(offset, -1, `${file}: non-ASCII at ${offset}`);
  }
  assert.ok(FILES.includes('lib/messages.mjs'));
});
