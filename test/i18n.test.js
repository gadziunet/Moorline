import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { translate } from '../src/i18n.js';

// Extracts keys from a "lang: { ... }" dictionary block in a file.
function keysOf(file, lang) {
  const src = fs.readFileSync(new URL(file, import.meta.url), 'utf8');
  const start = src.indexOf(`\n  ${lang}: {`);
  const end = src.indexOf('\n  },', start);
  return new Set([...src.slice(start, end).matchAll(/^\s+'([\w.]+)':/gm)].map((m) => m[1]));
}

for (const file of ['../src/i18n.js', '../public/i18n.js']) {
  test(`${file}: en and pl have the same keys`, () => {
    const en = keysOf(file, 'en');
    const pl = keysOf(file, 'pl');
    assert.ok(en.size > 10);
    assert.deepEqual([...en].filter((k) => !pl.has(k)), []);
    assert.deepEqual([...pl].filter((k) => !en.has(k)), []);
  });
}

test('every key used by the server exists', () => {
  const en = keysOf('../src/i18n.js', 'en');
  const used = new Set();
  for (const f of ['server.js', 'stacks.js', 'compose.js', 'auth.js', 'proxies.js', 'autoupdate.js', 'system.js', 'notify.js']) {
    const src = fs.readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');
    for (const m of src.matchAll(/(?:UserError\(|\bt\(|req\.t\(|fail\(req, res, \d+, |key: )'([\w.]+)'/g)) used.add(m[1]);
    for (const m of src.matchAll(/return '(auth\.[\w.]+)'/g)) used.add(m[1]);
  }
  assert.ok(used.size > 15);
  assert.deepEqual([...used].filter((k) => !en.has(k)), []);
});

test('every key used by the UI exists', () => {
  const en = keysOf('../public/i18n.js', 'en');
  const src = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const used = [...src.matchAll(/\bt\('([\w.]+)'/g)].map((m) => m[1]);
  assert.deepEqual(used.filter((k) => !en.has(k)), []);
  for (const k of ['state.running', 'state.partial', 'state.exited', 'state.down',
    'act.up', 'act.update', 'act.stop', 'act.restart', 'act.down',
    'tab.compose', 'tab.env', 'tab.containers', 'tab.logs', 'tab.history', 'tab.delete']) {
    assert.ok(en.has(k), k);
  }
});

test('variable substitution', () => {
  assert.equal(translate('pl', 'step.exitCode', { code: 2 }), 'Polecenie zakończyło się kodem 2.');
  assert.equal(translate('en', 'step.exitCode', { code: 2 }), 'The command exited with code 2.');
  assert.equal(translate('xx', 'notFound'), 'Not found.');
});
