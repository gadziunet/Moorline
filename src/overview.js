// One cheap summary for the dashboard and the status bar: no restic or registry calls,
// only what the panel already knows (saved snapshot list, histories, tunnel states).

const sqlTime = (s) => (s && !s.includes('T') ? `${s.replace(' ', 'T')}Z` : s);

/**
 * @param {object} p
 * @param {string} p.domain             the local domain ('' when off)
 * @param {Array}  p.routes             all routes: { stack, subdomain }
 * @param {Array}  p.snapshots          saved snapshot list (newest first)
 * @param {boolean} p.backupsConfigured
 * @param {Array}  p.backupHistory      backup job history (newest first)
 * @param {object|null} p.backupRunning the running backup job
 * @param {Array}  p.operations         latest stack operations (newest first)
 * @param {Array}  p.tunnels            vpn.list()
 * @param {object} p.domainStatus       domains.status() (may be cached)
 * @param {Array}  p.proxies            proxies.list()
 * @param {Array}  p.proxyEvents        proxy state changes (newest first)
 * @param {string} p.serverIp           this server's address in the local network ('' when unknown)
 */
export function buildOverview(p) {
  const addresses = {};
  for (const r of p.routes || []) {
    if (p.domain && !addresses[r.stack]) addresses[r.stack] = `${r.subdomain}.${p.domain}`;
  }

  const lastBackup = {};
  for (const s of p.snapshots || []) {
    if (s.stack && !lastBackup[s.stack]) lastBackup[s.stack] = { at: s.time, size: s.size };
  }

  // The newest finished backup job, and the size of everything it saved.
  const last = (p.backupHistory || []).find((h) => !['restore', 'restore-server', 'verify'].includes(h.kind));
  let lastSize = null;
  const newestRun = (p.snapshots || []).find((s) => s.run)?.run;
  if (newestRun) lastSize = p.snapshots.filter((s) => s.run === newestRun).reduce((n, s) => n + (s.size || 0), 0);

  const events = [
    ...(p.backupHistory || []).slice(0, 8).map((h) => ({
      at: h.at, type: 'backup', kind: h.kind, stack: h.stack || null, ok: h.ok, stacks: h.stacks ?? null,
    })),
    ...(p.operations || []).slice(0, 8).map((o) => ({
      at: sqlTime(o.started_at), type: 'action', action: o.action, stack: o.stack, ok: o.status === 'ok', status: o.status,
    })),
    ...(p.proxyEvents || []).slice(0, 8).map((e) => ({ at: e.at, type: 'proxy', name: e.name, ok: e.ok })),
  ].filter((e) => e.at).sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 6);

  const ds = p.domainStatus || { enabled: false };
  return {
    domain: ds.enabled
      ? { enabled: true, domain: ds.domain, running: ds.running, certificate: ds.certificate, panelUrl: ds.panelUrl || null }
      : { enabled: false },
    addresses,
    serverIp: p.serverIp || null,
    backup: {
      configured: Boolean(p.backupsConfigured),
      running: Boolean(p.backupRunning),
      last: last ? { at: last.at, ok: last.ok, kind: last.kind } : null,
      lastSize,
      perStack: lastBackup,
    },
    vpn: (p.tunnels || []).map((x) => ({ name: x.name, state: x.status?.state || 'unknown', stacks: (x.stacks || []).length })),
    proxies: (p.proxies || []).map((x) => ({
      id: x.id, name: x.name, address: p.domain ? `${x.subdomain}.${p.domain}` : null, target: x.target, monitor: x.monitor,
      ok: x.status ? x.status.ok : null, ms: x.status?.ms ?? null, since: x.status?.since || null,
    })),
    events,
  };
}
