import test from 'node:test';
import assert from 'node:assert/strict';
import { createPanelLock } from '../src/panel-lock.js';

const settings = { domain: 'dom.example.com', panelSubdomain: 'panel', panelDomainOnly: true };

function run(lock, req) {
  const out = {};
  const res = {
    status(c) { out.status = c; return this; },
    json(b) { out.json = b; return this; },
    redirect(c, u) { out.status = c; out.location = u; },
  };
  lock.middleware({ method: 'GET', path: '/', originalUrl: '/', t: (k) => k, ...req }, res, () => { out.next = true; });
  return out;
}

const make = (s = settings, caddyIp = '172.20.0.2', env = {}) => createPanelLock({
  getSettings: () => s,
  domains: { caddyIp: () => caddyIp, panelUrl: () => 'https://panel.dom.example.com' },
  env,
});

test('panel lock: Caddy passes, IP access is redirected', () => {
  const lock = make();
  assert.ok(run(lock, { socket: { remoteAddress: '::ffff:172.20.0.2' } }).next);
  const r = run(lock, { socket: { remoteAddress: '192.168.1.10' }, originalUrl: '/#/settings', hostname: '192.168.1.240' });
  assert.equal(r.status, 302);
  assert.equal(r.location, 'https://panel.dom.example.com/#/settings');
  // A spoofed Host header does not help when Caddy's address is known.
  assert.equal(run(lock, { socket: { remoteAddress: '192.168.1.10' }, hostname: 'panel.dom.example.com' }).status, 302);
});

test('panel lock: API answers 421 with the address, health check stays open', () => {
  const lock = make();
  const api = run(lock, { socket: { remoteAddress: '192.168.1.10' }, path: '/api/stacks', method: 'GET' });
  assert.equal(api.status, 421);
  assert.equal(api.json.redirect, 'https://panel.dom.example.com');
  assert.ok(run(lock, { socket: { remoteAddress: '172.17.0.1' }, path: '/api/state' }).next);
  assert.ok(run(lock, { socket: { remoteAddress: '127.0.0.1' }, path: '/api/stacks' }).next);
});

test('panel lock: off, incomplete settings or emergency switch let everything through', () => {
  const ip = { socket: { remoteAddress: '192.168.1.10' } };
  assert.ok(run(make({ ...settings, panelDomainOnly: false }), ip).next);
  assert.ok(run(make({ ...settings, panelSubdomain: '' }), ip).next);
  assert.ok(run(make(settings, '172.20.0.2', { STACKMOOR_ALLOW_IP: '1' }), ip).next);
  // Unknown Caddy address: fall back to the Host header.
  assert.ok(run(make(settings, null), { ...ip, hostname: 'panel.dom.example.com' }).next);
  assert.equal(run(make(settings, null), { ...ip, hostname: '192.168.1.240' }).status, 302);
});

test('panel lock: a running server restore can still be followed by IP (the route itself needs the code)', () => {
  const lock = make();
  const ip = { socket: { remoteAddress: '192.168.1.10' } };
  assert.ok(run(lock, { ...ip, path: '/api/setup/restore/status' }).next);
  // only reading the status – nothing else of the setup wizard
  assert.equal(run(lock, { ...ip, path: '/api/setup/restore/start', method: 'POST' }).status, 421);
  assert.equal(run(lock, { ...ip, path: '/api/setup', method: 'POST' }).status, 421);
});
