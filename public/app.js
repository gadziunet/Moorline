// Stackmoor UI – no framework, no build step.
import { t, lang, setLang, LANGS } from './i18n.js';
import { openTargets as buildTargets } from './links.js';

const app = document.getElementById('app');
const state = { user: null, needsSetup: false, stacks: [], refreshTimer: null, abort: null, version: '' };

const NEW_STACK_TEMPLATE = `services:
  app:
    image: nginx:alpine
    restart: unless-stopped
    ports:
      - "8080:80"
    volumes:
      - /usr/share/nginx/html
`;

const stateLabel = (s) => t(`state.${s}`);

// ---------- theme: the system decides until the user picks light or dark ----------
const THEME_KEY = 'sm-theme';
const storedTheme = () => { try { return localStorage.getItem(THEME_KEY); } catch { return null; } };
function applyTheme() {
  const v = storedTheme();
  if (v === 'light' || v === 'dark') document.documentElement.dataset.theme = v;
  else delete document.documentElement.dataset.theme;
}
const currentTheme = () => document.documentElement.dataset.theme
  || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
function setTheme(v) {
  try { localStorage.setItem(THEME_KEY, v); } catch { /* private mode: just this tab */ }
  applyTheme();
}
applyTheme();

const svg = (d, size = 18) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICON = {
  stacks: '<path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 13l9 5 9-5"/>',
  backups: '<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6"/><path d="M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>',
  domains: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18"/>',
  network: '<path d="M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6l8-3z"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
  moon: '<path d="M12 3a9 9 0 1 0 9 9 7 7 0 0 1-9-9z"/>',
  logout: '<path d="M15 4h4v16h-4"/><path d="M10 8l-4 4 4 4"/><path d="M6 12h10"/>',
  up: '<path d="M12 19V5"/><path d="M6 11l6-6 6 6"/>',
};

// ---------- helpers ----------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), 2600);
}

// One-time setup code (first run only), kept for this tab while the account is created or restored.
const SETUP_CODE_KEY = 'sm-setup-code';
const setupCode = {
  get() { try { return sessionStorage.getItem(SETUP_CODE_KEY) || ''; } catch { return ''; } },
  // Only letters and digits: anything else (a typo like "ą", a pasted "–") would break every request header.
  set(v) { try { sessionStorage.setItem(SETUP_CODE_KEY, String(v).toUpperCase().replace(/[^A-Z0-9]/g, '')); } catch { /* ignore */ } },
  clear() { try { sessionStorage.removeItem(SETUP_CODE_KEY); } catch { /* ignore */ } },
};

const headers = (json) => ({
  ...(json ? { 'Content-Type': 'application/json' } : {}),
  'X-Requested-With': 'stackmoor',
  'X-Lang': lang,
  ...(setupCode.get() ? { 'X-Setup-Code': setupCode.get() } : {}),
});

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: headers(true),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && state.user) {
    state.user = null;
    render();
  }
  // The panel was locked to its domain while this tab used the IP address.
  if (res.status === 421 && data.redirect) location.href = data.redirect + location.hash;
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// Reads a streamed response and passes text through as it arrives. Returns the exit code (if any).
async function stream(method, url, onText, signal, body) {
  const res = await fetch(url, {
    method, signal,
    headers: body === undefined ? headers(false) : headers(true),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let exit = null;
  let buf = '';
  // Only full lines are shown, so the __EXIT__ marker is never split.
  const flush = (all) => {
    const cut = all ? buf.length : buf.lastIndexOf('\n') + 1;
    if (cut <= 0) return;
    const out = buf.slice(0, cut).replace(/(^|\n)__EXIT__:(\d+)\n?/g, (_m, pre, code) => {
      exit = Number(code);
      return pre;
    });
    buf = buf.slice(cut);
    if (out) onText(out);
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    flush(false);
  }
  buf += dec.decode();
  flush(true);
  return exit;
}

function stopStream() {
  state.abort?.abort();
  state.abort = null;
}

function appendTo(pre, text) {
  const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40;
  pre.textContent += text;
  if (pre.textContent.length > 300_000) pre.textContent = pre.textContent.slice(-200_000);
  if (atBottom) pre.scrollTop = pre.scrollHeight;
}

function enableTabKey(textarea, save) {
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault();
      const { selectionStart: s, selectionEnd: en, value } = textarea;
      textarea.value = value.slice(0, s) + '  ' + value.slice(en);
      textarea.selectionStart = textarea.selectionEnd = s + 2;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      save?.();
    }
  });
}

const errorBox = (err) => `<div class="notice error">${esc(err.message)}</div>`;

function notices(result) {
  let html = '';
  if (result.changes?.length) {
    html += `<div class="notice info"><strong>${t('notice.changes')}</strong>
      <ul>${result.changes.map((c) => `<li>${esc(c)}</li>`).join('')}</ul></div>`;
  }
  if (result.warnings?.length) {
    html += `<div class="notice warn"><strong>${t('notice.warnings')}</strong>
      <ul>${result.warnings.map((c) => `<li>${esc(c)}</li>`).join('')}</ul></div>`;
  }
  return html;
}

function langSelect(id) {
  return `<select id="${id}" class="lang" aria-label="${esc(t('set.language'))}">
    ${Object.entries(LANGS).map(([code, label]) => `<option value="${code}" ${code === lang ? 'selected' : ''}>${label}</option>`).join('')}
  </select>`;
}

function bindLangSelect(id) {
  document.getElementById(id)?.addEventListener('change', (e) => {
    setLang(e.target.value);
    document.querySelector('.layout')?.remove(); // rebuild the whole layout in the new language
    render();
  });
}

// ---------- login ----------

function renderAuth() {
  if (state.wizard === 'progress') return renderRestoreProgress();
  if (state.wizard === 'restore' && state.needsSetup) return renderRestoreWizard();
  const setup = state.needsSetup;
  app.innerHTML = `
    <div class="auth"><form class="card" id="auth">
      <div class="row" style="justify-content:space-between;align-items:flex-start">
        <img src="/logo.svg" alt="Stackmoor" width="52" height="52">${langSelect('auth-lang')}
      </div>
      <h1>${t(setup ? 'auth.welcome' : 'auth.login')}</h1>
      <p>${t(setup ? 'auth.setupLead' : 'auth.loginLead')}</p>
      ${setup ? `<div class="field"><label for="sc">${t('auth.setupCode')}</label>
        <input type="text" id="sc" autocomplete="off" autocapitalize="characters" spellcheck="false" required placeholder="XXXX-XXXX-XXXX" value="${esc(setupCode.get())}">
        <p class="hint">${t('auth.setupCodeHint')}</p></div>` : ''}
      <div class="field"><label for="u">${t('auth.username')}</label>
        <input type="text" id="u" autocomplete="username" autocapitalize="off" required value="${setup ? 'admin' : ''}"></div>
      <div class="field"><label for="p">${t('auth.password')}</label>
        <input type="password" id="p" autocomplete="${setup ? 'new-password' : 'current-password'}" required minlength="${setup ? 10 : 1}">
        ${setup ? `<p class="hint">${t('auth.minLength')}</p>` : ''}</div>
      <div id="err"></div>
      <button class="btn primary" style="width:100%">${t(setup ? 'auth.create' : 'auth.submit')}</button>
      ${setup ? `<p class="auth-or">${t('wiz.or')}</p>
        <button type="button" class="btn" id="wiz-open" style="width:100%">${t('wiz.restoreBtn')}</button>` : ''}
    </form></div>`;
  bindLangSelect('auth-lang');
  if (state.authError) {
    document.getElementById('err').innerHTML = errorBox(new Error(state.authError));
    state.authError = null;
  }
  const codeInput = document.getElementById('sc');
  document.getElementById('wiz-open')?.addEventListener('click', () => {
    if (!codeInput.reportValidity()) return;
    setupCode.set(codeInput.value);
    state.wizard = 'restore';
    render();
  });
  document.getElementById('auth').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = { username: document.getElementById('u').value, password: document.getElementById('p').value };
    if (codeInput) setupCode.set(codeInput.value);
    try {
      await api('POST', setup ? '/api/setup' : '/api/login', body);
      setupCode.clear();
      if (setup) state.afterSetup = true; // next: how to open the panel (IP or domain)
      await boot();
    } catch (err) {
      document.getElementById('err').innerHTML = errorBox(err);
    }
  });
}

// ---------- first run: IP address for now, or the domain right away ----------

async function renderAccessStep() {
  const here = `${location.protocol}//${location.host}`;
  app.innerHTML = `
    <div class="auth"><div class="card wide" id="access">
      <div class="row" style="justify-content:space-between;align-items:flex-start">
        <img src="/logo.svg" alt="Stackmoor" width="52" height="52">${langSelect('auth-lang')}
      </div>
      <h1>${t('acc2.title')}</h1>
      <p>${t('acc2.lead')}</p>
      <div class="choices">
        <button type="button" class="choice" id="acc-ip">
          <strong>${t('acc2.ip')}</strong>
          <span>${t('acc2.ipHint', { url: esc(here) })}</span>
        </button>
        <button type="button" class="choice" id="acc-domain">
          <strong>${t('acc2.domain')}</strong>
          <span>${t('acc2.domainHint')}</span>
        </button>
      </div>
      <div id="acc-body"></div>
    </div></div>`;
  bindLangSelect('auth-lang');
  const finish = () => { state.afterSetup = false; location.hash = '#/'; render(); };
  document.getElementById('acc-ip').addEventListener('click', finish);
  document.getElementById('acc-domain').addEventListener('click', async () => {
    document.querySelector('#access .choices').hidden = true;
    const bodyEl = document.getElementById('acc-body');
    bodyEl.innerHTML = `<p class="hint">${t('stack.loading')}</p>`;
    let d;
    try {
      d = await api('GET', '/api/domains');
    } catch (err) {
      bodyEl.innerHTML = errorBox(err);
      return;
    }
    bodyEl.innerHTML = `<p class="hint">${t('dom.lead')}</p><div id="acc-form"></div>
      <button type="button" class="btn" id="acc-skip" style="margin-top:12px">${t('acc2.later')}</button>`;
    document.getElementById('acc-skip').addEventListener('click', finish);
    domainForm(document.getElementById('acc-form'), d, {
      submitLabel: t('acc2.submit'),
      onApplied: () => {
        document.getElementById('acc-skip')?.remove();
        waitForCertificate(bodyEl, finish);
      },
    });
  });
}

/**
 * After the wizard set up the domain: wait for the certificate (up to 10 minutes), showing
 * what is going on every 10 seconds, then offer the new address.
 */
async function waitForCertificate(el, finish) {
  const box = document.createElement('div');
  box.className = 'notice info';
  box.style.marginTop = '14px';
  el.appendChild(box);
  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  const started = Date.now();
  const mmss = (ms) => { const s = Math.round(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  const LIMIT = 10 * 60e3;
  for (;;) {
    const st = await api('GET', '/api/domains/status').catch(() => null);
    const elapsed = Date.now() - started;
    if (st?.certificate || elapsed > LIMIT) {
      const url = st?.panelUrl || '';
      box.innerHTML = st?.certificate
        ? `<strong>✓ ${t('acc2.ready')}</strong>
           ${url ? `<p class="hint" style="margin:6px 0 10px">${t('acc2.readyHint', { url: esc(url) })}</p>
             <a class="btn primary" href="${esc(url)}">${t('acc2.open', { url: esc(url.replace('https://', '')) })}</a>` : ''}
           <button type="button" class="btn" id="acc-stay" style="margin-left:6px">${t('acc2.stay')}</button>`
        : `<strong>${t('acc2.slow')}</strong><p class="hint" style="margin:6px 0 10px">${t('acc2.slowHint')}</p>
           ${st?.errors?.length ? `<div class="notice error" style="margin-bottom:10px">${st.errors.map(esc).join('\n')}</div>` : ''}
           <button type="button" class="btn" id="acc-stay">${t('acc2.continue')}</button>`;
      box.querySelector('#acc-stay').addEventListener('click', finish);
      return;
    }
    // Rough phases: Caddy waits <propagation> s after adding the TXT record, then Let's Encrypt checks.
    const wait = (st?.propagation || 0) * 1000;
    const phase = elapsed < 15e3 ? t('acc2.phaseTxt')
      : elapsed < wait + 15e3 ? t('acc2.phaseWait', { left: Math.max(0, Math.round((wait + 15e3 - elapsed) / 1000)) })
        : t('acc2.phaseCheck');
    box.innerHTML = `<strong>${t('acc2.waitCert')}</strong>
      <p class="hint" style="margin:6px 0 0">${phase}</p>
      <p class="hint" style="margin:4px 0 0">${t('acc2.elapsed', { time: mmss(elapsed) })}</p>
      ${st?.errors?.length ? `<p class="hint" style="margin:8px 0 0">${t('acc2.retrying')}</p><div class="notice error" style="margin-top:6px">${esc(st.errors.at(-1))}</div>` : ''}`;
    await new Promise((r) => setTimeout(r, 10_000));
  }
}

// ---------- setup wizard: restore a whole server ----------

async function renderRestoreWizard() {
  let opts;
  try {
    opts = await api('GET', '/api/setup/restore/options');
  } catch (err) {
    state.wizard = null;
    state.authError = err.message;
    return render();
  }
  const dests = opts.destinations;
  app.innerHTML = `
    <div class="auth"><div class="card wide">
      <div class="row" style="justify-content:space-between;align-items:flex-start">
        <img src="/logo.svg" alt="Stackmoor" width="52" height="52">${langSelect('auth-lang')}
      </div>
      <h1>${t('wiz.title')}</h1>
      <p>${t('wiz.lead')}</p>
      <form id="wiz-form">
        <div class="field"><label for="wz-dest">${t('bak.destination')}</label>
          <select id="wz-dest" class="lang">${dests.map((d) => `<option value="${esc(d.id)}">${esc(d.name)}</option>`).join('')}</select></div>
        <div class="row field">
          <div style="flex:3;min-width:200px"><label for="wz-endpoint">${t('bak.endpoint')}</label>
            <input type="text" id="wz-endpoint" autocapitalize="off" autocomplete="off" required></div>
          <div style="flex:1;min-width:110px"><label for="wz-region">${t('bak.region')}</label>
            <input type="text" id="wz-region" autocapitalize="off" autocomplete="off"></div>
        </div>
        <div class="row field">
          <div style="flex:2;min-width:160px"><label for="wz-bucket">${t('bak.bucket')}</label>
            <input type="text" id="wz-bucket" autocapitalize="off" autocomplete="off" required></div>
          <div style="flex:1;min-width:110px"><label for="wz-prefix">${t('bak.prefix')}</label>
            <input type="text" id="wz-prefix" value="stackmoor" autocapitalize="off" autocomplete="off"></div>
        </div>
        <div class="field"><label for="wz-ak">${t('bak.accessKey')}</label>
          <input type="text" id="wz-ak" autocapitalize="off" autocomplete="off" required></div>
        <div class="field"><label for="wz-sk">${t('bak.secretKey')}</label>
          <input type="password" id="wz-sk" autocomplete="off" required></div>
        <div class="field"><label for="wz-pw">${t('bak.password')}</label>
          <input type="password" id="wz-pw" autocomplete="off" required></div>
        <div id="wz-out"></div>
        <div class="row">
          <button class="btn primary" id="wz-connect">${t('wiz.connect')}</button>
          <button type="button" class="btn" id="wz-back">${t('wiz.back')}</button>
        </div>
      </form>
      <div id="wz-runs"></div>
    </div></div>`;
  bindLangSelect('auth-lang');
  const fill = () => {
    const d = dests.find((x) => x.id === document.getElementById('wz-dest').value);
    const region = d?.region || '';
    document.getElementById('wz-region').value = region;
    document.getElementById('wz-endpoint').value = d?.endpoint && !d.endpoint.includes('<') ? d.endpoint.replace('{region}', region) : '';
    document.getElementById('wz-endpoint').placeholder = (d?.endpoint || 'minio.example.com:9000').replace('{region}', region || 'region');
  };
  fill();
  document.getElementById('wz-dest').addEventListener('change', fill);
  document.getElementById('wz-region').addEventListener('input', (e) => {
    const d = dests.find((x) => x.id === document.getElementById('wz-dest').value);
    if (d?.endpoint && d.endpoint.includes('{region}') && !d.endpoint.includes('<')) {
      document.getElementById('wz-endpoint').value = d.endpoint.replace('{region}', e.target.value.trim());
    }
  });
  document.getElementById('wz-back').addEventListener('click', () => { state.wizard = null; render(); });

  document.getElementById('wiz-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const out = document.getElementById('wz-out');
    const btn = document.getElementById('wz-connect');
    const val = (id) => document.getElementById(id).value.trim();
    btn.disabled = true;
    out.innerHTML = `<p class="hint">${t('wiz.connecting')}</p>`;
    let runs;
    try {
      ({ runs } = await api('POST', '/api/setup/restore/connect', {
        destination: val('wz-dest'), endpoint: val('wz-endpoint'), region: val('wz-region'), bucket: val('wz-bucket'),
        prefix: val('wz-prefix'), accessKey: val('wz-ak'), secretKey: val('wz-sk'), password: document.getElementById('wz-pw').value,
      }));
    } catch (err) {
      out.innerHTML = errorBox(err);
      btn.disabled = false;
      return;
    }
    out.innerHTML = '';
    btn.disabled = false;
    const box = document.getElementById('wz-runs');
    if (!runs.length) {
      box.innerHTML = `<div class="notice warn">${t('wiz.noRuns')}</div>`;
      return;
    }
    box.innerHTML = `
      <h2 style="margin-top:22px">${t('wiz.chooseRun')}</h2>
      <form id="wz-pick">
        <div class="run-pick">${runs.map((r, i) => `
          <label class="check run-option"><input type="radio" name="run" value="${esc(r.id)}" ${i === 0 ? 'checked' : ''}>
            <span><strong>${fmtDate(r.time)}</strong> · ${esc(t(`bak.kind.${r.kind}`))} · ${fmtBytes(r.size)}<br>
            <span class="hint">${r.stacks.length ? esc(r.stacks.join(', ')) : t('wiz.noStacks')}</span></span></label>`).join('')}
        </div>
        <p class="hint">${t('wiz.startWarn')}</p>
        <div id="wz-start-out"></div>
        <button class="btn primary">${t('wiz.start')}</button>
      </form>`;
    box.scrollIntoView({ behavior: 'smooth', block: 'start' });
    document.getElementById('wz-pick').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const run = document.querySelector('input[name="run"]:checked')?.value;
      try {
        await api('POST', '/api/setup/restore/start', { run });
      } catch (err) {
        document.getElementById('wz-start-out').innerHTML = errorBox(err);
        return;
      }
      state.wizard = 'progress';
      render();
    });
  });
}

function renderRestoreProgress() {
  app.innerHTML = `
    <div class="auth"><div class="card wide">
      <img src="/logo.svg" alt="Stackmoor" width="52" height="52">
      <h1 id="wz-title">${t('wiz.progress')}</h1>
      <p id="wz-phase">${t('stack.loading')}</p>
      <div class="progress" aria-hidden="true"><span id="wz-bar"></span></div>
      <pre class="terminal" id="wz-log"></pre>
      <div id="wz-done"></div>
    </div></div>`;
  const pre = document.getElementById('wz-log');
  // Drawn again (e.g. after a hash change): only the newest view keeps polling.
  const gen = (renderRestoreProgress.gen = (renderRestoreProgress.gen || 0) + 1);
  const live = () => state.wizard === 'progress' && gen === renderRestoreProgress.gen;
  const toLogin = async () => {
    if (!live()) return;
    setupCode.clear();
    state.wizard = null;
    await boot();
  };
  const tick = async () => {
    if (!live()) return;
    let st;
    try {
      st = await api('GET', '/api/setup/restore/status');
    } catch (err) {
      // No restore to follow (the panel restarted) or the account is already back: log in.
      if (err.status === 404) return toLogin();
      if (err.status === 403) {
        const s = await api('GET', '/api/state').catch(() => null);
        return s && !s.needsSetup && !s.restoring ? toLogin() : askCode();
      }
      return setTimeout(tick, 3000);
    }
    if (!live()) return;
    document.getElementById('wz-done').innerHTML = '';
    const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40;
    pre.textContent = st.log || '';
    if (atBottom) pre.scrollTop = pre.scrollHeight;
    const phase = document.getElementById('wz-phase');
    phase.textContent = st.phase === 'stacks'
      ? t('wiz.phase.stacks', { i: st.current, n: st.total, name: st.stack || '' })
      : t(`wiz.phase.${st.phase}`);
    const parts = 2 + st.total;
    const doneParts = st.phase === 'panel' ? 0 : st.phase === 'stacks' ? Math.max(0, st.current) : parts;
    document.getElementById('wz-bar').style.width = `${Math.round((doneParts / parts) * 100)}%`;
    if (!st.done) return setTimeout(tick, 2000);

    document.getElementById('wz-title').textContent = t(st.error ? 'wiz.stopped' : 'wiz.finished');
    const msg = st.error
      ? `<div class="notice error">${esc(t('wiz.error', { error: st.error }))}</div>`
      : st.failed.length
        ? `<div class="notice warn">${esc(t('wiz.doneFailed', { list: st.failed.join(', ') }))}</div>`
        : `<div class="notice info">${t('wiz.done')}</div>`;
    // All went well: nothing left to read, go to the login page by itself.
    if (!st.error && !st.failed.length) {
      document.getElementById('wz-done').innerHTML = `${msg}<p class="hint">${t('wiz.redirecting')}</p>`;
      setTimeout(toLogin, 3000);
      return;
    }
    document.getElementById('wz-done').innerHTML = `${msg}
      <button class="btn primary" id="wz-login" style="width:100%">${t(st.error ? 'wiz.back' : 'wiz.login')}</button>`;
    document.getElementById('wz-login').addEventListener('click', toLogin);
  };
  // Opened in a new window (or the code is wrong): ask for it, then keep following the restore.
  const askCode = () => {
    const box = document.getElementById('wz-done');
    if (document.getElementById('wz-code')) return;
    box.innerHTML = `<form id="wz-code-form" style="margin-top:12px">
      <p class="hint">${t('wiz.codeAgain')}</p>
      <div class="field"><label for="wz-code">${t('auth.setupCode')}</label>
        <input type="text" id="wz-code" autocomplete="off" autocapitalize="characters" spellcheck="false" required placeholder="XXXX-XXXX-XXXX"></div>
      <button class="btn primary">${t('wiz.codeContinue')}</button></form>`;
    document.getElementById('wz-code-form').addEventListener('submit', (e) => {
      e.preventDefault();
      setupCode.set(document.getElementById('wz-code').value);
      box.innerHTML = '';
      tick();
    });
  };
  tick();
}

// ---------- layout ----------

const LOGO = `<img src="/logo.svg" alt="" width="28" height="28">`;

// Old addresses (Settings → Domains, VPN, Backups, Account) keep working.
const OLD_HASH = { 'settings/domains': 'domains', 'settings/vpn': 'network/vpn', 'settings/backups': 'backups', 'settings/account': 'account', 'settings/general': 'settings/folders' };

function route() {
  let h = location.hash.replace(/^#\/?/, '');
  if (OLD_HASH[h]) { h = OLD_HASH[h]; history.replaceState(null, '', `#/${h}`); }
  if (h === 'new') return { page: 'new', nav: 'home' };
  if (h === 'backups') return { page: 'backups', tab: 'backups', nav: 'backups' };
  if (h === 'domains') return { page: 'domains', tab: 'domains', nav: 'domains' };
  if (h === 'account') return { page: 'account', tab: 'account', nav: '' };
  const net = h.match(/^network(?:\/([a-z]+))?$/);
  if (net) return { page: 'network', tab: net[1] || 'vpn', nav: 'network' };
  const st = h.match(/^settings(?:\/([a-z]+))?$/);
  if (st) return { page: 'settings', tab: st[1] || 'panel', nav: 'settings' };
  const m = h.match(/^stack\/([a-z0-9_-]+)$/);
  if (m) return { page: 'stack', name: m[1], nav: 'home' };
  const px = h.match(/^proxy\/(new|\d+)$/);
  if (px) return { page: 'proxy', id: px[1] === 'new' ? null : Number(px[1]), nav: 'home' };
  return { page: 'home', nav: 'home' };
}

const NAV = [
  ['home', '#/', 'nav.stacks', 'stacks'],
  ['backups', '#/backups', 'nav.backups', 'backups'],
  ['domains', '#/domains', 'nav.domains', 'domains'],
  ['network', '#/network', 'nav.network', 'network'],
  ['settings', '#/settings', 'nav.settings', 'settings'],
];

async function logout() {
  await api('POST', '/api/logout').catch(() => {});
  state.user = null;
  render();
}

function renderShell() {
  if (!document.querySelector('.layout')) {
    app.innerHTML = `
      <div class="layout">
        <header class="topbar">
          <a class="brand" href="#/">${LOGO}<span>Stackmoor</span></a>
          <nav class="topnav" aria-label="Stackmoor">
            ${NAV.map(([k, href, label]) => `<a href="${href}" data-nav="${k}">${t(label)}</a>`).join('')}
          </nav>
          <div class="top-actions">
            <div class="search" id="search-box">
              <button type="button" class="search-toggle" id="search-toggle" aria-label="${esc(t('nav.search'))}">${svg(ICON.search, 20)}</button>
              <label for="stack-search" class="sr-only">${t('nav.search')}</label>
              <input type="search" id="stack-search" placeholder="${esc(t('nav.searchPh'))}" autocomplete="off" autocapitalize="off" spellcheck="false">
            </div>
            <a class="btn primary new-btn" href="#/new" aria-label="${esc(t('new.title'))}"><span class="lbl-long">${t('nav.newStack')}</span><span class="lbl-short">+</span></a>
            <a class="btn proxy-btn hide-mobile" href="#/proxy/new">${t('px.newBtn')}</a>
            <div class="acct" id="acct">
              <button type="button" id="acct-btn" aria-haspopup="menu" aria-expanded="false" aria-controls="acct-menu" aria-label="${esc(t('acct.title'))}">
                ${svg(ICON.user)}<span class="acct-label">${t('acct.title')}</span><span class="caret" aria-hidden="true">▾</span>
              </button>
              <div class="acct-menu" id="acct-menu" role="menu" hidden>
                <a role="menuitem" href="#/account">${svg(ICON.user, 16)}${t('acct.settings')}</a>
                <div class="row-item">${svg(ICON.moon, 16)}<span>${t('acct.theme')}</span>
                  <span class="seg" role="group" aria-label="${esc(t('acct.theme'))}">
                    <button type="button" data-theme-set="light">${t('acct.light')}</button>
                    <button type="button" data-theme-set="dark">${t('acct.dark')}</button>
                  </span></div>
                <hr>
                <button type="button" role="menuitem" class="item logout" id="logout">${svg(ICON.logout, 16)}${t('nav.logout')}</button>
              </div>
            </div>
          </div>
        </header>
        <div id="update-banner"></div>
        <div id="global-warning"></div>
        <div class="content" id="content"></div>
        <div class="dock">
          <footer class="statusbar" id="statusbar" aria-label="${esc(t('bar.label'))}"></footer>
          <nav class="bottom-nav" aria-label="Stackmoor">
            ${NAV.map(([k, href, label, icon]) => `<a href="${href}" data-nav="${k}">${svg(ICON[icon], 20)}${t(label)}</a>`).join('')}
          </nav>
        </div>
      </div>`;
    bindShell();
  }
  const r = route();
  document.querySelectorAll('[data-nav]').forEach((a) => {
    const on = a.dataset.nav === r.nav;
    a.classList.toggle('on', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  document.getElementById('acct').classList.toggle('on', r.page === 'account');
  drawThemeButtons();
  renderUpdateBadge();
  renderGlobalWarning();
  renderStatusbar();
}

function drawThemeButtons() {
  const cur = currentTheme();
  document.querySelectorAll('[data-theme-set]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.themeSet === cur)));
}

function bindShell() {
  const btn = document.getElementById('acct-btn');
  const menu = document.getElementById('acct-menu');
  const close = () => { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
    btn.setAttribute('aria-expanded', String(!menu.hidden));
  });
  document.addEventListener('click', (e) => { if (!menu.hidden && !menu.contains(e.target)) close(); });
  menu.addEventListener('click', (e) => { if (e.target.closest('a')) close(); });
  menu.querySelectorAll('[data-theme-set]').forEach((b) => b.addEventListener('click', () => {
    setTheme(b.dataset.themeSet);
    drawThemeButtons();
  }));
  document.getElementById('logout').addEventListener('click', logout);

  // Search: filters the stack cards and the stack list; Enter opens the first match.
  const box = document.getElementById('search-box');
  const input = document.getElementById('stack-search');
  input.addEventListener('input', () => {
    state.search = input.value.trim().toLowerCase();
    const r = route();
    if (r.page === 'home') renderHome();
    else if (r.page === 'stack') renderStackList();
    else if (state.search) location.hash = '#/';
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const hit = filteredStacks()[0];
      if (hit) { location.hash = `#/stack/${hit.name}`; input.blur(); box.classList.remove('open'); }
    }
    if (e.key === 'Escape') { input.value = ''; state.search = ''; input.dispatchEvent(new Event('input')); input.blur(); box.classList.remove('open'); }
  });
  document.getElementById('search-toggle').addEventListener('click', () => {
    box.classList.toggle('open');
    if (box.classList.contains('open')) input.focus();
  });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k' && document.getElementById('stack-search')) {
      e.preventDefault();
      box.classList.add('open');
      input.focus();
      input.select();
    }
    if (e.key === 'Escape') close();
  });
}

const filteredStacks = () => {
  const q = state.search || '';
  return q ? state.stacks.filter((s) => s.name.includes(q)) : state.stacks;
};

/** Sets up the area under the top bar for a page and returns its <main>. */
function frame(kind, opts = {}) {
  const content = document.getElementById('content');
  if (kind === 'stack') {
    if (!content.querySelector('.stack-layout')) {
      content.innerHTML = `
        <div class="stack-layout">
          <aside class="stack-side" aria-label="${esc(t('home.title'))}">
            <a class="back" href="#/">← ${t('stack.allStacks')}</a>
            <ul class="stack-list" id="stack-list"></ul>
          </aside>
          <div class="stack-main"><main class="main" id="main"></main></div>
        </div>`;
    }
    renderStackList();
  } else if (kind === 'sub') {
    content.innerHTML = `
      <div class="subpage">
        <nav class="subnav" aria-label="${esc(opts.label)}">
          ${opts.items.map((x) => x.soon
            ? `<a aria-disabled="true">${esc(x.label)} <span class="tag soon">${t('net.soon')}</span></a>`
            : `<a href="${x.href}" class="${x.on ? 'on' : ''}"${x.on ? ' aria-current="page"' : ''}>${esc(x.label)}</a>`).join('')}
        </nav>
        <main class="main" id="main"></main>
      </div>`;
  } else {
    content.innerHTML = '<main class="main" id="main"></main>';
  }
  return document.getElementById('main');
}

function renderGlobalWarning() {
  const warn = document.getElementById('global-warning');
  if (!warn) return;
  // Tunnels that are down – the apps behind them have no internet (kill switch).
  const down = {};
  for (const s of state.stacks || []) {
    if (s.vpn && !s.vpn.ok) (down[s.vpn.tunnel] ||= []).push(s.name);
  }
  warn.innerHTML = (state.stacksDirOk === false
    ? `<div class="notice error global">${t('warn.stacksDir', { dir: esc(state.stacksDir) })}</div>`
    : '')
    + Object.entries(down).map(([tunnel, names]) => `<div class="notice error global plain">${t('vpn.warnDown', { name: esc(tunnel), stacks: names.map(esc).join(', ') })}
        <a href="#/network">${t('vpn.warnOpen')}</a></div>`).join('');
}

const stackTags = (s) => (s.updateAvailable ? `<span class="tag solid" title="${esc(t('upd.stackBadge'))}">↑ ${t('dash.new')}</span>` : '')
  + (s.vpn ? `<span class="tag ${s.vpn.ok ? '' : 'bad'}" title="${esc(t(s.vpn.ok ? 'vpn.tagOk' : 'vpn.tagDown', { name: s.vpn.tunnel }))}">VPN${s.vpn.ok ? '' : ' ✕'}</span>` : '');

function renderStackList() {
  const list = document.getElementById('stack-list');
  if (!list) return;
  const current = route().name;
  const items = filteredStacks();
  const addr = state.overview?.addresses || {};
  list.innerHTML = items.length
    ? items.map((s) => `
      <li><a href="#/stack/${esc(s.name)}" class="${s.name === current ? 'active' : ''}"${s.name === current ? ' aria-current="page"' : ''} title="${esc(stateLabel(s.state))}">
        <span class="l1"><span class="dot ${s.state}"></span>${esc(s.name)}${stackTags(s)}</span>
        <span class="l2">${s.total ? `${s.running}/${s.total}` : esc(stateLabel(s.state))}${addr[s.name] ? ` · ${esc(addr[s.name])}` : ''}</span>
      </a></li>`).join('')
    : `<li class="empty-hint">${t(state.search ? 'nav.noMatch' : 'nav.noStacks')}</li>`;
}

// ---------- status bar ----------

const ago = (iso) => {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return t('vpn.agoS', { n: s });
  if (s < 3600) return t('vpn.agoM', { n: Math.round(s / 60) });
  if (s < 86400 * 2) return t('vpn.agoH', { n: Math.round(s / 3600) });
  return t('vpn.agoD', { n: Math.round(s / 86400) });
};

function renderStatusbar() {
  const bar = document.getElementById('statusbar');
  if (!bar) return;
  const o = state.overview;
  const parts = [];
  if (o?.domain?.enabled) {
    const d = o.domain;
    parts.push(`<a href="#/domains"><span class="${d.running ? 'ok' : 'bad'}">${d.running ? '●' : '✕'}</span> <span class="lbl-long">${t(d.running ? 'bar.caddyOk' : 'bar.caddyDown')}</span><span class="lbl-short">Caddy</span></a>`);
    parts.push(`<a href="#/domains"><span class="${d.certificate ? 'ok' : ''}">${d.certificate ? '✓' : '…'}</span> <span class="lbl-long">${d.certificate ? t('bar.cert', { domain: esc(d.domain) }) : t('bar.certWaiting')}</span><span class="lbl-short">${t('bar.certShort')}</span></a>`);
  }
  (o?.vpn || []).slice(0, 3).forEach((v, i) => {
    const ok = v.state === 'up';
    const cls = ok ? 'ok' : v.state === 'down' ? 'bad' : '';
    parts.push(`<a href="#/network"${i ? ' class="hide-mobile"' : ''}><span class="${cls}">${v.state === 'down' ? '✕' : '●'}</span> <span class="lbl-long">${t('bar.vpn', { name: esc(v.name), state: t(`vpn.state.${v.state}`) })}</span><span class="lbl-short">VPN</span></a>`);
  });
  const watched = (o?.proxies || []).filter((x) => x.monitor && x.ok !== null);
  if (watched.length) {
    const okN = watched.filter((x) => x.ok).length;
    parts.push(`<a href="#/"><span class="${okN === watched.length ? 'ok' : 'bad'}">●</span> ${t('bar.proxies', { n: okN, total: watched.length })}</a>`);
  }
  if (o?.backup?.configured) {
    const b = o.backup;
    const txt = b.running ? t('bar.backupRunning')
      : b.last ? `${b.last.ok ? '' : '✕ '}${t('bar.backup', { ago: ago(b.last.at) })}${b.lastSize ? ` · ${fmtBytes(b.lastSize)}` : ''}`
        : t('bar.backupNever');
    const short = b.running ? '…' : b.last ? ago(b.last.at) : '—';
    parts.push(`<a href="#/backups"><span class="lbl-long">${txt}</span><span class="lbl-short">${t('bar.backupShort', { ago: short })}</span></a>`);
  }
  const p = state.updates?.panel;
  const ver = p?.updateAvailable
    ? `<button type="button" class="ver-upd" id="bar-upd">${esc(state.version)} → ${esc(p.buildUpdate ? t('upd.newBuildShort') : showVersion(p.latest))} ↑</button>`
    : `<span class="ver">${esc(state.version)}</span>`;
  bar.innerHTML = parts.map((x) => `<span${x.includes('hide-mobile') ? ' class="hide-mobile"' : ''}>${x}</span>`).join('') + ver;
  document.getElementById('bar-upd')?.addEventListener('click', openUpdateDialog);
}

async function refreshOverview() {
  try {
    state.overview = await api('GET', '/api/overview');
    renderStatusbar();
    renderStackList();
    if (route().page === 'home') renderHome();
  } catch { /* e.g. logged out */ }
}

let refreshTick = 0;
async function refreshStacks() {
  try {
    state.stacks = await api('GET', '/api/stacks');
    renderStackList();
    renderGlobalWarning();
    if (route().page === 'home') renderHome();
    refreshTick += 1;
    if (refreshTick % 3 === 0) refreshOverview();
  } catch { /* e.g. logged out */ }
}

// ---------- pages ----------

/** Restart or start a stack from its card, without leaving the dashboard. */
const busyStacks = new Map();
async function quickAction(name, act, btn) {
  busyStacks.set(name, act);
  btn.disabled = true;
  btn.textContent = `${t(`act.${act}`)}…`;
  const code = await stream('POST', `/api/stacks/${name}/actions/${act}`, () => {}).catch(() => 1);
  busyStacks.delete(name);
  toast(t(code === 0 ? 'act.done' : 'act.failed', { action: `${t(`act.${act}`)} · ${name}` }));
  await refreshStacks();
  refreshOverview();
}

function eventText(e) {
  if (e.type === 'proxy') return t(e.ok ? 'px.evUp' : 'px.evDown', { name: esc(e.name) });
  if (e.type === 'backup') {
    const kind = t(`bak.kind.${e.kind}`);
    if (e.stack) return `${kind} – ${esc(e.stack)}`;
    return e.stacks ? `${kind} – ${t('bak.runStacks', { n: e.stacks })}` : kind;
  }
  return `${t(`act.${e.action}`)} – ${esc(e.stack)}`;
}

function renderHome() {
  if (route().page !== 'home') return;
  const main = document.getElementById('main') || frame('page');
  const o = state.overview || {};
  const addr = o.addresses || {};
  const per = o.backup?.perStack || {};
  const items = filteredStacks();
  const running = state.stacks.filter((s) => s.state === 'running').length;
  const upd = state.stacks.filter((s) => s.updateAvailable).length;
  const summary = [t('dash.running', { n: running, total: state.stacks.length })];
  if (upd) summary.push(t('dash.updates', { n: upd }));

  if (!state.stacks.length) {
    main.innerHTML = `<div class="card strong"><h2>${t('home.emptyTitle')}</h2>
      <p class="hint">${t('home.emptyLead')}</p>
      <p><a class="btn primary" href="#/new">${t('home.emptyCta')}</a></p></div>${proxySection(o)}`;
    return;
  }
  // Keep focus and scroll while the cards refresh every few seconds.
  const scroll = window.scrollY;
  main.innerHTML = `
    <div class="dash-head"><h1>${t('home.title')}</h1><p class="hint">${summary.join(' · ')}</p>
      ${o.domain?.enabled ? `<a class="dash-px-link" href="#/proxy/new">${t('px.newBtn')}</a>` : ''}</div>
    ${items.length ? `<div class="stack-cards">${items.map((s) => {
      const b = per[s.name];
      const act = s.updateAvailable ? 'update' : s.state === 'running' || s.state === 'partial' ? 'restart' : 'up';
      return `
      <article class="stack-card ${s.updateAvailable ? 'upd' : ''}">
        <div class="top"><span class="dot ${s.state}" title="${esc(stateLabel(s.state))}"></span>
          <h3><a href="#/stack/${esc(s.name)}">${esc(s.name)}</a></h3>${s.updateAvailable ? `<span class="tag solid">${t('dash.update')}</span>` : s.vpn ? `<span class="tag ${s.vpn.ok ? '' : 'bad'}">VPN · ${esc(s.vpn.tunnel)}</span>` : ''}</div>
        <dl>
          <dt>${t('dash.containers')}</dt><dd>${s.total ? `${s.running}/${s.total} ` : ''}${esc(stateLabel(s.state))}</dd>
          <dt>${t('dash.address')}</dt><dd>${addr[s.name] ? esc(addr[s.name]) : '—'}</dd>
          ${o.backup?.configured ? `<dt>${t('dash.backup')}</dt><dd>${b ? `${ago(b.at)}${b.size ? ` · ${fmtBytes(b.size)}` : ''}` : '—'}</dd>` : ''}
        </dl>
        <div class="acts">
          ${busyStacks.has(s.name)
            ? `<button type="button" class="btn" disabled>${t(`act.${busyStacks.get(s.name)}`)}…</button>`
            : `<button type="button" class="btn ${act === 'update' ? 'primary' : ''}" data-quick="${act}" data-name="${esc(s.name)}">${t(`act.${act}`)}</button>`}
          <a class="btn" href="#/stack/${esc(s.name)}">${t('dash.open')}</a>
        </div>
      </article>`;
    }).join('')}</div>` : `<p class="hint">${t('nav.noMatch')}</p>`}
    ${proxySection(o)}
    ${o.events?.length ? `
      <section><h2>${t('dash.events')}</h2>
        <div class="events">${o.events.map((e) => `
          <div><time datetime="${esc(e.at)}">${esc(fmtShort(e.at))}</time><span>${eventText(e)}</span>
            <span class="res ${e.status === 'running' ? '' : e.ok ? 'ok' : 'bad'}">${e.status === 'running' ? t('dash.evRunning') : e.ok ? `✓ ${t('dash.evOk')}` : `✕ ${t('dash.evFailed')}`}</span></div>`).join('')}
        </div></section>` : ''}`;
  window.scrollTo(0, scroll);
  main.querySelectorAll('[data-quick]').forEach((b) => b.addEventListener('click', () => {
    const name = b.dataset.name;
    if (b.dataset.quick === 'update') {
      // Updating shows its output on the stack page (and asks first).
      state.pendingAction = { name, act: 'update' };
      location.hash = `#/stack/${name}`;
      return;
    }
    quickAction(name, b.dataset.quick, b);
  }));
}

// ---------- proxies (servers outside Stackmoor) ----------

const filteredProxies = (o) => {
  const q = state.search || '';
  const list = o?.proxies || [];
  return q ? list.filter((x) => x.name.toLowerCase().includes(q) || (x.address || '').includes(q)) : list;
};

function proxySection(o) {
  const list = filteredProxies(o);
  if (!list.length) return '';
  const watched = (o.proxies || []).filter((x) => x.monitor && x.ok !== null);
  const okCount = watched.filter((x) => x.ok).length;
  return `
    <section class="px-section" aria-labelledby="px-h">
      <div class="dash-head"><h1 id="px-h">${t('px.title')}</h1>
        <p class="hint">${t('px.lead')}${watched.length ? ` · ${t('px.okOf', { n: okCount, total: watched.length })}` : ''}</p>
        <a class="dash-more" href="#/proxy/new">+ ${t('px.add')}</a></div>
      <div class="stack-cards">${list.map((x) => {
        const st = x.monitor === false || x.ok === null ? '' : x.ok ? 'running' : 'exited';
        const stateText = x.monitor === false ? t('px.notWatched')
          : x.ok === null ? t('px.checking')
            : x.ok ? t('px.up', { ms: x.ms ?? '—' }) : t('px.down', { ago: x.since ? ago(x.since).replace(/^\s+/, '') : '' });
        return `
        <article class="stack-card proxy-card ${x.ok === false ? 'down' : ''}">
          <div class="top"><span class="dot ${st}"></span><h3><a href="#/proxy/${x.id}">${esc(x.name)}</a></h3><span class="tag proxy">${t('px.tag')}</span></div>
          <dl>
            <dt>${t('px.target')}</dt><dd><code>${esc(x.target)}</code></dd>
            <dt>${t('dash.address')}</dt><dd>${x.address ? esc(x.address) : '—'}</dd>
            <dt>${t('px.state')}</dt><dd class="${st === 'running' ? 'ok-text' : st === 'exited' ? 'bad-text' : ''}">${stateText}</dd>
          </dl>
          <div class="acts">
            <a class="btn" href="#/proxy/${x.id}">${t('px.edit')}</a>
            ${x.address ? `<a class="btn" href="https://${esc(x.address)}" target="_blank" rel="noopener">${t('dash.open')} ↗</a>` : ''}
          </div>
        </article>`;
      }).join('')}</div>
    </section>`;
}

async function renderProxyForm(id) {
  const main = frame('page');
  main.innerHTML = `<p class="hint">${t('stack.loading')}</p>`;
  let d;
  let list;
  try {
    [d, list] = await Promise.all([api('GET', '/api/domains'), api('GET', '/api/proxies')]);
  } catch (err) {
    main.innerHTML = errorBox(err);
    return;
  }
  if (route().page !== 'proxy') return;
  const cur = id ? list.find((x) => x.id === id) : null;
  if (id && !cur) { main.innerHTML = `<div class="notice error">${t('px.notFound')}</div>`; return; }
  const p = cur || { name: '', subdomain: '', scheme: 'https', host: '', port: '', insecure: true, hostHeader: false, monitor: true };
  main.innerHTML = `
    <a class="back-link" href="#/">← ${t('px.back')}</a>
    <div class="head"><div class="ht"><h1>${cur ? esc(cur.name) : t('px.newTitle')}</h1><p class="lead">${t('px.formLead')}</p></div></div>
    ${!d.domain ? `<div class="card"><p class="hint" style="margin-top:0">${t('px.needDomain')}</p><a class="btn" href="#/domains">${t('route.goSettings')}</a></div>` : `
    <div class="two-col">
      <form class="card strong wide" id="px-form" novalidate>
        <div class="row field" style="align-items:flex-start">
          <div style="flex:1;min-width:200px"><label for="px-name">${t('px.name')}</label>
            <input type="text" id="px-name" value="${esc(p.name)}" maxlength="40" placeholder="proxmox" autocomplete="off"></div>
          <div style="flex:1;min-width:220px"><label for="px-sub">${t('dash.address')}</label>
            <div class="row" style="flex-wrap:nowrap;gap:6px"><input type="text" id="px-sub" value="${esc(p.subdomain)}" placeholder="proxmox" autocapitalize="off" autocomplete="off" style="flex:1;min-width:0">
              <span class="hint" style="margin:0;white-space:nowrap">.${esc(d.domain)}</span></div></div>
        </div>
        <div class="field"><label for="px-host">${t('px.targetLabel')}</label>
          <div class="px-target">
            <select id="px-scheme" class="lang" aria-label="${esc(t('px.scheme'))}">
              <option value="https" ${p.scheme === 'https' ? 'selected' : ''}>https://</option>
              <option value="http" ${p.scheme === 'http' ? 'selected' : ''}>http://</option>
            </select>
            <input type="text" id="px-host" value="${esc(p.host)}" placeholder="192.168.1.10" autocapitalize="off" autocomplete="off" spellcheck="false">
            <input type="number" id="px-port" value="${esc(p.port)}" placeholder="${esc(t('route.port'))}" min="1" max="65535" aria-label="${esc(t('route.port'))}">
          </div>
          <p class="hint">${t('px.targetHint')}</p></div>
        <label class="check field" id="px-insecure-row"><input type="checkbox" id="px-insecure" ${p.insecure ? 'checked' : ''}>
          <span>${t('px.insecure')} <span class="hint">${t('px.insecureHint')}</span></span></label>
        <details class="field" ${p.hostHeader || !p.monitor ? 'open' : ''}><summary>${t('px.advanced')}</summary>
          <label class="check" style="margin-top:10px"><input type="checkbox" id="px-hosthdr" ${p.hostHeader ? 'checked' : ''}>
            <span>${t('px.hostHeader')} <span class="hint">${t('px.hostHeaderHint')}</span></span></label>
          <label class="check" style="margin-top:8px"><input type="checkbox" id="px-monitor" ${p.monitor ? 'checked' : ''}>
            <span>${t('px.monitor')}</span></label>
        </details>
        <div class="px-check field">
          <button type="button" class="btn small" id="px-check" style="border-color:var(--text);font-weight:600">${t('px.check')}</button>
          <span id="px-check-out" class="hint" style="margin:0"></span>
        </div>
        <div id="px-out"></div>
        <div class="row">
          <button class="btn primary" type="submit">${cur ? t('edit.save') : t('px.saveNew')}</button>
          <a class="btn" href="#/">${t('bak.cancel')}</a>
          ${cur ? `<button type="button" class="btn danger" id="px-del" style="margin-left:auto">${t('px.remove')}</button>` : ''}
        </div>
      </form>
      <aside class="card">
        <h2>${t('px.afterTitle')}</h2>
        <ol class="px-after">
          <li>${t('px.after1', { domain: esc(d.domain) })}</li>
          <li>${t('px.after2')}</li>
          <li>${t('px.after3')}</li>
        </ol>
        <p class="hint">${t('px.afterNote')}</p>
      </aside>
    </div>`}`;
  if (!d.domain) return;
  const val = (x) => document.getElementById(x).value;
  const body = () => ({
    name: val('px-name'), subdomain: val('px-sub'), scheme: val('px-scheme'), host: val('px-host'), port: Number(val('px-port')),
    insecure: document.getElementById('px-insecure').checked,
    hostHeader: document.getElementById('px-hosthdr').checked,
    monitor: document.getElementById('px-monitor').checked,
  });
  const syncScheme = () => { document.getElementById('px-insecure-row').hidden = val('px-scheme') !== 'https'; };
  document.getElementById('px-scheme').addEventListener('change', syncScheme);
  syncScheme();
  // The address follows the name until it is typed by hand.
  const sub = document.getElementById('px-sub');
  let subTouched = Boolean(p.subdomain);
  sub.addEventListener('input', () => { subTouched = true; });
  document.getElementById('px-name').addEventListener('input', (e) => {
    if (!subTouched) sub.value = e.target.value.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63);
  });
  document.getElementById('px-check').addEventListener('click', async (e) => {
    const out = document.getElementById('px-check-out');
    e.target.disabled = true;
    out.className = 'hint';
    out.textContent = t('px.checking');
    try {
      const r = await api('POST', '/api/proxies/check', body());
      out.className = r.ok ? 'ok-text' : 'bad-text';
      out.textContent = r.ok
        ? `✓ ${t('px.checkOk', { ms: r.ms })}${r.tls ? ` · ${t(`px.tls.${r.tls}`)}` : ''}`
        : `✕ ${t('px.checkFail', { error: r.error })}`;
    } catch (err) {
      out.className = 'bad-text';
      out.textContent = err.message;
    }
    e.target.disabled = false;
  });
  document.getElementById('px-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const out = document.getElementById('px-out');
    try {
      if (cur) await api('PUT', `/api/proxies/${cur.id}`, body());
      else await api('POST', '/api/proxies', body());
      toast(t('toast.saved'));
      await refreshOverview();
      location.hash = '#/';
    } catch (err) {
      out.innerHTML = errorBox(err);
    }
  });
  document.getElementById('px-del')?.addEventListener('click', async () => {
    if (!confirm(t('px.removeConfirm', { name: cur.name }))) return;
    try {
      await api('DELETE', `/api/proxies/${cur.id}`);
      toast(t('toast.done'));
      await refreshOverview();
      location.hash = '#/';
    } catch (err) {
      document.getElementById('px-out').innerHTML = errorBox(err);
    }
  });
}

const fmtShort = (iso) => new Date(iso).toLocaleString(lang === 'pl' ? 'pl-PL' : 'en-GB', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

function renderNew() {
  const main = frame('page');
  main.innerHTML = `
    <div class="head"><h1>${t('new.title')}</h1></div>
    <form id="new" class="card">
      <div class="field"><label for="name">${t('new.name')}</label>
        <input type="text" id="name" placeholder="${esc(t('new.namePlaceholder'))}" required pattern="[a-z0-9][a-z0-9_\\-]*" autocapitalize="off" autocomplete="off">
        <p class="hint">${t('new.nameHint')}</p></div>
      <div class="field"><label for="compose">compose.yaml</label>
        <textarea id="compose" class="code" spellcheck="false">${esc(NEW_STACK_TEMPLATE)}</textarea>
        <p class="hint">${t('new.composeHint')}</p></div>
      <div class="field"><label for="env">.env <span class="hint">${t('new.envOptional')}</span></label>
        <textarea id="env" class="code env" spellcheck="false" placeholder="TZ=Europe/Warsaw"></textarea></div>
      <label class="check field"><input type="checkbox" id="auto" checked>
        <span>${t('auto.label')} <span class="hint">${t('auto.hintNew')}</span></span></label>
      <div id="out"></div>
      <div class="row">
        <button class="btn" type="submit" data-start="0">${t('new.create')}</button>
        <button class="btn primary" type="submit" data-start="1">${t('new.createStart')}</button>
      </div>
    </form>`;
  enableTabKey(document.getElementById('compose'));
  document.getElementById('new').addEventListener('submit', async (e) => {
    e.preventDefault();
    const start = e.submitter?.dataset.start === '1';
    const out = document.getElementById('out');
    const name = document.getElementById('name').value.trim();
    try {
      const res = await api('POST', '/api/stacks', {
        name,
        compose: document.getElementById('compose').value,
        env: document.getElementById('env').value,
        autoVolumes: document.getElementById('auto').checked,
      });
      state.pendingNotice = { name, result: res, autostart: start };
      await refreshStacks();
      location.hash = `#/stack/${name}`;
    } catch (err) {
      out.innerHTML = errorBox(err);
    }
  });
}

/**
 * Addresses where a stack's app can be opened: its domains when it has any,
 * otherwise the published TCP ports on the address the panel is opened from.
 */
function openTargets(routesInfo, containers) {
  return buildTargets({
    domain: routesInfo?.domain,
    routes: routesInfo?.routes,
    containers,
    hostname: location.hostname,
    serverIp: state.overview?.serverIp,
  });
}

// Close an open "Open" menu when clicking anywhere else.
document.addEventListener('click', (e) => {
  document.querySelectorAll('details.open-menu[open]').forEach((d) => { if (!d.contains(e.target) || e.target.closest('.menu a')) d.open = false; });
});

/** The "Open" button next to Start/Restart…: one link, or a small menu when there are several. */
async function fillOpenButton(name, containers) {
  const info = await api('GET', `/api/stacks/${name}/routes`).catch(() => null);
  const slot = document.getElementById('open-slot');
  if (!slot) return;
  const urls = openTargets(info, containers);
  const label = (u) => esc(u.replace(/^https?:\/\//, ''));
  if (!urls.length) slot.innerHTML = '';
  else if (urls.length === 1) {
    slot.innerHTML = `<a class="btn primary" href="${esc(urls[0])}" target="_blank" rel="noopener" title="${esc(urls[0])}">${t('act.openApp')} ↗</a>`;
  } else {
    slot.innerHTML = `<details class="open-menu"><summary class="btn primary">${t('act.openApp')} ▾</summary>
      <div class="menu">${urls.map((u) => `<a href="${esc(u)}" target="_blank" rel="noopener">${label(u)} ↗</a>`).join('')}</div></details>`;
  }
}

async function renderStack(name) {
  const main = frame('stack');
  main.innerHTML = `<p class="hint">${t('stack.loading')}</p>`;
  let data;
  try {
    data = await api('GET', `/api/stacks/${name}`);
  } catch (err) {
    main.innerHTML = errorBox(err);
    return;
  }
  const summary = state.stacks.find((s) => s.name === name) || { state: 'down' };

  const notRunning = summary.state !== 'running';
  main.innerHTML = `
    <a class="back-mobile" href="#/">← ${t('stack.allStacks')}</a>
    <div class="head">
      <h1>${esc(name)}</h1>
      <span class="badge ${summary.state}" id="badge">● ${esc(stateLabel(summary.state))}${summary.total ? ` · ${summary.running}/${summary.total}` : ''}</span>
      <div class="actions">
        ${notRunning ? `<button class="btn" data-act="up">${t('act.up')}</button>` : ''}
        <button class="btn" data-act="restart">${t('act.restart')}</button>
        <button class="btn" data-act="update" title="${esc(t('act.updateTitle'))}">${t('act.update')}</button>
        <button class="btn" data-act="stop">${t('act.stop')}</button>
        <button class="btn hide-mobile" data-act="down" title="${esc(t('act.downTitle'))}">${t('act.down')}</button>
        <span id="open-slot"></span>
      </div>
    </div>
    <div id="notice"></div>
    <div id="op-wrap" hidden><h2 id="op-title">${t('act.operation')}</h2><pre class="terminal" id="op"></pre><br></div>
    <div class="tabs" role="tablist">
      ${['compose', 'env', 'domain', 'vpn', 'containers', 'logs', 'backups', 'history', 'delete']
        .map((k, i) => `<button data-tab="${k}" class="${i === 0 ? 'on' : ''}${k === 'delete' ? ' del' : ''}">${t(`tab.${k}`)}</button>`).join('')}
    </div>
    <div id="tab"></div>`;

  let autostart = false;
  if (state.pendingNotice?.name === name) {
    document.getElementById('notice').innerHTML = notices(state.pendingNotice.result);
    autostart = state.pendingNotice.autostart;
    state.pendingNotice = null;
  }
  const newImages = (state.updates?.stacks?.[name]?.images || []).filter((i) => i.updateAvailable);
  if (summary.updateAvailable && newImages.length) {
    document.getElementById('notice').insertAdjacentHTML('beforeend', `
      <div class="notice info" id="stack-upd-box"><strong>${t('upd.stackTitle')}</strong>
        <ul>${newImages.map((i) => `<li>${esc(i.svc)}: ${esc(i.image)}</li>`).join('')}</ul>
        <p class="hint" style="margin:8px 0">${t('upd.stackLead')}</p>
        <button class="btn primary small" id="stack-upd">${t('act.update')}</button>
      </div>`);
  }

  let currentTab = 'compose';
  const tab = document.getElementById('tab');
  let routesInfo = null;

  // Cards next to the editor: containers, addresses and the latest backups of this stack.
  const sideCards = () => {
    const cts = data.containers || [];
    const urls = [...new Set([...openTargets(routesInfo, cts), ...openTargets(null, cts)])];
    const dom = state.overview?.domain;
    const hasDomainUrl = urls.some((u) => u.startsWith('https://') && dom?.domain && u.endsWith(dom.domain));
    return `
      <section class="side-card"><h2>${t('side.containers')}</h2>
        ${cts.length ? cts.map((c) => `<div class="item"><span class="dot ${c.state === 'running' ? 'running' : 'exited'}" title="${esc(c.status)}"></span><strong>${esc(c.service)}</strong>
          <span class="r" title="${esc(c.image)}">${esc(c.image.replace(/^docker\.io\//, ''))}</span></div>`).join('')
        : `<div class="body hint">${t('ct.empty')}</div>`}</section>
      <section class="side-card"><h2>${t('side.addresses')}</h2>
        <div class="body">${urls.length ? urls.map((u) => `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(u.replace(/^https?:\/\//, ''))} ↗</a>`).join('') : `<span class="hint">${t('side.noAddress')}</span>`}
          ${hasDomainUrl ? `<span class="ok">${dom.certificate ? `✓ ${t('side.certOk')}` : t('dom.certWaiting')}</span>` : ''}</div></section>
      ${state.overview?.backup?.configured ? `<section class="side-card"><h2>${t('side.backups')} <button type="button" id="side-bak-all">${t('side.all')} →</button></h2>
        <div id="side-bak"><div class="body hint">${t('stack.loading')}</div></div></section>` : ''}`;
  };
  const fillSideBackups = async () => {
    const box = document.getElementById('side-bak');
    if (!box) return;
    const list = await api('GET', `/api/backups/snapshots?stack=${encodeURIComponent(name)}`).catch(() => null);
    if (!box.isConnected) return;
    box.innerHTML = list?.length
      ? list.slice(0, 3).map((sn) => `<div class="item"><span>${esc(fmtShort(sn.time))}</span>${sn.preUpdate ? `<span class="tag soon">${t('bak.preUpdate')}</span>` : ''}<span class="r">${fmtBytes(sn.size)}</span></div>`).join('')
      : `<div class="body hint">${t('bak.noSnapshots')}</div>`;
  };

  const tabs = {
    compose() {
      tab.innerHTML = `
        <div class="compose-grid">
        <div class="card">
          <textarea id="ed" class="code" spellcheck="false">${esc(data.compose)}</textarea>
          <label class="check" style="margin-top:12px"><input type="checkbox" id="auto" ${data.autoVolumes ? 'checked' : ''}>
            <span>${t('auto.label')} <span class="hint">${t('auto.hint')}</span></span></label>
          <div id="save-out" style="margin-top:12px"></div>
          <div class="row" style="margin-top:12px">
            <button class="btn" id="save">${t('edit.save')}</button>
            <button class="btn primary" id="save-up">${t('edit.saveStart')}</button>
            <span class="hint hide-mobile">${t('edit.ctrlS')}</span>
          </div>
        </div>
        <div class="side-cards" id="side-cards">${sideCards()}</div>
        </div>`;
      fillSideBackups();
      tab.querySelector('#side-bak-all')?.addEventListener('click', () => showTab('backups'));
      const ed = document.getElementById('ed');
      const doSave = async (thenUp) => {
        const out = document.getElementById('save-out');
        const auto = document.getElementById('auto').checked;
        try {
          const res = await api('PUT', `/api/stacks/${name}`, { compose: ed.value, env: data.env, autoVolumes: auto });
          data.compose = res.compose;
          data.autoVolumes = auto;
          ed.value = res.compose;
          out.innerHTML = notices(res);
          toast(t('edit.saved'));
          if (thenUp) runAction('up');
        } catch (err) {
          out.innerHTML = errorBox(err);
        }
      };
      enableTabKey(ed, () => doSave(false));
      document.getElementById('save').addEventListener('click', () => doSave(false));
      document.getElementById('save-up').addEventListener('click', () => doSave(true));
    },

    env() {
      tab.innerHTML = `
        <div class="card">
          <textarea id="ed" class="code env" style="min-height:260px" spellcheck="false" placeholder="KEY=value">${esc(data.env)}</textarea>
          <p class="hint">${t('env.hint')}</p>
          <div id="save-out"></div>
          <button class="btn primary" id="save">${t('edit.save')}</button>
        </div>`;
      const ed = document.getElementById('ed');
      const doSave = async () => {
        const out = document.getElementById('save-out');
        try {
          await api('PUT', `/api/stacks/${name}`, { compose: data.compose, env: ed.value, autoVolumes: data.autoVolumes });
          data.env = ed.value;
          out.innerHTML = '';
          toast(t('env.saved'));
        } catch (err) {
          out.innerHTML = errorBox(err);
        }
      };
      enableTabKey(ed, doSave);
      document.getElementById('save').addEventListener('click', doSave);
    },

    async containers() {
      tab.innerHTML = `<p class="hint">${t('stack.loading')}</p>`;
      const fresh = await api('GET', `/api/stacks/${name}`).catch(() => data);
      data.containers = fresh.containers;
      if (currentTab !== 'containers') return;
      tab.innerHTML = data.containers.length ? `
        <div class="card" style="padding:6px 8px; overflow-x:auto"><table>
          <thead><tr><th>${t('ct.service')}</th><th>${t('ct.state')}</th><th>${t('ct.image')}</th><th>${t('ct.ports')}</th></tr></thead>
          <tbody>${data.containers.map((c) => `
            <tr><td><strong>${esc(c.service)}</strong><br><span class="hint">${esc(c.name)}</span></td>
              <td><span class="badge ${c.state === 'running' ? 'running' : 'exited'}">${esc(c.state)}</span><br><span class="hint">${esc(c.status)}</span></td>
              <td><code>${esc(c.image)}</code></td>
              <td>${c.ports.map((p) => `<code>${esc(p)}</code>`).join('<br>') || '<span class="hint">—</span>'}</td></tr>`).join('')}
          </tbody></table></div>`
        : `<div class="card hint">${t('ct.empty')}</div>`;
    },

    logs() {
      const services = [...new Set((data.containers || []).map((c) => c.service).filter(Boolean))].sort();
      tab.innerHTML = `
        <div class="row" style="margin-bottom:10px">
          ${services.length > 1 ? `<select id="log-svc" class="lang" aria-label="${esc(t('logs.service'))}">
            <option value="">${t('logs.allServices')}</option>
            ${services.map((x) => `<option value="${esc(x)}">${esc(x)}</option>`).join('')}
          </select>` : ''}
          <label class="check" style="margin:0"><input type="checkbox" id="follow" checked> ${t('logs.live')}</label>
          <button class="btn small" id="reload">${t('logs.refresh')}</button>
        </div>
        <pre class="terminal tall" id="logs"></pre>`;
      const pre = document.getElementById('logs');
      const load = () => {
        stopStream();
        pre.textContent = '';
        const ctl = new AbortController();
        state.abort = ctl;
        const follow = document.getElementById('follow').checked ? 1 : 0;
        const svc = document.getElementById('log-svc')?.value || '';
        stream('GET', `/api/stacks/${name}/logs?tail=300&follow=${follow}${svc ? `&service=${encodeURIComponent(svc)}` : ''}`, (txt) => appendTo(pre, txt), ctl.signal)
          .catch((err) => { if (err.name !== 'AbortError') appendTo(pre, `\n${err.message}\n`); });
      };
      document.getElementById('reload').addEventListener('click', load);
      document.getElementById('follow').addEventListener('change', load);
      document.getElementById('log-svc')?.addEventListener('change', load);
      load();
    },

    async backups() {
      tab.innerHTML = `<p class="hint">${t('stack.loading')}</p>`;
      const b = await api('GET', '/api/backups').catch(() => null);
      if (currentTab !== 'backups') return;
      if (!b?.config?.configured) {
        tab.innerHTML = `<div class="card"><p class="hint">${t('bak.notConfigured')}</p>
          <a class="btn" href="#/backups">${t('bak.goSettings')}</a></div>`;
        return;
      }
      tab.innerHTML = `
        <div class="card">
          <div class="row"><button type="button" class="btn primary" id="sb-run">${t('bak.runStack')}</button>
            <span class="hint">${t('bak.stackLead')}</span></div>
          <pre class="terminal" id="sb-log" hidden></pre>
        </div>
        <div class="card"><div class="row" style="justify-content:space-between;margin-bottom:8px"><h2 style="margin:0">${t('bak.snapshots')}</h2>
          <button type="button" class="btn small" id="sb-refresh" title="${esc(t('bak.refreshTitle'))}">${t('logs.refresh')}</button></div>
          <div id="sb-snaps"><p class="hint">${t('stack.loading')}</p></div></div>
        <form class="card" id="sb-ex-form">
          <h2>${t('bak.exTitle')}</h2>
          <p class="hint" style="margin-top:-4px">${t('bak.exLead', { dir: esc(`${state.stacksDir || '/opt/stacks'}/${name}`) })}</p>
          <textarea id="sb-ex" class="code env" spellcheck="false" placeholder="data/app/cache&#10;data/*/thumbs"></textarea>
          <p class="hint">${t('bak.exHint')}</p>
          <div id="sb-ex-out"></div>
          <button class="btn">${t('set.save')}</button>
        </form>`;
      api('GET', `/api/stacks/${name}/backup-excludes`).then((r) => {
        const ta = document.getElementById('sb-ex');
        if (ta) ta.value = r.excludes.join('\n');
      }).catch(() => {});
      document.getElementById('sb-ex-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const out = document.getElementById('sb-ex-out');
        try {
          const r = await api('PUT', `/api/stacks/${name}/backup-excludes`, { excludes: document.getElementById('sb-ex').value });
          document.getElementById('sb-ex').value = r.excludes.join('\n');
          out.innerHTML = '';
          toast(t('set.saved'));
        } catch (err) {
          out.innerHTML = errorBox(err);
        }
      });
      const loadSnaps = async (fresh = false) => {
        const box = document.getElementById('sb-snaps');
        if (fresh) box.innerHTML = `<p class="hint">${t('stack.loading')}</p>`;
        const list = await api('GET', `/api/backups/snapshots?stack=${encodeURIComponent(name)}${fresh ? '&fresh=1' : ''}`)
          .catch((err) => { box.innerHTML = errorBox(err); return null; });
        if (list && currentTab === 'backups') {
          snapshotsTable(box, list, {
            showStack: false,
            onRestored: (target) => { if (target !== name) location.hash = `#/stack/${target}`; else loadSnaps(); },
          });
        }
      };
      const runBtn = document.getElementById('sb-run');
      const follow = () => {
        runBtn.disabled = true;
        watchBackupJob(document.getElementById('sb-log'), (st) => {
          runBtn.disabled = false;
          toast(t(st.history?.[0]?.ok ? 'toast.done' : 'toast.failed'));
          loadSnaps();
        });
      };
      runBtn.addEventListener('click', async () => {
        try { await api('POST', `/api/stacks/${name}/backup`); } catch (err) { toast(err.message); return; }
        follow();
      });
      document.getElementById('sb-refresh').addEventListener('click', () => loadSnaps(true));
      if (b.status.running || b.status.queued) follow();
      loadSnaps();
    },

    async history() {
      const ops = await api('GET', `/api/stacks/${name}/operations`).catch(() => []);
      if (currentTab !== 'history') return;
      const STATUS = { ok: 'running', error: 'exited', running: 'partial', interrupted: 'exited' };
      tab.innerHTML = ops.length ? `
        <div class="card" style="padding:6px 8px"><table>
          <thead><tr><th>${t('hist.action')}</th><th>${t('hist.result')}</th><th>${t('hist.started')}</th><th></th></tr></thead>
          <tbody>${ops.map((o) => `<tr>
            <td>${esc(t(`act.${o.action}`))}</td>
            <td><span class="badge ${STATUS[o.status] || ''}">${esc(o.status)}</span></td>
            <td><span class="hint">${esc(o.started_at)} UTC</span></td>
            <td><button class="btn small" data-op="${o.id}">${t('hist.show')}</button></td></tr>`).join('')}
          </tbody></table></div><pre class="terminal" id="op-out" hidden></pre>`
        : `<div class="card hint">${t('hist.empty')}</div>`;
      tab.querySelectorAll('[data-op]').forEach((b) => b.addEventListener('click', async () => {
        const op = await api('GET', `/api/operations/${b.dataset.op}`);
        const pre = document.getElementById('op-out');
        pre.hidden = false;
        pre.textContent = op.output || t('hist.noOutput');
        pre.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }));
    },

    async vpn() {
      tab.innerHTML = `<p class="hint">${t('stack.loading')}</p>`;
      let info;
      try {
        info = await api('GET', `/api/stacks/${name}/vpn`);
      } catch (err) {
        tab.innerHTML = errorBox(err);
        return;
      }
      if (currentTab !== 'vpn') return;
      if (!info.tunnels.length) {
        tab.innerHTML = `<div class="card"><h2>${t('vpn.stackTitle')}</h2><p class="hint">${t('vpn.noTunnels')}</p>
          <a class="btn" href="#/network">${t('vpn.goSettings')}</a></div>`;
        return;
      }
      const cur = info.attach || { tunnel: '', services: [] };
      tab.innerHTML = `
        <form class="card" id="vpn-form">
          <h2>${t('vpn.stackTitle')}</h2>
          <p class="hint" style="margin-top:-4px">${t('vpn.stackLead')}</p>
          <div class="field"><label for="vpn-tunnel">${t('vpn.tunnel')}</label>
            <select id="vpn-tunnel" class="lang">
              <option value="">${t('vpn.none')}</option>
              ${info.tunnels.map((x) => `<option value="${esc(x.name)}" ${x.name === cur.tunnel ? 'selected' : ''}>${esc(x.name)} – ${t(`vpn.state.${x.state}`)}</option>`).join('')}
            </select></div>
          <div class="field" id="vpn-svcs">
            <label>${t('vpn.services')}</label>
            ${info.services.map((sv) => `<label class="check"><input type="checkbox" value="${esc(sv.name)}" ${cur.services.includes(sv.name) ? 'checked' : ''} ${sv.hostNetwork ? 'disabled' : ''}>
              <span><strong>${esc(sv.name)}</strong>${sv.ports.length ? ` <span class="hint">${t('vpn.portsMove', { ports: esc(sv.ports.join(', ')) })}</span>` : ''}${sv.hostNetwork ? ` <span class="hint">${t('vpn.hostNet')}</span>` : ''}</span></label>`).join('')}
            <p class="hint">${t('vpn.servicesHint')}</p>
          </div>
          <div class="notice info" style="margin-bottom:12px">${t('vpn.killSwitchNote')}</div>
          <div id="vpn-out"></div>
          <button class="btn primary">${t('vpn.saveApply')}</button>
        </form>
        <div id="vpn-op" hidden><pre class="terminal" id="vpn-term"></pre></div>`;
      const sync = () => {
        const off = !document.getElementById('vpn-tunnel').value;
        document.querySelectorAll('#vpn-svcs input').forEach((el) => { if (!el.hasAttribute('data-host')) el.closest('label').style.opacity = off ? 0.5 : 1; });
      };
      document.getElementById('vpn-tunnel').addEventListener('change', sync);
      sync();
      document.getElementById('vpn-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const tunnel = document.getElementById('vpn-tunnel').value;
        const services = [...document.querySelectorAll('#vpn-svcs input:checked')].map((el) => el.value);
        const out = document.getElementById('vpn-out');
        if (tunnel && !services.length) { out.innerHTML = `<div class="notice error">${t('vpn.pickService')}</div>`; return; }
        out.innerHTML = '';
        e.submitter.disabled = true;
        const pre = document.getElementById('vpn-term');
        document.getElementById('vpn-op').hidden = false;
        pre.textContent = '';
        const code = await stream('PUT', `/api/stacks/${name}/vpn`, (txt) => appendTo(pre, txt), undefined, { tunnel: tunnel || null, services })
          .catch((err) => { appendTo(pre, `\n${err.message}\n`); return 1; });
        e.submitter.disabled = false;
        toast(t(code === 0 ? 'toast.done' : 'toast.failed'));
        refreshStacks();
      });
    },

    async domain() {
      tab.innerHTML = `<p class="hint">${t('stack.loading')}</p>`;
      let info;
      try {
        info = await api('GET', `/api/stacks/${name}/routes`);
      } catch (err) {
        tab.innerHTML = errorBox(err);
        return;
      }
      if (currentTab !== 'domain') return;
      if (!info.domain) {
        tab.innerHTML = `<div class="card"><p class="hint">${t('route.noDomain')}</p>
          <a class="btn" href="#/domains">${t('route.goSettings')}</a></div><div id="pub-box"></div>`;
        publicCard(document.getElementById('pub-box'), name, info.services || []);
        return;
      }
      let rows = info.routes.length ? info.routes.map((r) => ({ ...r })) : [];
      const svcOptions = (sel) => info.services.map((sv) =>
        `<option value="${esc(sv.name)}" ${sv.name === sel ? 'selected' : ''}>${esc(sv.name)}</option>`).join('');
      const suggestedPort = (svc) => info.services.find((x) => x.name === svc)?.ports?.[0] || '';
      const draw = () => {
        tab.innerHTML = `
          <div class="card">
            <h2>${t('route.title')}</h2>
            <p class="hint" style="margin-top:-4px">${t('route.lead', { domain: esc(info.domain) })}</p>
            <div id="route-rows">
              ${rows.map((r, i) => `
                <div class="route-row" data-i="${i}">
                  <div class="route-host"><input type="text" class="r-sub" value="${esc(r.subdomain)}" aria-label="${esc(t('route.subdomain'))}" placeholder="${esc(name)}" autocapitalize="off"><span>.${esc(info.domain)}</span></div>
                  <select class="r-svc lang" aria-label="${esc(t('route.service'))}">${svcOptions(r.service)}</select>
                  <input type="number" class="r-port" value="${esc(r.port)}" min="1" max="65535" aria-label="${esc(t('route.port'))}" placeholder="${esc(t('route.port'))}">
                  <button type="button" class="btn small danger r-del" aria-label="${esc(t('route.remove'))}">✕</button>
                </div>`).join('') || `<p class="hint">${t('route.none')}</p>`}
            </div>
            <p class="hint">${t('route.portHint')}</p>
            <div id="route-out"></div>
            <div class="row">
              <button type="button" class="btn" id="route-add">${t('route.add')}</button>
              <button type="button" class="btn primary" id="route-save">${t('edit.save')}</button>
            </div>
          </div>
          ${info.routes.length ? `<div class="card"><h2>${t('route.open')}</h2><ul class="link-list">${info.routes.map((r) =>
            `<li><a href="https://${esc(r.subdomain)}.${esc(info.domain)}" target="_blank" rel="noopener">https://${esc(r.subdomain)}.${esc(info.domain)}</a></li>`).join('')}</ul></div>` : ''}
          <div id="pub-box"></div>`;
        publicCard(document.getElementById('pub-box'), name, info.services || []);
        const read = () => {
          rows = [...tab.querySelectorAll('.route-row')].map((el) => ({
            subdomain: el.querySelector('.r-sub').value.trim().toLowerCase(),
            service: el.querySelector('.r-svc').value,
            port: Number(el.querySelector('.r-port').value),
          }));
        };
        tab.querySelectorAll('.r-svc').forEach((sel) => sel.addEventListener('change', (e) => {
          const port = e.target.closest('.route-row').querySelector('.r-port');
          if (!port.value) port.value = suggestedPort(e.target.value);
        }));
        tab.querySelectorAll('.r-del').forEach((b) => b.addEventListener('click', (e) => {
          read();
          rows.splice(Number(e.target.closest('.route-row').dataset.i), 1);
          draw();
        }));
        document.getElementById('route-add').addEventListener('click', () => {
          read();
          const svc = info.services[0]?.name || '';
          rows.push({ subdomain: rows.length ? '' : name, service: svc, port: suggestedPort(svc) });
          draw();
        });
        document.getElementById('route-save').addEventListener('click', async (e) => {
          read();
          e.target.disabled = true;
          const out = document.getElementById('route-out');
          out.innerHTML = `<p class="hint">${t('route.applying')}</p>`;
          try {
            const r = await api('PUT', `/api/stacks/${name}/routes`, { routes: rows });
            info.routes = r.routes;
            rows = r.routes.map((x) => ({ ...x }));
            draw();
            // The Open button and the Addresses card follow the new subdomains at once.
            routesInfo = { ...(routesInfo || {}), domain: info.domain, routes: r.routes };
            fillOpenButton(name, data.containers);
            refreshOverview();
            if (r.applied) toast(t('edit.saved'));
            else document.getElementById('route-out').innerHTML = `<div class="notice error">${esc(r.log.trim().split('\n').slice(-6).join('\n'))}</div>`;
          } catch (err) {
            out.innerHTML = errorBox(err);
            e.target.disabled = false;
          }
        });
      };
      draw();
    },

    delete() {
      tab.innerHTML = `
        <div class="card">
          <h2>${t('del.title')}</h2>
          <p class="hint">${t('del.lead')}</p>
          <div class="field"><label for="confirm">${t('del.confirm', { name: esc(name) })}</label>
            <input type="text" id="confirm" autocomplete="off" autocapitalize="off"></div>
          <div id="del-out"></div>
          <button class="btn danger" id="del">${t('del.button')}</button>
        </div>`;
      document.getElementById('del').addEventListener('click', async () => {
        try {
          await api('DELETE', `/api/stacks/${name}`, { confirm: document.getElementById('confirm').value });
          toast(t('del.done'));
          await refreshStacks();
          location.hash = '#/';
        } catch (err) {
          document.getElementById('del-out').innerHTML = errorBox(err);
        }
      });
    },
  };

  const showTab = (k) => {
    if (currentTab === 'logs' && k !== 'logs') stopStream();
    currentTab = k;
    main.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === k));
    revealActiveTab(main.querySelector('.tabs'), true);
    tabs[k]();
  };
  main.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

  async function runAction(act) {
    const buttons = main.querySelectorAll('[data-act]');
    buttons.forEach((b) => (b.disabled = true));
    const wrap = document.getElementById('op-wrap');
    const pre = document.getElementById('op');
    const title = document.getElementById('op-title');
    const label = t(`act.${act}`);
    title.textContent = `${label}…`;
    wrap.hidden = false;
    pre.textContent = '';
    try {
      const code = await stream('POST', `/api/stacks/${name}/actions/${act}`, (txt) => appendTo(pre, txt));
      title.textContent = t(code === 0 ? 'act.done' : 'act.failed', { action: label });
      toast(t(code === 0 ? 'toast.done' : 'toast.failed'));
    } catch (err) {
      appendTo(pre, `\n${err.message}\n`);
    } finally {
      buttons.forEach((b) => (b.disabled = false));
      await refreshStacks();
      // Pick up the new "update available" flags, then drop the stale update notice if this stack is current.
      state.updates = await api('GET', '/api/updates').catch(() => state.updates);
      if (!state.stacks.find((x) => x.name === name)?.updateAvailable) document.getElementById('stack-upd-box')?.remove();
      const s = state.stacks.find((x) => x.name === name);
      const badge = document.getElementById('badge');
      if (s && badge) {
        badge.className = `badge ${s.state}`;
        badge.textContent = `● ${stateLabel(s.state)}${s.total ? ` · ${s.running}/${s.total}` : ''}`;
      }
      refreshOverview();
      // compose.yaml may have gained volumes declared by the image
      const fresh = await api('GET', `/api/stacks/${name}`).catch(() => null);
      if (fresh) {
        data.compose = fresh.compose;
        data.containers = fresh.containers;
        if (currentTab === 'compose' || currentTab === 'containers') tabs[currentTab]();
        fillOpenButton(name, data.containers);
      }
    }
  }
  main.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.act === 'down' && !confirm(t('act.downConfirm'))) return;
    runAction(b.dataset.act);
  }));

  document.getElementById('stack-upd')?.addEventListener('click', () => {
    if (!confirm(t('upd.stackConfirm', { name }))) return;
    document.getElementById('stack-upd-box')?.remove();
    runAction('update');
  });

  tabs.compose();
  api('GET', `/api/stacks/${name}/routes`).then((info) => {
    routesInfo = info;
    if (currentTab === 'compose' && document.getElementById('side-cards')) {
      document.getElementById('side-cards').innerHTML = sideCards();
      fillSideBackups();
      tab.querySelector('#side-bak-all')?.addEventListener('click', () => showTab('backups'));
    }
  }).catch(() => {});
  fillOpenButton(name, data.containers);
  if (autostart) runAction('up');
  if (state.pendingAction?.name === name) {
    const { act } = state.pendingAction;
    state.pendingAction = null;
    if (act !== 'update' || confirm(t('upd.stackConfirm', { name }))) runAction(act);
  }
}

// Scroll a tab bar sideways so its active tab is centred (only the bar moves, never the page).
function revealActiveTab(nav, smooth = false) {
  const on = nav?.querySelector('.on');
  if (!on) return;
  const left = nav.scrollLeft + on.getBoundingClientRect().left - nav.getBoundingClientRect().left
    - (nav.clientWidth - on.offsetWidth) / 2;
  nav.scrollTo({ left: Math.max(0, left), behavior: smooth ? 'smooth' : 'auto' });
}

const SETTINGS_TABS = ['panel', 'updates', 'server', 'notify', 'folders'];

async function renderSettings(tab = 'panel') {
  if (!SETTINGS_TABS.includes(tab)) tab = 'panel';
  const main = frame('sub', {
    label: t('set.title'),
    items: SETTINGS_TABS.map((k) => ({ href: `#/settings/${k}`, label: t(`set.tab.${k}`), on: k === tab })),
  });
  main.innerHTML = `<div class="head"><h1>${t(`set.tab.${tab}`)}</h1></div><div id="set-body"><p class="hint">${t('stack.loading')}</p></div>`;
  const body = document.getElementById('set-body');
  try {
    if (tab === 'panel') return await settingsPanel(body);
    if (tab === 'server') return await settingsServer(body);
    if (tab === 'notify') return await settingsNotify(body);
    const s = await api('GET', '/api/settings');
    if (route().tab !== tab) return;
    (tab === 'updates' ? settingsUpdates : settingsGeneral)(body, s);
  } catch (err) {
    body.innerHTML = errorBox(err);
  }
}

/** Plain pages: Backups, Domains, Account. */
async function renderPage(page) {
  const main = frame('page');
  const titles = { backups: 'nav.backups', domains: 'nav.domains', account: 'acct.settings' };
  main.innerHTML = `<div class="head"><div class="ht"><h1>${t(titles[page])}</h1><p class="lead" id="page-lead"></p></div></div><div id="set-body"><p class="hint">${t('stack.loading')}</p></div>`;
  const body = document.getElementById('set-body');
  if (page === 'backups') return settingsBackups(body);
  if (page === 'domains') return settingsDomains(body);
  return settingsAccount(body);
}

/** Network: VPN now, Pangolin later. */
function renderNetwork(tab = 'vpn') {
  if (tab !== 'pangolin') tab = 'vpn';
  const main = frame('sub', {
    label: t('nav.network'),
    items: [
      { href: '#/network/vpn', label: 'VPN', on: tab === 'vpn' },
      { href: '#/network/pangolin', label: 'Pangolin', on: tab === 'pangolin' },
    ],
  });
  const title = tab === 'vpn' ? 'VPN' : 'Pangolin';
  main.innerHTML = `<div class="head"><div class="ht"><h1>${title}</h1><p class="lead">${t(tab === 'vpn' ? 'vpn.lead' : 'pg.lead')}</p></div></div><div id="set-body"><p class="hint">${t('stack.loading')}</p></div>`;
  (tab === 'vpn' ? settingsVpn : settingsPangolin)(document.getElementById('set-body'));
}

// ---------- Pangolin ----------

async function settingsPangolin(body, extra = {}) {
  let d;
  try {
    d = await api('GET', '/api/pangolin');
  } catch (err) {
    body.innerHTML = errorBox(err);
    return;
  }
  if (route().tab !== 'pangolin') return;
  const c = d.config;
  const st = d.status || {};
  const field = (id, label, value, hint, type = 'text', ph = '') => `
    <div class="field"><label for="${id}">${t(label)}</label>
      <input id="${id}" type="${type}" value="${type === 'password' ? '' : esc(value || '')}" placeholder="${esc(type === 'password' ? value || '' : ph)}" autocomplete="off" autocapitalize="off">
      ${hint ? `<p class="hint">${t(hint)}</p>` : ''}</div>`;
  const pill = (ok, onText, offText) => `<span class="badge ${ok ? 'running' : 'exited'}">${t(ok ? onText : offText)}</span>`;
  const siteBox = !c.configured ? '' : `
    <div class="card">
      <h2>${t('pg.siteTitle')}</h2>
      ${st.connected ? `
        <div class="kv">
          <span>Newt</span><span>${pill(st.container === 'running', 'pg.running', 'pg.notRunning')}</span>
          <span>${t('pg.inPangolin')}</span><span>${st.online === null ? '—' : pill(st.online, 'pg.online', 'pg.offline')}</span>
        </div>
        ${st.error ? `<div class="notice warn">${esc(st.error.vars?.message || st.error.vars?.error || '')}</div>` : ''}
        <div class="row">
          <button type="button" class="btn" id="pg-connect">${t('pg.restartNewt')}</button>
          <button type="button" class="btn danger" id="pg-disconnect">${t('pg.disconnect')}</button>
        </div>`
    : `<p class="hint" style="margin-top:-4px">${t('pg.siteLead')}</p>
        <button type="button" class="btn primary" id="pg-connect">${t('pg.connect')}</button>`}
      <div id="pg-op" hidden><pre class="terminal" id="pg-term"></pre></div>
      <div id="pg-site-out"></div>
    </div>`;
  const list = !d.routes?.length ? '' : `
    <div class="card" style="padding:6px 8px; overflow-x:auto">
      <h2 style="margin:10px 12px 4px">${t('pg.addresses')}</h2>
      <table><thead><tr><th>${t('pg.address')}</th><th>${t('au.stack')}</th><th>${t('pg.login')}</th><th></th></tr></thead>
      <tbody>${d.routes.map((r) => `<tr>
        <td><a href="https://${esc(r.fullDomain)}" target="_blank" rel="noopener">${esc(r.fullDomain)}</a></td>
        <td><a href="#/stack/${esc(r.stack)}">${esc(r.stack)}</a> <span class="hint">${esc(r.service)}:${esc(r.port)}</span></td>
        <td>${r.sso ? `<span class="tag">${t('pg.ssoOn')}</span>` : `<span class="tag bad">${t('pg.ssoOff')}</span>`}</td>
        <td><button type="button" class="btn small danger pg-del" data-id="${r.id}">${t('nt.delete')}</button></td></tr>`).join('')}</tbody></table>
      <div id="pg-list-out"></div>
    </div>`;
  body.innerHTML = `
    <form class="card" id="pg-form">
      <h2>${t('pg.connTitle')}</h2>
      <p class="hint" style="margin-top:-4px">${t('pg.connLead')}</p>
      ${field('pg-endpoint', 'pg.endpoint', c.endpoint, 'pg.endpointHint', 'text', 'https://pangolin.example.com')}
      ${field('pg-api', 'pg.apiUrl', c.apiUrl, 'pg.apiUrlHint', 'text', 'https://api.pangolin.example.com/v1')}
      <div class="row field" style="align-items:flex-start">
        <div style="flex:1;min-width:160px">${field('pg-org', 'pg.orgId', c.orgId, '', 'text', 'my-org')}</div>
        <div style="flex:2;min-width:200px">${field('pg-key', 'pg.apiKey', c.apiKey, '', 'password')}</div>
      </div>
      <p class="hint">${t('pg.keyHint')}</p>
      ${extra.domains ? `<div class="notice">${t('pg.domainsFound', { list: esc(extra.domains.map((x) => x.baseDomain).join(', ') || '—') })}</div>` : ''}
      <div id="pg-out"></div>
      <button class="btn primary">${t('pg.saveCheck')}</button>
    </form>
    ${siteBox}
    ${list}`;

  document.getElementById('pg-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const out = document.getElementById('pg-out');
    out.innerHTML = `<p class="hint">${t('pg.checking')}</p>`;
    try {
      const r = await api('PUT', '/api/pangolin', {
        endpoint: document.getElementById('pg-endpoint').value,
        apiUrl: document.getElementById('pg-api').value,
        orgId: document.getElementById('pg-org').value,
        apiKey: document.getElementById('pg-key').value,
      });
      toast(t('set.saved'));
      settingsPangolin(body, { domains: r.domains });
    } catch (err) {
      out.innerHTML = errorBox(err);
    }
  });
  document.getElementById('pg-connect')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    const pre = document.getElementById('pg-term');
    document.getElementById('pg-op').hidden = false;
    pre.textContent = '';
    const code = await stream('POST', '/api/pangolin/connect', (txt) => appendTo(pre, txt)).catch((err) => { appendTo(pre, `\n${err.message}\n`); return 1; });
    toast(t(code === 0 ? 'toast.done' : 'toast.failed'));
    if (code === 0) setTimeout(() => { if (route().tab === 'pangolin') settingsPangolin(body); }, 3000);
    else e.target.disabled = false;
  });
  body.querySelectorAll('.pg-del').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm(t('pg.deleteConfirm'))) return;
    b.disabled = true;
    try { await api('DELETE', `/api/pangolin/routes/${b.dataset.id}`); settingsPangolin(body); } catch (err) {
      document.getElementById('pg-list-out').innerHTML = errorBox(err);
      b.disabled = false;
    }
  }));
  document.getElementById('pg-disconnect')?.addEventListener('click', async (e) => {
    if (!confirm(t('pg.disconnectConfirm', { n: d.routes?.length || 0 }))) return;
    e.target.disabled = true;
    try {
      await api('DELETE', '/api/pangolin');
      toast(t('toast.done'));
      settingsPangolin(body);
    } catch (err) {
      document.getElementById('pg-site-out').innerHTML = errorBox(err);
      e.target.disabled = false;
    }
  });
}

/** The stack's Domain tab: public addresses through Pangolin. */
async function publicCard(box, name, services) {
  if (!box) return;
  let d;
  try {
    d = await api('GET', `/api/stacks/${name}/public`);
  } catch (err) {
    box.innerHTML = `<div class="card">${errorBox(err)}</div>`;
    return;
  }
  if (!box.isConnected) return;
  if (!d.connected) {
    box.innerHTML = `<div class="card"><h2>${t('pg.publicTitle')}</h2><p class="hint" style="margin-top:-4px">${t('pg.publicOff')}</p>
      <a class="btn" href="#/network/pangolin">${t('pg.goSettings')}</a></div>`;
    return;
  }
  const doms = d.domains || [];
  const svcOptions = services.map((sv) => `<option value="${esc(sv.name)}">${esc(sv.name)}</option>`).join('');
  const port0 = services[0]?.ports?.[0] || '';
  box.innerHTML = `
    <div class="card">
      <h2>${t('pg.publicTitle')}</h2>
      <p class="hint" style="margin-top:-4px">${t('pg.publicLead')}</p>
      ${d.routes.length ? `<div class="nt-list">${d.routes.map((r) => `
        <div class="nt-row" data-id="${r.id}">
          <div class="nt-name"><a href="https://${esc(r.fullDomain)}" target="_blank" rel="noopener"><strong>https://${esc(r.fullDomain)}</strong></a><span class="hint">${esc(r.service)}:${esc(r.port)}</span></div>
          <label class="check"><input type="checkbox" class="pub-sso" ${r.sso ? 'checked' : ''}> ${t('pg.login')}</label>
          <button type="button" class="btn danger pub-del">${t('nt.delete')}</button>
        </div>`).join('')}</div>` : `<p class="hint">${t('pg.noPublic')}</p>`}
      ${!doms.length ? `<div class="notice warn">${t('pg.noDomains')}</div>` : `
      <form id="pub-form" class="nt-form" style="margin-top:14px">
        <h3>${t('pg.addPublic')}</h3>
        <div class="route-row">
          <div class="route-host pub-host"><input type="text" id="pub-sub" value="${esc(name)}" aria-label="${esc(t('route.subdomain'))}" autocapitalize="off">
            <span>.</span><select id="pub-dom" class="lang">${doms.map((x) => `<option value="${esc(x.domainId)}" data-type="${esc(x.type)}">${esc(x.baseDomain)}</option>`).join('')}</select></div>
          <select id="pub-svc" class="lang" aria-label="${esc(t('route.service'))}">${svcOptions}</select>
          <input type="number" id="pub-port" value="${esc(port0)}" min="1" max="65535" aria-label="${esc(t('route.port'))}" placeholder="${esc(t('route.port'))}">
        </div>
        <label class="check field"><input type="checkbox" id="pub-sso" checked> <span>${t('pg.ssoLabel')}</span></label>
        <div id="pub-out"></div>
        <button class="btn primary">${t('pg.addPublicBtn')}</button>
      </form>`}
      <div id="pub-list-out"></div>
    </div>`;
  const refresh = () => publicCard(box, name, services);
  box.querySelector('#pub-svc')?.addEventListener('change', (e) => {
    document.getElementById('pub-port').value = services.find((x) => x.name === e.target.value)?.ports?.[0] || '';
  });
  // A CNAME domain in Pangolin is used as it is – no subdomain.
  const domSel = box.querySelector('#pub-dom');
  const syncSub = () => {
    const cname = domSel.selectedOptions[0]?.dataset.type === 'cname';
    const sub = document.getElementById('pub-sub');
    sub.disabled = cname;
    sub.nextElementSibling.hidden = cname;
  };
  domSel?.addEventListener('change', syncSub);
  if (domSel) syncSub();
  box.querySelector('#pub-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const sso = document.getElementById('pub-sso').checked;
    if (!sso && !confirm(t('pg.ssoOffConfirm'))) return;
    const btn = e.target.querySelector('.btn.primary');
    btn.disabled = true;
    try {
      await api('POST', `/api/stacks/${name}/public`, {
        subdomain: document.getElementById('pub-sub').disabled ? '' : document.getElementById('pub-sub').value,
        domainId: domSel.value,
        service: document.getElementById('pub-svc').value,
        port: Number(document.getElementById('pub-port').value),
        sso,
      });
      toast(t('pg.added'));
      refresh();
    } catch (err) {
      document.getElementById('pub-out').innerHTML = errorBox(err);
      btn.disabled = false;
    }
  });
  box.querySelectorAll('.nt-row[data-id]').forEach((row) => {
    const id = row.dataset.id;
    row.querySelector('.pub-sso').addEventListener('change', async (e) => {
      if (!e.target.checked && !confirm(t('pg.ssoOffConfirm'))) { e.target.checked = true; return; }
      try { await api('PUT', `/api/pangolin/routes/${id}`, { sso: e.target.checked }); toast(t('set.saved')); } catch (err) {
        e.target.checked = !e.target.checked;
        document.getElementById('pub-list-out').innerHTML = errorBox(err);
      }
    });
    row.querySelector('.pub-del').addEventListener('click', async (e) => {
      if (!confirm(t('pg.deleteConfirm'))) return;
      e.target.disabled = true;
      try { await api('DELETE', `/api/pangolin/routes/${id}`); refresh(); } catch (err) {
        document.getElementById('pub-list-out').innerHTML = errorBox(err);
        e.target.disabled = false;
      }
    });
  });
}

function settingsGeneral(body, s) {
  body.innerHTML = `
    <form class="card" id="settings">
      <h2>${t('set.folders')}</h2>
      <p class="hint" style="margin-top:-4px">${t('set.foldersLead', { dir: esc(s.stacksDir) })}</p>
      <div class="row field">
        <div style="flex:1;min-width:120px"><label for="puid">${t('set.puid')}</label><input type="number" id="puid" value="${esc(s.puid)}"></div>
        <div style="flex:1;min-width:120px"><label for="pgid">${t('set.pgid')}</label><input type="number" id="pgid" value="${esc(s.pgid)}"></div>
      </div>
      <div class="field"><label for="allow">${t('set.allow')}</label>
        <textarea id="allow" class="code env" spellcheck="false">${esc(s.hostPathAllowlist.join('\n'))}</textarea>
        <p class="hint">${t('set.allowHint')}</p></div>
      <div id="s-out"></div>
      <button class="btn primary">${t('set.save')}</button>
    </form>`;
  document.getElementById('settings').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('PUT', '/api/settings', {
        puid: Number(document.getElementById('puid').value),
        pgid: Number(document.getElementById('pgid').value),
        hostPathAllowlist: document.getElementById('allow').value.split('\n'),
      });
      document.getElementById('s-out').innerHTML = '';
      toast(t('set.saved'));
    } catch (err) {
      document.getElementById('s-out').innerHTML = errorBox(err);
    }
  });
}

const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString(lang === 'pl' ? 'pl-PL' : 'en-GB') : t('upd.never'));
const showVersion = (v) => (!v ? '' : /^\d/.test(v) ? `v${v}` : v);

function settingsUpdates(body, s) {
  const u = state.updates || {};
  const p = u.panel || {};
  const mode = u.self?.mode || 'none';
  const stackNames = u.stacksWithUpdates || [];

  let panelBox = '';
  if (p.updateAvailable) {
    const howTo = mode === 'compose'
      ? `<button class="btn primary" id="upd-apply">${t('upd.apply')}</button>`
      : `<p class="hint">${t(`upd.how.${mode}`, { tag: esc(u.self?.tag || '') })}</p>`;
    panelBox = `
      <div class="notice info">
        <strong>${p.buildUpdate ? t('upd.newBuild') : t('upd.newVersion', { version: esc(showVersion(p.latest)) })}</strong>
        ${p.notes ? `<pre class="release-notes">${esc(p.notes)}</pre>` : ''}
        ${p.url ? `<p><a href="${esc(p.url)}" target="_blank" rel="noopener">${t('upd.releaseLink')}</a></p>` : ''}
        ${howTo}
      </div>`;
  } else if (p.pending) {
    panelBox = `<div class="notice info">${t('upd.pending', { version: esc(showVersion(p.latest)) })}</div>`;
  } else if (p.checkedAt) {
    panelBox = `<p class="hint">${p.error ? t('upd.checkError') : t('upd.upToDate')}</p>`;
  }

  body.innerHTML = `
    <div class="card">
      <h2>Stackmoor</h2>
      <div class="kv">
        <span>${t('upd.current')}</span><strong>${esc(showVersion(p.current || state.version.replace(/^v/, '')))}</strong>
        <span>${t('upd.latest')}</span><strong>${esc(showVersion(p.latest) || '—')}</strong>
        <span>${t('upd.lastCheck')}</span><span>${esc(fmtDate(u.lastRun))}</span>
      </div>
      ${panelBox}
      <div id="upd-out"></div>
      <button class="btn" id="upd-check">${t(u.checking ? 'upd.checking' : 'upd.checkNow')}</button>
    </div>

    <div class="card">
      <h2>${t('upd.stacksTitle')}</h2>
      ${stackNames.length
        ? `<p class="hint">${t('upd.stacksLead')}</p><ul class="link-list">${stackNames.map((n) => `<li><a href="#/stack/${esc(n)}">${esc(n)}</a></li>`).join('')}</ul>`
        : `<p class="hint">${u.lastRun ? t('upd.stacksNone') : t('upd.never')}</p>`}
    </div>

    <form class="card" id="upd-form">
      <h2>${t('upd.settingsTitle')}</h2>
      <label class="check field"><input type="checkbox" id="upd-on" ${s.updateCheck ? 'checked' : ''}>
        <span>${t('upd.autoCheck')}</span></label>
      <div class="field"><label for="upd-int">${t('upd.interval')}</label>
        <select id="upd-int" class="lang">
          <option value="daily" ${s.updateInterval === 'daily' ? 'selected' : ''}>${t('upd.daily')}</option>
          <option value="weekly" ${s.updateInterval === 'weekly' ? 'selected' : ''}>${t('upd.weekly')}</option>
        </select></div>
      <label class="check field"><input type="checkbox" id="upd-stacks" ${s.updateCheckStacks ? 'checked' : ''}>
        <span>${t('upd.checkStacks')} <span class="hint">${t('upd.checkStacksHint')}</span></span></label>
      <p class="hint">${t('upd.neverAuto')}</p>
      <div id="upd-form-out"></div>
      <button class="btn primary">${t('set.save')}</button>
    </form>

    <div id="au-box"></div>`;

  document.getElementById('upd-check').addEventListener('click', async (e) => {
    e.target.disabled = true;
    e.target.textContent = t('upd.checking');
    try {
      state.updates = await api('POST', '/api/updates/check');
      await refreshStacks();
      renderUpdateBadge();
      if (route().tab === 'updates') settingsUpdates(body, s);
    } catch (err) {
      document.getElementById('upd-out').innerHTML = errorBox(err);
      e.target.disabled = false;
      e.target.textContent = t('upd.checkNow');
    }
  });

  document.getElementById('upd-apply')?.addEventListener('click', openUpdateDialog);
  autoUpdateCard(document.getElementById('au-box'));

  document.getElementById('upd-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      Object.assign(s, await api('PUT', '/api/settings', {
        updateCheck: document.getElementById('upd-on').checked,
        updateInterval: document.getElementById('upd-int').value,
        updateCheckStacks: document.getElementById('upd-stacks').checked,
      }));
      document.getElementById('upd-form-out').innerHTML = '';
      toast(t('set.saved'));
    } catch (err) {
      document.getElementById('upd-form-out').innerHTML = errorBox(err);
    }
  });
}

// ---------- schedules (automatic updates, restarts) ----------

const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const scheduleFields = (prefix, c) => `
  <div class="field"><label>${t('bak.days')}</label>
    <div class="row days">${WEEK.map((x) => `<label class="check"><input type="checkbox" class="${prefix}-day" value="${x}" ${c.days.includes(x) ? 'checked' : ''}> ${esc(dayName(x))}</label>`).join('')}</div></div>
  <div class="field" style="max-width:180px"><label for="${prefix}-time">${t('bak.time')}</label>
    <input type="time" id="${prefix}-time" value="${esc(c.time)}"></div>
  <p class="hint field">${t('bak.timeZone', { zone: esc(browserZone()) })}</p>`;
const readSchedule = (prefix) => ({
  days: [...document.querySelectorAll(`.${prefix}-day:checked`)].map((x) => Number(x.value)),
  time: document.getElementById(`${prefix}-time`).value,
  timeZone: browserZone(),
});

// ---------- automatic stack updates ----------

let auTimer = null;
async function autoUpdateCard(box) {
  clearTimeout(auTimer);
  let d;
  try {
    d = await api('GET', '/api/autoupdate');
  } catch (err) {
    box.innerHTML = `<div class="card">${errorBox(err)}</div>`;
    return;
  }
  if (!box.isConnected) return;
  const c = d.config;
  const list = state.stacks || [];
  const isOn = (s) => s.state === 'running' || s.state === 'partial';
  const resultTag = (r) => `<span class="tag ${r.result === 'updated' ? 'solid' : 'bad'}">${t(`au.result.${r.result}`)}</span>`;
  box.innerHTML = `
    <form class="card" id="au-form">
      <h2>${t('au.title')}</h2>
      <p class="hint" style="margin-top:-4px">${t('au.lead')}</p>
      <label class="check field"><input type="checkbox" id="au-on" ${c.enabled ? 'checked' : ''}> <span>${t('au.enabled')}</span></label>
      ${scheduleFields('au', c)}
      <div class="field"><label>${t('au.stacks')}</label>
        ${list.length
          ? `<div class="au-list">${list.map((s) => `<label class="check"><input type="checkbox" class="au-stack" value="${esc(s.name)}" ${c.exclude.includes(s.name) ? '' : 'checked'}> <span>${esc(s.name)}${isOn(s) ? '' : ` <span class="hint">${t('au.stopped')}</span>`}</span></label>`).join('')}</div>`
          : `<p class="hint">${t('au.noStacks')}</p>`}
        <p class="hint">${t('au.stacksHint')}</p></div>
      <div class="notice">${t('au.how')}</div>
      <div id="au-out"></div>
      <div class="row">
        <button class="btn primary">${t('set.save')}</button>
        <button type="button" class="btn" id="au-run" ${d.running ? 'disabled' : ''}>${d.running
          ? esc(t('au.running', { stack: d.running.stack || '…' }))
          : t('au.runNow')}</button>
      </div>
    </form>
    <div class="card" style="padding:6px 8px; overflow-x:auto">
      <h2 style="margin:10px 12px 4px">${t('au.history')}</h2>
      ${d.runs.length ? `<table>
        <thead><tr><th>${t('au.when')}</th><th>${t('au.stack')}</th><th>${t('au.result')}</th></tr></thead>
        <tbody>${d.runs.map((r) => `
          <tr><td>${esc(fmtDate(r.at))}<br><span class="hint">${t(r.kind === 'scheduled' ? 'au.kind.scheduled' : 'au.kind.manual')}</span></td>
            <td><a href="#/stack/${esc(r.stack)}">${esc(r.stack)}</a>${(r.images || []).length ? `<br><span class="hint">${r.images.map((i) => `<code>${esc(i)}</code>`).join(' ')}</span>` : ''}</td>
            <td>${resultTag(r)}${r.reason ? `<br><span class="hint">${esc(r.reason)}</span>` : ''}</td></tr>`).join('')}</tbody>
      </table>` : `<p class="hint" style="margin:4px 12px 12px">${t('au.historyNone')}</p>`}
    </div>`;

  document.getElementById('au-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('PUT', '/api/autoupdate', {
        enabled: document.getElementById('au-on').checked,
        ...readSchedule('au'),
        exclude: [...document.querySelectorAll('.au-stack:not(:checked)')].map((x) => x.value),
      });
      document.getElementById('au-out').innerHTML = '';
      toast(t('set.saved'));
    } catch (err) {
      document.getElementById('au-out').innerHTML = errorBox(err);
    }
  });
  document.getElementById('au-run').addEventListener('click', async (e) => {
    if (!confirm(t('au.runConfirm'))) return;
    e.target.disabled = true;
    try {
      await api('POST', '/api/autoupdate/run');
      autoUpdateCard(box);
    } catch (err) {
      document.getElementById('au-out').innerHTML = errorBox(err);
      e.target.disabled = false;
    }
  });
  // While a run is going on, refresh the card until it ends.
  if (d.running) auTimer = setTimeout(() => { if (box.isConnected) autoUpdateCard(box); }, 5000);
}

// ---------- the server ----------

function fmtUptime(sec) {
  if (sec == null) return '—';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return d ? t('sys.uptimeDays', { d, h }) : t('sys.uptimeHours', { h, m });
}

async function settingsServer(body, fresh = false) {
  let d;
  try {
    d = await api('GET', `/api/system${fresh ? '?fresh=1' : ''}`);
  } catch (err) {
    body.innerHTML = errorBox(err);
    return;
  }
  if (route().tab !== 'server') return;
  const h = d.host;
  const p = h?.patches;
  const last = d.reboots?.[0];

  let patches = '';
  if (h && h.apt) {
    patches = `
      <div class="card">
        <h2>${t('sys.patchesTitle')}</h2>
        <p class="hint" style="margin-top:-4px">${t('sys.patchesLead')}</p>
        <div class="kv">
          <span>${t('sys.patchesState')}</span>
          <strong>${p.enabled ? t('sys.patchesOn') : p.installed ? t('sys.patchesOff') : t('sys.patchesMissing')}</strong>
        </div>
        <button type="button" class="btn ${p.enabled ? '' : 'primary'}" id="sys-patches" data-on="${p.enabled ? '0' : '1'}">${p.enabled ? t('sys.patchesDisable') : t('sys.patchesEnable')}</button>
        <div id="sys-patch-op" hidden><pre class="terminal" id="sys-patch-term"></pre></div>

        <form id="sys-ar" style="margin-top:22px">
          <h3>${t('sys.autoRebootTitle')}</h3>
          <label class="check field"><input type="checkbox" id="sys-ar-on" ${p.autoReboot ? 'checked' : ''} ${p.enabled ? '' : 'disabled'}> <span>${t('sys.autoReboot')}</span></label>
          <div class="field" style="max-width:180px"><label for="sys-ar-time">${t('sys.autoRebootTime')}</label>
            <input type="time" id="sys-ar-time" value="${esc(p.rebootTime || '04:00')}" ${p.enabled ? '' : 'disabled'}></div>
          <p class="hint field">${t('sys.autoRebootHint')}</p>
          <div id="sys-ar-out"></div>
          <button class="btn" ${p.enabled ? '' : 'disabled'}>${t('set.save')}</button>
        </form>
      </div>`;
  } else if (h) {
    patches = `<div class="card"><h2>${t('sys.patchesTitle')}</h2><p class="hint">${t(h.unraid ? 'sys.patchesUnraid' : 'sys.patchesOther')}</p></div>`;
  }

  body.innerHTML = `
    <div class="card">
      <h2>${t('sys.serverTitle')}</h2>
      ${d.error ? `<div class="notice warn">${esc(d.error)}</div>` : ''}
      ${h?.rebootRequired ? `<div class="notice warn"><strong>${t('sys.rebootRequired')}</strong>${h.packages.length ? `<div class="hint" style="margin-top:4px">${t('sys.rebootPackages', { list: esc(h.packages.join(', ')) })}</div>` : ''}</div>` : ''}
      <div class="kv">
        ${h ? `<span>${t('sys.os')}</span><strong>${esc(h.os || '—')}</strong>` : ''}
        ${d.kernel ? `<span>${t('sys.kernel')}</span><span>${esc(d.kernel)}</span>` : ''}
        ${d.caddy ? `<span>Caddy</span><span>${esc(d.caddy)}</span>` : ''}
        <span>${t('sys.uptime')}</span><span>${esc(fmtUptime(d.uptime))}</span>
        <span>${t('sys.lastReboot')}</span><span>${last ? `${esc(fmtDate(last.at))} <span class="hint">${t(last.kind === 'scheduled' ? 'sys.kind.scheduled' : 'sys.kind.manual')}</span>` : '—'}</span>
      </div>
      <div class="row">
        <button type="button" class="btn danger" id="sys-reboot" ${d.error ? 'disabled' : ''}>${t('sys.reboot')}</button>
        <button type="button" class="btn" id="sys-refresh">${t('sys.refresh')}</button>
      </div>
      <div id="sys-out"></div>
      <p class="hint" style="margin-top:12px">${t('sys.rebootHint')}</p>
    </div>

    <form class="card" id="sys-sched">
      <h2>${t('sys.scheduleTitle')}</h2>
      <p class="hint" style="margin-top:-4px">${t('sys.scheduleLead')}</p>
      <label class="check field"><input type="checkbox" id="rb-on" ${d.schedule.enabled ? 'checked' : ''}> <span>${t('sys.scheduleOn')}</span></label>
      ${scheduleFields('rb', d.schedule)}
      <div id="rb-out"></div>
      <button class="btn primary">${t('set.save')}</button>
    </form>
    ${patches}`;

  document.getElementById('sys-refresh').addEventListener('click', () => settingsServer(body, true));
  document.getElementById('sys-reboot').addEventListener('click', async (e) => {
    if (!confirm(t('sys.rebootConfirm'))) return;
    e.target.disabled = true;
    try {
      await api('POST', '/api/system/reboot');
      showRebooting();
    } catch (err) {
      document.getElementById('sys-out').innerHTML = errorBox(err);
      e.target.disabled = false;
    }
  });
  document.getElementById('sys-sched').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('PUT', '/api/system/schedule', { enabled: document.getElementById('rb-on').checked, ...readSchedule('rb') });
      document.getElementById('rb-out').innerHTML = '';
      toast(t('set.saved'));
    } catch (err) {
      document.getElementById('rb-out').innerHTML = errorBox(err);
    }
  });
  document.getElementById('sys-patches')?.addEventListener('click', async (e) => {
    const on = e.target.dataset.on === '1';
    if (!on && !confirm(t('sys.patchesDisableConfirm'))) return;
    e.target.disabled = true;
    const pre = document.getElementById('sys-patch-term');
    document.getElementById('sys-patch-op').hidden = false;
    pre.textContent = '';
    const code = await stream('POST', '/api/system/patches', (txt) => appendTo(pre, txt), undefined, { enabled: on })
      .catch((err) => { appendTo(pre, `\n${err.message}\n`); return 1; });
    toast(t(code === 0 ? 'toast.done' : 'toast.failed'));
    if (code === 0) setTimeout(() => settingsServer(body, true), 800);
    else e.target.disabled = false;
  });
  document.getElementById('sys-ar')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('PUT', '/api/system/auto-reboot', {
        enabled: document.getElementById('sys-ar-on').checked,
        time: document.getElementById('sys-ar-time').value,
      });
      document.getElementById('sys-ar-out').innerHTML = '';
      toast(t('set.saved'));
    } catch (err) {
      document.getElementById('sys-ar-out').innerHTML = errorBox(err);
    }
  });
}

// ---------- notifications ----------

const NT_EVENTS = [
  ['problems', ['backupFailed', 'stackDown', 'vpn', 'proxy', 'autoProblem', 'rebootRequired']],
  ['info', ['booted', 'panelUpdate', 'autoUpdated', 'stackUpdates', 'backupOk']],
];
// Fields of each channel type: [name, kind, required]
const NT_FIELDS = {
  email: [['host', 'text', true], ['port', 'number'], ['security', 'security'], ['user', 'text'], ['pass', 'secret'], ['from', 'text', true], ['to', 'text', true], ['insecure', 'check']],
  telegram: [['token', 'secret', true], ['chatId', 'text', true]],
  ntfy: [['server', 'text'], ['topic', 'text', true], ['token', 'secret']],
  pushover: [['user', 'secret', true], ['token', 'secret', true]],
  webhook: [['url', 'secret', true]],
};
function ntTarget(c) {
  if (c.type === 'email') return c.to;
  if (c.type === 'telegram') return `chat ${c.chatId}`;
  if (c.type === 'ntfy') return `${String(c.server || '').replace(/^https?:\/\//, '')}/${c.topic}`;
  if (c.type === 'webhook') return c.url;
  return '';
}

async function settingsNotify(body, d = null) {
  if (!d) {
    try {
      d = await api('GET', '/api/notify');
    } catch (err) {
      body.innerHTML = errorBox(err);
      return;
    }
  }
  if (route().tab !== 'notify') return;
  const ev = d.prefs.events;
  body.innerHTML = `
    <div class="card">
      <div class="row" style="justify-content:space-between;align-items:center">
        <h2 style="margin:0">${t('nt.channels')}</h2>
        <button type="button" class="btn primary" id="nt-add">${t('nt.add')}</button>
      </div>
      <p class="hint" style="margin:6px 0 12px">${t('nt.channelsLead')}</p>
      <div id="nt-form-box"></div>
      ${d.channels.length ? `<div class="nt-list">${d.channels.map((c) => `
        <div class="nt-row ${c.enabled ? '' : 'off'}" data-id="${esc(c.id)}">
          <span class="tag">${esc(t(`nt.type.${c.type}`))}</span>
          <div class="nt-name"><strong>${esc(c.name)}</strong><span class="hint">${esc(ntTarget(c))}</span></div>
          <label class="check"><input type="checkbox" class="nt-on" ${c.enabled ? 'checked' : ''}> ${t('nt.enabled')}</label>
          <div class="row nt-actions">
            <button type="button" class="btn" data-nt="test">${t('nt.test')}</button>
            <button type="button" class="btn" data-nt="edit">${t('nt.edit')}</button>
            <button type="button" class="btn danger" data-nt="delete">${t('nt.delete')}</button>
          </div>
        </div>`).join('')}</div>` : `<p class="hint">${t('nt.none')}</p>`}
      <div id="nt-out"></div>
    </div>

    <form class="card" id="nt-prefs">
      <h2>${t('nt.events')}</h2>
      ${NT_EVENTS.map(([group, keys]) => `
        <div class="field"><label>${t(`nt.group.${group}`)}</label>
          ${keys.map((k) => `<label class="check" style="margin:6px 0"><input type="checkbox" class="nt-ev" value="${k}" ${ev[k] ? 'checked' : ''}> <span>${t(`nt.ev.${k}`)}</span></label>`).join('')}
        </div>`).join('')}
      <div class="field" style="max-width:360px"><label for="nt-server">${t('nt.serverName')}</label>
        <input id="nt-server" value="${esc(d.prefs.serverName)}" placeholder="Stackmoor" maxlength="40">
        <p class="hint">${t('nt.serverNameHint')}</p></div>
      <div id="nt-prefs-out"></div>
      <button class="btn primary">${t('set.save')}</button>
    </form>

    <div class="card" style="padding:6px 8px; overflow-x:auto">
      <h2 style="margin:10px 12px 4px">${t('nt.history')}</h2>
      ${d.history.length ? `<table>
        <thead><tr><th>${t('au.when')}</th><th>${t('nt.message')}</th><th>${t('nt.channel')}</th><th>${t('au.result')}</th></tr></thead>
        <tbody>${d.history.map((h) => `
          <tr><td>${esc(fmtDate(h.at))}</td><td>${esc(h.title)}</td><td>${esc(h.channel)}</td>
            <td>${h.ok ? `<span class="badge running">${t('nt.sent')}</span>` : `<span class="badge exited">${t('nt.failed')}</span><br><span class="hint">${esc(h.error || '')}</span>`}</td></tr>`).join('')}</tbody>
      </table>` : `<p class="hint" style="margin:4px 12px 12px">${t('nt.historyNone')}</p>`}
    </div>`;

  const out = document.getElementById('nt-out');
  const refresh = (data) => settingsNotify(body, data);
  document.getElementById('nt-add').addEventListener('click', () => ntForm(body, null, refresh));
  body.querySelectorAll('.nt-row').forEach((row) => {
    const id = row.dataset.id;
    const ch = d.channels.find((c) => c.id === id);
    row.querySelector('.nt-on').addEventListener('change', async (e) => {
      try { refresh(await api('PUT', `/api/notify/channels/${id}`, { enabled: e.target.checked })); } catch (err) { out.innerHTML = errorBox(err); }
    });
    row.querySelectorAll('[data-nt]').forEach((b) => b.addEventListener('click', async () => {
      const act = b.dataset.nt;
      if (act === 'edit') return ntForm(body, ch, refresh);
      if (act === 'delete' && !confirm(t('nt.deleteConfirm', { name: ch.name }))) return;
      b.disabled = true;
      try {
        if (act === 'test') {
          const data = await api('POST', `/api/notify/channels/${id}/test`);
          toast(t('nt.testSent', { name: ch.name }));
          refresh(data);
        } else {
          refresh(await api('DELETE', `/api/notify/channels/${id}`));
        }
      } catch (err) {
        // A failed test is also in the history: show it there, and the reason above.
        if (act === 'test') await refresh(await api('GET', '/api/notify').catch(() => d));
        document.getElementById('nt-out').innerHTML = errorBox(err);
        b.disabled = false;
      }
    }));
  });
  document.getElementById('nt-prefs').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('PUT', '/api/notify/prefs', {
        serverName: document.getElementById('nt-server').value,
        timeZone: browserZone(),
        events: Object.fromEntries([...document.querySelectorAll('.nt-ev')].map((x) => [x.value, x.checked])),
      });
      document.getElementById('nt-prefs-out').innerHTML = '';
      toast(t('set.saved'));
    } catch (err) {
      document.getElementById('nt-prefs-out').innerHTML = errorBox(err);
    }
  });
}

/** Adding or editing a channel. */
function ntForm(body, ch, done) {
  const box = document.getElementById('nt-form-box');
  const type0 = ch?.type || 'telegram';
  const field = (type, [name, kind, req]) => {
    const id = `ntf-${name}`;
    const label = `<label for="${id}">${t(`nt.f.${type}.${name}`)}${req ? '' : ` <span class="hint">${t('nt.optional')}</span>`}</label>`;
    const v = ch?.type === type ? ch[name] ?? '' : '';
    const hint = t(`nt.h.${type}.${name}`) !== `nt.h.${type}.${name}` ? `<p class="hint">${t(`nt.h.${type}.${name}`)}</p>` : '';
    if (kind === 'check') return `<label class="check field"><input type="checkbox" id="${id}" ${v ? 'checked' : ''}> <span>${t(`nt.f.${type}.${name}`)}</span></label>`;
    if (kind === 'security') {
      return `<div class="field">${label}<select id="${id}" class="lang">${['starttls', 'tls', 'none'].map((x) => `<option value="${x}" ${(v || 'starttls') === x ? 'selected' : ''}>${t(`nt.sec.${x}`)}</option>`).join('')}</select></div>`;
    }
    const extra = type === 'telegram' && name === 'chatId'
      ? `<button type="button" class="btn" id="nt-find-chat">${t('nt.findChat')}</button>` : '';
    const input = `<input id="${id}" type="${kind === 'secret' ? 'password' : kind === 'number' ? 'number' : 'text'}" ${kind === 'secret' ? `placeholder="${esc(v)}" autocomplete="new-password"` : `value="${esc(v)}"`} ${type === 'ntfy' && name === 'server' ? 'placeholder="https://ntfy.sh"' : ''}>`;
    return `<div class="field">${label}${extra ? `<div class="row" style="flex-wrap:nowrap">${input.replace('<input', '<input style="flex:1;min-width:0"')}${extra}</div>` : input}${hint}<div id="${id}-more"></div></div>`;
  };
  const render = (type) => {
    box.innerHTML = `
      <form class="nt-form" id="nt-form">
        <h3>${ch ? t('nt.editTitle', { name: esc(ch.name) }) : t('nt.addTitle')}</h3>
        <div class="row field" style="align-items:flex-start">
          <div style="flex:1;min-width:160px"><label for="ntf-type">${t('nt.typeLabel')}</label>
            <select id="ntf-type" class="lang" ${ch ? 'disabled' : ''}>${Object.keys(NT_FIELDS).map((x) => `<option value="${x}" ${x === type ? 'selected' : ''}>${t(`nt.type.${x}`)}</option>`).join('')}</select></div>
          <div style="flex:2;min-width:180px"><label for="ntf-name">${t('nt.nameLabel')}</label>
            <input id="ntf-name" value="${esc(ch?.name || '')}" placeholder="${esc(t(`nt.type.${type}`))}" maxlength="40"></div>
        </div>
        <p class="hint" style="margin:-4px 0 14px">${t(`nt.how.${type}`)}</p>
        ${NT_FIELDS[type].map((f) => field(type, f)).join('')}
        <div id="ntf-out"></div>
        <div class="row">
          <button class="btn primary">${t('set.save')}</button>
          <button type="button" class="btn" id="ntf-cancel">${t('nt.cancel')}</button>
        </div>
      </form>`;
    document.getElementById('ntf-type').addEventListener('change', (e) => render(e.target.value));
    document.getElementById('ntf-cancel').addEventListener('click', () => { box.innerHTML = ''; });
    document.getElementById('nt-find-chat')?.addEventListener('click', async (e) => {
      const more = document.getElementById('ntf-chatId-more');
      const token = document.getElementById('ntf-token').value;
      e.target.disabled = true;
      try {
        const { chats } = await api('POST', '/api/notify/telegram-chats', token ? { token } : { id: ch?.id });
        more.innerHTML = chats.length
          ? `<div class="row" style="margin-top:8px">${chats.map((c) => `<button type="button" class="btn" data-chat="${esc(c.id)}">${esc(c.name)} · ${esc(c.id)}</button>`).join('')}</div>`
          : `<p class="hint">${t('nt.noChats')}</p>`;
        more.querySelectorAll('[data-chat]').forEach((b) => b.addEventListener('click', () => { document.getElementById('ntf-chatId').value = b.dataset.chat; }));
      } catch (err) {
        more.innerHTML = errorBox(err);
      }
      e.target.disabled = false;
    });
    document.getElementById('nt-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const payload = { type, name: document.getElementById('ntf-name').value };
      for (const [name, kind] of NT_FIELDS[type]) {
        const el = document.getElementById(`ntf-${name}`);
        payload[name] = kind === 'check' ? el.checked : el.value;
      }
      try {
        const data = ch
          ? await api('PUT', `/api/notify/channels/${ch.id}`, payload)
          : await api('POST', '/api/notify/channels', payload);
        toast(t('set.saved'));
        done(data);
      } catch (err) {
        document.getElementById('ntf-out').innerHTML = errorBox(err);
      }
    });
    document.getElementById('ntf-name').focus();
  };
  render(type0);
  box.scrollIntoView({ block: 'nearest' });
}

/** While the server restarts: a notice that stays until the panel answers again. */
function showRebooting() {
  document.getElementById('dialog')?.remove();
  document.body.insertAdjacentHTML('beforeend', `
    <div class="overlay" id="dialog">
      <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="dlg-title" style="max-width:460px">
        <div class="db">
          <h2 id="dlg-title" style="margin:0 0 10px">${t('sys.rebootingTitle')}</h2>
          <div class="progress indeterminate"><span></span></div>
          <p class="hint" style="margin:12px 0 0">${t('sys.rebootingHint')}</p>
        </div>
      </div>
    </div>`);
  // A server restart takes a while (containers stop first): reload only when a new panel answers.
  waitForRestart(null, Infinity);
  setTimeout(() => {
    const hint = document.querySelector('#dialog .hint');
    if (hint) hint.textContent = t('sys.rebootSlow');
  }, 10 * 60e3);
}

// After a self-update the panel restarts. Reload as soon as a new panel process answers
// (its bootId changes); after 30 s reload anyway – if the update is still running,
// the reloaded page shows the notice again and keeps waiting. After the reload the
// panel checks the version again, so no stale "new version" notice stays behind.
const RESTART_FALLBACK_MS = 30e3;
const JUST_UPDATED_KEY = 'sm-just-updated';
let restartTimer = null;
function waitForRestart(beforeReload, fallbackMs = RESTART_FALLBACK_MS) {
  if (restartTimer) return;
  const before = state.bootId;
  const started = Date.now();
  restartTimer = setInterval(async () => {
    let st = null;
    try { st = await fetch('/api/state', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)); } catch { /* panel is down */ }
    // Reload only when the panel answers – never onto an error page while it is down.
    if (st && (st.bootId !== before || Date.now() - started >= fallbackMs)) {
      clearInterval(restartTimer);
      try { sessionStorage.setItem(JUST_UPDATED_KEY, '1'); } catch { /* ignore */ }
      beforeReload?.();
      setTimeout(() => location.reload(), 400);
    }
  }, 2000);
}

// ---------- VPN ----------


async function settingsVpn(body) {
  let d;
  try {
    d = await api('GET', '/api/vpn');
  } catch (err) {
    body.innerHTML = errorBox(err);
    return;
  }
  if (route().page !== 'network') return;
  const pill = (st) => {
    const k = st?.state || 'unknown';
    return `<span class="badge ${k === 'up' ? 'running' : k === 'down' ? 'exited' : 'partial'}">${t(`vpn.state.${k}`)}</span>`;
  };
  const card = (x) => `
    <div class="card vpn-card ${x.stacks.length ? 'strong' : ''}" data-name="${esc(x.name)}">
      <div class="row" style="justify-content:space-between;align-items:center">
        <h2 style="margin:0">${esc(x.name)}</h2>${pill(x.status)}
      </div>
      <div class="kv" style="margin-top:10px">
        <span>${t('vpn.mode')}</span><strong>${x.full ? t('vpn.modeFull') : t('vpn.modeSplit', { nets: esc((x.allowedIps || []).filter((c) => !c.includes(':')).join(', ')) })}</strong>
        <span>${t('vpn.server')}</span><strong>${esc((x.endpoints || []).join(', '))}</strong>
        <span>${t('vpn.address')}</span><strong>${esc(x.address || '')}</strong>
        <span>${t('vpn.handshake')}</span><strong>${x.status?.handshake ? ago(x.status.handshake) : '—'}</strong>
        <span>${t('vpn.usedBy')}</span><strong>${x.stacks.length ? x.stacks.map((s) => `<a href="#/stack/${esc(s.stack)}">${esc(s.stack)}</a> (${s.services.map(esc).join(', ')})`).join(', ') : '—'}</strong>
      </div>
      ${x.status?.state === 'down' ? `<div class="notice error" style="margin-top:10px">${t('vpn.downHint')}</div>` : ''}
      <div class="row" style="gap:8px;margin-top:12px">
        <button type="button" class="btn small" data-act="restart">${t('vpn.restart')}</button>
        <button type="button" class="btn small" data-act="conf">${t('vpn.replaceConf')}</button>
        <button type="button" class="btn small danger" data-act="remove" ${x.stacks.length ? `disabled title="${esc(t('vpn.removeInUse'))}"` : ''}>${t('vpn.remove')}</button>
      </div>
      <div class="vpn-conf-box" hidden>
        <textarea class="code env" spellcheck="false" placeholder="[Interface]&#10;PrivateKey = …"></textarea>
        <button type="button" class="btn primary small" data-act="saveconf" style="margin-top:8px">${t('vpn.saveConf')}</button>
      </div>
      <pre class="terminal" hidden></pre>
    </div>`;
  body.innerHTML = `
    <div class="notice plain">${t('vpn.killSwitchNote')}</div>
    ${d.tunnels.length ? `<div class="vpn-cards">${d.tunnels.map(card).join('')}</div>` : ''}
    <form class="card" id="vpn-add">
      <h2>${t('vpn.addTitle')}</h2>
      <div class="field"><label for="vpn-name">${t('vpn.name')}</label>
        <input type="text" id="vpn-name" placeholder="home" autocapitalize="off" autocomplete="off" style="max-width:240px" required></div>
      <div class="field"><label for="vpn-conf">${t('vpn.conf')}</label>
        <textarea id="vpn-conf" class="code env" spellcheck="false" placeholder="[Interface]&#10;PrivateKey = …&#10;Address = 10.8.0.5/32&#10;&#10;[Peer]&#10;PublicKey = …&#10;Endpoint = vpn.example.com:51820&#10;AllowedIPs = 0.0.0.0/0" required></textarea>
        <input type="file" id="vpn-file" accept=".conf,text/plain" style="margin-top:8px">
        <p class="hint">${t('vpn.confHint')}</p></div>
      <div id="vpn-add-out"></div>
      <button class="btn primary">${t('vpn.add')}</button>
      <pre class="terminal" id="vpn-add-term" hidden style="margin-top:12px"></pre>
    </form>`;

  document.getElementById('vpn-file').addEventListener('change', async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    document.getElementById('vpn-conf').value = await f.text();
    const nameEl = document.getElementById('vpn-name');
    if (!nameEl.value) nameEl.value = f.name.replace(/\.conf$/i, '').toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 21);
  });
  const run = async (pre, method, url, payload) => {
    pre.hidden = false;
    pre.textContent = '';
    const code = await stream(method, url, (txt) => appendTo(pre, txt), undefined, payload)
      .catch((err) => { appendTo(pre, `\n${err.message}\n`); return 1; });
    toast(t(code === 0 ? 'toast.done' : 'toast.failed'));
    return code;
  };
  document.getElementById('vpn-add').addEventListener('submit', async (e) => {
    e.preventDefault();
    e.submitter.disabled = true;
    const code = await run(document.getElementById('vpn-add-term'), 'POST', '/api/vpn', {
      name: document.getElementById('vpn-name').value, conf: document.getElementById('vpn-conf').value,
    });
    e.submitter.disabled = false;
    if (code === 0) setTimeout(() => { if (route().page === 'network') settingsVpn(body); }, 4000);
  });
  body.querySelectorAll('.vpn-card').forEach((c) => {
    const name = c.dataset.name;
    const pre = c.querySelector('pre');
    c.querySelector('[data-act="restart"]').addEventListener('click', async () => {
      await run(pre, 'POST', `/api/vpn/${name}/restart`);
      setTimeout(() => { if (route().page === 'network') settingsVpn(body); }, 5000);
    });
    c.querySelector('[data-act="conf"]').addEventListener('click', () => { c.querySelector('.vpn-conf-box').hidden = false; });
    c.querySelector('[data-act="saveconf"]').addEventListener('click', async () => {
      const code = await run(pre, 'PUT', `/api/vpn/${name}`, { conf: c.querySelector('textarea').value });
      if (code === 0) setTimeout(() => { if (route().page === 'network') settingsVpn(body); }, 4000);
    });
    c.querySelector('[data-act="remove"]').addEventListener('click', async () => {
      if (!confirm(t('vpn.removeConfirm', { name }))) return;
      try {
        await api('DELETE', `/api/vpn/${name}`);
        toast(t('toast.done'));
        settingsVpn(body);
      } catch (err) {
        toast(err.message);
      }
    });
  });
  // While a tunnel is connecting, look again in a moment.
  if (d.tunnels.some((x) => x.status?.state === 'connecting')) {
    setTimeout(() => { if (route().page === 'network' && body.isConnected) settingsVpn(body); }, 10_000);
  }
}

/**
 * The local-domain form, used in Settings → Domains and in the first-run wizard.
 * Saving first checks the domain (API key, is *.domain already pointing elsewhere?),
 * then saves, creates the DNS record through the provider's API and starts Caddy.
 */
function domainForm(box, d, { onApplied, submitLabel } = {}) {
  const providerOptions = [
    `<option value="">${t('dom.chooseProvider')}</option>`,
    ...d.providers.map((p) => `<option value="${esc(p.id)}" ${p.id === d.dnsProvider ? 'selected' : ''}>${esc(p.name)}</option>`),
    `<option value="internal" ${d.dnsProvider === 'internal' ? 'selected' : ''}>${t('dom.internal')}</option>`,
  ].join('');
  box.innerHTML = `
    <form id="dom-form">
      <div class="field"><label for="dom-domain">${t('dom.domain')}</label>
        <input type="text" id="dom-domain" value="${esc(d.domain)}" placeholder="home.example.com" autocapitalize="off" autocomplete="off">
        <p class="hint">${t('dom.domainHint')}</p></div>
      <div class="field"><label for="dom-provider">${t('dom.provider')}</label>
        <select id="dom-provider" class="lang">${providerOptions}</select></div>
      <div id="dom-fields"></div>
      <div class="field"><label for="dom-ip">${t('dom.serverIp')}</label>
        <input type="text" id="dom-ip" value="${esc((d.serverIpAuto !== false ? d.detectedIp || d.serverIp : d.serverIp) || d.suggestedIp || '')}" placeholder="192.168.1.50" inputmode="decimal" autocomplete="off" ${d.serverIpAuto !== false ? 'readonly' : ''}>
        <label class="check" style="margin-top:8px"><input type="checkbox" id="dom-ip-auto" ${d.serverIpAuto !== false ? 'checked' : ''}>
          <span>${t('dom.serverIpAuto')}</span></label>
        <div id="dom-record"></div></div>
      <div class="field"><label for="dom-email">${t('dom.email')} <span class="hint">${t('new.envOptional')}</span></label>
        <input type="text" id="dom-email" value="${esc(d.acmeEmail)}" placeholder="you@example.com" autocapitalize="off"></div>
      <details class="field"><summary>${t('dom.advanced')}</summary>
        <div class="row" style="margin-top:10px">
          <div style="flex:1;min-width:120px"><label for="dom-http">HTTP</label><input type="number" id="dom-http" value="${esc(d.httpPort)}"></div>
          <div style="flex:1;min-width:120px"><label for="dom-https">HTTPS</label><input type="number" id="dom-https" value="${esc(d.httpsPort)}"></div>
        </div>
        <p class="hint">${t('dom.portsHint')}</p>
        <div style="margin-top:12px"><label for="dom-prop">${t('dom.propagation')}</label>
          <input type="number" id="dom-prop" min="0" max="3600" step="1" value="${d.propagationSeconds ?? ''}" style="max-width:160px">
          <p class="hint" id="dom-prop-hint"></p></div>
      </details>
      <div id="dom-out"></div>
      <button class="btn primary">${submitLabel || t('dom.saveApply')}</button>
    </form>
    <div id="dom-op" hidden><pre class="terminal" id="dom-term"></pre></div>`;

  const $ = (id) => box.querySelector(`#${id}`);
  const provider = () => d.providers.find((x) => x.id === $('dom-provider').value);

  const drawFields = () => {
    const id = $('dom-provider').value;
    const p = provider();
    const fields = $('dom-fields');
    if (id === 'internal') fields.innerHTML = `<p class="hint field">${t('dom.internalHint')}</p>`;
    else if (!p) fields.innerHTML = '';
    else {
      const help = p.help?.[lang] || p.help?.en || '';
      fields.innerHTML = `
        ${help ? `<p class="hint field">${esc(help)}</p>` : ''}
        ${p.fields.map((f) => {
          const saved = id === d.dnsProvider ? d.credentials?.[f.key] || '' : '';
          return `<div class="field"><label for="dns-${esc(f.key)}">${esc(f.label)}${f.required ? '' : ` <span class="hint">${t('new.envOptional')}</span>`}</label>
            <input type="${f.secret ? 'password' : 'text'}" id="dns-${esc(f.key)}" data-key="${esc(f.key)}" class="dns-field"
              value="${f.secret ? '' : esc(saved || f.default || '')}" placeholder="${esc(f.secret && saved ? saved : f.placeholder || '')}" autocomplete="off" autocapitalize="off"></div>`;
        }).join('')}`;
    }
    drawRecord();
  };
  // Automatic *.domain record when the provider supports it; otherwise say what to add by hand.
  const drawRecord = () => {
    const p = provider();
    const domain = $('dom-domain').value.trim().toLowerCase() || 'home.example.com';
    const ip = $('dom-ip').value.trim() || '192.168.x.x';
    const prev = $('dom-auto');
    const auto = prev ? prev.checked : d.autoDnsRecord !== false;
    $('dom-record').innerHTML = p?.autoRecord
      ? `<label class="check" style="margin-top:8px"><input type="checkbox" id="dom-auto" ${auto ? 'checked' : ''}>
          <span>${t('dom.autoRecord', { name: esc(`${domain}, *.${domain}`) })}</span></label>`
      : `<p class="hint">${t('dom.manualRecord', { name: esc(`${domain}, *.${domain}`), ip: esc(ip) })}</p>`;
  };
  const drawProp = () => {
    const p = provider();
    $('dom-prop').placeholder = String(p?.propagation ?? 0);
    $('dom-prop-hint').innerHTML = t('dom.propagationHint', { n: p?.propagation ?? 0 });
  };
  drawFields();
  drawProp();
  $('dom-provider').addEventListener('change', () => { drawFields(); drawProp(); });
  $('dom-ip-auto').addEventListener('change', (e) => {
    const ip = $('dom-ip');
    ip.readOnly = e.target.checked;
    if (e.target.checked && d.detectedIp) ip.value = d.detectedIp;
    drawRecord();
  });
  $('dom-domain').addEventListener('input', drawRecord);
  $('dom-ip').addEventListener('input', () => { if (!provider()?.autoRecord) drawRecord(); });

  const collect = () => {
    const credentials = {};
    box.querySelectorAll('.dns-field').forEach((el) => { credentials[el.dataset.key] = el.value; });
    return {
      domain: $('dom-domain').value.trim(),
      dnsProvider: $('dom-provider').value,
      serverIp: $('dom-ip').value.trim(),
      serverIpAuto: $('dom-ip-auto').checked,
      propagationSeconds: $('dom-prop').value === '' ? null : Number($('dom-prop').value),
      autoDnsRecord: $('dom-auto') ? $('dom-auto').checked : d.autoDnsRecord !== false,
      acmeEmail: $('dom-email').value,
      httpPort: Number($('dom-http').value),
      httpsPort: Number($('dom-https').value),
      credentials,
    };
  };

  const apply = async (payload) => {
    const out = $('dom-out');
    try {
      await api('PUT', '/api/domains', payload);
      out.innerHTML = '';
    } catch (err) {
      out.innerHTML = errorBox(err);
      return;
    }
    const pre = $('dom-term');
    $('dom-op').hidden = false;
    pre.textContent = '';
    const code = await stream('POST', '/api/domains/apply', (txt) => appendTo(pre, txt)).catch((err) => {
      appendTo(pre, `\n${err.message}\n`);
      return 1;
    });
    toast(t(code === 0 ? 'toast.done' : 'toast.failed'));
    if (code === 0) onApplied?.(payload);
  };

  $('dom-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const out = $('dom-out');
    const btn = e.submitter || box.querySelector('#dom-form .btn.primary');
    const payload = collect();
    // Turning domains off, or saving an already configured domain again: nothing to check.
    if (!payload.domain || (payload.domain === d.domain && payload.dnsProvider === d.dnsProvider)) return apply(payload);
    btn.disabled = true;
    out.innerHTML = `<p class="hint">${t('dom.checking')}</p>`;
    let c;
    try {
      c = await api('POST', '/api/domains/check', payload);
    } catch (err) {
      out.innerHTML = errorBox(err);
      btn.disabled = false;
      return;
    }
    btn.disabled = false;
    const name = `${c.domain} / *.${c.domain}`;
    if (c.api && !c.api.ok) {
      out.innerHTML = `<div class="notice error">${t(`dom.apiError.${c.api.kind}`, { message: esc(c.api.message || '') })}</div>`;
      return;
    }
    if (c.inUse) {
      out.innerHTML = `<div class="notice warn"><strong>${t('dom.inUseTitle', { name: esc(name) })}</strong>
        <p class="hint" style="margin:6px 0 10px">${t(c.source === 'api' ? 'dom.inUseApi' : 'dom.inUseDns', { name: esc(name), ips: esc(c.existing.join(', ')) })}</p>
        <button type="button" class="btn" id="dom-anyway">${t('dom.useAnyway')}</button></div>`;
      $('dom-anyway').addEventListener('click', () => { out.innerHTML = ''; apply(payload); });
      return;
    }
    out.innerHTML = c.api?.ok ? `<p class="hint">✓ ${t('dom.checkedApi', { zone: esc(c.zone) })}</p>` : '';
    apply(payload);
  });
}

async function settingsDomains(body) {
  let d;
  try {
    d = await api('GET', '/api/domains');
  } catch (err) {
    body.innerHTML = errorBox(err);
    return;
  }
  if (route().page !== 'domains') return;
  const st = d.status || {};
  const routes = d.routes || [];
  const pxs = d.domain ? await api('GET', '/api/proxies').catch(() => []) : [];
  if (route().page !== 'domains') return;
  body.innerHTML = `
    <div class="two-col" style="margin-bottom:24px">
      <div class="card wide">
        <h2>${t('dom.title')}</h2>
        <p class="hint" style="margin-top:-4px">${t('dom.lead')}</p>
        <div id="dom-form-box"></div>
      </div>
      ${st.enabled ? '<div class="card strong" id="dom-status"></div>' : ''}
    </div>
    ${d.domain ? `<section><h2>${t('dom.routesTitle')}</h2>
      ${routes.length || pxs.length ? `<div class="card" style="padding:0;overflow-x:auto"><table>
        <thead><tr><th>${t('dom.routeAddr')}</th><th>${t('dom.routeTarget')}</th><th></th></tr></thead>
        <tbody>${routes.map((r) => {
          const vpnOn = state.stacks.find((x) => x.name === r.stack)?.vpn;
          return `<tr><td><a href="https://${esc(r.subdomain)}.${esc(d.domain)}" target="_blank" rel="noopener">${esc(r.subdomain)}.${esc(d.domain)}</a></td>
            <td><code><a href="#/stack/${esc(r.stack)}">${esc(r.stack)}</a> → ${esc(r.service)}:${esc(r.port)}</code></td>
            <td>${vpnOn ? `<span class="tag">${t('dom.viaVpn', { name: esc(vpnOn.tunnel) })}</span>` : ''}</td></tr>`;
        }).join('')}${pxs.map((x) => `<tr><td><a href="https://${esc(x.subdomain)}.${esc(d.domain)}" target="_blank" rel="noopener">${esc(x.subdomain)}.${esc(d.domain)}</a></td>
            <td><code><a href="#/proxy/${x.id}">${esc(x.name)}</a> → ${esc(x.target)}</code></td>
            <td><span class="tag proxy">${t('px.tag')}</span></td></tr>`).join('')}</tbody></table></div>` : `<p class="hint">${t('dom.routesNone')}</p>`}
      <p class="hint">${t('dom.routesHint')}</p></section>` : ''}`;
  domainForm(document.getElementById('dom-form-box'), d, {
    onApplied: () => setTimeout(() => { if (route().page === 'domains') settingsDomains(body); }, 8000),
  });
  if (st.enabled) domainStatus(document.getElementById('dom-status'), d, st);
}

/** Settings → Panel address: my.<domain>, and the lock to that address. */
async function settingsPanel(body) {
  const d = await api('GET', '/api/domains');
  if (route().tab !== 'panel') return;
  if (!d.domain) {
    body.innerHTML = `<div class="card"><p class="hint" style="margin-top:0">${t('dom.panelNoDomain')}</p>
      <a class="btn" href="#/domains">${t('route.goSettings')}</a></div>`;
    return;
  }
  body.innerHTML = `
    <form class="card strong" id="panel-form">
      <div class="field"><label for="dom-panel">${t('dom.panelSub')}</label>
        <div class="row" style="align-items:center;gap:8px;flex-wrap:nowrap">
          <input type="text" id="dom-panel" value="${esc(d.panelSubdomain)}" placeholder="my" autocapitalize="off" autocomplete="off" style="flex:0 1 220px;min-width:0">
          <span class="hint" style="white-space:nowrap;margin:0">.${esc(d.domain)}</span>
        </div>
        <p class="hint">${t('dom.panelSubHint')}</p>
        <div id="dom-lock"></div></div>
      <div id="panel-out"></div>
      <button class="btn primary">${t('dom.panelSave')}</button>
    </form>`;
  // The IP lock can only be switched on from the panel's own address (proof that it works).
  const drawLock = () => {
    const box = document.getElementById('dom-lock');
    if (!box) return;
    const sub = document.getElementById('dom-panel').value.trim().toLowerCase();
    if (!sub) { box.innerHTML = ''; return; }
    const url = `https://${sub}.${d.domain}`;
    const here = location.hostname === `${sub}.${d.domain}`;
    const prev = document.getElementById('dom-lock-on');
    const checked = prev ? prev.checked : d.panelDomainOnly;
    box.innerHTML = `
      <label class="check" style="margin-top:10px"><input type="checkbox" id="dom-lock-on" ${checked && (here || d.panelDomainOnly) ? 'checked' : ''} ${here || d.panelDomainOnly ? '' : 'disabled'}>
        ${t('dom.lock')}</label>
      <p class="hint">${here || d.panelDomainOnly ? t('dom.lockHint') : t('dom.lockOpenFirst', { url: esc(url) })}</p>`;
  };
  drawLock();
  document.getElementById('dom-panel').addEventListener('input', drawLock);
  document.getElementById('panel-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const out = document.getElementById('panel-out');
    try {
      await api('PUT', '/api/domains/panel', {
        panelSubdomain: document.getElementById('dom-panel').value,
        panelDomainOnly: Boolean(document.getElementById('dom-lock-on')?.checked),
      });
      toast(t('toast.saved'));
      settingsPanel(body);
    } catch (err) {
      out.innerHTML = errorBox(err);
    }
  });
}

/**
 * The Status card in Settings → Domains. Refresh updates only this card; while the
 * certificate is not there yet, it refreshes itself every 10 s.
 */
function domainStatus(card, d, st) {
  const autoRecord = d.autoDnsRecord && d.serverIp && d.providers.find((p) => p.id === d.dnsProvider)?.autoRecord;
  const time = (iso) => new Date(iso).toLocaleTimeString(lang === 'pl' ? 'pl-PL' : 'en-GB');
  const draw = (s, busy = false) => {
    s = { ...s, domain: s.domain || d.domain };
    card.innerHTML = `
      <h2>${t('dom.status')}</h2>
      <div class="kv">
        <span>Caddy</span><strong>${s.running ? '✓ ' + t('dom.running') : '✕ ' + t('dom.stopped')}</strong>
        <span>${t('dom.cert')}</span><strong>${s.certificate ? `✓ *.${esc(s.domain)}` : t('dom.certWaiting')}</strong>
        ${s.panelUrl ? `<span>${t('dom.panelUrl')}</span><a href="${esc(s.panelUrl)}">${esc(s.panelUrl.replace('https://', ''))}</a>` : ''}
      </div>
      ${s.errors?.length ? `<div class="notice error">${s.errors.map(esc).join('\n')}</div>` : ''}
      ${s.imageProblem ? `<div class="notice info">${t('dom.caddyImageProblem', { image: esc(s.imageProblem) })}</div>` : ''}
      ${d.ipChange ? `<div class="notice info">${t('dom.ipChanged', { from: esc(d.ipChange.from), to: esc(d.ipChange.to), when: esc(new Date(d.ipChange.at).toLocaleString(lang === 'pl' ? 'pl-PL' : 'en-GB')) })}${d.ipChange.record ? ' ' + t('dom.ipChangedRecord') : ''}</div>` : ''}
      <p class="hint">${autoRecord
        ? t('dom.recordAuto', { name: esc(`${s.domain}, *.${s.domain}`), ip: esc(d.serverIp) })
        : t('dom.dnsRecord', { domain: esc(s.domain) })}</p>
      <div class="row" style="align-items:center;gap:8px">
        <button type="button" class="btn small" id="dom-refresh" ${busy ? 'disabled' : ''}>${busy ? t('dom.refreshing') : t('logs.refresh')}</button>
        ${!s.certificate && s.running ? `<button type="button" class="btn small" id="dom-retry" ${busy ? 'disabled' : ''}>${t('dom.retryCert')}</button>` : ''}
        <span class="hint">${s.checkedAt ? t('dom.checkedAt', { time: esc(time(s.checkedAt)) }) : ''}${!s.certificate ? ` · ${t('dom.autoRefresh')}` : ''}</span>
      </div>`;
    card.querySelector('#dom-refresh').addEventListener('click', () => refresh());
    card.querySelector('#dom-retry')?.addEventListener('click', async (e) => {
      if (!confirm(t('dom.retryConfirm'))) return;
      e.target.disabled = true;
      e.target.textContent = t('dom.retrying');
      try {
        await api('POST', '/api/domains/retry-cert');
        toast(t('dom.retryStarted'));
      } catch (err) {
        toast(err.message);
      }
      setTimeout(refresh, 3000);
    });
  };
  let current = st;
  let timer = null;
  const refresh = async () => {
    if (!card.isConnected) return;
    draw(current, true);
    const next = await api('GET', '/api/domains/status').catch(() => null);
    if (!card.isConnected) return;
    if (next) current = next;
    draw(current);
    schedule();
  };
  const schedule = () => {
    clearTimeout(timer);
    if (!current.certificate) timer = setTimeout(() => { if (card.isConnected && route().tab === 'domains') refresh(); }, 10_000);
  };
  draw(current);
  schedule();
}

// ---------- backups ----------

const fmtBytes = (n) => {
  if (n === null || n === undefined) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = Number(n);
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(v < 10 && i ? 1 : 0)} ${u[i]}`;
};

// Monday first; 0 = Sunday as in JavaScript.
const WEEK = [1, 2, 3, 4, 5, 6, 0];
const dayName = (d) => new Intl.DateTimeFormat(lang === 'pl' ? 'pl-PL' : 'en-GB', { weekday: 'short' })
  .format(new Date(Date.UTC(2026, 0, 4 + d))); // 2026-01-04 was a Sunday

/** When the next scheduled backup runs (in this browser's time zone), or null. */
function nextBackup(c) {
  if (!c?.enabled || !c.days?.length || !/^\d{1,2}:\d{2}$/.test(c.time || '')) return null;
  const [h, m] = c.time.split(':').map(Number);
  const now = new Date();
  for (let i = 0; i < 8; i += 1) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i, h, m);
    if (d > now && c.days.includes(d.getDay())) return d;
  }
  return null;
}

/** Shows the running backup job's log in `pre` until it finishes, then calls done(). */
function watchBackupJob(pre, done) {
  let stopped = false;
  const tick = async () => {
    if (stopped || !document.body.contains(pre)) return;
    const st = await api('GET', '/api/backups/status').catch(() => null);
    if (!st) return setTimeout(tick, 3000);
    pre.hidden = false;
    // Follow the end only if the user has not scrolled up to read.
    const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40;
    pre.textContent = st.log || '';
    if (atBottom) pre.scrollTop = pre.scrollHeight;
    if (st.running || st.queued) setTimeout(tick, 2000);
    else done?.(st);
  };
  tick();
  return () => { stopped = true; };
}

function backupRunLabel(h) {
  const what = h.stack ? `${t(`bak.kind.${h.kind}`)} · ${esc(h.stack)}` : t(`bak.kind.${h.kind}`);
  const res = h.ok ? `<span class="badge running">✓</span>` : `<span class="badge exited">✕</span>`;
  const fail = h.failed?.length ? ` <span class="hint">${t('bak.failedFor', { list: esc(h.failed.join(', ')) })}</span>` : '';
  return `<tr><td>${fmtDate(h.at)}</td><td>${what}</td><td>${res}${fail}${h.error ? `<div class="hint" style="white-space:pre-wrap">${esc(h.error)}</div>` : ''}</td></tr>`;
}

/** Table of snapshots with restore. onRestored() runs after a restore finishes. */
function snapshotsTable(box, list, { showStack, onRestored }) {
  if (!list.length) {
    box.innerHTML = `<p class="hint">${t('bak.noSnapshots')}</p>`;
    return;
  }
  box.innerHTML = `
    <table class="snapshots"><thead><tr>
      ${showStack ? `<th>${t('bak.stack')}</th>` : ''}<th>${t('bak.date')}</th><th>${t('bak.size')}</th><th></th>
    </tr></thead><tbody>
    ${list.map((sn) => `<tr>
      ${showStack ? `<td>${esc(sn.stack)}</td>` : ''}
      <td>${fmtDate(sn.time)}${sn.preUpdate ? ` <span class="badge partial">${t('bak.preUpdate')}</span>` : ''}</td>
      <td class="hint">${fmtBytes(sn.size)}</td>
      <td><button type="button" class="btn small" data-restore="${esc(sn.id)}" data-stack="${esc(sn.stack)}">${t('bak.restore')}</button></td>
    </tr>`).join('')}
    </tbody></table>
    <form class="notice warn" id="restore-form" hidden>
      <strong id="restore-title"></strong>
      <p style="margin:6px 0">${t('bak.restoreLead')}</p>
      <div class="field"><label for="rs-target">${t('bak.restoreTarget')}</label>
        <input type="text" id="rs-target" autocapitalize="off" autocomplete="off">
        <p class="hint">${t('bak.restoreTargetHint')}</p></div>
      <div class="field"><label for="rs-confirm">${t('bak.restoreConfirm')}</label>
        <input type="text" id="rs-confirm" autocapitalize="off" autocomplete="off"></div>
      <div id="rs-out"></div>
      <div class="row"><button class="btn primary">${t('bak.restoreGo')}</button>
        <button type="button" class="btn" id="rs-cancel">${t('bak.cancel')}</button></div>
    </form>
    <pre class="terminal" id="rs-log" hidden></pre>`;
  const form = box.querySelector('#restore-form');
  let snapshot = null;
  box.querySelectorAll('[data-restore]').forEach((b) => b.addEventListener('click', () => {
    snapshot = b.dataset.restore;
    const sn = list.find((x) => x.id === snapshot);
    form.hidden = false;
    box.querySelector('#restore-title').textContent = t('bak.restoreTitle', { stack: sn.stack, date: fmtDate(sn.time) });
    box.querySelector('#rs-target').value = sn.stack;
    box.querySelector('#rs-confirm').value = '';
    box.querySelector('#rs-confirm').focus();
  }));
  box.querySelector('#rs-cancel').addEventListener('click', () => { form.hidden = true; });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const target = box.querySelector('#rs-target').value.trim();
    try {
      await api('POST', '/api/backups/restore', { snapshot, target, confirm: box.querySelector('#rs-confirm').value.trim() });
    } catch (err) {
      box.querySelector('#rs-out').innerHTML = errorBox(err);
      return;
    }
    form.hidden = true;
    box.querySelectorAll('[data-restore]').forEach((b) => (b.disabled = true));
    watchBackupJob(box.querySelector('#rs-log'), (st) => {
      const last = st.history?.[0];
      toast(t(last?.ok ? 'toast.done' : 'toast.failed'));
      refreshStacks().catch(() => {});
      onRestored?.(target, last?.ok);
    });
  });
}

/** Backup runs (one nightly run = all stacks + the panel's settings), newest first. */
function runsTable(box, runs, onDone) {
  if (!runs.length) {
    box.innerHTML = `<p class="hint">${t('bak.noSnapshots')}</p>`;
    return;
  }
  box.innerHTML = `
    <div class="runs">${runs.map((r, i) => `
      <details class="run" ${i === 0 ? 'open' : ''}>
        <summary>
          <span class="run-date">${fmtDate(r.time)}</span>
          <span class="tag ${r.kind === 'pre-update' ? 'soon' : ''}">${esc(t(`bak.kind.${r.kind}`))}</span>
          <span class="hint">${t('bak.runStacks', { n: r.stacks.length })}${r.system ? ` · ${t('bak.runSettings')}` : ''}</span>
          <span class="hint run-size">${fmtBytes(r.size)}</span>
        </summary>
        <table><tbody>${r.stacks.map((sn) => `<tr>
          <td>${esc(sn.stack)}</td><td class="hint">${fmtBytes(sn.size)}</td>
          <td style="text-align:right"><button type="button" class="btn small" data-one="${esc(sn.id)}" data-stack="${esc(sn.stack)}">${t('bak.restore')}</button></td>
        </tr>`).join('')}</tbody></table>
        ${r.stacks.length > 1 ? `<button type="button" class="btn small" data-all="${esc(r.id)}">${t('bak.restoreAll')}</button>` : ''}
      </details>`).join('')}
    </div>
    <form class="notice warn" id="rr-form" hidden>
      <strong id="rr-title"></strong>
      <p style="margin:6px 0" id="rr-lead"></p>
      <div id="rr-one">
        <div class="field"><label for="rr-target">${t('bak.restoreTarget')}</label>
          <input type="text" id="rr-target" autocapitalize="off" autocomplete="off">
          <p class="hint">${t('bak.restoreTargetHint')}</p></div>
        <div class="field"><label for="rr-confirm">${t('bak.restoreConfirm')}</label>
          <input type="text" id="rr-confirm" autocapitalize="off" autocomplete="off"></div>
      </div>
      <label class="check field" id="rr-all"><input type="checkbox" id="rr-all-ok"> ${t('bak.restoreAllConfirm')}</label>
      <div id="rr-out"></div>
      <div class="row"><button class="btn primary">${t('bak.restoreGo')}</button>
        <button type="button" class="btn" id="rr-cancel">${t('bak.cancel')}</button></div>
    </form>
    <pre class="terminal" id="rr-log" hidden></pre>`;

  const form = box.querySelector('#rr-form');
  let mode = null;
  let target = null;
  const open = () => { form.hidden = false; form.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); };
  box.querySelectorAll('[data-one]').forEach((b) => b.addEventListener('click', () => {
    const run = runs.find((r) => r.stacks.some((x) => x.id === b.dataset.one));
    mode = 'one';
    target = b.dataset.one;
    box.querySelector('#rr-title').textContent = t('bak.restoreTitle', { stack: b.dataset.stack, date: fmtDate(run.time) });
    box.querySelector('#rr-lead').textContent = t('bak.restoreLead');
    box.querySelector('#rr-one').hidden = false;
    box.querySelector('#rr-all').hidden = true;
    box.querySelector('#rr-target').value = b.dataset.stack;
    box.querySelector('#rr-confirm').value = '';
    open();
    box.querySelector('#rr-confirm').focus();
  }));
  box.querySelectorAll('[data-all]').forEach((b) => b.addEventListener('click', () => {
    const run = runs.find((r) => r.id === b.dataset.all);
    mode = 'all';
    target = run.id;
    box.querySelector('#rr-title').textContent = t('bak.restoreAllTitle', { date: fmtDate(run.time) });
    box.querySelector('#rr-lead').textContent = t('bak.restoreAllLead', { list: run.stacks.map((x) => x.stack).join(', ') });
    box.querySelector('#rr-one').hidden = true;
    box.querySelector('#rr-all').hidden = false;
    box.querySelector('#rr-all-ok').checked = false;
    open();
  }));
  box.querySelector('#rr-cancel').addEventListener('click', () => { form.hidden = true; });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      if (mode === 'one') {
        const name = box.querySelector('#rr-target').value.trim();
        await api('POST', '/api/backups/restore', { snapshot: target, target: name, confirm: box.querySelector('#rr-confirm').value.trim() });
      } else {
        await api('POST', '/api/backups/restore-run', { run: target, confirm: box.querySelector('#rr-all-ok').checked });
      }
    } catch (err) {
      box.querySelector('#rr-out').innerHTML = errorBox(err);
      return;
    }
    form.hidden = true;
    box.querySelectorAll('[data-one],[data-all]').forEach((b) => (b.disabled = true));
    watchBackupJob(box.querySelector('#rr-log'), (st) => {
      toast(t(st.history?.[0]?.ok ? 'toast.done' : 'toast.failed'));
      refreshStacks().catch(() => {});
      setTimeout(onDone, 2500);
    });
  });
}

async function settingsBackups(body) {
  let d;
  try {
    d = await api('GET', '/api/backups');
  } catch (err) {
    body.innerHTML = errorBox(err);
    return;
  }
  if (route().page !== 'backups') return;
  const c = d.config;
  const st = d.status;
  const last = st.history?.find((h) => h.kind !== 'restore' && h.kind !== 'verify');
  const verify = st.verifyData || st.verify;

  const next = nextBackup(c);
  const destName = c.destinations.find((x) => x.id === c.destination)?.name || '';
  const lead = document.getElementById('page-lead');
  if (lead) {
    lead.textContent = c.configured
      ? [destName, c.bucket, c.enabled && c.days.length ? `${WEEK.filter((x) => c.days.includes(x)).map(dayName).join(', ')} ${c.time}` : t('bak.off')].filter(Boolean).join(' · ')
      : t('bak.lead');
  }
  if (c.configured) {
    document.querySelector('.head')?.insertAdjacentHTML('beforeend', `
      <div class="actions">
        <button type="button" class="btn" id="bak-open-settings">${t('bak.settingsBtn')}</button>
        <button type="button" class="btn primary" id="bak-run">${t('bak.runNow')}</button>
      </div>`);
  }
  const statusBox = !c.configured ? '' : `
    <section class="summary" aria-label="${esc(t('bak.status'))}">
      <div><span class="k">${t('bak.lastRun')}</span><span class="v">${last ? `${ago(last.at)} <small class="${last.ok ? 'ok' : 'bad'}">${last.ok ? `✓ ${t('bak.okWord')}` : `✕ ${t('bak.failedWord')}`}</small>` : t('upd.never')}</span></div>
      <div><span class="k">${t('bak.next')}</span><span class="v">${next ? esc(fmtShort(next.toISOString())) : t('bak.off')}</span></div>
      <div><span class="k">${t('bak.checksums')}</span><span class="v">${verify ? `${ago(verify.at)} <small class="${verify.ok ? 'ok' : 'bad'}">${verify.ok ? '✓' : '✕'} ${t(`bak.mode.${verify.mode}`)}</small>` : t('upd.never')}</span></div>
      <div><span class="k">${t('bak.lastSize')}</span><span class="v">${state.overview?.backup?.lastSize ? fmtBytes(state.overview.backup.lastSize) : '—'}</span></div>
    </section>
    ${verify && !verify.ok ? `<div class="notice error">${t('bak.verifyBad')}\n${esc(verify.error || '')}</div>` : ''}
    <div class="row" style="margin-bottom:16px">
      <button type="button" class="btn small" id="bak-verify" title="${esc(t('bak.verifyTitle'))}">${t('bak.verifyNow')}</button>
      ${st.history?.length ? `<details><summary>${t('bak.history')}</summary>
        <table><tbody>${st.history.map(backupRunLabel).join('')}</tbody></table></details>` : ''}
    </div>
    <pre class="terminal" id="bak-log" hidden style="margin-bottom:16px"></pre>
    <section style="margin-bottom:24px"><div class="row" style="justify-content:space-between;margin-bottom:10px"><h2 style="margin:0">${t('bak.runsTitle')}</h2>
      <button type="button" class="btn small" id="bk-refresh" title="${esc(t('bak.refreshTitle'))}">${t('logs.refresh')}</button></div>
      <div id="bk-snaps"><p class="hint">${t('stack.loading')}</p></div></section>`;

  const destOptions = c.destinations.map((x) => `<option value="${esc(x.id)}" ${x.id === c.destination ? 'selected' : ''}>${esc(x.name)}</option>`).join('');
  body.innerHTML = `
    ${statusBox}
    <details class="card" id="bak-settings" ${c.configured ? '' : 'open'}>
    <summary><strong style="color:var(--text)">${t('bak.settingsBtn')}</strong></summary>
    <form id="bak-form" style="margin-top:16px">
      <h2>${t('bak.storage')}</h2>
      <div class="field"><label for="bk-dest">${t('bak.destination')}</label>
        <select id="bk-dest" class="lang">${destOptions}</select>
        <p class="hint" id="bk-help"></p></div>
      <div class="row field">
        <div style="flex:3;min-width:220px"><label for="bk-endpoint">${t('bak.endpoint')}</label>
          <input type="text" id="bk-endpoint" value="${esc(c.endpoint)}" autocapitalize="off" autocomplete="off"></div>
        <div style="flex:1;min-width:120px"><label for="bk-region">${t('bak.region')}</label>
          <input type="text" id="bk-region" value="${esc(c.region)}" autocapitalize="off" autocomplete="off"></div>
      </div>
      <div class="row field">
        <div style="flex:2;min-width:180px"><label for="bk-bucket">${t('bak.bucket')}</label>
          <input type="text" id="bk-bucket" value="${esc(c.bucket)}" autocapitalize="off" autocomplete="off"></div>
        <div style="flex:1;min-width:120px"><label for="bk-prefix">${t('bak.prefix')}</label>
          <input type="text" id="bk-prefix" value="${esc(c.prefix)}" autocapitalize="off" autocomplete="off"></div>
      </div>
      <div class="field"><label for="bk-ak">${t('bak.accessKey')}</label>
        <input type="text" id="bk-ak" value="${esc(c.accessKey)}" autocapitalize="off" autocomplete="off"></div>
      <div class="field"><label for="bk-sk">${t('bak.secretKey')}</label>
        <input type="password" id="bk-sk" placeholder="${esc(c.secretKey)}" autocomplete="off"></div>

      <h2 style="margin-top:22px">${t('bak.encryption')}</h2>
      <div class="field"><label for="bk-pw">${t('bak.password')}</label>
        <div class="row" style="flex-wrap:nowrap">
          <input type="password" id="bk-pw" placeholder="${esc(c.password)}" autocomplete="new-password" style="flex:1;min-width:0">
          <button type="button" class="btn" id="bk-gen">${t('bak.generate')}</button>
          ${c.password ? `<button type="button" class="btn" id="bk-show">${t('bak.show')}</button>` : ''}
        </div></div>
      <div class="notice warn">${t('bak.passwordWarn')}</div>

      <h2 style="margin-top:22px">${t('bak.scheduleTitle')}</h2>
      <label class="check field"><input type="checkbox" id="bk-enabled" ${c.enabled ? 'checked' : ''}> ${t('bak.enabled')}</label>
      <div class="field"><label>${t('bak.days')}</label>
        <div class="row days">${WEEK.map((x) => `<label class="check"><input type="checkbox" class="bk-day" value="${x}" ${c.days.includes(x) ? 'checked' : ''}> ${esc(dayName(x))}</label>`).join('')}</div></div>
      <div class="field" style="max-width:180px"><label for="bk-time">${t('bak.time')}</label>
        <input type="time" id="bk-time" value="${esc(c.time)}"></div>
      <p class="hint field">${t('bak.timeZone', { zone: esc(Intl.DateTimeFormat().resolvedOptions().timeZone) })}</p>

      <h2 style="margin-top:22px">${t('bak.retention')}</h2>
      <p class="hint" style="margin-top:-4px">${t('bak.retentionLead')}</p>
      <div class="row field">
        <div style="flex:1;min-width:110px"><label for="bk-kd">${t('bak.keepDaily')}</label><input type="number" min="0" id="bk-kd" value="${esc(c.keepDaily)}"></div>
        <div style="flex:1;min-width:110px"><label for="bk-kw">${t('bak.keepWeekly')}</label><input type="number" min="0" id="bk-kw" value="${esc(c.keepWeekly)}"></div>
        <div style="flex:1;min-width:110px"><label for="bk-km">${t('bak.keepMonthly')}</label><input type="number" min="0" id="bk-km" value="${esc(c.keepMonthly)}"></div>
      </div>
      <label class="check field"><input type="checkbox" id="bk-before" ${c.beforeUpdate ? 'checked' : ''}> ${t('bak.beforeUpdate')}</label>
      <label class="check field"><input type="checkbox" id="bk-vw" ${c.verifyWeekly ? 'checked' : ''}> ${t('bak.verifyWeekly')}</label>

      <div id="bk-out"></div>
      <button class="btn primary">${t('bak.saveTest')}</button>
    </form>
    </details>`;
  document.getElementById('bak-open-settings')?.addEventListener('click', () => {
    const det = document.getElementById('bak-settings');
    det.open = true;
    det.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  // Destination presets: help text, and the address filled in from the region.
  const epFor = (dest, region) => (dest?.endpoint && !dest.endpoint.includes('<') ? dest.endpoint.replace('{region}', region) : '');
  let autoEp = null;
  const drawDest = (fill) => {
    const dest = c.destinations.find((x) => x.id === document.getElementById('bk-dest').value);
    document.getElementById('bk-help').textContent = dest?.help?.[lang] || dest?.help?.en || '';
    const ep = document.getElementById('bk-endpoint');
    const rg = document.getElementById('bk-region');
    if (fill) {
      rg.value = dest?.region || '';
      ep.value = epFor(dest, rg.value);
      autoEp = ep.value;
    } else if (autoEp !== null && ep.value === autoEp) {
      ep.value = epFor(dest, rg.value);
      autoEp = ep.value;
    }
    ep.placeholder = (dest?.endpoint || 'minio.example.com:9000').replace('{region}', rg.value || dest?.region || '');
  };
  drawDest(!c.endpoint);
  document.getElementById('bk-dest').addEventListener('change', () => drawDest(true));
  document.getElementById('bk-region').addEventListener('input', () => drawDest(false));

  document.getElementById('bk-gen').addEventListener('click', () => {
    const abc = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const bytes = crypto.getRandomValues(new Uint8Array(28));
    const pw = Array.from(bytes, (b) => abc[b % abc.length]).join('');
    const el = document.getElementById('bk-pw');
    el.type = 'text';
    el.value = pw;
    el.select();
  });
  document.getElementById('bk-show')?.addEventListener('click', async () => {
    const r = await api('POST', '/api/backups/reveal').catch(() => null);
    if (!r) return;
    const el = document.getElementById('bk-pw');
    el.type = 'text';
    el.value = r.password;
    el.select();
  });

  document.getElementById('bak-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const out = document.getElementById('bk-out');
    const val = (id) => document.getElementById(id).value;
    const ep = document.getElementById('bk-endpoint');
    try {
      await api('PUT', '/api/backups', {
        destination: val('bk-dest'),
        endpoint: ep.value.trim(),
        region: val('bk-region').trim(),
        bucket: val('bk-bucket'),
        prefix: val('bk-prefix'),
        accessKey: val('bk-ak'),
        secretKey: val('bk-sk'),
        password: val('bk-pw'),
        enabled: document.getElementById('bk-enabled').checked,
        days: [...document.querySelectorAll('.bk-day:checked')].map((x) => Number(x.value)),
        time: val('bk-time'),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        keepDaily: Number(val('bk-kd')),
        keepWeekly: Number(val('bk-kw')),
        keepMonthly: Number(val('bk-km')),
        beforeUpdate: document.getElementById('bk-before').checked,
        verifyWeekly: document.getElementById('bk-vw').checked,
      });
      out.innerHTML = `<p class="hint">${t('bak.testing')}</p>`;
      const r = await api('POST', '/api/backups/test');
      toast(t(r.created ? 'bak.repoCreated' : 'bak.repoOk'));
      renderPage('backups');
    } catch (err) {
      out.innerHTML = errorBox(err);
    }
  });

  const startJob = async (url) => {
    const runBtn = document.getElementById('bak-run');
    const verBtn = document.getElementById('bak-verify');
    if (runBtn) runBtn.disabled = true;
    if (verBtn) verBtn.disabled = true;
    if (url) { try { await api('POST', url); } catch (err) { toast(err.message); } }
    const logEl = document.getElementById('bak-log');
    if (!logEl) return;
    watchBackupJob(logEl, (s2) => {
      toast(t(s2.history?.[0]?.ok ? 'toast.done' : 'toast.failed'));
      setTimeout(() => { if (route().page === 'backups') { renderPage('backups'); refreshOverview(); } }, 1500);
    });
  };
  document.getElementById('bak-run')?.addEventListener('click', () => startJob('/api/backups/run'));
  document.getElementById('bak-verify')?.addEventListener('click', () => startJob('/api/backups/verify'));
  if (st.running || st.queued) startJob(null); // a job is already running: just follow it

  const snapsBox = document.getElementById('bk-snaps');
  const loadAll = async (fresh = false) => {
    if (fresh) snapsBox.innerHTML = `<p class="hint">${t('stack.loading')}</p>`;
    const list = await api('GET', `/api/backups/runs${fresh ? '?fresh=1' : ''}`).catch((err) => { snapsBox.innerHTML = errorBox(err); return null; });
    if (list && route().page === 'backups') runsTable(snapsBox, list.filter((r) => r.stacks.length), () => loadAll());
  };
  if (snapsBox) {
    document.getElementById('bk-refresh').addEventListener('click', () => loadAll(true));
    loadAll();
  }
}

function settingsAccount(body) {
  body.innerHTML = `
    <form class="card strong" id="pw" style="max-width:720px">
      <h2>${t('acct.security')}</h2>
      <p class="hint" style="margin-top:-4px">${t('acc.signedInAs', { user: esc(state.user?.username || '') })}</p>
      <div class="field"><label for="cur">${t('pw.current')}</label><input type="password" id="cur" autocomplete="current-password" required></div>
      <div class="row field" style="align-items:flex-start">
        <div style="flex:1;min-width:200px"><label for="nw">${t('pw.new')}</label><input type="password" id="nw" autocomplete="new-password" minlength="10" required></div>
        <div style="flex:1;min-width:200px"><label for="nw2">${t('pw.repeat')}</label><input type="password" id="nw2" autocomplete="new-password" minlength="10" required></div>
      </div>
      <div id="pw-out"></div>
      <button class="btn primary">${t('pw.submit')}</button>
    </form>
    <div class="card" style="max-width:720px">
      <h2>${t('set.language')}</h2>
      <label for="acc-lang">${t('acct.langLabel')}</label>
      <div style="max-width:320px">${langSelect('acc-lang')}</div>
    </div>`;
  bindLangSelect('acc-lang');
  document.getElementById('pw').addEventListener('submit', async (e) => {
    e.preventDefault();
    const out = document.getElementById('pw-out');
    if (document.getElementById('nw').value !== document.getElementById('nw2').value) {
      out.innerHTML = `<div class="notice error">${t('pw.mismatch')}</div>`;
      return;
    }
    try {
      await api('POST', '/api/password', { current: document.getElementById('cur').value, next: document.getElementById('nw').value });
      e.target.reset();
      out.innerHTML = '';
      toast(t('pw.done'));
    } catch (err) {
      out.innerHTML = errorBox(err);
    }
  });
}

// ---------- new panel version: banner, status bar, dialog ----------

const UPD_HIDE_KEY = 'sm-upd-hide';
const hiddenFor = () => { try { return localStorage.getItem(UPD_HIDE_KEY); } catch { return null; } };
const updKey = (p) => (p ? `${p.latest || ''}|${p.buildUpdate ? 'build' : ''}` : '');

function renderUpdateBadge() {
  renderStatusbar();
  const el = document.getElementById('update-banner');
  if (!el) return;
  const p = state.updates?.panel;
  if (!p?.updateAvailable || hiddenFor() === updKey(p) || state.updating) { el.innerHTML = ''; return; }
  const what = p.buildUpdate ? t('upd.newBuild') : t('upd.bannerTitle', { version: esc(showVersion(p.latest)) });
  el.innerHTML = `
    <div class="update-banner" role="status">
      ${svg(ICON.up)}
      <span><strong>${what}</strong> <span class="muted">· ${t('upd.youHave', { version: esc(state.version) })}</span></span>
      <a href="#" id="upd-notes">${t('upd.whatsNew')}</a>
      <div class="acts">
        <button type="button" class="btn" id="upd-open">${t('upd.updateBtn')}</button>
        <button type="button" class="btn close" id="upd-hide" aria-label="${esc(t('upd.hideBanner'))}" title="${esc(t('upd.hideBanner'))}">×</button>
      </div>
    </div>`;
  el.querySelector('#upd-notes').addEventListener('click', (e) => { e.preventDefault(); openUpdateDialog(); });
  el.querySelector('#upd-open').addEventListener('click', openUpdateDialog);
  el.querySelector('#upd-hide').addEventListener('click', () => {
    try { localStorage.setItem(UPD_HIDE_KEY, updKey(p)); } catch { /* ignore */ }
    el.innerHTML = '';
  });
}

/** Release notes (Markdown from the release) as simple HTML: headings, lists, paragraphs. */
function notesHtml(md) {
  const out = [];
  let list = false;
  const inline = (x) => esc(x).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>');
  for (const raw of String(md || '').split('\n')) {
    const line = raw.trim();
    const li = line.match(/^[-*]\s+(.*)$/);
    if (li) { if (!list) { out.push('<ul>'); list = true; } out.push(`<li>${inline(li[1])}</li>`); continue; }
    if (list) { out.push('</ul>'); list = false; }
    if (!line) continue;
    const h = line.match(/^#{1,6}\s+(.*)$/);
    out.push(h ? `<h4>${inline(h[1])}</h4>` : `<p>${inline(line)}</p>`);
  }
  if (list) out.push('</ul>');
  return out.join('');
}

function closeDialog() {
  document.getElementById('dialog')?.remove();
}

function openUpdateDialog() {
  const u = state.updates || {};
  const p = u.panel || {};
  if (!p.updateAvailable) { location.hash = '#/settings/updates'; return; }
  const mode = u.self?.mode || 'none';
  const target = p.buildUpdate ? t('upd.newBuildShort') : showVersion(p.latest);
  closeDialog();
  document.body.insertAdjacentHTML('beforeend', `
    <div class="overlay" id="dialog">
      <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="dlg-title">
        <div class="dh">
          <h2 id="dlg-title">${t('upd.dialogTitle')}</h2>
          <span class="ver">${esc(state.version)} → <strong>${esc(target)}</strong></span>
          <button type="button" class="x" id="dlg-x" aria-label="${esc(t('upd.close'))}">×</button>
        </div>
        <div class="db">
          <div class="notes">
            <h3>${t('upd.whatsNew')}</h3>
            <div class="scroll">${p.notes ? notesHtml(p.notes) : `<p class="hint">${t('upd.noNotes')}</p>`}</div>
            ${p.url ? `<a href="${esc(p.url)}" target="_blank" rel="noopener" style="display:inline-block;margin-top:8px;font-size:13px">${t('upd.fullNotes')} ↗</a>` : ''}
          </div>
          ${mode === 'compose'
            ? `<div class="notice" style="margin:0"><div>${t('upd.dialogKeep')}</div><div class="hint" style="margin-top:4px">${t('upd.dialogReload')}</div></div>`
            : `<div class="notice" style="margin:0">${t(`upd.how.${mode}`, { tag: esc(u.self?.tag || '') })}</div>`}
          <div id="dlg-out"></div>
        </div>
        <div class="df">
          <button type="button" class="btn" id="dlg-later">${t('upd.later')}</button>
          ${mode === 'compose' ? `<button type="button" class="btn primary" id="dlg-go">${t('upd.updateNow')}</button>` : ''}
        </div>
      </div>
    </div>`);
  const dlg = document.getElementById('dialog');
  dlg.addEventListener('click', (e) => { if (e.target === dlg) closeDialog(); });
  dlg.querySelector('#dlg-x').addEventListener('click', closeDialog);
  dlg.querySelector('#dlg-later').addEventListener('click', closeDialog);
  dlg.querySelector('#dlg-x').focus();
  dlg.querySelector('#dlg-go')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      await api('POST', '/api/updates/apply');
    } catch (err) {
      dlg.querySelector('#dlg-out').innerHTML = errorBox(err);
      e.target.disabled = false;
      return;
    }
    showUpdateProgress(target);
  });
}

/** While the panel updates itself: steps, then the page reloads on its own. */
function showUpdateProgress(target) {
  closeDialog();
  document.body.insertAdjacentHTML('beforeend', `
    <div class="overlay" id="dialog">
      <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="dlg-title" style="max-width:460px">
        <div class="db">
          <h2 id="dlg-title" style="margin:0;font-size:18px">${t('upd.progressTitle', { version: esc(target) })}</h2>
          <div class="progress"><span id="upd-bar" style="width:15%"></span></div>
          <ol class="steps" id="upd-steps">
            <li class="done">${t('upd.stepStarted')}</li>
            <li class="now">${t('upd.stepWaiting')}</li>
            <li class="todo">${t('upd.stepReload')}</li>
            <li class="todo">${t('upd.stepCheck')}</li>
          </ol>
          <p class="hint" style="margin:0">${t('upd.progressHint')}</p>
        </div>
      </div>
    </div>`);
  const started = Date.now();
  const bar = document.getElementById('upd-bar');
  const timer = setInterval(() => {
    if (!bar.isConnected) { clearInterval(timer); return; }
    bar.style.width = `${Math.min(90, 15 + ((Date.now() - started) / RESTART_FALLBACK_MS) * 75)}%`;
  }, 500);
  waitForRestart(() => {
    const steps = document.querySelectorAll('#upd-steps li');
    steps[1].className = 'done';
    steps[2].className = 'now';
    bar.style.width = '100%';
  });
}

// ---------- start ----------

function render() {
  stopStream();
  closeDialog();
  if (!state.user) {
    clearInterval(state.refreshTimer);
    state.refreshTimer = null;
    return renderAuth();
  }
  if (state.afterSetup) return renderAccessStep();
  renderShell();
  window.scrollTo(0, 0);
  const r = route();
  if (r.page === 'new') renderNew();
  else if (r.page === 'stack') renderStack(r.name);
  else if (r.page === 'proxy') renderProxyForm(r.id);
  else if (r.page === 'settings') renderSettings(r.tab);
  else if (r.page === 'network') renderNetwork(r.tab);
  else if (r.page === 'backups' || r.page === 'domains' || r.page === 'account') renderPage(r.page);
  else { frame('page'); renderHome(); }
}

async function boot() {
  const s = await api('GET', '/api/state');
  state.user = s.user;
  state.needsSetup = s.needsSetup;
  if (s.restoring) state.wizard = 'progress';
  state.version = !s.version ? '' : /^\d/.test(s.version) ? `v${s.version}` : s.version;
  state.stacksDir = s.stacksDir;
  state.stacksDirOk = s.stacksDirOk;
  state.bootId = s.bootId;
  state.updating = Boolean(s.updating);
  if (state.user) {
    state.stacks = await api('GET', '/api/stacks').catch(() => []);
    state.updates = await api('GET', '/api/updates').catch(() => null);
    state.overview = await api('GET', '/api/overview').catch(() => null);
    clearInterval(state.refreshTimer);
    state.refreshTimer = setInterval(refreshStacks, 10_000);
  }
  render();
  // Opened (or reloaded) while a self-update is still running: keep waiting for the new panel.
  if (state.user && state.updating) {
    const p = state.updates?.panel;
    showUpdateProgress(p?.latest && !p.buildUpdate ? showVersion(p.latest) : t('upd.newBuildShort'));
  }
  // Just reloaded after a self-update: ask again which version is the newest.
  let justUpdated = false;
  try { justUpdated = sessionStorage.getItem(JUST_UPDATED_KEY) === '1'; sessionStorage.removeItem(JUST_UPDATED_KEY); } catch { /* ignore */ }
  if (state.user && justUpdated && !state.updating) {
    api('POST', '/api/updates/check').then((u) => { state.updates = u; renderUpdateBadge(); }).catch(() => {});
  }
}

window.addEventListener('hashchange', render);
boot();
