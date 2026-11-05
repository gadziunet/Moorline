import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, getState } from '../src/db.js';
import { initSecrets } from '../src/secrets.js';
import { cleanChannel, deliver, createNotifier, createStackWatch } from '../src/notify.js';

initSecrets(fs.mkdtempSync(path.join(os.tmpdir(), 'sm-notify-')));
const T = (k, v) => `${k}${v ? ` ${JSON.stringify(v)}` : ''}`;
const TOKEN = '123456789:AAHfakeTokenForTests_abcdefgh';

test('channels from the form are checked; masked secrets keep the saved ones', () => {
  assert.throws(() => cleanChannel({ type: 'sms' }), { key: 'nt.badType' });
  assert.throws(() => cleanChannel({ type: 'telegram', chatId: 'abc', token: TOKEN }), { key: 'nt.badChatId' });
  assert.throws(() => cleanChannel({ type: 'telegram', chatId: '42', token: 'nope' }), { key: 'nt.badToken' });
  assert.throws(() => cleanChannel({ type: 'email', host: 'smtp.example.com', from: 'x', to: 'a@example.com' }), { key: 'nt.badFrom' });
  assert.throws(() => cleanChannel({ type: 'email', host: 'smtp.example.com', from: 'a@example.com', to: 'a@example.com', user: 'me' }), { key: 'nt.missingSecret' });
  assert.throws(() => cleanChannel({ type: 'webhook', url: 'ftp://x' }), { key: 'nt.badUrl' });

  const mail = cleanChannel({ type: 'email', host: 'smtp.example.com', security: 'tls', from: 'Stackmoor <panel@example.com>', to: 'a@example.com; b@example.com', user: 'panel', pass: 'secret' });
  assert.equal(mail.config.port, 465);
  assert.equal(mail.config.to, 'a@example.com, b@example.com');
  const again = cleanChannel({ pass: '••••••cret', name: 'Mail' }, mail);
  assert.equal(again.secrets.pass, 'secret');
  assert.equal(again.name, 'Mail');

  const ntfy = cleanChannel({ type: 'ntfy', topic: 'home-alerts' });
  assert.equal(ntfy.config.server, 'https://ntfy.sh');
});

test('each channel type sends the right request', async () => {
  const calls = [];
  const fetchFn = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, json: async () => ({ ok: true }), text: async () => '' };
  };
  const msg = { event: 'vpn.down', level: 'error', title: 'Home: VPN <x> is down', body: 'Tunnel & co', server: 'Home', at: '2026-11-05T10:00:00Z', when: 'now' };
  await deliver({ type: 'telegram', config: { chatId: '42' }, secrets: { token: TOKEN } }, msg, { fetchFn });
  await deliver({ type: 'ntfy', config: { server: 'https://ntfy.example.com', topic: 't' }, secrets: { token: 'tk' } }, msg, { fetchFn });
  await deliver({ type: 'pushover', config: {}, secrets: { user: 'u'.repeat(30), token: 'a'.repeat(30) } }, msg, { fetchFn });
  await deliver({ type: 'webhook', config: {}, secrets: { url: 'https://hooks.example.com/x' } }, msg, { fetchFn });

  assert.equal(calls[0].url, `https://api.telegram.org/bot${TOKEN}/sendMessage`);
  assert.equal(JSON.parse(calls[0].opts.body).text, '<b>Home: VPN &lt;x&gt; is down</b>\nTunnel &amp; co');
  assert.deepEqual(JSON.parse(calls[1].opts.body), { topic: 't', title: msg.title, message: msg.body, priority: 4, tags: ['rotating_light'] });
  assert.equal(calls[1].opts.headers.Authorization, 'Bearer tk');
  assert.equal(new URLSearchParams(calls[2].opts.body).get('priority'), '1');
  const hook = JSON.parse(calls[3].opts.body);
  assert.equal(hook.event, 'vpn.down');
  assert.match(hook.content, /^\*\*Home: VPN/); // Discord
  assert.match(hook.text, /^Home: VPN/); // Slack, Mattermost

  let mail = null;
  await deliver({ type: 'email', config: { host: 'h', port: 587, security: 'starttls', user: 'u', from: 'a@example.com', to: 'b@example.com' }, secrets: { pass: 'p' } }, msg, { sendMail: async (m) => { mail = m; } });
  assert.equal(mail.subject, msg.title);
  assert.equal(mail.pass, 'p');

  const failing = async () => ({ ok: false, status: 401, text: async () => 'Unauthorized' });
  await assert.rejects(deliver({ type: 'webhook', config: {}, secrets: { url: 'https://x.example.com' } }, msg, { fetchFn: failing }), /HTTP 401: Unauthorized/);
});

test('events go to every enabled channel, once, with retries and a history', async () => {
  const db = openDb(':memory:');
  const sent = [];
  let failFirst = 1;
  const n = createNotifier({
    db, getT: () => T, wait: async () => {},
    deliverFn: async (ch, msg) => {
      if (ch.name === 'flaky' && failFirst-- > 0) throw new Error('timeout');
      if (ch.name === 'broken') throw new Error('HTTP 500');
      sent.push(`${ch.name}: ${msg.title}`);
    },
  });
  n.saveChannel({ type: 'ntfy', name: 'phone', topic: 'a' });
  n.saveChannel({ type: 'ntfy', name: 'flaky', topic: 'b' });
  n.saveChannel({ type: 'ntfy', name: 'broken', topic: 'c' });
  const off = n.saveChannel({ type: 'ntfy', name: 'off', topic: 'd', enabled: false });
  assert.equal(n.channels().find((c) => c.id === off.id).enabled, false);
  n.savePrefs({ serverName: 'Home' });

  await n.emit('vpn', { name: 'office' }, { variant: 'down', level: 'error', subject: 'office' });
  assert.deepEqual(sent.sort(), ['flaky: Home: nt.ev.vpn.down.title {"name":"office"}', 'phone: Home: nt.ev.vpn.down.title {"name":"office"}']);
  const h = getState(db, 'notify.history');
  assert.equal(h.length, 3);
  assert.equal(h.find((x) => x.channel === 'broken').error, 'HTTP 500');

  // The same thing again right away: not repeated.
  sent.length = 0;
  await n.emit('vpn', { name: 'office' }, { variant: 'down', level: 'error', subject: 'office' });
  assert.deepEqual(sent, []);

  // Off by default / turned off by the user: nothing is sent.
  await n.emit('backupOk', {});
  n.savePrefs({ events: { proxy: false } });
  await n.emit('proxy', { name: 'nas' }, { variant: 'down' });
  assert.deepEqual(sent, []);
  assert.equal(n.prefs().events.backupFailed, true);
  assert.equal(n.prefs().events.proxy, false);

  // down → up → down within minutes: every change is sent.
  sent.length = 0;
  await n.emit('vpn', { name: 'office' }, { variant: 'up', level: 'ok', subject: 'office' });
  await n.emit('vpn', { name: 'office' }, { variant: 'down', level: 'error', subject: 'office' });
  assert.equal(sent.filter((x) => x.startsWith('phone')).length, 2);

  // Switching a channel off keeps its name.
  const phone = n.channels().find((c) => c.name === 'phone');
  n.saveChannel({ enabled: false }, phone.id);
  assert.equal(n.channels().find((c) => c.id === phone.id).name, 'phone');
});

test('"Send test" reports the reason when it fails', async () => {
  const db = openDb(':memory:');
  const n = createNotifier({ db, getT: () => T, deliverFn: async () => { throw new Error('535 Authentication failed'); } });
  const { id } = n.saveChannel({ type: 'webhook', url: 'https://hooks.example.com/a' });
  await assert.rejects(n.test(id, T), (err) => err.key === 'nt.testFailed' && /535/.test(err.vars.error));
  assert.equal(n.history()[0].ok, false);
  assert.match(n.channels()[0].url, /^••••••/);
});

test('a stack that stops by itself is reported after two checks, and again when it is back', async () => {
  let state = { name: 'web', state: 'running', running: 2, total: 2, busy: false };
  let ops = [];
  const out = [];
  const w = createStackWatch({
    stacks: { list: async () => [state], recentOperations: () => ops },
    emit: (key, vars, o) => out.push(`${key}.${o.variant}`),
  });
  await w.check();
  state = { ...state, state: 'partial', running: 1 };
  await w.check();
  assert.deepEqual(out, [], 'one check is not enough (it may be restarting)');
  await w.check();
  assert.deepEqual(out, ['stackDown.down']);
  await w.check();
  assert.deepEqual(out, ['stackDown.down'], 'reported once');
  state = { ...state, state: 'running', running: 2 };
  await w.check();
  assert.deepEqual(out, ['stackDown.down', 'stackDown.up']);

  // Stopped from the panel: not reported.
  ops = [{ stack: 'web', started_at: new Date().toISOString().replace('T', ' ').slice(0, 19) }];
  state = { ...state, state: 'exited', running: 0 };
  await w.check();
  await w.check();
  assert.deepEqual(out, ['stackDown.down', 'stackDown.up']);
});
