import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PROVIDERS, providerJson } from '../src/dns-providers.js';
import { initSecrets, encrypt, decrypt, mask } from '../src/secrets.js';

test('every provider is built into the Caddy image', () => {
  const dockerfile = fs.readFileSync(new URL('../caddy/Dockerfile', import.meta.url), 'utf8');
  for (const p of PROVIDERS) assert.ok(dockerfile.includes(`--with ${p.module}`), p.id);
  assert.equal(new Set(PROVIDERS.map((p) => p.id)).size, PROVIDERS.length);
});

test('provider JSON for Caddy', () => {
  assert.deepEqual(providerJson('cloudflare', { api_token: 'abc' }), { name: 'cloudflare', api_token: 'abc' });
  assert.deepEqual(providerJson('godaddy', { key: 'K', secret: 'S' }), { name: 'godaddy', api_token: 'K:S' });
  assert.deepEqual(providerJson('route53', { access_key_id: 'A', secret_access_key: 'B' }),
    { name: 'route53', access_key_id: 'A', secret_access_key: 'B' });
  assert.equal(providerJson('nope', {}), null);
});

test('every provider has help in both languages', () => {
  for (const p of PROVIDERS) {
    assert.ok(p.help.en && p.help.pl, p.id);
    assert.ok(p.fields.length > 0, p.id);
  }
});

test('secrets are encrypted and can be read back', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stackmoor-'));
  initSecrets(dir);
  const blob = encrypt({ api_token: 'top-secret-1234' });
  assert.ok(!blob.includes('top-secret'));
  assert.deepEqual(decrypt(blob), { api_token: 'top-secret-1234' });
  assert.equal(decrypt('v1:broken'), null);
  assert.equal(mask('top-secret-1234'), '••••••1234');
  assert.equal(fs.statSync(path.join(dir, 'secret.key')).mode & 0o777, 0o600);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('certificate errors: only after the last success, never "context canceled"', async () => {
  const { certErrors } = await import('../src/caddy-logs.js');
  const line = (o) => JSON.stringify(o);
  const logs = [
    line({ level: 'error', msg: 'could not get certificate from issuer', error: 'old failure' }),
    line({ level: 'info', msg: 'certificate obtained successfully', identifier: '*.dom.example.com' }),
    line({ level: 'error', msg: 'job failed', error: 'provisioning client: context canceled' }),
    'not json',
  ].join('\n');
  assert.deepEqual(certErrors(logs), []);
  const failing = `${logs}\n${line({ level: 'error', msg: 'job failed', error: 'DNS: unauthorized' })}`;
  assert.deepEqual(certErrors(failing), ['job failed: DNS: unauthorized']);
});

test('Caddy image follows the panel version', async () => {
  const { caddyImageFor, DEFAULT_PANEL_SUBDOMAIN } = await import('../src/domains.js');
  assert.equal(caddyImageFor('0.6.1', true), 'ghcr.io/gadziunet/stackmoor-caddy:0.6.1');
  assert.equal(caddyImageFor('v0.7.0', true), 'ghcr.io/gadziunet/stackmoor-caddy:0.7.0');
  assert.equal(caddyImageFor('edge', true), 'ghcr.io/gadziunet/stackmoor-caddy:edge');
  // Local runs (no CI version) have no image of their own.
  assert.equal(caddyImageFor('0.6.0', false), 'ghcr.io/gadziunet/stackmoor-caddy:latest');
  assert.equal(DEFAULT_PANEL_SUBDOMAIN, 'my');
});

test('starting page: Caddy answers "not reachable" with a page that reloads by itself', async () => {
  const { startingErrors, DIAL_TIMEOUT } = await import('../src/domains.js');
  const e = startingErrors('my.example.com');
  assert.equal(DIAL_TIMEOUT, '3s');
  assert.match(e.routes[0].match[0].expression, /502, 503, 504/);
  const [panel, app] = e.routes[0].handle[0].routes;
  assert.deepEqual(panel.match, [{ host: ['my.example.com'] }]);
  assert.equal(app.match, undefined); // every other address
  for (const r of [panel, app]) {
    const h = r.handle[0];
    assert.equal(h.status_code, 503);
    assert.deepEqual(h.headers['Retry-After'], ['5']);
    assert.match(h.body, /Sprawdzam co 5 s/);
  }
  assert.match(panel.handle[0].body, /Stackmoor się uruchamia/);
  assert.match(app.handle[0].body, /Aplikacja się uruchamia/);
  // Without a panel address only the app page is left.
  assert.equal(startingErrors(null).routes[0].handle[0].routes.length, 1);
  // Proxies get their own text; every answer carries the marker the page looks for.
  const withProxy = startingErrors('my.example.com', ['nas.example.com']).routes[0].handle[0].routes;
  assert.deepEqual(withProxy[1].match, [{ host: ['nas.example.com'] }]);
  assert.match(withProxy[1].handle[0].body, /Serwer nie odpowiada/);
  for (const r of withProxy) assert.deepEqual(r.handle[0].headers['X-Stackmoor-Starting'], ['1']);
  assert.match(panel.handle[0].body, /redirect: 'manual'/);
  assert.match(panel.handle[0].body, /location\.replace\(location\.href\)/);
});

test('admin network: Caddy is on both networks, the admin one only for Caddy and the panel', async () => {
  const { caddyComposeSpec, NETWORK, ADMIN_NETWORK } = await import('../src/domains.js');
  assert.notEqual(NETWORK, ADMIN_NETWORK);
  const c = caddyComposeSpec({ image: 'ghcr.io/x/stackmoor-caddy:1.0.0', httpPort: 80, httpsPort: 443 });
  assert.deepEqual(c.services.caddy.networks, [NETWORK, ADMIN_NETWORK]);
  assert.deepEqual(c.networks[ADMIN_NETWORK], { external: true, name: ADMIN_NETWORK });
  assert.deepEqual(c.services.caddy.ports, ['80:80', '443:443', '443:443/udp']);
});

test('admin network: an older installation moves over in a safe order, a new one needs nothing', async () => {
  const { networkSteps, NETWORK, ADMIN_NETWORK } = await import('../src/domains.js');
  // before: panel and Caddy only on the apps' network
  assert.deepEqual(networkSteps({ self: 'stackmoor', selfNets: ['stackmoor_default', NETWORK], caddyNets: [NETWORK] }), [
    ['network', 'connect', ADMIN_NETWORK, 'stackmoor-caddy'], // Caddy first …
    ['network', 'connect', ADMIN_NETWORK, 'stackmoor'],       // … then the panel …
    ['network', 'disconnect', NETWORK, 'stackmoor'],          // … and only then it leaves the apps
  ]);
  // already moved: nothing to do
  assert.deepEqual(networkSteps({ self: 'stackmoor', selfNets: ['stackmoor_default', ADMIN_NETWORK], caddyNets: [NETWORK, ADMIN_NETWORK] }), []);
  // panel recreated after an update (fresh container, only its own network)
  assert.deepEqual(networkSteps({ self: 'stackmoor', selfNets: ['stackmoor_default'], caddyNets: [NETWORK, ADMIN_NETWORK] }), [
    ['network', 'connect', ADMIN_NETWORK, 'stackmoor'],
  ]);
  // a panel whose only normal network is the apps' one keeps it (the admin network has no internet)
  assert.deepEqual(networkSteps({ self: 'stackmoor', selfNets: [NETWORK], caddyNets: [NETWORK] }), [
    ['network', 'connect', ADMIN_NETWORK, 'stackmoor-caddy'],
    ['network', 'connect', ADMIN_NETWORK, 'stackmoor'],
  ]);
  // no Caddy container yet
  assert.deepEqual(networkSteps({ self: 'stackmoor', selfNets: [], caddyNets: null }), [
    ['network', 'connect', ADMIN_NETWORK, 'stackmoor'],
  ]);
});
