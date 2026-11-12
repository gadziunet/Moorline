// "Panel only through its domain": with the lock on, only Caddy may reach
// the panel, and opening it by IP redirects to https://<panel>.<domain>.
// Emergency switch: STACKMOOR_ALLOW_IP=1, or `docker exec stackmoor node src/cli.js unlock`.

import { isInContainer } from './mounts.js';

const normalizeIp = (ip = '') => ip.replace(/^::ffff:/, '');

export function createPanelLock({ getSettings, domains, env = process.env, inContainer = isInContainer() }) {
  // Caddy may have just started or got a new address: ask Docker again (at most every 5 s)
  // instead of waiting for the next minute's refresh.
  let lastNudge = 0;
  const nudge = () => {
    if (!domains.refreshCaddyIp || Date.now() - lastNudge < 5000) return;
    lastNudge = Date.now();
    domains.refreshCaddyIp().catch(() => {});
  };

  function lockedHost() {
    if (env.STACKMOOR_ALLOW_IP === '1') return null;
    const s = getSettings();
    return s.panelDomainOnly && s.domain && s.panelSubdomain ? `${s.panelSubdomain}.${s.domain}` : null;
  }

  function middleware(req, res, next) {
    const host = lockedHost();
    if (!host) return next();
    const remote = normalizeIp(req.socket?.remoteAddress);
    if (remote === '127.0.0.1' || remote === '::1') return next();
    // Health checks (install.sh, monitoring) may still ask whether the panel is up.
    if (req.method === 'GET' && req.path === '/api/state') return next();
    // A server restore may switch the lock on halfway; its progress (code or login needed) stays readable.
    if (req.method === 'GET' && req.path === '/api/setup/restore/status') return next();
    // In a container only Caddy's own address counts. While it is unknown (Caddy starting,
    // stopped or being replaced) nobody gets in – a Host header is easy to fake.
    // Outside Docker (development) Caddy reaches the panel through the host: only Host is left.
    const caddy = domains.caddyIp();
    const fromCaddy = domains.isCaddy ? domains.isCaddy(remote) : remote === caddy;
    if (caddy && fromCaddy) return next();
    if (!caddy && inContainer) {
      nudge();
      res.setHeader('Retry-After', '5');
      if (req.path.startsWith('/api/')) return res.status(503).json({ error: req.t('dns.panelStarting') });
      return res.status(503).type('html').send(startingPage(req.t('dns.panelStarting')));
    }
    if (!caddy && req.hostname === host) return next();
    if (caddy) nudge(); // a stale address would send even Caddy's requests round in redirects
    const url = domains.panelUrl();
    if (req.path.startsWith('/api/')) {
      return res.status(421).json({ error: req.t('dns.useDomain', { url }), redirect: url });
    }
    res.redirect(302, url + req.originalUrl);
  }

  return { lockedHost, middleware };
}

/** A minimal page that tries again by itself (no scripts: the panel's CSP allows none inline). */
function startingPage(text) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="5">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark">
<title>Stackmoor</title></head><body style="font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;margin:0">
<p style="max-width:28rem;text-align:center;padding:1rem">${esc(text)}</p></body></html>`;
}
