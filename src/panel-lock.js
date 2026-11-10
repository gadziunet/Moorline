// "Panel only through its domain": with the lock on, only Caddy may reach
// the panel, and opening it by IP redirects to https://<panel>.<domain>.
// Emergency switch: STACKMOOR_ALLOW_IP=1, or `docker exec stackmoor node src/cli.js unlock`.

const normalizeIp = (ip = '') => ip.replace(/^::ffff:/, '');

export function createPanelLock({ getSettings, domains, env = process.env }) {
  function lockedHost() {
    if (env.STACKMOOR_ALLOW_IP === '1') return null;
    const s = getSettings();
    return s.panelDomainOnly && s.domain && s.panelSubdomain ? `${s.panelSubdomain}.${s.domain}` : null;
  }

  function middleware(req, res, next) {
    const host = lockedHost();
    if (!host) return next();
    const remote = normalizeIp(req.socket?.remoteAddress);
    // When the panel runs on Caddy's network we know Caddy's address; otherwise (dev runs,
    // panel outside Docker) the Host header is all there is to check.
    const caddy = domains.caddyIp();
    const viaCaddy = caddy ? remote === caddy : req.hostname === host;
    if (viaCaddy || remote === '127.0.0.1' || remote === '::1') return next();
    // Health checks (install.sh, monitoring) may still ask whether the panel is up.
    if (req.method === 'GET' && req.path === '/api/state') return next();
    // A server restore may switch the lock on halfway; its progress (code or login needed) stays readable.
    if (req.method === 'GET' && req.path === '/api/setup/restore/status') return next();
    const url = domains.panelUrl();
    if (req.path.startsWith('/api/')) {
      return res.status(421).json({ error: req.t('dns.useDomain', { url }), redirect: url });
    }
    res.redirect(302, url + req.originalUrl);
  }

  return { lockedHost, middleware };
}
