import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { initSecrets } from '../src/secrets.js';
import { cleanConfig, createPangolin, fullDomainOf } from '../src/pangolin.js';

initSecrets(fs.mkdtempSync(path.join(os.tmpdir(), 'sm-pg-')));

// The fields Pangolin's own (strict) request schemas allow – anything else is rejected there.
const ALLOWED = {
  'PUT /org/home/site': ['name', 'type', 'newtId', 'secret', 'address', 'niceId', 'exitNodeId', 'pubKey', 'subnet'],
  'PUT /org/home/resource': ['name', 'subdomain', 'http', 'protocol', 'domainId', 'mode', 'stickySession', 'postAuthPath', 'matchBaseDomain'],
  'POST /resource/7': ['sso', 'name', 'subdomain', 'enabled', 'domainId', 'blockAccess'],
  'PUT /resource/7/target': ['siteId', 'ip', 'mode', 'method', 'port', 'enabled'],
};

function fakePangolin() {
  const calls = [];
  const reply = (status, data) => ({ ok: status < 300, status, json: async () => ({ data, success: status < 300, error: status >= 300, message: status < 300 ? 'ok' : 'Not allowed', status }) });
  const fetchFn = async (url, opts) => {
    const u = new URL(url);
    assert.equal(u.origin + u.pathname.slice(0, 3), 'https://api.example.com/v1'.slice(0, 'https://api.example.com'.length + 3));
    const route = `${opts.method} ${u.pathname.replace(/^\/v1/, '')}`;
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ route, body, auth: opts.headers.Authorization, query: u.search });
    if (ALLOWED[route]) for (const k of Object.keys(body)) assert.ok(ALLOWED[route].includes(k), `${route}: Pangolin would reject "${k}"`);
    if (opts.headers.Authorization !== 'Bearer key.secret') return reply(401);
    if (route === 'GET /org/home/domains') return reply(200, { domains: [{ domainId: 'd1', baseDomain: 'example.com', type: 'ns', verified: true }, { domainId: 'd2', baseDomain: 'app.example.org', type: 'cname' }] });
    if (route === 'GET /org/home/pick-site-defaults') return reply(200, { newtId: 'nid', newtSecret: 'nsecret', clientAddress: '100.90.128.5', exitNodeId: 1 });
    if (route === 'PUT /org/home/site') return reply(201, { siteId: 42, niceId: 'stackmoor', name: 'Stackmoor', newtId: 'nid', secret: 'nsecret' });
    if (route === 'GET /site/42') return reply(200, { siteId: 42, online: true });
    if (route === 'PUT /org/home/resource') return reply(201, { resourceId: 7, fullDomain: `${body.subdomain}.example.com` });
    if (route === 'POST /resource/7') return reply(200, null);
    if (route === 'PUT /resource/7/target') return reply(201, { targetId: 99 });
    if (route === 'DELETE /resource/7') return reply(200, null);
    if (route === 'DELETE /site/42') return reply(200, null);
    return reply(404);
  };
  return { calls, fetchFn };
}

function setup() {
  const db = openDb(':memory:');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-pg-stacks-'));
  const pg = fakePangolin();
  const docker = [];
  const overrides = [];
  const p = createPangolin({
    db, stacksDir: dir, fetchFn: pg.fetchFn,
    run: async (args) => { docker.push(args.join(' ')); return { code: 0, stdout: 'running', output: '' }; },
    stacks: { assertName: () => {}, config: async () => ({ services: { app: {} } }) },
    domains: { ensureNetwork: async () => {}, writeOverride: async (s) => overrides.push(s), upstreamFor: async (stack, svc, port) => `${stack}-${svc}-1:${port}` },
  });
  return { db, dir, pg, docker, overrides, p };
}

test('connection settings from the form', () => {
  assert.throws(() => cleanConfig({ endpoint: 'pangolin.example.com' }), { key: 'pg.badEndpoint' });
  const c = cleanConfig({ endpoint: 'https://pangolin.example.com/', apiUrl: 'https://api.example.com', orgId: 'home', apiKey: 'k' });
  assert.equal(c.apiUrl, 'https://api.example.com/v1');
  assert.equal(c.endpoint, 'https://pangolin.example.com');
  // A line break can't sneak another setting into Newt's .env.
  assert.throws(() => cleanConfig({ endpoint: 'https://p.example.com/\nNEWT_SECRET=x', apiUrl: 'https://api.example.com', orgId: 'home', apiKey: 'k' }), { key: 'pg.badEndpoint' });
  assert.equal(cleanConfig({ endpoint: 'https://p.example.com/dash', apiUrl: 'https://api.example.com/v1/', orgId: 'h', apiKey: 'k' }).endpoint, 'https://p.example.com');
  assert.equal(cleanConfig({ apiKey: '••••••abcd' }, c).apiKey, 'k');
  assert.equal(fullDomainOf('app', { baseDomain: 'example.com' }), 'app.example.com');
  assert.equal(fullDomainOf(null, { baseDomain: 'app.example.org' }), 'app.example.org');
});

test('connect: checks the key, creates a site, starts Newt with the secret only in .env', async () => {
  const { p, pg, docker, dir } = setup();
  await assert.rejects(p.saveConfig({ endpoint: 'https://pangolin.example.com', apiUrl: 'https://api.example.com/v1', orgId: 'home', apiKey: 'wrong' }), { key: 'pg.denied' });
  const saved = await p.saveConfig({ endpoint: 'https://pangolin.example.com', apiUrl: 'https://api.example.com/v1', orgId: 'home', apiKey: 'key.secret' });
  assert.equal(saved.domains.length, 2);
  assert.match(saved.apiKey, /^••••••/);

  const st = await p.connect();
  assert.equal(st.online, true);
  assert.deepEqual(pg.calls.map((c) => c.route).slice(-3), ['GET /org/home/pick-site-defaults', 'PUT /org/home/site', 'GET /site/42']);
  assert.deepEqual(pg.calls.find((c) => c.route === 'PUT /org/home/site').body, { name: 'Stackmoor', type: 'newt', newtId: 'nid', secret: 'nsecret' });
  const env = fs.readFileSync(path.join(dir, '.stackmoor/newt/.env'), 'utf8');
  assert.match(env, /NEWT_SECRET=nsecret/);
  assert.equal(fs.statSync(path.join(dir, '.stackmoor/newt/.env')).mode & 0o777, 0o600);
  assert.ok(!fs.readFileSync(path.join(dir, '.stackmoor/newt/compose.yaml'), 'utf8').includes('nsecret'));
  assert.ok(docker.some((d) => d.includes('up -d')));
  // Connecting again doesn't create a second site.
  await p.connect();
  assert.equal(pg.calls.filter((c) => c.route === 'PUT /org/home/site').length, 1);
});

test('a public address: resource, login off only when asked, target to the container; removed again', async () => {
  const { p, pg, docker, overrides } = setup();
  await p.saveConfig({ endpoint: 'https://pangolin.example.com', apiUrl: 'https://api.example.com/v1', orgId: 'home', apiKey: 'key.secret' });
  await assert.rejects(p.addRoute('immich', { service: 'app', port: 2283, domainId: 'd1', subdomain: 'photos' }), { key: 'pg.notConnected' });
  await p.connect();

  await assert.rejects(p.addRoute('immich', { service: 'app', port: 2283, domainId: 'd2', subdomain: 'x' }), { key: 'pg.cnameNoSub' });
  const r = await p.addRoute('immich', { service: 'app', port: 2283, domainId: 'd1', subdomain: 'photos', sso: false });
  assert.equal(r.fullDomain, 'photos.example.com');
  assert.equal(r.sso, false);
  const res = pg.calls.find((c) => c.route === 'PUT /org/home/resource').body;
  assert.deepEqual(res, { name: 'immich · app', subdomain: 'photos', domainId: 'd1', http: true, protocol: 'tcp' });
  assert.deepEqual(pg.calls.find((c) => c.route === 'POST /resource/7').body, { sso: false });
  assert.deepEqual(pg.calls.find((c) => c.route === 'PUT /resource/7/target').body, { siteId: 42, ip: 'immich-app-1', port: 2283, method: 'http', enabled: true });
  assert.deepEqual(p.servicesFor('immich'), ['app']);
  assert.deepEqual(overrides, ['immich']);
  assert.ok(docker.includes('network connect stackmoor immich-app-1'));
  await assert.rejects(p.addRoute('other', { service: 'app', port: 80, domainId: 'd1', subdomain: 'photos' }), { key: 'pg.taken' });

  await p.setSso(r.id, true);
  assert.equal(p.routes('immich')[0].sso, true);
  await p.removeRoute(r.id);
  assert.ok(pg.calls.some((c) => c.route === 'DELETE /resource/7'));
  assert.deepEqual(p.routes('immich'), []);
});

test('disconnect removes the site with its resources and stops Newt', async () => {
  const { p, pg, docker } = setup();
  await p.saveConfig({ endpoint: 'https://pangolin.example.com', apiUrl: 'https://api.example.com/v1', orgId: 'home', apiKey: 'key.secret' });
  await p.connect();
  await p.addRoute('immich', { service: 'app', port: 2283, domainId: 'd1', subdomain: 'photos' });
  await p.disconnect();
  // Resources one by one, then the site – deleteResources is refused for API keys.
  const order = pg.calls.map((c) => c.route).filter((r) => r.startsWith('DELETE'));
  assert.deepEqual(order, ['DELETE /resource/7', 'DELETE /site/42']);
  assert.equal(pg.calls.find((c) => c.route === 'DELETE /site/42').query, '');
  assert.ok(docker.some((d) => d.endsWith(' down')));
  assert.deepEqual(p.routes(), []);
  assert.equal(p.publicConfig().configured, false);
});

test('when the stack cannot be prepared, nothing is left behind – here or in Pangolin', async () => {
  const { p, pg, overrides } = setup();
  await p.saveConfig({ endpoint: 'https://pangolin.example.com', apiUrl: 'https://api.example.com/v1', orgId: 'home', apiKey: 'key.secret' });
  await p.connect();
  overrides.push = () => { throw new Error('compose config failed'); };
  await assert.rejects(p.addRoute('immich', { service: 'app', port: 2283, domainId: 'd1', subdomain: 'photos' }), /compose config failed/);
  assert.deepEqual(p.routes(), []);
  assert.ok(pg.calls.some((c) => c.route === 'DELETE /resource/7'));
});
