// Pangolin: public addresses for stacks, next to the local domain. Stackmoor talks to
// Pangolin's Integration API: it creates its own site, runs the site's tunnel client (Newt)
// as a container on the shared network, and creates one resource + target per address.
// Routes used (they exist in both older and newer Pangolin versions):
//   GET  /org/{orgId}/domains            GET /org/{orgId}/pick-site-defaults
//   PUT  /org/{orgId}/site               GET/DELETE /site/{siteId}
//   PUT  /org/{orgId}/resource           POST/DELETE /resource/{id}
//   PUT  /resource/{id}/target
import fs from 'node:fs';
import path from 'node:path';
import { stringify } from 'yaml';
import { docker } from './docker.js';
import { getState, setState } from './db.js';
import { UserError } from './errors.js';
import { encrypt, decrypt, mask } from './secrets.js';
import { NETWORK } from './domains.js';

export const NEWT = 'stackmoor-newt';
export const NEWT_IMAGE = process.env.STACKMOOR_NEWT_IMAGE || 'fosrl/newt:latest';
const SUB_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const str = (v) => String(v ?? '').trim();
const isUrl = (v) => { try { return ['http:', 'https:'].includes(new URL(v).protocol); } catch { return false; } };

/** Checks the connection settings from the form. Empty or masked key keeps the saved one. */
export function cleanConfig(body = {}, old = {}) {
  const rawEndpoint = str(body.endpoint ?? old.endpoint);
  const rawApi = str(body.apiUrl ?? old.apiUrl);
  // No control characters or spaces (the address goes into Newt's .env file).
  if (!isUrl(rawEndpoint) || /[\s\x00-\x1f$"'`\\]/.test(rawEndpoint)) throw new UserError('pg.badEndpoint');
  if (!isUrl(rawApi) || /[\s\x00-\x1f$"'`\\]/.test(rawApi)) throw new UserError('pg.badApiUrl');
  const endpoint = new URL(rawEndpoint).origin;
  const u = new URL(rawApi);
  let apiUrl = `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
  if (!/\/v1$/.test(apiUrl)) apiUrl += '/v1';
  const orgId = str(body.orgId ?? old.orgId);
  const key = body.apiKey === undefined || str(body.apiKey) === '' || str(body.apiKey).startsWith('••••••') ? old.apiKey || '' : str(body.apiKey);
  if (!/^[\w.-]{1,64}$/.test(orgId)) throw new UserError('pg.badOrg');
  if (!key) throw new UserError('pg.badKey');
  return { endpoint, apiUrl, orgId, apiKey: key };
}

/** A small client for Pangolin's Integration API. Errors come back as UserError with Pangolin's message. */
export function pangolinApi({ apiUrl, apiKey }, fetchFn = fetch) {
  return async function call(method, pathname, body) {
    let res;
    try {
      res = await fetchFn(`${apiUrl}${pathname}`, {
        method,
        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20000),
      });
    } catch (err) {
      throw new UserError('pg.unreachable', { error: err.cause?.code || err.message });
    }
    const data = await res.json().catch(() => null);
    if (!res.ok || data?.error === true || data?.success === false) {
      const message = data?.message || `HTTP ${res.status}`;
      if (res.status === 401 || res.status === 403) throw new UserError('pg.denied', { message });
      throw new UserError('pg.apiError', { message, status: res.status });
    }
    return data?.data ?? null;
  };
}

/** The address Pangolin gives a resource: subdomain + base domain (or the base domain itself). */
export const fullDomainOf = (subdomain, domain) => (subdomain ? `${subdomain}.${domain.baseDomain}` : domain.baseDomain);

export function createPangolin({ db, stacksDir, stacks, domains, fetchFn = fetch, run = docker }) {
  const dir = path.join(stacksDir, '.stackmoor', 'newt');

  // ---------- settings ----------

  function config() {
    const c = getState(db, 'pangolin.config', null);
    if (!c) return null;
    return { ...c, ...(decrypt(c.secrets) || {}) };
  }
  function saveState(c) {
    const { apiKey, newtSecret, ...rest } = c;
    setState(db, 'pangolin.config', { ...rest, secrets: encrypt({ apiKey, newtSecret }) });
  }
  const api = (c = config()) => {
    if (!c?.apiKey) throw new UserError('pg.notSet');
    return pangolinApi(c, fetchFn);
  };

  /** Settings for the page – no secrets. */
  function publicConfig() {
    const c = config();
    if (!c) return { configured: false };
    return {
      configured: true, endpoint: c.endpoint, apiUrl: c.apiUrl, orgId: c.orgId, apiKey: mask(c.apiKey),
      site: c.siteId ? { siteId: c.siteId, niceId: c.niceId || null, name: c.siteName || null } : null,
    };
  }

  async function listDomains(c = config()) {
    const data = await api(c)('GET', `/org/${encodeURIComponent(c.orgId)}/domains?limit=1000&offset=0`);
    return (data?.domains || []).map((d) => ({ domainId: d.domainId, baseDomain: d.baseDomain, type: d.type, verified: d.verified !== false }));
  }

  /** Saves the connection after checking it works (lists the organisation's domains). */
  async function saveConfig(body) {
    const old = config() || {};
    const c = { ...old, ...cleanConfig(body, old) };
    const found = await listDomains(c);
    saveState(c);
    return { ...publicConfig(), domains: found };
  }

  // ---------- this server as a Pangolin site (Newt) ----------

  const composeFile = () => path.join(dir, 'compose.yaml');
  const composeArgs = () => ['compose', '--ansi', 'never', '--progress', 'plain', '-p', NEWT, '--project-directory', dir, '-f', composeFile()];

  function writeNewtFiles(c) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // The secret goes into .env (mode 600), not into compose.yaml.
    fs.writeFileSync(path.join(dir, '.env'), `PANGOLIN_ENDPOINT=${c.endpoint}\nNEWT_ID=${c.newtId}\nNEWT_SECRET=${c.newtSecret}\n`, { mode: 0o600 });
    fs.writeFileSync(composeFile(), stringify({
      name: NEWT,
      services: {
        newt: {
          image: NEWT_IMAGE,
          container_name: NEWT,
          restart: 'unless-stopped',
          environment: ['PANGOLIN_ENDPOINT=${PANGOLIN_ENDPOINT}', 'NEWT_ID=${NEWT_ID}', 'NEWT_SECRET=${NEWT_SECRET}'],
          // Apps with network_mode: host are reached through the server's address.
          extra_hosts: ['host.docker.internal:host-gateway'],
          networks: [NETWORK],
        },
      },
      networks: { [NETWORK]: { external: true, name: NETWORK } },
    }));
  }

  /** Creates the site in Pangolin (once) and starts Newt. Streams Docker's output to log(). */
  let connecting = null;
  function connect(log = () => {}, t = (k) => k) {
    // One at a time – two at once could create two sites.
    if (!connecting) connecting = doConnect(log, t).finally(() => { connecting = null; });
    return connecting;
  }
  async function doConnect(log, t) {
    const c = config();
    if (!c) throw new UserError('pg.notSet');
    const call = api(c);
    if (!c.siteId) {
      const org = encodeURIComponent(c.orgId);
      const d = await call('GET', `/org/${org}/pick-site-defaults`);
      // No "address": the suggested one isn't reserved – Pangolin picks a free one itself.
      const site = await call('PUT', `/org/${org}/site`, { name: 'Stackmoor', type: 'newt', newtId: d.newtId, secret: d.newtSecret });
      Object.assign(c, { siteId: site.siteId, niceId: site.niceId, siteName: site.name, newtId: site.newtId || d.newtId, newtSecret: site.secret || d.newtSecret });
      saveState(c);
      log(`${t('pg.log.siteCreated', { name: site.name || 'Stackmoor' })}\n`);
    }
    await domains.ensureNetwork();
    writeNewtFiles(c);
    log(`$ docker compose -p ${NEWT} up -d\n`);
    const up = await run([...composeArgs(), 'up', '-d', '--pull', 'missing'], { onData: log });
    if (up.code !== 0) throw new UserError('step.exitCode', { code: up.code });
    return status();
  }

  /** Removes the site (and its resources) from Pangolin and stops Newt. */
  async function disconnect() {
    const c = config();
    if (!c) return;
    const gone = (err) => { if (err.vars?.status !== 404) throw err; };
    const affected = [...new Set(db.prepare('SELECT stack FROM pangolin_routes').all().map((r) => r.stack))];
    // Resources first, one by one: Pangolin's "deleteResources" option needs a logged-in
    // user and is refused for API keys.
    for (const r of db.prepare('SELECT * FROM pangolin_routes').all()) {
      await api(c)('DELETE', `/resource/${r.resource_id}`).catch(gone);
      db.prepare('DELETE FROM pangolin_routes WHERE id = ?').run(r.id);
    }
    if (c.siteId) await api(c)('DELETE', `/site/${c.siteId}`).catch(gone);
    if (fs.existsSync(composeFile())) await run([...composeArgs(), 'down']);
    db.prepare('DELETE FROM pangolin_routes').run();
    for (const s of affected) await domains.writeOverride(s).catch(() => {});
    setState(db, 'pangolin.config', null);
  }

  async function status() {
    const c = config();
    if (!c) return { configured: false };
    const ps = await run(['inspect', '--format', '{{.State.Status}}', NEWT]);
    const container = ps.code === 0 ? ps.stdout.trim() : 'missing';
    let online = null;
    let error = null;
    if (c.siteId) {
      try {
        const s = await api(c)('GET', `/site/${c.siteId}`);
        online = Boolean(s?.online);
      } catch (err) {
        error = err.key === 'pg.unreachable' || err.key === 'pg.denied' ? err : null;
        if (err.vars?.status === 404) online = null; // the site was removed in Pangolin
      }
    }
    return { configured: true, connected: Boolean(c.siteId), container, online, error: error ? { key: error.key, vars: error.vars } : null };
  }

  /** After the panel starts: Newt keeps running with restart: unless-stopped; recreate it if missing. */
  async function startAll() {
    const c = config();
    if (!c?.siteId || !c.newtSecret) return;
    const ps = await run(['inspect', '--format', '{{.State.Status}}', NEWT]);
    if (ps.code !== 0) await connect().catch(() => {});
  }

  // ---------- public addresses ----------

  const fromRow = (r) => ({
    id: r.id, stack: r.stack, service: r.service, port: r.port, domainId: r.domain_id,
    subdomain: r.subdomain, fullDomain: r.full_domain, sso: Boolean(r.sso), resourceId: r.resource_id,
  });
  const routes = (stack) => (stack
    ? db.prepare('SELECT * FROM pangolin_routes WHERE stack = ? ORDER BY full_domain').all(stack)
    : db.prepare('SELECT * FROM pangolin_routes ORDER BY full_domain').all()).map(fromRow);
  const servicesFor = (stack) => [...new Set(routes(stack).map((r) => r.service))];

  /** Connects a running service to the shared network now (the override does it on the next start). */
  async function joinNetwork(stack, service) {
    const cfg = await stacks.config(stack).catch(() => null);
    const def = cfg?.services?.[service];
    if (!def || def.network_mode) return;
    await run(['network', 'connect', NETWORK, def.container_name || `${stack}-${service}-1`]);
  }

  async function addRoute(stack, body = {}) {
    const c = config();
    if (!c?.siteId) throw new UserError('pg.notConnected');
    stacks.assertName(stack);
    const service = str(body.service);
    const port = Number(body.port);
    const subdomain = str(body.subdomain).toLowerCase() || null;
    const sso = body.sso !== false;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(service)) throw new UserError('dns.badService', { service });
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new UserError('dns.badPort');
    if (subdomain && !SUB_RE.test(subdomain)) throw new UserError('dns.badSubdomain', { sub: subdomain });
    const domain = (await listDomains(c)).find((d) => d.domainId === str(body.domainId));
    if (!domain) throw new UserError('pg.badDomain');
    if (domain.type === 'cname' && subdomain) throw new UserError('pg.cnameNoSub', { domain: domain.baseDomain });
    const fullDomain = fullDomainOf(domain.type === 'cname' ? null : subdomain, domain);
    if (db.prepare('SELECT 1 FROM pangolin_routes WHERE full_domain = ?').get(fullDomain)) throw new UserError('pg.taken', { address: fullDomain });

    const target = await domains.upstreamFor(stack, service, port);
    const [ip, tport] = [target.slice(0, target.lastIndexOf(':')), Number(target.slice(target.lastIndexOf(':') + 1))];
    const call = api(c);
    // http + protocol: understood by older Pangolin versions too (newer ones read them as mode "http").
    const res = await call('PUT', `/org/${encodeURIComponent(c.orgId)}/resource`, {
      name: `${stack} · ${service}`, subdomain: domain.type === 'cname' ? null : subdomain, domainId: domain.domainId, http: true, protocol: 'tcp',
    });
    const resourceId = res.resourceId;
    let rowId = null;
    try {
      // New resources have Pangolin's login on; turn it off only when asked.
      if (!sso) await call('POST', `/resource/${resourceId}`, { sso: false });
      const tg = await call('PUT', `/resource/${resourceId}/target`, { siteId: c.siteId, ip, port: tport, method: 'http', enabled: true });
      const row = db.prepare(`INSERT INTO pangolin_routes(stack, service, port, domain_id, subdomain, full_domain, sso, resource_id, target_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(stack, service, port, domain.domainId, subdomain, res.fullDomain || fullDomain, sso ? 1 : 0, resourceId, tg?.targetId ?? null);
      rowId = row.lastInsertRowid;
      await domains.writeOverride(stack);
      await joinNetwork(stack, service).catch(() => {});
      return fromRow(db.prepare('SELECT * FROM pangolin_routes WHERE id = ?').get(rowId));
    } catch (err) {
      // Don't leave half an address behind – neither in Pangolin nor here.
      if (rowId) db.prepare('DELETE FROM pangolin_routes WHERE id = ?').run(rowId);
      await call('DELETE', `/resource/${resourceId}`).catch(() => {});
      throw err;
    }
  }

  async function setSso(id, sso) {
    const r = db.prepare('SELECT * FROM pangolin_routes WHERE id = ?').get(id);
    if (!r) throw new UserError('pg.routeNotFound');
    await api()('POST', `/resource/${r.resource_id}`, { sso: Boolean(sso) });
    db.prepare('UPDATE pangolin_routes SET sso = ? WHERE id = ?').run(sso ? 1 : 0, id);
    return fromRow({ ...r, sso: sso ? 1 : 0 });
  }

  async function removeRoute(id) {
    const r = db.prepare('SELECT * FROM pangolin_routes WHERE id = ?').get(id);
    if (!r) throw new UserError('pg.routeNotFound');
    await api()('DELETE', `/resource/${r.resource_id}`).catch((err) => {
      if (err.vars?.status !== 404) throw err; // already gone in Pangolin – fine
    });
    db.prepare('DELETE FROM pangolin_routes WHERE id = ?').run(id);
    await domains.writeOverride(r.stack).catch(() => {});
  }

  /** A stack was deleted: its public addresses go too. */
  async function removeStack(stack) {
    // When Pangolin can't be reached, the address stays listed in Network → Pangolin to remove later.
    for (const r of routes(stack)) await removeRoute(r.id).catch(() => {});
  }

  return {
    publicConfig, saveConfig, listDomains, connect, disconnect, status, startAll,
    routes, servicesFor, addRoute, setSso, removeRoute, removeStack, configured: () => Boolean(config()?.siteId),
  };
}
