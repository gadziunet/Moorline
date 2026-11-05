// "Connect through VPN": chosen services of a stack send their traffic through a WireGuard
// tunnel – like a second internet connection only for them. Typical use: an SSH web client
// (e.g. Termix) reaching servers whose firewall only allows the tunnel's fixed address,
// while the home connection has a changing IP.
//
// How it works:
// - Each tunnel is a small container "stackmoor-vpn-<name>" (image stackmoor-vpn) with the
//   user's WireGuard config and a kill switch: nothing leaves it except through the tunnel
//   (and to the local network). If the tunnel is down, the apps have no internet at all.
// - A chosen service gets `network_mode: container:stackmoor-vpn-<name>` in the stack's
//   override file, so it shares the tunnel's network. Its published ports move to the
//   tunnel container, which also joins the stack's networks (the app still reaches its db).
// - When the tunnel container restarts, the services that use it lose their network and are
//   recreated by the panel.

import fs from 'node:fs';
import path from 'node:path';
import { stringify } from 'yaml';
import { docker } from './docker.js';
import { getState, setState } from './db.js';
import { UserError } from './errors.js';
import { encrypt, decrypt } from './secrets.js';
import { VERSION, isSemver } from './version.js';
import { NETWORK } from './domains.js';

export const PREFIX = 'stackmoor-vpn-';
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,20}$/;
const PRIVATE = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'];
// Lines that run commands or touch the host's DNS – never taken from an uploaded file.
const DROP_KEYS = new Set(['dns', 'saveconfig', 'preup', 'postup', 'predown', 'postdown', 'table']);

export function vpnImageFor(version = VERSION, fromCi = Boolean(process.env.APP_VERSION)) {
  const tag = version === 'edge' ? 'edge' : (fromCi && isSemver(version) ? String(version).replace(/^v/, '') : 'latest');
  return `ghcr.io/gadziunet/stackmoor-vpn:${tag}`;
}

/**
 * Reads a WireGuard config (wg-quick format). Returns the cleaned config text plus what
 * the panel needs to know. Throws UserError('vpn.badConf', …) when something is missing.
 */
export function parseConf(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const out = [];
  let section = null;
  const iface = {};
  const peers = [];
  let peer = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const sec = line.match(/^\[(\w+)\]$/);
    if (sec) {
      section = sec[1].toLowerCase();
      if (section === 'peer') { peer = { allowedIps: [] }; peers.push(peer); }
      out.push(`[${sec[1][0].toUpperCase()}${sec[1].slice(1).toLowerCase()}]`);
      continue;
    }
    const kv = line.match(/^([A-Za-z]+)\s*=\s*(.*)$/);
    if (!kv || !section) throw new UserError('vpn.badConf', { line: line.slice(0, 60) });
    const key = kv[1].toLowerCase();
    const value = kv[2].trim();
    if (DROP_KEYS.has(key)) continue;
    if (section === 'interface') iface[key] = value;
    if (section === 'peer') {
      if (key === 'allowedips') peer.allowedIps.push(...value.split(',').map((s) => s.trim()).filter(Boolean));
      else peer[key] = value;
    }
    out.push(`${kv[1]} = ${value}`);
  }
  if (!iface.privatekey) throw new UserError('vpn.badConf', { line: 'PrivateKey' });
  if (!iface.address) throw new UserError('vpn.badConf', { line: 'Address' });
  if (!peers.length) throw new UserError('vpn.badConf', { line: '[Peer]' });
  for (const p of peers) {
    if (!p.publickey) throw new UserError('vpn.badConf', { line: 'PublicKey' });
    if (!p.endpoint) throw new UserError('vpn.badConf', { line: 'Endpoint' });
    if (!p.allowedIps.length) throw new UserError('vpn.badConf', { line: 'AllowedIPs' });
  }
  // Keep the tunnel (and its status) alive behind NAT.
  const text2 = out.join('\n').replace(/(\[Peer\][^[]*)/g, (blk) => (/PersistentKeepalive/i.test(blk) ? blk : `${blk.trimEnd()}\nPersistentKeepalive = 25\n`));
  const allowed = [...new Set(peers.flatMap((p) => p.allowedIps))];
  const ipv4 = allowed.filter((c) => !c.includes(':'));
  return {
    conf: `${text2.trim()}\n`,
    address: iface.address,
    endpoints: peers.map((p) => p.endpoint),
    allowedIps: allowed,
    full: ipv4.some((c) => c === '0.0.0.0/0' || c === '0.0.0.0/1'),
  };
}

/** "vpn.example.com:51820" / "[2001:db8::1]:51820" → { host, port } */
export function splitEndpoint(ep) {
  const m = String(ep).match(/^\[?([^\]]+?)\]?:(\d+)$/);
  return m ? { host: m[1], port: Number(m[2]) } : null;
}

/**
 * The kill switch (iptables rules inside the tunnel container). Runs before the tunnel starts.
 * Full tunnel: only the tunnel, the WireGuard server and the local network are allowed.
 * Split tunnel: the tunnel's networks may only be reached through the tunnel; the rest as usual.
 */
export function killSwitchScript({ endpoints, allowedIps, full }) {
  const sh = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
  const ipv4 = allowedIps.filter((c) => !c.includes(':'));
  const lines = [
    '#!/bin/bash',
    '# Generated by Stackmoor – do not edit, changes are overwritten.',
    'set -e',
    'iptables -F OUTPUT',
    'iptables -A OUTPUT -o lo -j ACCEPT',
    'iptables -A OUTPUT -o wg0 -j ACCEPT',
    // The local network and Docker's networks (replies to your browser, Caddy, the app's database).
    ...PRIVATE.map((n) => `iptables -A OUTPUT -d ${n} -j ACCEPT`),
    '# The WireGuard server itself',
    'resolve() { getent ahostsv4 "$1" 2>/dev/null | awk \'{print $1; exit}\'; }',
  ];
  for (const ep of endpoints) {
    const e = splitEndpoint(ep);
    if (!e || e.host.includes(':')) continue; // IPv6 endpoints are not supported (IPv6 is off)
    lines.push(`ip=$(resolve ${sh(e.host)}); [ -n "$ip" ] || ip=${sh(e.host)}`);
    lines.push(`iptables -A OUTPUT -p udp -d "$ip" --dport ${e.port} -j ACCEPT`);
  }
  if (full) {
    lines.push('# Full tunnel: everything else only through wg0', 'iptables -A OUTPUT -j REJECT');
  } else {
    lines.push('# Split tunnel: these networks only through wg0');
    for (const c of ipv4) lines.push(`iptables -A OUTPUT -d ${sh(c)} -j REJECT`);
  }
  // IPv6: only through the tunnel (if the config has IPv6), never directly.
  lines.push(
    'ip6tables -F OUTPUT 2>/dev/null || true',
    'ip6tables -A OUTPUT -o lo -j ACCEPT 2>/dev/null || true',
    'ip6tables -A OUTPUT -o wg0 -j ACCEPT 2>/dev/null || true',
    'ip6tables -P OUTPUT DROP 2>/dev/null || true',
  );
  return `${lines.join('\n')}\n`;
}

const isPrivateNet = (cidr) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(cidr);

/**
 * Routes set after the tunnel is up. With AllowedIPs = 0.0.0.0/0 wg-quick sends everything
 * that is not directly attached into the tunnel – including your home network. Private
 * networks therefore go the normal way (your LAN, e.g. a server at 192.168.x.x, and replies
 * to browsers using IP:port), except private networks listed in AllowedIPs: those stay in
 * the tunnel (e.g. the tunnel's own network or a private network behind it).
 */
export function routesScript({ allowedIps }) {
  const inTunnel = allowedIps.filter((c) => !c.includes(':') && isPrivateNet(c));
  return `${[
    '#!/bin/bash',
    '# Generated by Stackmoor – do not edit, changes are overwritten.',
    "gw=$(ip -4 route show table main default | awk '{print $3; exit}')",
    "dev=$(ip -4 route show table main default | awk '{print $5; exit}')",
    '[ -n "$gw" ] || exit 0',
    '# The local network the normal way',
    ...PRIVATE.map((n) => `ip -4 route replace ${n} via "$gw" dev "$dev"`),
    ...(inTunnel.length ? ['# Private networks that belong to the tunnel', ...inTunnel.map((n) => `ip -4 route replace '${n}' dev wg0`)] : []),
  ].join('\n')}\n`;
}

/** Published ports of the services that moved into a tunnel, for the tunnel container. */
export function tunnelPorts(rawConfigs) {
  const out = new Set();
  for (const { cfg, services } of rawConfigs) {
    for (const svc of services) {
      for (const p of cfg.services?.[svc]?.ports || []) {
        if (!p.published) continue;
        const host = p.host_ip ? `${p.host_ip}:` : '';
        out.add(`${host}${p.published}:${p.target}/${p.protocol || 'tcp'}`);
      }
    }
  }
  return [...out].sort();
}

export function createVpn({ db, stacks, stacksDir, domains }) {
  const baseDir = path.join(stacksDir, '.stackmoor', 'vpn');
  const image = process.env.STACKMOOR_VPN_IMAGE || vpnImageFor();
  const container = (name) => `${PREFIX}${name}`;
  const hooks = {}; // onState(name, 'up' | 'down') – for notifications
  const dirOf = (name) => path.join(baseDir, name);

  const writeFile = (file, content, mode = 0o644) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, content, { mode });
    fs.renameSync(tmp, file);
  };

  // ---------- stored data ----------

  const tunnels = () => getState(db, 'vpn.tunnels', []);
  const saveTunnels = (list) => setState(db, 'vpn.tunnels', list);
  /** { [stack]: { tunnel, services: [] } } */
  const attachments = () => getState(db, 'vpn.attach', {});
  const saveAttachments = (a) => setState(db, 'vpn.attach', a);

  function tunnelInfo(t) {
    const p = parseConf(decrypt(t.conf));
    return { name: t.name, address: p.address, endpoints: p.endpoints, allowedIps: p.allowedIps, full: p.full };
  }

  /** Which services of a stack go through which tunnel (used by the domains override). */
  function servicesFor(stack) {
    const a = attachments()[stack];
    return a ? a.services.map((service) => ({ service, tunnel: a.tunnel, container: container(a.tunnel) })) : [];
  }
  const stacksOf = (name) => Object.entries(attachments()).filter(([, a]) => a.tunnel === name).map(([stack, a]) => ({ stack, services: a.services }));

  // ---------- tunnel container ----------

  async function rawConfigsFor(name) {
    const out = [];
    for (const { stack, services } of stacksOf(name)) {
      try { out.push({ stack, services, cfg: await stacks.config(stack, { raw: true }) }); } catch { /* broken stack */ }
    }
    return out;
  }

  async function writeFiles(name) {
    const t = tunnels().find((x) => x.name === name);
    if (!t) throw new UserError('vpn.notFound', { name });
    const p = parseConf(decrypt(t.conf));
    const dir = dirOf(name);
    writeFile(path.join(dir, 'wg0.conf'), p.conf, 0o600);
    writeFile(path.join(dir, 'killswitch.sh'), killSwitchScript(p), 0o700);
    writeFile(path.join(dir, 'routes.sh'), routesScript(p), 0o700);
    const raw = await rawConfigsFor(name);
    const ports = tunnelPorts(raw);
    const doc = {
      name: container(name),
      services: {
        vpn: {
          image,
          container_name: container(name),
          restart: 'unless-stopped',
          cap_add: ['NET_ADMIN'],
          // IPv6 is blocked by the kill switch (ip6tables) – a sysctl here would fail on hosts without IPv6.
          sysctls: { 'net.ipv4.conf.all.src_valid_mark': 1 },
          volumes: [
            './wg0.conf:/etc/wireguard/wg0.conf:ro',
            './killswitch.sh:/etc/wireguard/killswitch.sh:ro',
            './routes.sh:/etc/wireguard/routes.sh:ro',
          ],
          ...(ports.length ? { ports } : {}),
          networks: [NETWORK],
          labels: { 'stackmoor.vpn': name },
        },
      },
      networks: { [NETWORK]: { external: true, name: NETWORK } },
    };
    writeFile(path.join(dir, 'compose.yaml'), `# Generated by Stackmoor – do not edit, changes are overwritten.\n${stringify(doc)}`);
    return raw;
  }

  const composeArgs = (name) => ['compose', '--ansi', 'never', '--progress', 'plain', '-p', container(name),
    '--project-directory', dirOf(name), '-f', path.join(dirOf(name), 'compose.yaml')];

  async function ensureNetwork() {
    if ((await docker(['network', 'inspect', NETWORK])).code !== 0) await docker(['network', 'create', NETWORK]);
  }

  /** The tunnel joins the networks of the services it carries, so they still reach e.g. their database. */
  async function joinStackNetworks(name, raw, log = () => {}) {
    for (const { cfg, services } of raw) {
      for (const svc of services) {
        for (const key of Object.keys(cfg.services?.[svc]?.networks || { default: null })) {
          const net = cfg.networks?.[key]?.name || `${cfg.name}_${key}`;
          const r = await docker(['network', 'connect', net, container(name)]);
          if (r.code === 0) log(`$ docker network connect ${net} ${container(name)}\n`);
        }
      }
    }
  }

  async function startedAt(name) {
    const r = await docker(['inspect', '--format', '{{.State.StartedAt}}', container(name)]);
    return r.code === 0 ? r.stdout.trim() : null;
  }

  /** (Re)creates the tunnel container when its config changed, then fixes up the apps that use it. */
  async function up(name, log = () => {}, t = (k) => k) {
    const raw = await writeFiles(name);
    await ensureNetwork();
    if ((await docker(['image', 'inspect', image])).code !== 0) {
      log(`$ docker pull ${image}\n`);
      await docker(['pull', image], { onData: log });
    }
    log(`$ docker compose -p ${container(name)} up -d\n`);
    const r = await docker([...composeArgs(name), 'up', '-d', '--remove-orphans'], { onData: log });
    if (r.code !== 0) throw new UserError('step.exitCode', { code: r.code });
    await joinStackNetworks(name, raw, log);
    await reattach(name, log, t);
  }

  /**
   * Apps that share a tunnel's network lose it when the tunnel container restarts.
   * Recreate them whenever the tunnel started anew since we last looked.
   */
  async function reattach(name, log = () => {}, _t, { force = false } = {}) {
    const now = await startedAt(name);
    if (!now) return;
    const seen = getState(db, 'vpn.started', {});
    if (!force && seen[name] === now) return;
    for (const { stack, services } of stacksOf(name)) {
      if (!stacks.exists(stack) || stacks.isBusy(stack)) continue;
      const ps = await stacks.compose(stack, ['ps', '-q', ...services]);
      if (!ps.stdout?.trim()) continue; // not running – it joins when the stack starts
      await stacks.compose(stack, ['up', '-d', '--no-deps', '--force-recreate', ...services], log);
    }
    setState(db, 'vpn.started', { ...getState(db, 'vpn.started', {}), [name]: now });
  }

  async function down(name) {
    if (fs.existsSync(path.join(dirOf(name), 'compose.yaml'))) await docker([...composeArgs(name), 'down']);
  }

  // ---------- status ----------

  const status = new Map(); // name → { state, handshake, checkedAt }

  async function check(name) {
    const ps = await docker(['inspect', '--format', '{{.State.Status}}', container(name)]);
    const running = ps.code === 0 && ps.stdout.trim() === 'running';
    let handshake = null;
    if (running) {
      const r = await docker(['exec', container(name), 'wg', 'show', 'wg0', 'latest-handshakes']);
      const ts = r.stdout?.split('\n').map((l) => Number(l.split('\t')[1])).filter((n) => n > 0);
      if (ts?.length) handshake = new Date(Math.max(...ts) * 1000).toISOString();
    }
    const fresh = handshake && Date.now() - Date.parse(handshake) < 180e3;
    const prev = status.get(name);
    const now = new Date().toISOString();
    let state = !running ? 'down' : fresh ? 'up' : 'connecting';
    // No handshake for 2 minutes after (re)starting or losing it means: not working.
    const since = state === 'connecting' ? (prev?.state === 'connecting' ? prev.since : now) : now;
    if (state === 'connecting' && Date.now() - Date.parse(since) > 120e3) state = 'down';
    if (state === 'connecting' && prev?.state === 'down') state = 'down'; // stays down until a handshake
    const s = { state, handshake, checkedAt: now, since: state === 'down' && prev?.state === 'down' ? prev.since : since };
    status.set(name, s);
    // Only real changes: up → down and down → up (not the first look, not "connecting").
    if (prev && prev.state !== state && (state === 'down' || (state === 'up' && prev.state === 'down'))) {
      try { hooks.onState?.(name, state); } catch { /* a listener must not break the check */ }
    }
    return s;
  }

  async function checkAll() {
    for (const tn of tunnels()) {
      try {
        await check(tn.name);
        await reattach(tn.name);
      } catch { /* docker not reachable – try again later */ }
    }
  }

  function startMonitor() {
    setTimeout(() => checkAll(), 5_000).unref();
    setInterval(() => checkAll(), 30_000).unref();
  }

  /** For the stack list: is the tunnel a stack depends on working? */
  function stackState(stack) {
    const a = attachments()[stack];
    if (!a) return null;
    const s = status.get(a.tunnel);
    return { tunnel: a.tunnel, services: a.services, ok: s ? s.state !== 'down' : true, state: s?.state || 'unknown' };
  }

  // ---------- API ----------

  function list() {
    return tunnels().map((tn) => {
      let info = { name: tn.name };
      try { info = tunnelInfo(tn); } catch { /* unreadable – show the name only */ }
      return { ...info, createdAt: tn.createdAt, status: status.get(tn.name) || null, stacks: stacksOf(tn.name) };
    });
  }

  async function add({ name, conf }, log, t) {
    name = String(name || '').trim().toLowerCase();
    if (!NAME_RE.test(name)) throw new UserError('vpn.badName');
    if (tunnels().some((x) => x.name === name)) throw new UserError('vpn.exists', { name });
    const parsed = parseConf(conf);
    saveTunnels([...tunnels(), { name, conf: encrypt(parsed.conf), createdAt: new Date().toISOString() }]);
    try {
      await up(name, log, t);
    } catch (err) {
      log(`\n${t('vpn.log.startFailed')}\n`);
      throw err;
    }
    log(`${t('vpn.log.started', { name })}\n`);
  }

  async function replaceConf(name, conf, log, t) {
    const parsed = parseConf(conf);
    const list = tunnels();
    const tn = list.find((x) => x.name === name);
    if (!tn) throw new UserError('vpn.notFound', { name });
    tn.conf = encrypt(parsed.conf);
    saveTunnels(list);
    await up(name, log, t);
  }

  async function remove(name) {
    if (stacksOf(name).length) throw new UserError('vpn.inUse', { name, stacks: stacksOf(name).map((s) => s.stack).join(', ') });
    await down(name);
    fs.rmSync(dirOf(name), { recursive: true, force: true });
    saveTunnels(tunnels().filter((x) => x.name !== name));
    status.delete(name);
  }

  async function restart(name, log, t) {
    if (!tunnels().some((x) => x.name === name)) throw new UserError('vpn.notFound', { name });
    log(`$ docker restart ${container(name)}\n`);
    await docker(['restart', container(name)], { onData: log });
    await reattach(name, log, t, { force: true });
    await joinStackNetworks(name, await rawConfigsFor(name), log);
  }

  /** Stack → VPN: which services go through which tunnel (null = none). Applies it right away. */
  async function setStack(stack, { tunnel, services }, log, t) {
    stacks.assertName(stack);
    const cfg = await stacks.config(stack, { raw: true });
    const all = Object.keys(cfg.services || {});
    const chosen = [...new Set((services || []).map(String))].filter((s) => all.includes(s));
    const map = attachments();
    const before = map[stack]?.tunnel || null;
    const changed = [...new Set([...(map[stack]?.services || []), ...chosen])];
    if (tunnel && chosen.length) {
      if (!tunnels().some((x) => x.name === tunnel)) throw new UserError('vpn.notFound', { name: tunnel });
      for (const svc of chosen) {
        const nm = cfg.services[svc].network_mode;
        if (nm && !String(nm).startsWith(`container:${PREFIX}`)) throw new UserError('vpn.hostNetwork', { service: svc });
      }
      map[stack] = { tunnel, services: chosen };
    } else {
      delete map[stack];
    }
    saveAttachments(map);
    await domains.writeOverride(stack);
    // The services that change sides give up their ports first (they move to/from the tunnel).
    const running = stacks.exists(stack) && (await stacks.compose(stack, ['ps', '-q'])).stdout?.trim();
    if (running && changed.length) await stacks.compose(stack, ['rm', '-s', '-f', ...changed], log);
    for (const name of new Set([before, map[stack]?.tunnel].filter(Boolean))) await up(name, log, t);
    if (stacks.exists(stack)) {
      if (running) {
        const r = await stacks.compose(stack, ['up', '-d', '--remove-orphans'], log);
        if (r.code !== 0) throw new UserError('step.exitCode', { code: r.code });
        if (map[stack]) await joinStackNetworks(map[stack].tunnel, await rawConfigsFor(map[stack].tunnel), log);
      }
    }
    await domains.reloadConfig().catch(() => {});
    return stackState(stack);
  }

  /** Stack hooks: the tunnel must run before the app starts, and join the stack's networks after. */
  async function beforeUp(stack, log, t) {
    const a = attachments()[stack];
    if (!a) return;
    const ps = await docker(['inspect', '--format', '{{.State.Status}}', container(a.tunnel)]);
    if (ps.code !== 0 || ps.stdout.trim() !== 'running') {
      log(`${t('vpn.log.startingTunnel', { name: a.tunnel })}\n`);
      await up(a.tunnel, log, t);
    } else {
      await writeFiles(a.tunnel); // ports may have changed with the stack
      const r = await docker([...composeArgs(a.tunnel), 'up', '-d'], { onData: log });
      if (r.code !== 0) throw new UserError('step.exitCode', { code: r.code });
    }
  }
  async function afterUp(stack, log) {
    const a = attachments()[stack];
    if (a) await joinStackNetworks(a.tunnel, await rawConfigsFor(a.tunnel), log);
  }

  /** When a stack is deleted. */
  async function forgetStack(stack) {
    const map = attachments();
    const a = map[stack];
    if (!a) return;
    delete map[stack];
    saveAttachments(map);
    await up(a.tunnel).catch(() => {});
  }

  /**
   * On start (e.g. after a panel update): rewrite each tunnel's files and let Compose
   * recreate the container only if something changed (new image, new mounts or ports).
   */
  async function syncImages() {
    for (const tn of tunnels()) await up(tn.name).catch(() => {});
  }

  /** After restoring a whole server: start every tunnel. */
  async function startAll(log = () => {}, t = (k) => k) {
    for (const tn of tunnels()) await up(tn.name, log, t).catch((err) => log(`${err.message}\n`));
  }

  return {
    syncImages, startAll,
    list, add, replaceConf, remove, restart, setStack, servicesFor, stackState, beforeUp, afterUp, forgetStack,
    startMonitor, checkAll, check, attachments, image, hooks,
  };
}
