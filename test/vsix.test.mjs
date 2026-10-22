// What the .vsix would hold, as `vsce ls` lists it (the same file collection
// `vsce package` uses): only what runs and what the stores show, and nothing
// that looks like a token.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const VSCE = join(ROOT, 'node_modules/@vscode/vsce/vsce');

const REQUIRED = ['CHANGELOG.md', 'LICENSE', 'README.md', 'SECURITY.md', 'dist/extension.js', 'media/icon.png', 'package.json',
  'server/wisply-mcp.mjs', 'skills/wisply-memos/SKILL.md', 'vendor/SOURCE.json'];

const listed = execFileSync(process.execPath, [VSCE, 'ls', '--no-dependencies'], {
  cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
}).split('\n').map((line) => line.trim()).filter(Boolean).sort();

test('the package holds exactly the runtime files and the store documents', () => {
  for (const file of REQUIRED) assert.ok(listed.includes(file), `${file} missing (run npm run build first)`);
  for (const file of listed) assert.ok(REQUIRED.includes(file), `unexpected file in the .vsix: ${file}`);
});

test('no sources, tests, fixtures, scripts, vendored sources, dependencies or maps', () => {
  for (const file of listed) {
    assert.doesNotMatch(file, /^(src|test|scripts|out|node_modules|vendor\/wisply-mcp|vendor\/skills)\//, file);
    assert.doesNotMatch(file, /\.map$|fixtures|\.vsix$|tsconfig|esbuild\.mjs|package-lock|\.npmrc/, file);
  }
});

test('no packaged file tells anyone to run the npm package, and the extension holds no client templates', () => {
  for (const file of listed) {
    assert.doesNotMatch(readFileSync(join(ROOT, file), 'latin1'), /npx -y @wisply\/mcp/, file);
  }
  const extension = readFileSync(join(ROOT, 'dist/extension.js'), 'latin1');
  assert.doesNotMatch(extension, /standard_entry|"command": "npx"/, 'dist/extension.js bundles no npx entries');
});

test('no packaged file contains anything shaped like a Wisply token', () => {
  for (const file of listed) {
    assert.doesNotMatch(readFileSync(join(ROOT, file), 'latin1'), /wsp[cr]?_[0-9a-f]{64}/, file);
  }
});
