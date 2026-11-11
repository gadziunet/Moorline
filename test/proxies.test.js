import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { openDb, saveSettings, getSettings } from '../src/db.js';
import { cleanProxy, proxyRoute, targetUrl, checkTarget, createProxies, locationRewrite } from '../src/proxies.js';

test('form values are checked and cleaned', () => {
  const p = cleanProxy({ name: ' Proxmox ', subdomain: 'PVE', scheme: 'https', host: 'https://192.168.1.10/', port: '8006' });
  assert.deepEqual(p, { name: 'Proxmox', subdomain: 'pve', scheme: 'https', host: '192.168.1.10', port: 8006, insecure: true, hostHeader: false, monitor: true });
  assert.equal(cleanProxy({ name: 'a', subdomain: 'a', scheme: 'http', host: 'nas.lan', port: 80, insecure: true }).insecure, false);
  assert.equal(targetUrl(cleanProxy({ name: 'a', subdomain: 'a', host: '[fd00::5]', port: 80 })), 'http://[fd00::5]:80');
  assert.throws(() => cleanProxy({ name: '', subdomain: 'a', host: 'x', port: 1 }), (e) => e.key === 'proxy.badName');
  assert.throws(() => cleanProxy({ name: 'a', subdomain: 'a b', host: 'x', port: 1 }), (e) => e.key === 'dns.badSubdomain');
  assert.throws(() => cleanProxy({ name: 'a', subdomain: 'a', host: 'bad host', port: 1 }), (e) => e.key === 'proxy.badHost');
  assert.throws(() => cleanProxy({ name: 'a', subdomain: 'a', host: 'x', port: 70000 }), (e) => e.key === 'dns.badPort');
  assert.throws(() => cleanProxy({ name: 'a', subdomain: 'a', scheme: 'ftp', host: 'x', port: 1 }), (e) => e.key === 'proxy.badScheme');
});

test('Caddy route: https with a self-signed certificate, host name and Host header', () => {
  const r = proxyRoute({ subdomain: 'pve', scheme: 'https', host: '192.168.1.10', port: 8006, insecure: true, hostHeader: false }, 'local.example.com');
  assert.deepEqual(r.match, [{ host: ['pve.local.example.com'] }]);
  assert.equal(r.handle[0].upstreams[0].dial, '192.168.1.10:8006');
  assert.deepEqual(r.handle[0].transport, { protocol: 'http', dial_timeout: '3s', tls: { insecure_skip_verify: true } });
  const n = proxyRoute({ subdomain: 'nas', scheme: 'https', host: 'nas.lan', port: 5001, insecure: false, hostHeader: true }, 'd.eu');
  assert.deepEqual(n.handle[0].transport.tls, { server_name: 'nas.lan' });
  assert.deepEqual(n.handle[0].headers.request.set.Host, ['{http.reverse_proxy.upstream.hostport}']);
  const plain = proxyRoute({ subdomain: 'ha', scheme: 'http', host: '10.0.0.2', port: 8123 }, 'd.eu');
  assert.deepEqual(plain.handle[0].transport, { protocol: 'http', dial_timeout: '3s' });
});

test('redirects to the target\'s own address come back to our address (like NPM)', () => {
  // Caddy uses Go regexps: (?i) at the start is the case-insensitive flag.
  const rewrite = (p, loc) => {
    const r = locationRewrite(p);
    const re = new RegExp(r.search_regexp.replace('(?i)', ''), 'i');
    return loc.replace(re, r.replace.replace('{http.request.host}', 'un.d.eu').replace('$1', '$1'));
  };
  const unraid = { host: '192.168.1.20', port: 8080 };
  assert.equal(rewrite(unraid, 'http://192.168.1.20:8080/Dashboard'), 'https://un.d.eu/Dashboard');
  assert.equal(rewrite(unraid, 'HTTP://192.168.1.20:8080'), 'https://un.d.eu');
  assert.equal(rewrite(unraid, '/Dashboard'), '/Dashboard'); // relative (QNAP) – untouched
  assert.equal(rewrite(unraid, 'http://192.168.1.20:80/x'), 'http://192.168.1.20:80/x'); // another port
  assert.equal(rewrite(unraid, 'http://192.168.1.200:8080/x'), 'http://192.168.1.200:8080/x'); // another address
  const nas = { host: 'nas.lan', port: 443 };
  assert.equal(rewrite(nas, 'https://nas.lan/login'), 'https://un.d.eu/login'); // default port left out
  assert.equal(rewrite(nas, 'https://nas.lan:443/login'), 'https://un.d.eu/login');
  const r = proxyRoute({ subdomain: 'un', scheme: 'http', host: '192.168.1.20', port: 8080, hostHeader: true }, 'd.eu');
  assert.ok(r.handle[0].headers.response.replace.Location);
  assert.ok(r.handle[0].headers.request.set.Host);
});

test('connection check: open and closed ports', async () => {
  const srv = net.createServer((s) => s.end()).listen(0, '127.0.0.1');
  await new Promise((r) => srv.on('listening', r));
  const { port } = srv.address();
  const up = await checkTarget({ scheme: 'http', host: '127.0.0.1', port });
  assert.equal(up.ok, true);
  srv.close();
  const down = await checkTarget({ scheme: 'http', host: '127.0.0.1', port }, 1000);
  assert.equal(down.ok, false);
  assert.equal(down.error, 'ECONNREFUSED');
});

test('save, taken subdomains, status changes become events', async () => {
  const db = openDb(':memory:');
  saveSettings(db, { domain: 'local.example.com', panelSubdomain: 'my' });
  db.prepare('INSERT INTO routes(stack, subdomain, service, port) VALUES (?, ?, ?, ?)').run('cloud', 'cloud', 'app', 80);
  let reloads = 0;
  let up = true;
  const px = createProxies({ db, getSettings: () => getSettings(db), reloadConfig: async () => { reloads += 1; }, check: async () => ({ ok: up, ms: 3 }) });
  const { id } = await px.save({ name: 'proxmox', subdomain: 'pve', scheme: 'https', host: '192.168.1.10', port: 8006 });
  assert.equal(reloads, 1);
  await assert.rejects(px.save({ name: 'x', subdomain: 'cloud', host: 'a', port: 1 }), (e) => e.key === 'dns.subdomainTaken');
  await assert.rejects(px.save({ name: 'x', subdomain: 'my', host: 'a', port: 1 }), (e) => e.key === 'dns.subdomainTaken');
  await assert.rejects(px.save({ name: 'x', subdomain: 'pve', host: 'a', port: 1 }), (e) => e.key === 'dns.subdomainTaken');
  await px.save({ name: 'proxmox 2', subdomain: 'pve', scheme: 'https', host: '192.168.1.11', port: 8006 }, id); // own subdomain is fine
  await px.checkAll();
  assert.equal(px.list()[0].status.ok, true);
  assert.equal(px.list()[0].target, 'https://192.168.1.11:8006');
  up = false;
  await px.checkAll();
  assert.deepEqual(px.events().map((e) => [e.name, e.ok]), [['proxmox 2', false]]);
  await px.remove(id);
  assert.equal(px.list().length, 0);
  await assert.rejects(px.remove(id), (e) => e.key === 'proxy.notFound');
});

test('no domain: a proxy cannot be added', async () => {
  const db = openDb(':memory:');
  const px = createProxies({ db, getSettings: () => getSettings(db), reloadConfig: async () => {} });
  await assert.rejects(px.save({ name: 'a', subdomain: 'a', host: 'x', port: 1 }), (e) => e.key === 'dns.noDomain');
});
