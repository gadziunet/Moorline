import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSetupToken, normalizeCode, formatCode } from '../src/setup-token.js';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sm-setup-'));

test('no account: a code is created once, kept across restarts and readable only by the owner', () => {
  const dir = tmpDir();
  const a = createSetupToken({ dataDir: dir, hasUsers: () => false });
  const code = a.ensure();
  assert.match(code, /^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
  assert.equal(fs.statSync(a.file).mode & 0o777, 0o600);
  // a restarted panel shows the same code
  const b = createSetupToken({ dataDir: dir, hasUsers: () => false });
  assert.equal(b.ensure(), code);
});

test('the code is checked without caring about case, spaces or dashes', () => {
  const t = createSetupToken({ dataDir: tmpDir(), hasUsers: () => false });
  const code = t.ensure();
  assert.equal(t.check(code), true);
  assert.equal(t.check(code.toLowerCase().replace(/-/g, ' ')), true);
  assert.equal(t.check(code.replace(/-/g, '')), true);
  assert.equal(t.check(`${code}X`), false);
  assert.equal(t.check('AAAA-AAAA-AAAA'), false);
  assert.equal(t.check(''), false);
  assert.equal(t.check(undefined), false);
});

test('with an account there is no code, and an old one is removed', () => {
  const dir = tmpDir();
  createSetupToken({ dataDir: dir, hasUsers: () => false }).ensure();
  const t = createSetupToken({ dataDir: dir, hasUsers: () => true });
  assert.equal(t.ensure(), null);
  assert.equal(fs.existsSync(t.file), false);
  assert.equal(t.check('anything'), false);
});

test('clear() ends the code: it no longer matches', () => {
  const t = createSetupToken({ dataDir: tmpDir(), hasUsers: () => false });
  const code = t.ensure();
  t.clear();
  assert.equal(t.check(code), false);
});

test('helpers', () => {
  assert.equal(normalizeCode(' ab-cd ef '), 'ABCDEF');
  assert.equal(formatCode('ABCDEFGHJKMN'), 'ABCD-EFGH-JKMN');
});
