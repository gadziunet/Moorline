// Notifications: channels (e-mail, Telegram, ntfy, Pushover, webhook) and the events the
// user wants to hear about. Secrets of the channels are stored encrypted.
import crypto from 'node:crypto';
import { getState, setState } from './db.js';
import { UserError } from './errors.js';
import { encrypt, decrypt, mask } from './secrets.js';
import { sendMail as smtpSend } from './smtp.js';

/** What the user can turn on, and what is on by default. */
export const EVENTS = {
  backupFailed: { on: true },
  backupOk: { on: false },
  stackDown: { on: true },
  vpn: { on: true },
  proxy: { on: true },
  autoProblem: { on: true },
  autoUpdated: { on: false },
  panelUpdate: { on: true },
  stackUpdates: { on: false },
  rebootRequired: { on: true },
  booted: { on: true },
};

export const TYPES = {
  email: { fields: ['host', 'port', 'security', 'user', 'from', 'to', 'insecure'], secrets: ['pass'] },
  telegram: { fields: ['chatId'], secrets: ['token'] },
  ntfy: { fields: ['server', 'topic'], secrets: ['token'] },
  pushover: { fields: [], secrets: ['user', 'token'] },
  webhook: { fields: [], secrets: ['url'] },
};

const MAX_HISTORY = 50;
const QUIET_MS = 5 * 60e3; // the same message is not repeated within 5 minutes
const RETRIES = [60e3, 5 * 60e3];
const str = (v) => String(v ?? '').trim();
const isMasked = (v) => str(v).startsWith('••••••');
const isUrl = (v) => { try { return ['http:', 'https:'].includes(new URL(v).protocol); } catch { return false; } };
const EMAIL_RE = /^[^\s@<>,]+@[^\s@<>,]+$/;
const addrOf = (x) => (str(x).match(/<([^>]+)>/)?.[1] || str(x));

/** Checks a channel from the form. Empty or masked secrets keep the saved ones. */
export function cleanChannel(body = {}, old = null) {
  const type = str(body.type || old?.type);
  if (!TYPES[type]) throw new UserError('nt.badType');
  const name = str(body.name) || old?.name || type;
  if (name.length > 40) throw new UserError('nt.badName');
  const c = {};
  for (const f of TYPES[type].fields) c[f] = body[f] !== undefined ? body[f] : old?.config?.[f];
  const s = {};
  for (const f of TYPES[type].secrets) s[f] = body[f] === undefined || str(body[f]) === '' || isMasked(body[f]) ? old?.secrets?.[f] || '' : str(body[f]);

  if (type === 'email') {
    c.host = str(c.host);
    c.port = Number(c.port) || (c.security === 'tls' ? 465 : c.security === 'none' ? 25 : 587);
    c.security = ['tls', 'starttls', 'none'].includes(c.security) ? c.security : 'starttls';
    c.user = str(c.user);
    c.from = str(c.from);
    c.to = str(c.to).split(/[,;\s]+/).filter(Boolean).join(', ');
    c.insecure = Boolean(c.insecure);
    if (!c.host || /[\s/]/.test(c.host)) throw new UserError('nt.badHost');
    if (!Number.isInteger(c.port) || c.port < 1 || c.port > 65535) throw new UserError('dns.badPort');
    if (!EMAIL_RE.test(addrOf(c.from))) throw new UserError('nt.badFrom');
    if (!c.to || !c.to.split(', ').every((x) => EMAIL_RE.test(x))) throw new UserError('nt.badTo');
    if (c.user && !s.pass) throw new UserError('nt.missingSecret');
  }
  if (type === 'telegram') {
    c.chatId = str(c.chatId);
    if (!/^-?\d+$|^@\w{4,}$/.test(c.chatId)) throw new UserError('nt.badChatId');
    if (!/^\d+:[\w-]{20,}$/.test(s.token)) throw new UserError('nt.badToken');
  }
  if (type === 'ntfy') {
    c.server = str(c.server).replace(/\/+$/, '') || 'https://ntfy.sh';
    c.topic = str(c.topic);
    if (!isUrl(c.server)) throw new UserError('nt.badUrl');
    if (!/^[\w-]{1,64}$/.test(c.topic)) throw new UserError('nt.badTopic');
  }
  if (type === 'pushover') {
    if (!/^\w{20,40}$/.test(s.user) || !/^\w{20,40}$/.test(s.token)) throw new UserError('nt.badPushover');
  }
  if (type === 'webhook') {
    if (!isUrl(s.url)) throw new UserError('nt.badUrl');
  }
  return { type, name, enabled: body.enabled === undefined ? old?.enabled ?? true : Boolean(body.enabled), config: c, secrets: s };
}

const localTime = (d, locale, timeZone) => {
  try { return d.toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short', timeZone: timeZone || 'UTC' }); } catch { return d.toISOString(); }
};
const escHtml = (s) => String(s).replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[ch]);
const PRIORITY = { error: { ntfy: 4, pushover: 1 }, warn: { ntfy: 4, pushover: 0 }, info: { ntfy: 3, pushover: 0 }, ok: { ntfy: 3, pushover: 0 } };
const TAG = { error: 'rotating_light', warn: 'warning', info: 'information_source', ok: 'white_check_mark' };

async function post(fetchFn, url, { json, form, headers = {} }) {
  const res = await fetchFn(url, {
    method: 'POST',
    headers: { ...(json ? { 'Content-Type': 'application/json' } : { 'Content-Type': 'application/x-www-form-urlencoded' }), ...headers },
    body: json ? JSON.stringify(json) : new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 160)}` : ''}`);
  }
  return res;
}

/** Sends one message through one channel. Throws with a short reason when it fails. */
export async function deliver(ch, msg, { fetchFn = fetch, sendMail = smtpSend } = {}) {
  const { config: c, secrets: s } = ch;
  const p = PRIORITY[msg.level] || PRIORITY.info;
  switch (ch.type) {
    case 'email':
      return sendMail({
        host: c.host, port: c.port, security: c.security, user: c.user, pass: s.pass, insecure: c.insecure,
        from: c.from, to: c.to, subject: msg.title, text: `${msg.body}\n\n— ${msg.server} · ${msg.when}\n`,
      });
    case 'telegram': {
      const res = await post(fetchFn, `https://api.telegram.org/bot${s.token}/sendMessage`, {
        json: { chat_id: c.chatId, text: `<b>${escHtml(msg.title)}</b>\n${escHtml(msg.body)}`, parse_mode: 'HTML', disable_web_page_preview: true },
      });
      const data = await res.json().catch(() => ({}));
      if (data.ok === false) throw new Error(data.description || 'Telegram error');
      return data;
    }
    case 'ntfy':
      return post(fetchFn, c.server, {
        json: { topic: c.topic, title: msg.title, message: msg.body, priority: p.ntfy, tags: [TAG[msg.level] || TAG.info] },
        headers: s.token ? { Authorization: `Bearer ${s.token}` } : {},
      });
    case 'pushover':
      return post(fetchFn, 'https://api.pushover.net/1/messages.json', {
        form: { token: s.token, user: s.user, title: msg.title, message: msg.body, priority: String(p.pushover) },
      });
    case 'webhook':
      // text/content make it work with Slack, Mattermost and Discord webhooks too.
      return post(fetchFn, s.url, {
        json: {
          event: msg.event, level: msg.level, title: msg.title, message: msg.body, server: msg.server, at: msg.at,
          text: `${msg.title}\n${msg.body}`, content: `**${msg.title}**\n${msg.body}`,
        },
      });
    default:
      throw new Error(`unknown channel type ${ch.type}`);
  }
}

export function createNotifier({ db, getT, deliverFn = deliver, wait = (ms) => new Promise((r) => setTimeout(r, ms).unref?.()) }) {
  const recent = new Map(); // message key -> when it was last sent

  const load = () => getState(db, 'notify.channels', []).map((x) => ({ ...x, secrets: decrypt(x.secrets) || {} }));
  const store = (list) => setState(db, 'notify.channels', list.map((x) => ({ ...x, secrets: encrypt(x.secrets) })));
  const prefs = () => ({ serverName: '', timeZone: 'UTC', events: {}, ...getState(db, 'notify.prefs', {}) });
  const enabled = (key) => prefs().events[key] ?? EVENTS[key]?.on ?? false;
  const history = () => getState(db, 'notify.history', []);
  const record = (h) => setState(db, 'notify.history', [h, ...history()].slice(0, MAX_HISTORY));

  /** Channels for the page: secrets masked. */
  function channels() {
    return load().map((x) => ({
      id: x.id, type: x.type, name: x.name, enabled: x.enabled, ...x.config,
      ...Object.fromEntries(Object.entries(x.secrets).map(([k, v]) => [k, mask(v)])),
    }));
  }

  function saveChannel(body, id = null) {
    const list = load();
    const old = id ? list.find((x) => x.id === id) : null;
    if (id && !old) throw new UserError('nt.notFound');
    const c = cleanChannel(body, old);
    if (old) Object.assign(old, c);
    else list.push({ id: crypto.randomBytes(6).toString('hex'), ...c });
    store(list);
    return { id: old?.id || list.at(-1).id };
  }

  function removeChannel(id) {
    const list = load();
    if (!list.some((x) => x.id === id)) throw new UserError('nt.notFound');
    store(list.filter((x) => x.id !== id));
  }

  function savePrefs(body = {}) {
    const p = prefs();
    if (body.serverName !== undefined) p.serverName = str(body.serverName).slice(0, 40);
    // Times in messages: the browser's time zone (the panel's container runs in UTC).
    if (body.timeZone) { try { new Intl.DateTimeFormat('en', { timeZone: body.timeZone }); p.timeZone = body.timeZone; } catch { /* keep */ } }
    if (body.events && typeof body.events === 'object') {
      for (const k of Object.keys(EVENTS)) if (body.events[k] !== undefined) p.events[k] = Boolean(body.events[k]);
    }
    setState(db, 'notify.prefs', p);
    return publicPrefs();
  }

  function publicPrefs() {
    const p = prefs();
    return { serverName: p.serverName, events: Object.fromEntries(Object.keys(EVENTS).map((k) => [k, enabled(k)])) };
  }

  function message(key, vars, variant, level, t) {
    const k = `nt.ev.${key}${variant ? `.${variant}` : ''}`;
    const now = new Date();
    return {
      event: variant ? `${key}.${variant}` : key, level, at: now.toISOString(),
      when: localTime(now, t('nt.locale'), prefs().timeZone),
      server: prefs().serverName || 'Stackmoor',
      title: `${prefs().serverName || 'Stackmoor'}: ${t(`${k}.title`, vars)}`,
      body: t(`${k}.body`, vars),
    };
  }

  async function sendTo(ch, msg) {
    let lastErr = null;
    for (let i = 0; i <= RETRIES.length; i++) {
      try {
        await deliverFn(ch, msg);
        record({ at: msg.at, event: msg.event, title: msg.title, channel: ch.name, type: ch.type, ok: true });
        return true;
      } catch (err) {
        lastErr = err;
        if (i < RETRIES.length) await wait(RETRIES[i]);
      }
    }
    record({ at: msg.at, event: msg.event, title: msg.title, channel: ch.name, type: ch.type, ok: false, error: String(lastErr?.message || lastErr).slice(0, 200) });
    return false;
  }

  /**
   * Something happened. key: one of EVENTS; variant: e.g. 'down'/'up'; level: error/warn/info/ok.
   * Never throws – a broken channel must not break the panel.
   */
  function emit(key, vars = {}, { variant = '', level = 'info', subject = '' } = {}) {
    try {
      if (!enabled(key)) return Promise.resolve([]);
      // The same message again within 5 minutes is skipped – but a change (down → up → down)
      // is always sent, so the last message never says the opposite of what is true.
      const dedup = `${key}.${subject}`;
      const last = recent.get(dedup);
      if (last && last.variant === variant && Date.now() - last.at < QUIET_MS) return Promise.resolve([]);
      recent.set(dedup, { variant, at: Date.now() });
      const msg = message(key, vars, variant, level, getT());
      const list = load().filter((x) => x.enabled);
      return Promise.all(list.map((ch) => sendTo(ch, msg).catch(() => false)));
    } catch (err) {
      console.error('Notification failed:', err.message);
      return Promise.resolve([]);
    }
  }

  /** "Send test" from the page: one try, the error comes back to the page. */
  async function test(id, t) {
    const ch = load().find((x) => x.id === id);
    if (!ch) throw new UserError('nt.notFound');
    const msg = message('test', {}, '', 'info', t);
    try {
      await deliverFn(ch, msg);
    } catch (err) {
      record({ at: msg.at, event: 'test', title: msg.title, channel: ch.name, type: ch.type, ok: false, error: String(err.message).slice(0, 200) });
      throw new UserError('nt.testFailed', { error: String(err.message).slice(0, 300) });
    }
    record({ at: msg.at, event: 'test', title: msg.title, channel: ch.name, type: ch.type, ok: true });
    return { ok: true };
  }

  const secret = (id, key) => load().find((x) => x.id === id)?.secrets?.[key] || '';

  return { channels, saveChannel, removeChannel, prefs: publicPrefs, savePrefs, emit, test, secret, history: () => history().slice(0, 30) };
}

/**
 * Watches stacks: a stack that was running and stopped by itself (no start/stop from the panel)
 * is reported once it stays down for two checks in a row, and again when it is back.
 */
/** Telegram: the chats that wrote to the bot recently (to find the chat ID). */
export async function telegramChats(token, { fetchFn = fetch } = {}) {
  if (!/^\d+:[\w-]{20,}$/.test(str(token))) throw new UserError('nt.badToken');
  let data;
  try {
    const res = await fetchFn(`https://api.telegram.org/bot${str(token)}/getUpdates`, { signal: AbortSignal.timeout(15000) });
    data = await res.json();
  } catch (err) {
    throw new UserError('nt.testFailed', { error: err.message });
  }
  if (!data.ok) throw new UserError('nt.testFailed', { error: data.description || 'Telegram error' });
  const chats = new Map();
  for (const u of data.result || []) {
    const c = (u.message || u.channel_post || u.my_chat_member || {}).chat;
    if (c) chats.set(String(c.id), { id: String(c.id), name: c.title || [c.first_name, c.last_name].filter(Boolean).join(' ') || c.username || String(c.id), type: c.type });
  }
  return [...chats.values()];
}

export function createStackWatch({ stacks, emit, isQuiet = () => false }) {
  let prev = new Map(); // name -> { running, total }
  const suspect = new Map(); // name -> count of checks it looked down
  const reported = new Set();

  async function check() {
    const list = await stacks.list();
    const recentOps = new Set(stacks.recentOperations(30)
      .filter((o) => Date.now() - Date.parse(`${String(o.started_at).replace(' ', 'T')}Z`) < 5 * 60e3)
      .map((o) => o.stack));
    const next = new Map();
    for (const s of list) {
      next.set(s.name, { running: s.running, total: s.total });
      const before = prev.get(s.name);
      const lost = before && before.running > 0 && s.running < before.running;
      const userDid = s.busy || recentOps.has(s.name) || isQuiet();
      if (reported.has(s.name)) {
        if (userDid && s.state !== 'running') { reported.delete(s.name); continue; } // handled in the panel
        if (s.state === 'running') {
          reported.delete(s.name);
          emit('stackDown', { stack: s.name }, { variant: 'up', level: 'ok', subject: s.name });
        }
        continue;
      }
      if ((lost || suspect.has(s.name)) && !userDid && s.state !== 'running' && s.state !== 'down') {
        const n = (suspect.get(s.name) || 0) + 1;
        suspect.set(s.name, n);
        if (n >= 2) {
          suspect.delete(s.name);
          reported.add(s.name);
          emit('stackDown', { stack: s.name, running: s.running, total: s.total }, { variant: 'down', level: 'error', subject: s.name });
        }
        // keep the last good count so the next check still compares with it
        next.set(s.name, before && lost ? before : next.get(s.name));
      } else {
        suspect.delete(s.name);
      }
    }
    prev = next;
  }

  function start(everyMs = 60e3) {
    const tick = () => check().catch(() => {});
    setTimeout(tick, 30e3).unref?.();
    setInterval(tick, everyMs).unref?.();
  }

  return { check, start };
}
