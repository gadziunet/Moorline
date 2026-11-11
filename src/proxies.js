// Proxies: addresses in the local domain for servers and devices outside Stackmoor
// (Proxmox, a router, a NAS…). Caddy forwards <subdomain>.<domain> to scheme://host:port.
import net from 'node:net';
import tls from 'node:tls';
import { getState, setState } from './db.js';
import { UserError } from './errors.js';

export const SUBDOMAIN_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
// An IPv4/IPv6 address or a host name – no scheme, no path, no port.
const HOST_RE = /^(?:[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;
const IPV6_RE = /^[0-9a-f:]+$/i;
const MAX_EVENTS = 30;

/** Checks and normalises what the form sent. Throws UserError with the field that is wrong. */
export function cleanProxy(body = {}) {
  const name = String(body.name ?? '').trim();
  const subdomain = String(body.subdomain ?? '').trim().toLowerCase();
  const scheme = String(body.scheme ?? 'http').toLowerCase();
  let host = String(body.host ?? '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  const port = Number(body.port);
  if (!name || name.length > 40) throw new UserError('proxy.badName');
  if (!SUBDOMAIN_RE.test(subdomain)) throw new UserError('dns.badSubdomain', { sub: subdomain });
  if (scheme !== 'http' && scheme !== 'https') throw new UserError('proxy.badScheme');
  if (!host || !(HOST_RE.test(host) || (host.includes(':') && IPV6_RE.test(host)))) throw new UserError('proxy.badHost', { host });
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new UserError('dns.badPort');
  return {
    name, subdomain, scheme, host, port,
    insecure: scheme === 'https' && body.insecure !== false,
    hostHeader: Boolean(body.hostHeader),
    monitor: body.monitor !== false,
  };
}

const hostPort = (p) => (p.host.includes(':') ? `[${p.host}]:${p.port}` : `${p.host}:${p.port}`);
export const targetUrl = (p) => `${p.scheme}://${hostPort(p)}`;

const reEscape = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Some panels (Unraid, routers…) redirect to their own full address, e.g.
 * http://192.168.1.10:8086/Dashboard. Like Nginx Proxy Manager, turn that back into
 * our address – relative redirects and other addresses are left alone.
 */
export function locationRewrite(p) {
  const host = p.host.includes(':') ? `\\[${reEscape(p.host)}\\]` : reEscape(p.host);
  // The default port may be left out of the address.
  const port = p.port === 80 || p.port === 443 ? `(?::${p.port})?` : `:${p.port}`;
  return { search_regexp: `(?i)^https?://${host}${port}(/|$)`, replace: 'https://{http.request.host}$1' };
}

/** The Caddy route for one proxy. */
export function proxyRoute(p, domain) {
  const handler = {
    handler: 'reverse_proxy',
    upstreams: [{ dial: hostPort(p) }],
    headers: { response: { replace: { Location: [locationRewrite(p)] } } },
  };
  // A target that does not answer within a few seconds gets the "starting" page, not a spinner.
  handler.transport = { protocol: 'http', dial_timeout: '3s' };
  if (p.scheme === 'https') {
    handler.transport.tls = {
      ...(p.insecure ? { insecure_skip_verify: true } : {}),
      // Certificates name the server, not our address: ask for the target's own name.
      ...(!net.isIP(p.host) ? { server_name: p.host } : {}),
    };
  }
  // Some servers only answer to their own name or address.
  if (p.hostHeader) handler.headers.request = { set: { Host: ['{http.reverse_proxy.upstream.hostport}'] } };
  return { match: [{ host: [`${p.subdomain}.${domain}`] }], handle: [handler], terminal: true };
}

/** Can this server reach the target? TCP (and TLS for https), with the time it took. */
export function checkTarget({ scheme, host, port }, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const started = Date.now();
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve({ ...r, ms: Date.now() - started }); } };
    const opts = { host, port: Number(port), timeout: timeoutMs };
    const sock = scheme === 'https'
      ? tls.connect({ ...opts, rejectUnauthorized: false, servername: net.isIP(host) ? undefined : host }, () => {
        finish({ ok: true, tls: sock.authorized ? 'valid' : 'self-signed' });
        sock.destroy();
      })
      : net.connect(opts, () => { finish({ ok: true, tls: null }); sock.destroy(); });
    sock.on('timeout', () => { finish({ ok: false, error: 'timeout' }); sock.destroy(); });
    sock.on('error', (err) => finish({ ok: false, error: err.code || 'error' }));
  });
}

const fromRow = (r) => ({
  id: r.id, name: r.name, subdomain: r.subdomain, scheme: r.scheme, host: r.host, port: r.port,
  insecure: Boolean(r.insecure), hostHeader: Boolean(r.host_header), monitor: Boolean(r.monitor),
});

export function createProxies({ db, getSettings, reloadConfig, check = checkTarget, onChange = () => {} }) {
  const status = new Map(); // id -> { ok, ms, since, checkedAt, error }

  function all() {
    return db.prepare('SELECT * FROM proxies ORDER BY name').all().map(fromRow);
  }

  function list() {
    return all().map((p) => ({ ...p, target: targetUrl(p), status: status.get(p.id) || null }));
  }

  function events() { return getState(db, 'proxy.events', []); }

  function assertFree(subdomain, ownId = null) {
    const s = getSettings();
    if (subdomain === s.panelSubdomain) throw new UserError('dns.subdomainTaken', { sub: subdomain });
    if (db.prepare('SELECT 1 FROM routes WHERE subdomain = ?').get(subdomain)) throw new UserError('dns.subdomainTaken', { sub: subdomain });
    const other = db.prepare('SELECT id FROM proxies WHERE subdomain = ?').get(subdomain);
    if (other && other.id !== ownId) throw new UserError('dns.subdomainTaken', { sub: subdomain });
  }

  async function save(body, id = null) {
    if (!getSettings().domain) throw new UserError('dns.noDomain');
    const p = cleanProxy(body);
    if (id !== null && !db.prepare('SELECT 1 FROM proxies WHERE id = ?').get(id)) throw new UserError('proxy.notFound');
    assertFree(p.subdomain, id);
    const vals = [p.name, p.subdomain, p.scheme, p.host, p.port, p.insecure ? 1 : 0, p.hostHeader ? 1 : 0, p.monitor ? 1 : 0];
    if (id === null) {
      id = Number(db.prepare(`INSERT INTO proxies(name, subdomain, scheme, host, port, insecure, host_header, monitor)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(...vals).lastInsertRowid);
    } else {
      db.prepare(`UPDATE proxies SET name = ?, subdomain = ?, scheme = ?, host = ?, port = ?, insecure = ?, host_header = ?, monitor = ?
        WHERE id = ?`).run(...vals, id);
      status.delete(id);
    }
    await reloadConfig().catch(() => false);
    checkOne(fromRow(db.prepare('SELECT * FROM proxies WHERE id = ?').get(id))).catch(() => {});
    return { id };
  }

  async function remove(id) {
    const r = db.prepare('DELETE FROM proxies WHERE id = ?').run(id);
    if (!r.changes) throw new UserError('proxy.notFound');
    status.delete(id);
    await reloadConfig().catch(() => false);
  }

  async function checkOne(p) {
    if (!p) return null;
    const r = await check(p);
    const prev = status.get(p.id);
    const now = new Date().toISOString();
    const since = prev && prev.ok === r.ok ? prev.since : now;
    status.set(p.id, { ok: r.ok, ms: r.ms, error: r.error || null, tls: r.tls ?? null, since, checkedAt: now });
    // Only changes go to the dashboard's events (and not the very first check).
    if (prev && prev.ok !== r.ok) {
      setState(db, 'proxy.events', [{ at: now, name: p.name, ok: r.ok }, ...events()].slice(0, MAX_EVENTS));
      try { onChange(p, r); } catch { /* a listener must not break the check */ }
    }
    return status.get(p.id);
  }

  async function checkAll() {
    for (const p of all().filter((x) => x.monitor)) await checkOne(p).catch(() => {});
  }

  let timer = null;
  function startMonitor(everyMs = 60_000) {
    clearInterval(timer);
    checkAll();
    timer = setInterval(checkAll, everyMs);
    timer.unref?.();
  }

  return { list, all, save, remove, events, checkAll, checkOne, startMonitor, assertFree };
}
