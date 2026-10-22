// The generated data modules equal their JSON sources (so gen-data was run).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DATA_FILES, ROOT, generate, renderModule } from '../scripts/gen-data.mjs';

for (const [source, target] of DATA_FILES) {
  const present = existsSync(join(ROOT, source));
  test(`${target} equals ${source}`, { skip: present ? false : `${source} arrives later (DIST-M4)` }, async () => {
    const json = readFileSync(join(ROOT, source), 'utf8');
    const { default: data } = await import(pathToFileURL(join(ROOT, target)).href);
    assert.deepEqual(data, JSON.parse(json));
    const text = readFileSync(join(ROOT, target), 'utf8');
    assert.equal(text, renderModule(json, source), 'run npm run gen-data');
    assert.match(text, /^[\x00-\x7f]*$/, 'generated modules are ASCII');
  });
}

test('gen-data --check finds nothing out of date', () => {
  assert.deepEqual(generate({ check: true }), []);
});

test('renderModule escapes non-ASCII and keeps the data', async () => {
  const text = renderModule('{"a":"1–2 … —","b":[1,{"c":null}]}', 'x.json');
  assert.match(text, /^[\x00-\x7f]*$/);
  assert.ok(text.includes('\\u2013') && text.includes('\\u2026') && text.includes('\\u2014'));
  const { default: data } = await import(`data:text/javascript,${encodeURIComponent(text)}`);
  assert.deepEqual(data, { a: '1–2 … —', b: [1, { c: null }] });
});
