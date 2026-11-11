import { isPrivateIPv4 } from './dns-records.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { openDb, getSettings, saveSettings, getState, setState } from './db.js';
import {
  hashPassword, verifyPassword, verifyNobody, validatePassword, createSession, destroySession,
  sessionMiddleware, requireAuth, requireAppHeader, loginRateLimit,
} from './auth.js';
import { createStacks } from './stacks.js';
import { UserError } from './errors.js';
import { i18nMiddleware, translateAll, translate } from './i18n.js';
import { stacksDirMounted } from './mounts.js';
import { createUpdates } from './updates.js';
import { VERSION } from './version.js';
import { initSecrets } from './secrets.js';
import { createDomains } from './domains.js';
import { createPanelLock } from './panel-lock.js';
import { createBackups } from './backups.js';
import { createVpn } from './vpn.js';
import { buildOverview } from './overview.js';
import { createProxies, checkTarget, cleanProxy, targetUrl } from './proxies.js';
import { createAutoUpdate } from './autoupdate.js';
import { createSystem } from './system.js';
import { createNotifier, createStackWatch, telegramChats, EVENTS, TYPES } from './notify.js';
import { createPangolin } from './pangolin.js';
import { createSetupToken } from './setup-token.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const config = {
  port: Number(process.env.PORT || 5001),
  host: process.env.HOST || '0.0.0.0',
  dataDir: path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data')),
  stacksDir: path.resolve(process.env.STACKS_DIR || '/opt/stacks'),
};

fs.mkdirSync(config.dataDir, { recursive: true });
fs.mkdirSync(config.stacksDir, { recursive: true });

const db = openDb(path.join(config.dataDir, 'panel.db'));
initSecrets(config.dataDir);
const stacksDirOk = stacksDirMounted(config.stacksDir);
if (!stacksDirOk) {
  console.warn(`WARNING: ${config.stacksDir} is not mounted from the host – mount it at the same path and set STACKS_DIR.`);
}
const stacks = createStacks({ db, stacksDir: config.stacksDir, getSettings: () => getSettings(db) });
const updates = createUpdates({ db, stacks, getSettings: () => getSettings(db), onChecked: (st) => notifyUpdates(st) });
updates.afterStart();
updates.startScheduler();
// Language for things that run on their own (scheduled backups): the one the admin last used.
let lastLang = getState(db, 'ui.lang', 'en');
const notifier = createNotifier({ db, getT: () => (key, vars) => translate(lastLang, key, vars) });
const notify = notifier.emit;
const backups = createBackups({ db, stacks, stacksDir: config.stacksDir, dataDir: config.dataDir, sqlite: db });
backups.startScheduler(() => (key, vars) => translate(lastLang, key, vars));
const domains = createDomains({
  db, stacks, stacksDir: config.stacksDir,
  getSettings: () => getSettings(db),
  saveSettings: (patch) => saveSettings(db, patch),
});
const vpn = createVpn({ db, stacks, stacksDir: config.stacksDir, domains });
domains.vpn.servicesFor = vpn.servicesFor;
stacks.hooks.beforeUp = vpn.beforeUp;
stacks.hooks.afterUp = vpn.afterUp;
vpn.syncImages().catch(() => {}).finally(() => vpn.startMonitor());
const pangolin = createPangolin({ db, stacksDir: config.stacksDir, stacks, domains });
domains.pangolin.servicesFor = pangolin.servicesFor;
setTimeout(() => pangolin.startAll().catch(() => {}), 10e3).unref();
const proxies = createProxies({
  db, getSettings: () => getSettings(db), reloadConfig: () => domains.reloadConfig(),
  onChange: (p, r) => notify('proxy', { name: p.name, target: targetUrl(p), error: r.error || '' },
    { variant: r.ok ? 'up' : 'down', level: r.ok ? 'ok' : 'warn', subject: p.name }),
});
proxies.startMonitor();
const getT = () => (key, vars) => translate(lastLang, key, vars);
const settingsApi = { getSettings: () => getSettings(db), saveSettings: (patch) => saveSettings(db, patch) };
const autoUpdate = createAutoUpdate({
  db, stacks, updates, backups, ...settingsApi, getT, isRebooting: () => system.isRebooting(),
  onResult: (r) => (r.result === 'updated'
    ? notify('autoUpdated', { stack: r.stack, images: (r.images || []).join(', ') }, { level: 'ok', subject: r.stack })
    : notify('autoProblem', { stack: r.stack, reason: r.reason || '' }, { variant: r.result, level: 'error', subject: r.stack })),
});
autoUpdate.startScheduler();
const system = createSystem({
  db, stacks, updates, backups, autoUpdate, ...settingsApi, getT,
  onBooted: ({ started }) => notify('booted', { count: started.length, stacks: started.join(', ') || '—' }),
  onRebootRequired: ({ packages }) => notify('rebootRequired', { packages: packages.join(', ') || '—' }, { level: 'warn' }),
});
// Notifications for things that happen on their own.
backups.hooks.afterJob = (e) => {
  if (String(e.kind).startsWith('restore')) return; // restores run while the user watches
  if (!e.ok) {
    const error = e.error || (Array.isArray(e.failed) ? e.failed.join(', ') : '');
    notify('backupFailed', { stack: e.stack || '', error }, { variant: e.kind === 'verify' ? 'verify' : e.stack ? 'stack' : 'all', level: 'error', subject: `${e.kind}.${e.stack}` });
  } else if (e.kind === 'scheduled') {
    notify('backupOk', { count: Array.isArray(e.stacks) ? e.stacks.length : e.stacks ?? '' }, { level: 'ok' });
  }
};
vpn.hooks.onState = (name, state) => notify('vpn', { name }, { variant: state, level: state === 'down' ? 'error' : 'ok', subject: name });
createStackWatch({ stacks, emit: notify, isQuiet: () => system.isRebooting() || autoUpdate.busy() }).start();

/** After an update check: a new panel version, or stacks that got new images. Each only once. */
function notifyUpdates(st) {
  const p = st.panel;
  if (p?.updateAvailable && p.latest && getState(db, 'notify.panelSeen') !== p.latest) {
    setState(db, 'notify.panelSeen', p.latest);
    notify('panelUpdate', { version: p.latest }, { subject: p.latest });
  }
  const seen = getState(db, 'notify.stacksSeen', []);
  const fresh = (st.stacksWithUpdates || []).filter((n) => !seen.includes(n));
  setState(db, 'notify.stacksSeen', st.stacksWithUpdates || []);
  if (fresh.length) notify('stackUpdates', { stacks: fresh.join(', ') }, { subject: fresh.join(',') });
}
system.startMonitor();

// Changes with every start – the page uses it to notice that the panel restarted.
const BOOT_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const app = express();
app.disable('x-powered-by');
// X-Forwarded-For / -Proto only from Caddy (and this machine). From anyone else they are ignored,
// so a client cannot pick its own address (login limit) or claim https.
const plainIp = (ip) => String(ip || '').replace(/^::ffff:/, '');
app.set('trust proxy', (addr) => {
  const ip = plainIp(addr);
  return ip === '127.0.0.1' || ip === '::1' || (Boolean(domains.caddyIp()) && ip === domains.caddyIp());
});
// Security headers for every answer: no framing (clickjacking), no MIME sniffing, scripts and
// styles only from the panel itself. HSTS only when the page was opened over https.
const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data:",
  "connect-src 'self' https:", "font-src 'self'", "object-src 'none'", "base-uri 'self'",
  "form-action 'self'", "frame-ancestors 'none'",
].join('; ');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', CSP);
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  next();
});
app.use(express.json({ limit: '1mb' }));
app.use(i18nMiddleware);

// ---------- panel only through its domain ----------
domains.attachSelf().catch(() => {})
  // Learn Caddy's address right away: the domain lock and the trusted proxy depend on it.
  .then(() => domains.refreshCaddyIp()).catch(() => {})
  .then(() => domains.syncServerIp((key, vars) => translate(lastLang, key, vars))).catch(() => {})
  .then(() => domains.syncImage()).catch(() => {})
  // A new panel version may build Caddy's config differently (e.g. proxy redirects): rewrite it.
  .then(() => (getSettings(db).domain ? domains.reloadConfig() : null)).catch(() => {})
  .then(() => domains.refreshCaddyIp()).catch(() => {});
// Caddy follows the panel version; retry now and then in case its image was published later.
setInterval(() => { domains.syncImage().catch(() => {}); }, 6 * 3600_000).unref();
// After restoring a whole server: start Caddy with the restored domain settings.
backups.hooks.afterServerRestore = async (log, t) => {
  await vpn.startAll(log, t);
  if (!getSettings(db).domain) return;
  await domains.attachSelf().catch(() => {});
  await domains.apply(log, t);
};
const panelLock = createPanelLock({ getSettings: () => getSettings(db), domains });
// Caddy's address matters whenever there is a domain: the lock and the trusted proxy both use it.
setInterval(() => { if (getSettings(db).domain) domains.refreshCaddyIp().catch(() => {}); }, 60_000).unref();
app.use(panelLock.middleware);

app.use(sessionMiddleware(db));
app.use('/api', requireAppHeader);

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const hasUsers = () => db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0;

// Only while there is no account yet, and not while a server restore is running.
const restoreRunning = () => Boolean(backups.serverRestoreStatus() && !backups.serverRestoreStatus().done);
function setupOnly(req, res, next) {
  if (hasUsers()) return fail(req, res, 409, 'setup.exists');
  if (restoreRunning()) return fail(req, res, 409, 'backup.busy');
  next();
}

// One-time setup code: needed to create the account or restore a server while there is none.
const setupToken = createSetupToken({ dataDir: config.dataDir, hasUsers });
{
  const code = setupToken.ensure();
  if (code) console.log(`Setup code: ${code}  (the panel asks for it when you create the account)`);
}
const requireSetupCode = (req, res, next) => (setupToken.check(req.get('X-Setup-Code'))
  ? next()
  : fail(req, res, 403, 'setup.badCode'));
const fail = (req, res, status, key, vars) => res.status(status).json({ error: req.t(key, vars) });

const translateResult = (req, r) => ({
  ...r,
  changes: translateAll(req.t, r.changes),
  warnings: translateAll(req.t, r.warnings),
});

// Plain-text stream (live docker compose output).
function openStream(res) {
  res.status(200);
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  return (s) => { if (!res.writableEnded) res.write(s); };
}

function abortOnClose(res) {
  const ctl = new AbortController();
  res.on('close', () => { if (!res.writableFinished) ctl.abort(); });
  return ctl.signal;
}

const errorText = (req, err) => (err instanceof UserError ? req.t(err.key, err.vars) : err.message);

// ---------- account ----------

app.get('/api/state', (req, res) => {
  res.json({
    needsSetup: !hasUsers(),
    restoring: Boolean(backups.serverRestoreStatus() && !backups.serverRestoreStatus().done),
    user: req.user ? { username: req.user.username } : null,
    version: VERSION,
    bootId: BOOT_ID,
    ...(req.user ? { updating: updates.applying() } : {}),
    ...(req.user ? { stacksDir: config.stacksDir, stacksDirOk: stacksDirOk } : {}),
  });
});

app.post('/api/setup', loginRateLimit, setupOnly, requireSetupCode, wrap(async (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = req.body.password;
  if (!/^[a-zA-Z0-9._-]{3,32}$/.test(username)) return fail(req, res, 400, 'setup.badUsername');
  const pwErr = validatePassword(password);
  if (pwErr) return fail(req, res, 400, pwErr);
  const hash = await hashPassword(password);
  // Checked again after the (asynchronous) hashing: two requests at once must not make two accounts.
  if (hasUsers()) return fail(req, res, 409, 'setup.exists');
  const r = db.prepare('INSERT INTO users(username, password_hash) VALUES (?, ?)').run(username, hash);
  setupToken.clear();
  createSession(db, r.lastInsertRowid, req, res);
  res.json({ ok: true });
}));

app.post('/api/login', loginRateLimit, wrap(async (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(String(req.body.username || '').trim());
  const password = String(req.body.password || '');
  const ok = user ? await verifyPassword(password, user.password_hash) : await verifyNobody(password);
  if (!ok) return fail(req, res, 401, 'login.invalid');
  // After a server restore the code is no longer needed (kept while the restore still runs).
  if (!restoreRunning()) setupToken.clear();
  createSession(db, user.id, req, res);
  res.json({ ok: true });
}));

app.post('/api/logout', (req, res) => {
  destroySession(db, req, res);
  res.json({ ok: true });
});

// ---------- setup wizard: restore a whole server from a backup ----------
// Open only while the panel has no account yet, and only with the setup code. The restored
// database brings the old account back halfway through, so the status needs the code (or a login).


app.get('/api/setup/restore/options', setupOnly, requireSetupCode, (_req, res) => {
  res.json({ destinations: backups.publicConfig().destinations });
});

app.post('/api/setup/restore/connect', loginRateLimit, setupOnly, requireSetupCode, wrap(async (req, res) => {
  res.json({ runs: await backups.connectExisting(req.body || {}) });
}));

app.post('/api/setup/restore/start', setupOnly, requireSetupCode, wrap(async (req, res) => {
  res.status(202).json(await backups.restoreServer(String(req.body?.run || ''), req.t));
}));

app.get('/api/setup/restore/status', (req, res) => {
  const st = backups.serverRestoreStatus();
  if (!st) return fail(req, res, 404, 'notFound'); // e.g. the panel restarted: nothing to follow
  if (!req.user && !setupToken.check(req.get('X-Setup-Code'))) return fail(req, res, 403, 'setup.badCode');
  // After a good restore: the panel's own address from the restored settings, so the wizard can go there.
  res.json({ ...st, panelUrl: st.done && !st.error ? domains.panelUrl() || null : null });
});

app.use('/api', requireAuth);
app.use('/api', (req, _res, next) => {
  if (req.lang !== lastLang) { lastLang = req.lang; setState(db, 'ui.lang', lastLang); }
  next();
});

app.post('/api/password', wrap(async (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!await verifyPassword(String(req.body.current || ''), user.password_hash)) {
    return fail(req, res, 400, 'password.wrongCurrent');
  }
  const pwErr = validatePassword(req.body.next);
  if (pwErr) return fail(req, res, 400, pwErr);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(req.body.next), user.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
  createSession(db, user.id, req, res);
  res.json({ ok: true });
}));

// ---------- settings ----------

app.get('/api/settings', (_req, res) => res.json({ ...getSettings(db), stacksDir: config.stacksDir }));

app.put('/api/settings', (req, res) => {
  const patch = {};
  for (const key of ['puid', 'pgid']) {
    if (req.body[key] !== undefined) {
      const n = Number(req.body[key]);
      if (!Number.isInteger(n) || n < 0 || n > 65535) return fail(req, res, 400, 'settings.badId', { key: key.toUpperCase() });
      patch[key] = n;
    }
  }
  for (const key of ['updateCheck', 'updateCheckStacks']) {
    if (req.body[key] !== undefined) patch[key] = Boolean(req.body[key]);
  }
  if (req.body.updateInterval !== undefined) {
    patch.updateInterval = req.body.updateInterval === 'weekly' ? 'weekly' : 'daily';
  }
  if (req.body.hostPathAllowlist !== undefined) {
    const list = Array.isArray(req.body.hostPathAllowlist) ? req.body.hostPathAllowlist : [];
    const clean = list.map((p) => String(p).trim()).filter(Boolean);
    const bad = clean.find((p) => !p.startsWith('/') || p === '/');
    if (bad) return fail(req, res, 400, 'settings.badPath', { path: bad });
    patch.hostPathAllowlist = clean;
  }
  res.json(saveSettings(db, patch));
});

// ---------- stacks ----------

app.get('/api/stacks', wrap(async (_req, res) => {
  const withUpdates = new Set(updates.status().stacksWithUpdates);
  res.json((await stacks.list()).map((s) => ({ ...s, updateAvailable: withUpdates.has(s.name), vpn: vpn.stackState(s.name) })));
}));

app.post('/api/stacks', wrap(async (req, res) => {
  const result = await stacks.save(req.body.name, req.body, { create: true });
  res.status(201).json(translateResult(req, result));
}));

app.get('/api/stacks/:name', wrap(async (req, res) => res.json(await stacks.get(req.params.name))));

app.put('/api/stacks/:name', wrap(async (req, res) => {
  res.json(translateResult(req, await stacks.save(req.params.name, req.body)));
}));

app.post('/api/stacks/:name/actions/:action', wrap(async (req, res) => {
  stacks.assertName(req.params.name);
  const signal = abortOnClose(res);
  const write = openStream(res);
  const ok = await stacks.action(req.params.name, req.params.action, write, { signal, t: req.t })
    .catch((err) => { write(req.t('log.error', { message: errorText(req, err) }) + '\n'); return false; });
  // After updating images, refresh this stack's "update available" flag BEFORE the stream ends:
  // the page reloads its stack list as soon as the stream closes and must see the new state.
  if (ok && (req.params.action === 'update' || req.params.action === 'up')) {
    await updates.checkStack(req.params.name).catch(() => {});
  }
  write(`\n__EXIT__:${ok ? 0 : 1}\n`);
  res.end();
}));

// ---------- overview (dashboard and status bar) ----------

// Caddy's status needs docker exec and logs – keep it for a minute.
let domainStatusCache = { at: 0, value: null, domain: null };
async function cachedDomainStatus() {
  const domain = getSettings(db).domain || '';
  if (!domain) return { enabled: false };
  if (domainStatusCache.value && domainStatusCache.domain === domain && Date.now() - domainStatusCache.at < 60_000) {
    return domainStatusCache.value;
  }
  const value = await domains.status().catch(() => ({ enabled: true, domain, running: false, certificate: false }));
  domainStatusCache = { at: Date.now(), value, domain };
  return value;
}

app.get('/api/overview', wrap(async (_req, res) => {
  const b = backups.status();
  res.json(buildOverview({
    domain: getSettings(db).domain || '',
    routes: domains.routes(),
    snapshots: getState(db, 'backup.snapshots')?.list || [],
    backupsConfigured: b.configured,
    backupHistory: b.history,
    backupRunning: b.running,
    operations: stacks.recentOperations(8),
    tunnels: vpn.list(),
    domainStatus: await cachedDomainStatus(),
    proxies: proxies.list(),
    proxyEvents: proxies.events(),
    serverIp: getSettings(db).serverIp || '',
  }));
}));

// ---------- proxies (servers outside Stackmoor) ----------

app.get('/api/proxies', (_req, res) => res.json(proxies.list()));
app.post('/api/proxies', wrap(async (req, res) => res.status(201).json(await proxies.save(req.body || {}))));
app.put('/api/proxies/:id', wrap(async (req, res) => res.json(await proxies.save(req.body || {}, Number(req.params.id)))));
app.delete('/api/proxies/:id', wrap(async (req, res) => {
  await proxies.remove(Number(req.params.id));
  res.json({ ok: true });
}));
// "Check connection" in the form: only the target is needed.
app.post('/api/proxies/check', wrap(async (req, res) => {
  const p = cleanProxy({ name: 'x', subdomain: 'x', ...(req.body || {}) });
  res.json(await checkTarget(p));
}));

// ---------- updates ----------

app.get('/api/updates', wrap(async (_req, res) => {
  await updates.ready();
  res.json({ ...updates.status(), self: await updates.selfInfo().then((s) => ({ mode: s.mode, tag: s.tag })) });
}));

app.post('/api/updates/check', wrap(async (_req, res) => {
  await updates.checkAll();
  res.json({ ...updates.status(), self: await updates.selfInfo().then((s) => ({ mode: s.mode, tag: s.tag })) });
}));

app.post('/api/updates/apply', wrap(async (_req, res) => {
  res.json(await updates.updatePanel());
}));

app.get('/api/stacks/:name/logs', wrap(async (req, res) => {
  stacks.assertName(req.params.name);
  const signal = abortOnClose(res);
  const write = openStream(res);
  await stacks.logs(req.params.name, { tail: req.query.tail, follow: req.query.follow === '1', service: String(req.query.service || '') }, write, signal)
    .catch((err) => write(req.t('log.error', { message: errorText(req, err) }) + '\n'));
  res.end();
}));

app.delete('/api/stacks/:name', wrap(async (req, res) => {
  if (req.body?.confirm !== req.params.name) return fail(req, res, 400, 'delete.confirm');
  const lines = [];
  await stacks.remove(req.params.name, (s) => lines.push(s), req.t);
  await vpn.forgetStack(req.params.name).catch(() => {});
  await pangolin.removeStack(req.params.name).catch(() => {});
  backups.setStackExcludes(req.params.name, []);
  if (domains.routes(req.params.name).length) {
    domains.removeStack(req.params.name);
    if (getSettings(db).domain) await domains.apply(() => {}, req.t).catch(() => {});
  }
  res.json({ ok: true, output: lines.join('') });
}));

// ---------- VPN ----------

const streamJob = (fn) => wrap(async (req, res) => {
  const write = openStream(res);
  let ok = true;
  await fn(req, write).catch((err) => {
    ok = false;
    write(`\n${req.t('log.error', { message: errorText(req, err) })}\n`);
  });
  write(`\n__EXIT__:${ok ? 0 : 1}\n`);
  res.end();
});

app.get('/api/vpn', wrap(async (_req, res) => {
  await vpn.checkAll();
  res.json({ tunnels: vpn.list(), image: vpn.image });
}));
app.post('/api/vpn', streamJob((req, write) => vpn.add(req.body || {}, write, req.t)));
app.put('/api/vpn/:name', streamJob((req, write) => vpn.replaceConf(req.params.name, req.body?.conf, write, req.t)));
app.post('/api/vpn/:name/restart', streamJob((req, write) => vpn.restart(req.params.name, write, req.t)));
app.delete('/api/vpn/:name', wrap(async (req, res) => {
  await vpn.remove(req.params.name);
  res.json({ ok: true });
}));

// ---------- automatic stack updates ----------

app.get('/api/autoupdate', (_req, res) => res.json(autoUpdate.status()));
app.put('/api/autoupdate', (req, res) => {
  autoUpdate.saveConfig(req.body || {});
  res.json(autoUpdate.status());
});
app.post('/api/autoupdate/run', (_req, res) => {
  autoUpdate.runAll('manual').catch((err) => console.error('Automatic update failed:', err.message));
  res.json(autoUpdate.status());
});

// ---------- the server ----------

app.get('/api/system', wrap(async (req, res) => {
  const info = await system.info({ fresh: req.query.fresh === '1' });
  res.json({ ...info, error: info.error ? req.t(info.error) : null });
}));
app.post('/api/system/reboot', wrap(async (_req, res) => res.json(await system.reboot('manual'))));
app.put('/api/system/schedule', (req, res) => res.json(system.saveSchedule(req.body || {})));
app.put('/api/system/auto-reboot', wrap(async (req, res) => res.json(await system.setAutoReboot(req.body || {}))));
app.post('/api/system/patches', streamJob((req, write) => system.setPatches(Boolean(req.body?.enabled), write, req.t)));

// ---------- Pangolin (public addresses) ----------

const pangolinState = async () => {
  const cfg = pangolin.publicConfig();
  const st = cfg.configured ? await pangolin.status() : { configured: false };
  return { config: cfg, status: st, routes: pangolin.routes() };
};
app.get('/api/pangolin', wrap(async (_req, res) => res.json(await pangolinState())));
app.put('/api/pangolin', wrap(async (req, res) => { const r = await pangolin.saveConfig(req.body || {}); res.json({ ...(await pangolinState()), domains: r.domains }); }));
app.post('/api/pangolin/connect', streamJob((req, write) => pangolin.connect(write, req.t)));
app.delete('/api/pangolin', wrap(async (_req, res) => { await pangolin.disconnect(); res.json(await pangolinState()); }));
app.get('/api/pangolin/domains', wrap(async (_req, res) => res.json({ domains: await pangolin.listDomains() })));
app.get('/api/stacks/:name/public', wrap(async (req, res) => {
  stacks.assertName(req.params.name);
  const connected = pangolin.configured();
  const doms = connected ? await pangolin.listDomains().catch(() => null) : null;
  res.json({ connected, routes: pangolin.routes(req.params.name), domains: doms });
}));
app.post('/api/stacks/:name/public', wrap(async (req, res) => res.json(await pangolin.addRoute(req.params.name, req.body || {}))));
app.put('/api/pangolin/routes/:id', wrap(async (req, res) => res.json(await pangolin.setSso(Number(req.params.id), req.body?.sso))));
app.delete('/api/pangolin/routes/:id', wrap(async (req, res) => { await pangolin.removeRoute(Number(req.params.id)); res.json({ ok: true }); }));

// ---------- notifications ----------

const notifyState = () => ({
  channels: notifier.channels(), prefs: notifier.prefs(), history: notifier.history(),
  types: Object.keys(TYPES), events: Object.keys(EVENTS),
});
app.get('/api/notify', (_req, res) => res.json(notifyState()));
app.post('/api/notify/channels', (req, res) => { notifier.saveChannel(req.body || {}); res.json(notifyState()); });
app.put('/api/notify/channels/:id', (req, res) => { notifier.saveChannel(req.body || {}, req.params.id); res.json(notifyState()); });
app.delete('/api/notify/channels/:id', (req, res) => { notifier.removeChannel(req.params.id); res.json(notifyState()); });
app.post('/api/notify/channels/:id/test', wrap(async (req, res) => { await notifier.test(req.params.id, req.t); res.json(notifyState()); }));
app.put('/api/notify/prefs', (req, res) => { notifier.savePrefs(req.body || {}); res.json(notifyState()); });
app.post('/api/notify/telegram-chats', wrap(async (req, res) => {
  // A saved channel's token can be used without sending it again.
  const token = req.body?.id ? notifier.secret(req.body.id, 'token') : req.body?.token;
  res.json({ chats: await telegramChats(token) });
}));

app.get('/api/stacks/:name/vpn', wrap(async (req, res) => {
  stacks.assertName(req.params.name);
  const cfg = await stacks.config(req.params.name, { raw: true });
  const services = Object.entries(cfg.services || {}).map(([name, def]) => ({
    name,
    ports: (def.ports || []).filter((p) => p.published).map((p) => `${p.published}:${p.target}`),
    hostNetwork: Boolean(def.network_mode && !String(def.network_mode).startsWith('container:stackmoor-vpn-')),
  }));
  res.json({
    tunnels: vpn.list().map((x) => ({ name: x.name, state: x.status?.state || 'unknown', full: x.full })),
    attach: vpn.stackState(req.params.name),
    services,
  });
}));
app.put('/api/stacks/:name/vpn', streamJob((req, write) => vpn.setStack(req.params.name, req.body || {}, write, req.t)));

// ---------- backups ----------

// Long jobs run in the background; the UI polls /api/backups/status.
const background = (p) => { p.catch(() => {}); };

app.get('/api/backups', wrap(async (_req, res) => {
  res.json({ config: backups.publicConfig(), status: backups.status() });
}));

app.put('/api/backups', wrap(async (req, res) => res.json(backups.saveConfig(req.body || {}))));

app.post('/api/backups/test', wrap(async (_req, res) => res.json(await backups.test())));

app.post('/api/backups/reveal', (_req, res) => res.json({ password: backups.revealPassword() }));

app.get('/api/backups/status', (_req, res) => res.json(backups.status()));

app.get('/api/stacks/:name/backup-excludes', (req, res) => {
  stacks.assertName(req.params.name);
  res.json({ excludes: backups.stackExcludes(req.params.name) });
});
app.put('/api/stacks/:name/backup-excludes', (req, res) => {
  stacks.assertName(req.params.name);
  res.json({ excludes: backups.setStackExcludes(req.params.name, req.body?.excludes ?? '') });
});

app.get('/api/backups/snapshots', wrap(async (req, res) => {
  const list = await backups.snapshots({ fresh: req.query.fresh === '1' });
  res.json(req.query.stack ? list.filter((s) => s.stack === req.query.stack) : list);
}));

app.post('/api/backups/run', (req, res) => {
  background(backups.runAll('manual', req.t));
  res.status(202).json({ ok: true });
});

app.post('/api/backups/verify', (req, res) => {
  background(backups.verifyNow(req.t));
  res.status(202).json({ ok: true });
});

app.post('/api/stacks/:name/backup', (req, res) => {
  stacks.assertName(req.params.name);
  background(backups.backupOne(req.params.name, req.t));
  res.status(202).json({ ok: true });
});

app.get('/api/backups/runs', wrap(async (req, res) => {
  res.json(await backups.runs({ fresh: req.query.fresh === '1' }));
}));

app.post('/api/backups/restore-run', wrap(async (req, res) => {
  if (req.body?.confirm !== true) return fail(req, res, 400, 'delete.confirm');
  background(backups.restoreRun(String(req.body.run || ''), req.t));
  res.status(202).json({ ok: true });
}));

app.post('/api/backups/restore', wrap(async (req, res) => {
  const target = String(req.body?.target || '');
  if (!target || req.body?.confirm !== target) return fail(req, res, 400, 'delete.confirm');
  stacks.assertName(target);
  background(backups.restore(String(req.body.snapshot || ''), target, req.t));
  res.status(202).json({ ok: true });
}));

// ---------- domains ----------

// The server's IP: detected automatically unless switched off; the address the browser
// used is the fallback guess.
const withTimeout = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r(''), ms))]);
async function serverIpFor(body, req) {
  if (!body.domain || body.serverIpAuto === false) return body;
  const ip = await withTimeout(domains.detectServerIp().catch(() => ''), 10_000);
  return { ...body, serverIp: ip || body.serverIp || (isPrivateIPv4(req.hostname) ? req.hostname : '') };
}

app.get('/api/domains', wrap(async (req, res) => {
  const suggestedIp = isPrivateIPv4(req.hostname) ? req.hostname : '';
  const cfg = domains.publicConfig();
  if (cfg.serverIpAuto && !cfg.detectedIp) cfg.detectedIp = await withTimeout(domains.detectServerIp().catch(() => ''), 10_000);
  const status = await domains.status();
  domainStatusCache = { at: Date.now(), value: status, domain: status.domain || null };
  res.json({ ...cfg, suggestedIp, status, routes: domains.routes() });
}));

app.post('/api/domains/check', wrap(async (req, res) => res.json(await domains.check(await serverIpFor(req.body || {}, req)))));

app.post('/api/domains/retry-cert', wrap(async (_req, res) => res.json(await domains.retryCertificate())));

app.put('/api/domains', wrap(async (req, res) => {
  domains.saveConfig(await serverIpFor(req.body || {}, req), req.hostname);
  res.json(domains.publicConfig());
}));

app.put('/api/domains/panel', wrap(async (req, res) => {
  await domains.savePanel(req.body || {}, req.hostname);
  res.json(domains.publicConfig());
}));

app.post('/api/domains/apply', wrap(async (req, res) => {
  const write = openStream(res);
  let ok = true;
  await domains.apply(write, req.t).catch((err) => {
    ok = false;
    write(`\n${req.t('log.error', { message: errorText(req, err) })}\n`);
  });
  write(`\n__EXIT__:${ok ? 0 : 1}\n`);
  res.end();
}));

app.get('/api/domains/status', wrap(async (_req, res) => {
  const value = await domains.status();
  domainStatusCache = { at: Date.now(), value, domain: value.domain || null };
  res.json(value);
}));

app.get('/api/stacks/:name/routes', wrap(async (req, res) => {
  stacks.assertName(req.params.name);
  const cfg = await stacks.config(req.params.name);
  const services = Object.entries(cfg.services || {}).map(([name, def]) => ({
    name,
    ports: [...new Set([
      ...(def.ports || []).map((p) => Number(p.target)),
      ...(def.expose || []).map((p) => Number(String(p).split('/')[0])),
    ].filter(Boolean))],
    hostNetwork: Boolean(def.network_mode),
  }));
  const s = getSettings(db);
  res.json({ domain: s.domain, routes: domains.routes(req.params.name), services });
}));

app.put('/api/stacks/:name/routes', wrap(async (req, res) => {
  stacks.assertName(req.params.name);
  await domains.setRoutes(req.params.name, req.body?.routes);
  let log = '';
  let applied = true;
  if (getSettings(db).domain) {
    await domains.apply((s) => { log += s; }, req.t).catch((err) => {
      applied = false;
      log += `\n${req.t('log.error', { message: errorText(req, err) })}\n`;
    });
  }
  res.json({ routes: domains.routes(req.params.name), applied, log });
}));

app.get('/api/stacks/:name/operations', wrap(async (req, res) => {
  stacks.assertName(req.params.name);
  res.json(stacks.operations(req.params.name));
}));

app.get('/api/operations/:id', (req, res) => {
  const op = stacks.operationOutput(Number(req.params.id));
  if (!op) return fail(req, res, 404, 'notFound');
  res.json(op);
});

app.use('/api', (req, res) => fail(req, res, 404, 'notFound'));

// ---------- UI ----------

const publicDir = path.join(__dirname, '..', 'public');
// No caching without asking: after an update the browser must not keep the old UI.
// (ETags keep it cheap – an unchanged file is answered with 304.)
app.use(express.static(publicDir, { index: 'index.html', maxAge: 0, setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));
app.get('*', (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  const status = err instanceof UserError ? err.status : 500;
  if (status === 500) console.error(err);
  const message = status === 500 ? req.t('internal') : req.t(err.key, err.vars);
  if (res.headersSent) {
    res.end(`\n${req.t('log.error', { message })}\n`);
  } else {
    res.status(status).json({ error: message });
  }
});

app.listen(config.port, config.host, () => {
  console.log(`Stackmoor ${VERSION} listening on http://${config.host}:${config.port}`);
  console.log(`Stacks: ${config.stacksDir}, panel data: ${config.dataDir}`);
});
