// The English and Vietnamese UI strings must stay in sync: same keys, same {placeholders}.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../src/i18n.js', import.meta.url), 'utf8');
const block = (name) => {
  const start = src.indexOf(`const ${name} = {`);
  const end = src.indexOf('\n};', start);
  return src.slice(start, end);
};
// keys are single-quoted at the start of an entry; values may contain anything
const entries = (body) => Object.fromEntries([...body.matchAll(/'([\w.]+)':\s*(`[\s\S]*?`|'(?:[^'\\]|\\.)*')/g)].map((m) => [m[1], m[2]]));
const vars = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

test('every Vietnamese string has an English original with the same placeholders', () => {
  const en = entries(block('en'));
  const vi = entries(block('vi'));
  assert.ok(Object.keys(en).length > 100);
  for (const [k, v] of Object.entries(vi)) {
    assert.ok(k in en, `vi has extra key ${k}`);
    assert.deepEqual(vars(v), vars(en[k]), `placeholders differ for ${k}`);
  }
  const missing = Object.keys(en).filter((k) => !(k in vi) && !k.startsWith('mode.'));
  assert.deepEqual(missing, [], 'keys not translated to Vietnamese');
});

test('every t() key used in src exists', () => {
  const en = entries(block('en'));
  for (const f of fs.readdirSync(new URL('../src/', import.meta.url)).filter((x) => x !== 'i18n.js')) {
    const code = fs.readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');
    for (const m of code.matchAll(/\bt\('([\w.]+)'/g)) assert.ok(m[1] in en, `${f}: unknown key ${m[1]}`);
  }
});
