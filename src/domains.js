import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stringify, Document, YAMLSeq, YAMLMap } from 'yaml';
import { docker, parseJsonLines } from './docker.js';
import { getState, setState } from './db.js';
import { UserError } from './errors.js';
import { encrypt, decrypt, mask } from './secrets.js';
import { PROVIDERS, providerById, providerJson, defaultPropagation } from './dns-providers.js';
import { publishedPorts, findConflicts } from './ports.js';
import { proxyRoute } from './proxies.js';
import { certErrors } from './caddy-logs.js';
import { VERSION, isSemver } from './version.js';
import { checkDomain, upsertRecord, supportsAutoRecord, isIPv4 } from './dns-records.js';
import { isInContainer } from './mounts.js';
import { startingPage, STARTING_HEADER } from './starting-page.js';

// Give up on an address that does not answer after a few seconds, so the browser gets the
// "starting" page instead of spinning.
export const DIAL_TIMEOUT = '3s';

/** Caddy's error handling: "not reachable" (502/503/504) gets the starting page – the panel's own
 *  text on the panel's address, a "server not answering" text on proxies (whose cause may also be a
 *  wrong port or certificate setting), the app text everywhere else. */
export function startingErrors(panelHost, proxyHosts = []) {
  return {
    routes: [{
      match: [{ expression: '{http.error.status_code} in [502, 503, 504]' }],
      handle: [{
        handler: 'subroute',
        routes: [
          ...(panelHost ? [startingRoute('panel', [panelHost])] : []),
          ...(proxyHosts.length ? [startingRoute('proxy', proxyHosts)] : []),
          startingRoute('app'),
        ],
      }],
      terminal: true,
    }],
  };
}

/** Caddy route answering "not reachable" errors (502/503/504) with the starting page. */
function startingRoute(kind, hosts) {
  return {
    ...(hosts ? { match: [{ host: hosts }] } : {}),
    handle: [{
      handler: 'static_response',
      status_code: 503,
      headers: {
        'Content-Type': ['text/html; charset=utf-8'],
        'Cache-Control': ['no-store'],
        'Retry-After': ['5'],
        [STARTING_HEADER]: ['1'],
      },
      body: startingPage(kind),
    }],
    terminal: true,
  };
}

// Local domains: one Caddy container ("stackmoor-caddy") in front of all stacks.
// - It holds one wildcard certificate (*.domain) obtained through the DNS provider's API,
//   so the server never has to be reachable from the internet.
// - Stacks with a domain join the shared "stackmoor" network (via compose.stackmoor.yaml),
//   and Caddy proxies <sub>.<domain> to "<container>:<port>".
// - Config is JSON written to disk and loaded with `caddy reload` – no admin port exposed.

export const NETWORK = 'stackmoor';
// Caddy and the panel only. Apps sit on NETWORK with Caddy, so they can't reach the panel directly
// (like a guest network that can't open the router's admin page). Internal: no way out from here.
export const ADMIN_NETWORK = 'stackmoor-admin';
const CADDY = 'stackmoor-caddy';

/**
 * Docker commands that put the panel and Caddy on the right networks, in a safe order:
 * Caddy joins the admin network first, then the panel, and only then the panel leaves the apps'
 * network – so Caddy can reach the panel at every moment.
 * @param {{ self: string, selfNets: string[], caddyNets: string[] | null }} p  caddyNets null: no Caddy
 */
export function networkSteps({ self, selfNets, caddyNets }) {
  const steps = [];
  if (caddyNets && !caddyNets.includes(ADMIN_NETWORK)) steps.push(['network', 'connect', ADMIN_NETWORK, CADDY]);
  if (!selfNets.includes(ADMIN_NETWORK)) steps.push(['network', 'connect', ADMIN_NETWORK, self]);
  // Leave the apps' network only when the panel keeps a normal network of its own (internet:
  // backups, notifications, update checks) – the admin network is internal.
  const ownNet = selfNets.some((n) => n !== NETWORK && n !== ADMIN_NETWORK);
  if (selfNets.includes(NETWORK) && ownNet) steps.push(['network', 'disconnect', NETWORK, self]);
  return steps;
}

/** Caddy's compose file: on the apps' network and on the admin network. */
export function caddyComposeSpec({ image, httpPort, httpsPort }) {
  return {
    name: CADDY,
    services: {
      caddy: {
        image,
        container_name: CADDY,
        restart: 'unless-stopped',
        command: ['caddy', 'run', '--config', '/etc/caddy/caddy.json'],
        ports: [`${httpPort}:80`, `${httpsPort}:443`, `${httpsPort}:443/udp`],
        volumes: ['./config:/etc/caddy', './data:/data', './runtime:/config'],
        extra_hosts: ['host.docker.internal:host-gateway'],
        networks: [NETWORK, ADMIN_NETWORK],
      },
    },
    networks: {
      [NETWORK]: { external: true, name: NETWORK },
      [ADMIN_NETWORK]: { external: true, name: ADMIN_NETWORK },
    },
  };
}
const OVERRIDE = 'compose.stackmoor.yaml';
const SUBDOMAIN_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const DOMAIN_RE = /^(?=.{3,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

const writeFile = (file, content, mode = 0o644) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, { mode });
  fs.renameSync(tmp, file);
};

/**
 * Caddy goes with the panel: a release uses the Caddy image built for the same tag
 * (panel 0.6.1 → stackmoor-caddy:0.6.1), edge uses :edge. Updating the panel is all it takes.
 */
export function caddyImageFor(version = VERSION, fromCi = Boolean(process.env.APP_VERSION)) {
  const tag = version === 'edge' ? 'edge' : (fromCi && isSemver(version) ? String(version).replace(/^v/, '') : 'latest');
  return `ghcr.io/gadziunet/stackmoor-caddy:${tag}`;
}

/** The panel's own address under a newly added domain, like Cloudron's my.<domain>. */
export const DEFAULT_PANEL_SUBDOMAIN = 'my';

export function createDomains({ db, stacks, stacksDir, getSettings, saveSettings }) {
  const caddyDir = path.join(stacksDir, '.stackmoor', 'caddy');
  const image = process.env.STACKMOOR_CADDY_IMAGE || caddyImageFor();
  const followsTag = image.endsWith(':edge') || image.endsWith(':latest'); // moving tags: pull to see changes
  const panelPort = Number(process.env.PORT || 5001);

  // ---------- credentials ----------

  function credentials() {
    return decrypt(getState(db, 'dns.credentials')) || {};
  }

  /** Provider fields for the UI, with saved secrets masked. */
  function publicConfig() {
    const s = getSettings();
    const creds = credentials();
    const masked = {};
    const p = providerById(s.dnsProvider);
    for (const f of p?.fields || []) {
      const v = creds[f.key];
      masked[f.key] = f.secret ? mask(v) : v || '';
    }
    return {
      domain: s.domain,
      dnsProvider: s.dnsProvider,
      acmeEmail: s.acmeEmail,
      httpPort: s.httpPort,
      httpsPort: s.httpsPort,
      panelSubdomain: s.panelSubdomain,
      panelDomainOnly: Boolean(s.panelDomainOnly && s.domain && s.panelSubdomain),
      panelUrl: panelUrl(s),
      serverIp: s.serverIp,
      serverIpAuto: s.serverIpAuto !== false,
      detectedIp,
      ipChange: recentIpChange(),
      autoDnsRecord: s.autoDnsRecord !== false,
      propagationSeconds: s.propagationSeconds,
      credentials: masked,
      providers: PROVIDERS.map(({ id, name, fields, help }) => ({ id, name, fields, help, autoRecord: supportsAutoRecord(id), propagation: defaultPropagation(id) })),
    };
  }

  function panelUrl(s = getSettings()) {
    if (!s.domain || !s.panelSubdomain) return '';
    return `https://${s.panelSubdomain}.${s.domain}${s.httpsPort === 443 ? '' : `:${s.httpsPort}`}`;
  }

  /**
   * @param body  settings from the UI
   * @param currentHost  the host the user opened the panel with – the IP lock may only be
   *   turned on from the panel's own address, which proves that address works.
   */
  function saveConfig(body, currentHost = '') {
    const saved = getSettings();
    const domain = String(body.domain ?? '').trim().toLowerCase().replace(/^\*\./, '').replace(/\.$/, '');
    if (domain && !DOMAIN_RE.test(domain)) throw new UserError('dns.badDomain', { domain });

    const provider = String(body.dnsProvider || '');
    if (domain && provider !== 'internal' && !providerById(provider)) throw new UserError('dns.badProvider');

    // The panel address has its own section; the main form leaves it as it is.
    let panelSubdomain = String(body.panelSubdomain ?? saved.panelSubdomain ?? '').trim().toLowerCase();
    // First domain: give the panel my.<domain> right away (it can be changed or cleared later).
    if (domain && !saved.domain && !panelSubdomain && body.panelSubdomain === undefined
      && !db.prepare('SELECT 1 FROM routes WHERE subdomain = ?').get(DEFAULT_PANEL_SUBDOMAIN)) {
      panelSubdomain = DEFAULT_PANEL_SUBDOMAIN;
    }
    if (panelSubdomain && !SUBDOMAIN_RE.test(panelSubdomain)) throw new UserError('dns.badSubdomain', { sub: panelSubdomain });
    if (panelSubdomain && db.prepare('SELECT 1 FROM routes WHERE subdomain = ?').get(panelSubdomain)) {
      throw new UserError('dns.subdomainTaken', { sub: panelSubdomain });
    }

    const port = (v, def) => {
      const n = Number(v ?? def);
      if (!Number.isInteger(n) || n < 1 || n > 65535) throw new UserError('dns.badPort');
      return n;
    };
    const httpPort = port(body.httpPort, 80);
    const httpsPort = port(body.httpsPort, 443);
    if (httpPort === httpsPort) throw new UserError('dns.badPort');

    const email = String(body.acmeEmail ?? '').trim();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new UserError('dns.badEmail');

    const next = mergeCredentials(provider, body.credentials, Boolean(domain));
    const serverIp = String(body.serverIp ?? saved.serverIp ?? '').trim();
    if (serverIp && !isIPv4(serverIp)) throw new UserError('dns.badServerIp', { ip: serverIp });
    const autoDnsRecord = body.autoDnsRecord === undefined ? saved.autoDnsRecord !== false : Boolean(body.autoDnsRecord);
    const serverIpAuto = body.serverIpAuto === undefined ? saved.serverIpAuto !== false : Boolean(body.serverIpAuto);
    let propagationSeconds = body.propagationSeconds === undefined ? saved.propagationSeconds : body.propagationSeconds;
    if (propagationSeconds === '' || propagationSeconds === null) propagationSeconds = null;
    else {
      propagationSeconds = Number(propagationSeconds);
      if (!Number.isInteger(propagationSeconds) || propagationSeconds < 0 || propagationSeconds > 3600) throw new UserError('dns.badPropagation');
    }
    setState(db, 'dns.credentials', encrypt(next));
    const panelDomainOnly = Boolean(body.panelDomainOnly ?? saved.panelDomainOnly) && Boolean(domain && panelSubdomain);
    if (panelDomainOnly && String(currentHost).toLowerCase() !== `${panelSubdomain}.${domain}`) {
      throw new UserError('dns.lockNeedsDomain', { url: `https://${panelSubdomain}.${domain}` });
    }
    saveSettings({ domain, dnsProvider: provider, acmeEmail: email, httpPort, httpsPort, panelSubdomain, panelDomainOnly, serverIp, autoDnsRecord, serverIpAuto, propagationSeconds });
  }

  /** Seconds to wait after adding the TXT record (own setting, else the provider's default). */
  function propagation(s = getSettings()) {
    return s.propagationSeconds === null || s.propagationSeconds === undefined ? defaultPropagation(s.dnsProvider) : Number(s.propagationSeconds);
  }

  // ---------- this server's IP address ----------

  // The panel runs in a container and can't see the server's network. A one-second
  // helper container (the panel's own image) on the host network asks the system which
  // address it uses to reach the internet – that is the server's address in the LAN.
  const IP_SCRIPT = "const s=require('dgram').createSocket('udp4');s.on('error',()=>process.exit(1));"
    + "s.connect(53,'1.1.1.1',()=>{console.log(s.address().address);s.close()})";
  let detectedIp = '';
  async function detectServerIp() {
    let out = '';
    const me = await docker(['inspect', '--format', '{{.Image}}', os.hostname()]);
    if (me.code === 0 && me.stdout.trim()) {
      const r = await docker(['run', '--rm', '--network', 'host', '--log-driver', 'none', '--entrypoint', 'node', me.stdout.trim(), '-e', IP_SCRIPT]);
      if (r.code === 0) out = r.stdout.trim().split('\n').pop();
    } else {
      // Not in a container (development): this process already sees the host's network.
      const dgram = await import('node:dgram');
      out = await new Promise((resolve) => {
        const s = dgram.createSocket('udp4');
        s.on('error', () => resolve(''));
        s.connect(53, '1.1.1.1', () => { const a = s.address().address; s.close(); resolve(a); });
      });
    }
    if (isIPv4(out) && out !== '0.0.0.0') detectedIp = out;
    return detectedIp;
  }

  function recentIpChange() {
    const c = getState(db, 'dns.ipChange');
    return c && Date.now() - Date.parse(c.at) < 7 * 24 * 3600e3 ? c : null;
  }

  /** On start: has the server's address changed? Then save it and update the DNS record. */
  async function syncServerIp(t) {
    const s = getSettings();
    if (!s.domain || s.serverIpAuto === false) return null;
    const ip = await detectServerIp();
    if (!ip || ip === s.serverIp) return null;
    saveSettings({ serverIp: ip });
    let log = '';
    const rec = s.serverIp ? await ensureRecord((x) => { log += x; }, t) : null;
    if (s.serverIp) setState(db, 'dns.ipChange', { from: s.serverIp, to: ip, at: new Date().toISOString(), record: rec?.action || null });
    return { from: s.serverIp, to: ip, record: rec?.action || null, log };
  }

  /** "Get the certificate again": restarting Caddy makes it start a fresh attempt right away. */
  async function retryCertificate() {
    if (!getSettings().domain) throw new UserError('dns.noDomain');
    writeFile(path.join(caddyDir, 'config', 'caddy.json'), JSON.stringify(await buildConfig(), null, 2), 0o600);
    const r = await docker(['restart', CADDY]);
    if (r.code !== 0) throw new UserError('step.exitCode', { code: r.code });
    await refreshCaddyIp();
    setState(db, 'caddy.retryAt', new Date().toISOString());
    return { ok: true };
  }

  /** Credentials from the form; empty secret fields keep the saved value (the UI only shows a mask). */
  function mergeCredentials(provider, given, required) {
    const p = providerById(provider);
    const old = credentials();
    const next = {};
    for (const f of p?.fields || []) {
      let v = String(given?.[f.key] ?? '').trim();
      if (f.secret && (v === '' || v.startsWith('••••••'))) v = old[f.key] || '';
      if (/[\n\r]/.test(v)) throw new UserError('dns.badValue', { field: f.label });
      if (!v && f.default !== undefined) v = f.default;
      if (required && f.required && !v) throw new UserError('dns.missingField', { field: f.label });
      if (v) next[f.key] = v;
    }
    return next;
  }

  /**
   * Before saving: does the provider's API work with these credentials, and is *.domain
   * already pointing somewhere else? Changes nothing.
   */
  async function check(body) {
    const domain = String(body.domain ?? '').trim().toLowerCase().replace(/^\*\./, '').replace(/\.$/, '');
    if (!DOMAIN_RE.test(domain)) throw new UserError('dns.badDomain', { domain });
    const provider = String(body.dnsProvider || '');
    if (provider !== 'internal' && !providerById(provider)) throw new UserError('dns.badProvider');
    const serverIp = String(body.serverIp ?? '').trim();
    if (serverIp && !isIPv4(serverIp)) throw new UserError('dns.badServerIp', { ip: serverIp });
    const creds = provider === 'internal' ? {} : mergeCredentials(provider, body.credentials, true);
    const r = await checkDomain({ domain, provider, credentials: creds, serverIp });
    // Our own record from before (same domain, same IP) is not "in use".
    return { domain, ...r };
  }

  /** *.domain → serverIp through the provider's API (when supported and switched on). */
  async function ensureRecord(log, t) {
    const s = getSettings();
    if (!s.domain || !s.serverIp || s.autoDnsRecord === false || !supportsAutoRecord(s.dnsProvider)) return null;
    try {
      const r = await upsertRecord({ domain: s.domain, provider: s.dnsProvider, credentials: credentials(), ip: s.serverIp });
      log(t(`dns.log.record.${r.action}`, { name: `${s.domain}, *.${s.domain}`, ip: s.serverIp }) + '\n');
      return r;
    } catch (err) {
      log(t('dns.log.recordFailed', { name: `${s.domain}, *.${s.domain}`, reason: t(`dns.apiError.${err.kind || 'api'}`, { message: err.message }) }) + '\n');
      return null;
    }
  }

  /** Panel address and IP lock only – needs just a config reload, not a Caddy restart. */
  async function savePanel(body, currentHost = '') {
    const s = getSettings();
    if (!s.domain) throw new UserError('dns.noDomain');
    const panelSubdomain = String(body.panelSubdomain ?? '').trim().toLowerCase();
    if (panelSubdomain && !SUBDOMAIN_RE.test(panelSubdomain)) throw new UserError('dns.badSubdomain', { sub: panelSubdomain });
    if (panelSubdomain && (db.prepare('SELECT 1 FROM routes WHERE subdomain = ?').get(panelSubdomain)
      || db.prepare('SELECT 1 FROM proxies WHERE subdomain = ?').get(panelSubdomain))) {
      throw new UserError('dns.subdomainTaken', { sub: panelSubdomain });
    }
    const panelDomainOnly = Boolean(body.panelDomainOnly) && Boolean(panelSubdomain);
    if (panelDomainOnly && String(currentHost).toLowerCase() !== `${panelSubdomain}.${s.domain}`) {
      throw new UserError('dns.lockNeedsDomain', { url: `https://${panelSubdomain}.${s.domain}` });
    }
    saveSettings({ panelSubdomain, panelDomainOnly });
    await reloadConfig();
  }

  /** Rewrites caddy.json and reloads it in the running container (no pull, no restart). */
  async function reloadConfig() {
    writeFile(path.join(caddyDir, 'config', 'caddy.json'), JSON.stringify(await buildConfig(), null, 2), 0o600);
    const ps = await docker(['inspect', '--format', '{{.State.Status}}', CADDY]);
    if (ps.code !== 0 || ps.stdout.trim() !== 'running') return false;
    const r = await docker(['exec', CADDY, 'caddy', 'reload', '--config', '/etc/caddy/caddy.json']);
    if (r.code !== 0) throw new UserError('dns.reloadFailed');
    await refreshCaddyIp();
    return true;
  }

  // ---------- routes ----------

  function routes(stack) {
    return stack
      ? db.prepare('SELECT subdomain, service, port FROM routes WHERE stack = ? ORDER BY subdomain').all(stack)
      : db.prepare('SELECT stack, subdomain, service, port FROM routes ORDER BY subdomain').all();
  }

  async function setRoutes(stack, list) {
    const cfg = await stacks.config(stack);
    const services = Object.keys(cfg.services || {});
    const s = getSettings();
    const clean = [];
    const seen = new Set();
    for (const r of Array.isArray(list) ? list : []) {
      const subdomain = String(r.subdomain || '').trim().toLowerCase();
      const service = String(r.service || '');
      const port = Number(r.port);
      if (!SUBDOMAIN_RE.test(subdomain)) throw new UserError('dns.badSubdomain', { sub: subdomain });
      if (seen.has(subdomain) || subdomain === s.panelSubdomain) throw new UserError('dns.subdomainTaken', { sub: subdomain });
      const other = db.prepare('SELECT stack FROM routes WHERE subdomain = ? AND stack != ?').get(subdomain, stack);
      if (other || db.prepare('SELECT 1 FROM proxies WHERE subdomain = ?').get(subdomain)) throw new UserError('dns.subdomainTaken', { sub: subdomain });
      if (!services.includes(service)) throw new UserError('dns.badService', { service });
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new UserError('dns.badPort');
      seen.add(subdomain);
      clean.push({ subdomain, service, port });
    }
    db.transaction(() => {
      db.prepare('DELETE FROM routes WHERE stack = ?').run(stack);
      const ins = db.prepare('INSERT INTO routes(stack, subdomain, service, port) VALUES (?, ?, ?, ?)');
      for (const r of clean) ins.run(stack, r.subdomain, r.service, r.port);
    })();
    await writeOverride(stack);
  }

  function removeStack(stack) {
    db.prepare('DELETE FROM routes WHERE stack = ?').run(stack);
  }

  /** compose.stackmoor.yaml: adds the routed services to the shared network (keeping their own). */
  // Set by the VPN module: which services of a stack go through a tunnel.
  const vpn = { servicesFor: () => [] };
  // Set by the Pangolin module: services with a public address (Newt reaches them on the shared network).
  const pangolin = { servicesFor: () => [] };

  async function writeOverride(stack) {
    const file = path.join(stacks.stackDir(stack), OVERRIDE);
    const list = [...routes(stack), ...pangolin.servicesFor(stack).map((service) => ({ service }))];
    const viaVpn = vpn.servicesFor(stack);
    if (!list.length && !viaVpn.length) {
      fs.rmSync(file, { force: true });
      return;
    }
    // The user's own config, without the old override.
    const cfg = await stacks.config(stack, { raw: true });
    const services = {};
    const tunnelled = new Set(viaVpn.map((v) => v.service));
    for (const svc of new Set(list.map((r) => r.service))) {
      const def = cfg.services?.[svc];
      if (!def || def.network_mode || tunnelled.has(svc)) continue; // host network / VPN: reached differently
      const own = Object.keys(def.networks || { default: null });
      services[svc] = { networks: Object.fromEntries([...own, NETWORK].map((n) => [n, {}])) };
    }
    // Through a VPN: share the tunnel container's network. Its own ports and networks move
    // to the tunnel container (Docker does not allow them together with network_mode).
    for (const v of viaVpn) {
      if (!cfg.services?.[v.service]) continue;
      const ports = new YAMLSeq(); ports.tag = '!reset';
      const nets = new YAMLMap(); nets.tag = '!reset';
      services[v.service] = { network_mode: `container:${v.container}`, ports, networks: nets };
    }
    if (!Object.keys(services).length) {
      fs.rmSync(file, { force: true });
      return;
    }
    const needsNetwork = Object.values(services).some((x) => x.networks && !(x.networks instanceof YAMLMap));
    const doc = new Document({
      services,
      ...(needsNetwork ? { networks: { [NETWORK]: { external: true, name: NETWORK } } } : {}),
    });
    writeFile(file, `# Generated by Stackmoor (local domains, VPN) – do not edit, changes are overwritten.\n${doc.toString()}`);
  }

  /** Where to reach a service of a stack from the shared network (Caddy, Newt). */
  async function upstreamFor(stack, service, port) {
    return upstream(stack, { service, port }, await stacks.config(stack));
  }

  /** Where Caddy should send traffic for a route. */
  function upstream(stack, route, cfg) {
    const tunnel = vpn.servicesFor(stack).find((v) => v.service === route.service);
    if (tunnel) return `${tunnel.container}:${route.port}`;
    const def = cfg.services?.[route.service] || {};
    if (def.network_mode) return `host.docker.internal:${route.port}`;
    const container = def.container_name || `${stack}-${route.service}-1`;
    return `${container}:${route.port}`;
  }

  // ---------- Caddy ----------

  async function selfContainer() {
    const r = await docker(['inspect', '--format', '{{.Name}}', os.hostname()]);
    return r.code === 0 ? r.stdout.trim().replace(/^\//, '') : null;
  }

  function proxyRows() {
    try {
      return db.prepare('SELECT * FROM proxies ORDER BY subdomain').all()
        .map((r) => ({ ...r, insecure: Boolean(r.insecure), hostHeader: Boolean(r.host_header) }));
    } catch { return []; } // a database from before proxies existed
  }

  async function buildConfig() {
    const s = getSettings();
    const hostRoutes = [];
    for (const r of routes()) {
      let cfg;
      try { cfg = await stacks.config(r.stack); } catch { continue; }
      hostRoutes.push({ host: `${r.subdomain}.${s.domain}`, dial: upstream(r.stack, r, cfg) });
    }
    if (s.panelSubdomain) {
      const self = await selfContainer();
      hostRoutes.push({
        host: `${s.panelSubdomain}.${s.domain}`,
        dial: self ? `${self}:${panelPort}` : `host.docker.internal:${panelPort}`,
      });
    }

    const issuer = s.dnsProvider === 'internal'
      ? { module: 'internal' }
      : {
        module: 'acme',
        ...(s.acmeEmail ? { email: s.acmeEmail } : {}),
        challenges: {
          dns: {
            provider: providerJson(s.dnsProvider, credentials()),
            // Like "Propagation seconds" in Nginx Proxy Manager: wait before Let's Encrypt checks,
            // and only ask once public DNS really shows the TXT record (up to 10 minutes).
            ...(propagation(s) > 0 ? { propagation_delay: `${propagation(s)}s` } : {}),
            propagation_timeout: '10m',
            resolvers: ['1.1.1.1', '8.8.8.8'],
          },
        },
      };

    return {
      admin: { listen: 'localhost:2019' },
      logging: { logs: { default: { level: 'INFO' } } },
      apps: {
        http: {
          http_port: 80,
          https_port: 443,
          servers: {
            stackmoor: {
              listen: [':443'],
              routes: [
                ...hostRoutes.map((r) => ({
                  match: [{ host: [r.host] }],
                  handle: [{
                    handler: 'reverse_proxy',
                    upstreams: [{ dial: r.dial }],
                    transport: { protocol: 'http', dial_timeout: DIAL_TIMEOUT },
                  }],
                  terminal: true,
                })),
                // Servers outside Stackmoor (Proxmox, a router…).
                ...proxyRows().map((x) => proxyRoute(x, s.domain)),
                // The bare domain leads to the panel (when it has an address).
                ...(s.panelSubdomain ? [{
                  match: [{ host: [s.domain] }],
                  handle: [{ handler: 'static_response', status_code: 302, headers: { Location: [panelUrl(s)] } }],
                  terminal: true,
                }] : []),
              ],
              // Caddy could not reach the panel or an app (starting, restarting, stopped): a page
              // that waits and reloads by itself instead of an empty error or a spinning browser.
              errors: startingErrors(
                s.panelSubdomain ? `${s.panelSubdomain}.${s.domain}` : null,
                proxyRows().map((x) => `${x.subdomain}.${s.domain}`),
              ),
            },
          },
        },
        // One wildcard certificate covers every app: Caddy skips per-host certificates
        // for names covered by a managed wildcard (default since Caddy 2.10).
        tls: {
          // The wildcard does not cover the bare domain itself, so it gets its own certificate.
          certificates: { automate: [`*.${s.domain}`, s.domain] },
          automation: { policies: [{ subjects: [`*.${s.domain}`, s.domain], issuers: [issuer] }] },
        },
      },
    };
  }

  function caddyCompose(s) {
    return caddyComposeSpec({ image, httpPort: s.httpPort, httpsPort: s.httpsPort });
  }

  const composeArgs = () => ['compose', '--ansi', 'never', '--progress', 'plain', '-p', CADDY,
    '--project-directory', caddyDir, '-f', path.join(caddyDir, 'compose.yaml')];

  async function ensureNetwork() {
    const r = await docker(['network', 'inspect', NETWORK]);
    if (r.code !== 0) await docker(['network', 'create', NETWORK]);
    const a = await docker(['network', 'inspect', ADMIN_NETWORK]);
    if (a.code === 0) return true;
    const c = await docker(['network', 'create', '--internal', ADMIN_NETWORK]);
    if (c.code !== 0) console.error(`Could not create the ${ADMIN_NETWORK} network: ${c.output.trim()}`);
    return c.code === 0;
  }

  /** Names of the networks a container is on, or null when it doesn't exist. */
  async function networksOf(container) {
    const r = await docker(['inspect', '--format', '{{json .NetworkSettings.Networks}}', container]);
    if (r.code !== 0) return null;
    try { return Object.keys(JSON.parse(r.stdout || '{}') || {}); } catch { return []; }
  }

  /** Panel on the admin network (with Caddy) and off the apps' network. Safe to run again. */
  // Never leaves the panel unreachable: it leaves the apps' network only after Docker confirms
  // that both the panel and Caddy are on the admin network.
  async function placeSelf(self) {
    const selfNets = await networksOf(self);
    if (!selfNets) return;
    const caddyNets = await networksOf(CADDY);
    for (const step of networkSteps({ self, selfNets, caddyNets })) {
      if (step[1] === 'disconnect') {
        const now = await networksOf(self);
        const caddyNow = await networksOf(CADDY);
        if (!now?.includes(ADMIN_NETWORK) || (caddyNow && !caddyNow.includes(ADMIN_NETWORK))) return;
      }
      const r = await docker(step);
      if (r.code !== 0) {
        console.error(`docker ${step.join(' ')} failed: ${r.output.trim()}`);
        return;
      }
    }
  }

  /** Writes Caddy's files, (re)starts it and reloads the config. Streams output through log(). */
  async function apply(log, t) {
    const s = getSettings();
    if (!s.domain) {
      log(t('dns.log.disabled') + '\n');
      await docker([...composeArgs(), 'down'], { onData: log });
      return;
    }
    if (!s.dnsProvider) throw new UserError('dns.badProvider');

    await ensureRecord(log, t);
    if (!await ensureNetwork()) throw new UserError('dns.adminNetworkFailed', { name: ADMIN_NETWORK });
    writeFile(path.join(caddyDir, 'compose.yaml'), stringify(caddyCompose(s)));
    // The JSON holds the DNS API key, so only root may read it.
    writeFile(path.join(caddyDir, 'config', 'caddy.json'), JSON.stringify(await buildConfig(), null, 2), 0o600);

    // Free ports? (other containers; Caddy's own container is ignored)
    const cfg = await docker([...composeArgs(), 'config', '--format', 'json']);
    if (cfg.code === 0) {
      const ps = await docker(['ps', '--format', '{{json .}}']);
      const conflicts = findConflicts(publishedPorts(JSON.parse(cfg.stdout)), parseJsonLines(ps.stdout), CADDY);
      if (conflicts.length) throw new UserError('ports.conflicts', { conflicts });
    }

    // Running routed containers join the apps' network; the panel only its own network with Caddy.
    const self = await selfContainer();
    for (const r of routes()) {
      try {
        const c = await stacks.config(r.stack);
        const def = c.services?.[r.service] || {};
        if (!def.network_mode) await docker(['network', 'connect', NETWORK, def.container_name || `${r.stack}-${r.service}-1`]);
      } catch { /* stack not running or broken – it joins on next start */ }
    }

    log(`$ docker compose -p ${CADDY} up -d\n`);
    // Pull only when the image is not here yet – saving settings should not download anything.
    if ((await docker(['image', 'inspect', image])).code !== 0) {
      const pull = await docker([...composeArgs(), 'pull', '--quiet'], { onData: log });
      if (pull.code !== 0) log(t('dns.log.pullFailed') + '\n');
    }
    const before = await containerId();
    const r = await docker([...composeArgs(), 'up', '-d', '--remove-orphans'], { onData: log });
    if (r.code !== 0) throw new UserError('step.exitCode', { code: r.code });
    if (self) await placeSelf(self);

    // A freshly (re)created container has just read the config – reloading it right away
    // would cancel the certificate request it started. Otherwise reload; without --force
    // Caddy ignores an unchanged config, so a running certificate request keeps going.
    if (before && before === await containerId()) {
      const reload = await docker(['exec', CADDY, 'caddy', 'reload', '--config', '/etc/caddy/caddy.json'], { onData: log });
      if (reload.code !== 0) throw new UserError('dns.reloadFailed');
    }
    refreshCaddyIp();
    log(t('dns.log.applied') + '\n');
  }

  /**
   * On start: a recreated panel container (e.g. after an update) has left Caddy's network.
   * Also moves older installations (panel on the apps' network) to the admin network, and
   * rewrites Caddy's compose.yaml so a recreated Caddy keeps the admin network.
   */
  async function attachSelf() {
    const s = getSettings();
    if (!s.domain) return;
    const self = await selfContainer();
    if (!self) return;
    // Without the admin network nothing moves: the panel stays where Caddy can reach it.
    if (!await ensureNetwork()) return;
    const composeFile = path.join(caddyDir, 'compose.yaml');
    try {
      if (!fs.readFileSync(composeFile, 'utf8').includes(ADMIN_NETWORK)) writeFile(composeFile, stringify(caddyCompose(s)));
    } catch { /* Caddy was never set up here */ }
    await placeSelf(self);
  }

  async function containerId() {
    const r = await docker(['inspect', '--format', '{{.Id}}', CADDY]);
    return r.code === 0 ? r.stdout.trim() : null;
  }

  // Caddy's address on the shared network: with the IP lock on, only it may talk to the panel.
  let caddyIp = null;
  let caddyIps = [];
  // Only when the panel itself runs in a container on that network (otherwise Caddy reaches it
  // through host.docker.internal and the Host header is all we can check).
  // A failed docker call keeps the address we know: only a removed or stopped Caddy clears it.
  async function refreshCaddyIp() {
    if (!await selfContainer()) {
      if (!isInContainer()) { caddyIp = null; caddyIps = []; }
      return caddyIp;
    }
    // The address Caddy talks to the panel from: on the admin network (the apps' network only
    // for an installation that hasn't moved yet).
    const fmt = `{{with index .NetworkSettings.Networks "${ADMIN_NETWORK}"}}{{.IPAddress}}{{end}}|{{with index .NetworkSettings.Networks "${NETWORK}"}}{{.IPAddress}}{{end}}`;
    const r = await docker(['inspect', '--format', fmt, CADDY]);
    if (r.code !== 0) {
      if (/no such (object|container)/i.test(r.output)) { caddyIp = null; caddyIps = []; }
      return caddyIp;
    }
    const [admin, apps] = r.stdout.trim().split('|');
    const selfNets = await networksOf(await selfContainer());
    if (!selfNets) return caddyIp; // a failed docker call keeps the addresses we know
    // Every network the panel shares with Caddy (both while an older install is moving over).
    caddyIps = [admin && selfNets.includes(ADMIN_NETWORK) ? admin : '', apps && selfNets.includes(NETWORK) ? apps : ''].filter(Boolean);
    caddyIp = caddyIps[0] || null;
    return caddyIp;
  }

  /**
   * After a panel update: switch Caddy to the image that belongs to this panel version.
   * Runs on start and every few hours (the Caddy image of a release may be published a bit
   * after the panel's). If the image can't be pulled, the old Caddy keeps running.
   */
  async function syncImage() {
    const s = getSettings();
    if (!s.domain || !fs.existsSync(path.join(caddyDir, 'compose.yaml'))) return { changed: false };
    const local = () => docker(['image', 'inspect', '--format', '{{.Id}}', image]);
    let want = await local();
    if (followsTag || want.code !== 0) {
      const pull = await docker(['pull', '--quiet', image], { signal: AbortSignal.timeout(10 * 60_000) });
      if (pull.code !== 0 && want.code !== 0) {
        setState(db, 'caddy.image', { image, ok: false, at: new Date().toISOString() });
        return { changed: false, error: 'pull' };
      }
      want = await local();
    }
    const cur = await docker(['inspect', '--format', '{{.Image}}', CADDY]);
    if (cur.code === 0 && cur.stdout.trim() === want.stdout.trim()) {
      setState(db, 'caddy.image', { image, ok: true, at: new Date().toISOString() });
      return { changed: false };
    }
    // Every panel release builds its own Caddy image, usually with the very same Caddy inside.
    // Replacing the container takes the domain offline for a moment, so do it only when Caddy or
    // one of its modules really changed. The new image is used the next time Caddy is recreated.
    if (cur.code === 0 && sameCompose(s) && await sameCaddy(image)) {
      setState(db, 'caddy.image', { image, ok: true, same: true, at: new Date().toISOString() });
      return { changed: false, same: true };
    }
    // Certificates live in ./data, so recreating the container keeps them.
    writeFile(path.join(caddyDir, 'compose.yaml'), stringify(caddyCompose(s)));
    const up = await docker([...composeArgs(), 'up', '-d', '--remove-orphans']);
    setState(db, 'caddy.image', { image, ok: up.code === 0, at: new Date().toISOString() });
    if (up.code !== 0) return { changed: false, error: 'up' };
    await refreshCaddyIp();
    return { changed: true };
  }

  /** Is the same Caddy inside? `caddy build-info` lists Caddy, the Go version and every module and
   *  dependency, so a rebuild for a Go or library security fix counts as different. */
  async function sameCaddy(img) {
    const running = await docker(['exec', CADDY, 'caddy', 'build-info']);
    const wanted = await docker(['run', '--rm', '--network', 'none', '--log-driver', 'none', '--entrypoint', 'caddy', img, 'build-info']);
    const a = running.code === 0 ? running.stdout.trim() : '';
    const b = wanted.code === 0 ? wanted.stdout.trim() : '';
    return Boolean(a) && a === b;
  }

  /** Would this panel version write the same compose.yaml for Caddy (apart from the image)? */
  function sameCompose(s) {
    const noImage = (text) => String(text).replace(/^\s*image:.*$/m, '');
    try {
      const onDisk = fs.readFileSync(path.join(caddyDir, 'compose.yaml'), 'utf8');
      return noImage(onDisk) === noImage(stringify(caddyCompose(s)));
    } catch {
      return false;
    }
  }

  /** Is Caddy running, is there a certificate, and the latest certificate errors. */
  async function status() {
    const s = getSettings();
    if (!s.domain) return { enabled: false };
    const ps = await docker(['inspect', '--format', '{{.State.Status}}', CADDY]);
    const running = ps.code === 0 && ps.stdout.trim() === 'running';
    let certificate = false;
    let errors = [];
    if (running) {
      const ls = await docker(['exec', CADDY, 'sh', '-c', 'ls -1 /data/caddy/certificates/*/ 2>/dev/null']);
      certificate = ls.stdout.split('\n').some((d) => d.trim() === `wildcard_.${s.domain}`);
      const logs = await docker(['logs', '--since', '24h', '--tail', '500', CADDY]);
      errors = certErrors(logs.output);
    }
    const img = getState(db, 'caddy.image');
    const imageProblem = img && !img.ok && img.image === image ? image : null;
    return {
      enabled: true, running, certificate, errors, domain: s.domain, panelUrl: panelUrl(s), imageProblem,
      propagation: s.dnsProvider === 'internal' ? 0 : propagation(s),
      checkedAt: new Date().toISOString(),
    };
  }

  return {
    publicConfig, saveConfig, check, routes, setRoutes, removeStack, writeOverride, apply, status, buildConfig, vpn, pangolin, upstreamFor, ensureNetwork,
    panelUrl, refreshCaddyIp, attachSelf, savePanel, reloadConfig, syncImage, detectServerIp, syncServerIp, retryCertificate,
    caddyIp: () => caddyIp,
    /** Is this address one of Caddy's (on a network it shares with the panel)? */
    isCaddy: (ip) => Boolean(ip) && caddyIps.includes(String(ip).replace(/^::ffff:/, '')),
  };
}
