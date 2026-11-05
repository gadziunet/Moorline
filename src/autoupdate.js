// Automatic stack updates (off by default), like Cloudron: on the chosen days and time, every
// running stack with a newer image gets a backup (if backups are set up), new images and a
// restart. If the containers don't come up healthy, the stack goes back to the images it had.
import { docker } from './docker.js';
import { getState, setState } from './db.js';
import { isDue, localParts, cleanSchedule } from './schedule.js';

const MAX_RUNS = 40;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const AUTO_UPDATE_DEFAULTS = { enabled: false, days: [0, 1, 2, 3, 4, 5, 6], time: '04:00', timeZone: 'UTC', exclude: [] };

/**
 * One look at the containers after an update: 'ok', 'wait' (still starting) or 'fail'.
 * containers: `docker inspect` output; restarts: RestartCount per container id before.
 */
export function judgeContainers(containers, restarts = {}) {
  if (!containers.length) return { verdict: 'fail', reason: 'none' };
  let waiting = false;
  for (const c of containers) {
    const st = c.State || {};
    const svc = c.Config?.Labels?.['com.docker.compose.service'] || c.Name?.replace(/^\//, '') || '?';
    if ((c.RestartCount || 0) > (restarts[c.Id] ?? c.RestartCount ?? 0)) return { verdict: 'fail', reason: 'restarting', service: svc };
    if (st.Status === 'restarting') return { verdict: 'fail', reason: 'restarting', service: svc };
    if (st.Status === 'exited' || st.Status === 'dead') {
      if (st.ExitCode !== 0) return { verdict: 'fail', reason: 'exited', service: svc, code: st.ExitCode };
      continue; // one-off containers (migrations, init jobs) finish with 0
    }
    if (st.Health?.Status === 'unhealthy') return { verdict: 'fail', reason: 'unhealthy', service: svc };
    if (st.Status !== 'running' || st.Health?.Status === 'starting') waiting = true;
  }
  return { verdict: waiting ? 'wait' : 'ok' };
}

/**
 * Waits until the stack's containers are fine: at least `settle` ms without a crash or restart,
 * health checks passed. Gives up after `timeout` ms.
 */
export async function waitHealthy(inspect, { settle = 30e3, timeout = 180e3, every = 5e3, wait = sleep, now = Date.now } = {}) {
  const start = now();
  const first = await inspect();
  const restarts = Object.fromEntries(first.map((c) => [c.Id, c.RestartCount || 0]));
  for (;;) {
    await wait(every);
    const r = judgeContainers(await inspect(), restarts);
    if (r.verdict === 'fail') return { ok: false, ...r };
    if (r.verdict === 'ok' && now() - start >= settle) return { ok: true };
    if (now() - start >= timeout) return { ok: false, reason: 'timeout' };
  }
}

export function createAutoUpdate({ db, stacks, updates, backups, getSettings, saveSettings, getT, run = docker, healthOpts = {}, isRebooting = () => false, onResult = () => {} }) {
  let running = null;

  const config = () => ({ ...AUTO_UPDATE_DEFAULTS, ...(getSettings().autoUpdate || {}) });
  const runs = () => getState(db, 'autoupdate.runs', []);
  const addRun = (r) => setState(db, 'autoupdate.runs', [r, ...runs()].slice(0, MAX_RUNS));

  async function containers(name) {
    const ids = await stacks.compose(name, ['ps', '-a', '-q']);
    const list = ids.stdout.split('\n').map((x) => x.trim()).filter(Boolean);
    if (!list.length) return [];
    const r = await run(['inspect', ...list]);
    try { return r.code === 0 ? JSON.parse(r.stdout) : []; } catch { return []; }
  }

  /** Which image (id) each service runs now – to go back to it if the update fails. */
  async function currentImages(name) {
    const seen = new Map();
    for (const c of await containers(name)) {
      const ref = c.Config?.Image;
      if (ref && c.Image && !seen.has(ref)) seen.set(ref, c.Image);
    }
    return [...seen].map(([ref, id]) => ({ ref, id }));
  }

  // Docker drops an image as soon as nothing uses or names it – so before updating, the
  // current images get an extra name to come back to.
  const keepRef = (name, i) => `stackmoor-rollback/${name}:${i}`;
  async function keep(name, before) {
    for (const [i, { id }] of before.entries()) await run(['tag', id, keepRef(name, i)]);
  }
  async function forget(name, before) {
    for (const i of before.keys()) await run(['rmi', keepRef(name, i)]);
  }

  async function rollback(name, before, reason, t, log) {
    let intro = `${t('auto.log.rollback', { reason })}\n`;
    for (const [i, { ref }] of before.entries()) {
      const r = await run(['tag', keepRef(name, i), ref]);
      intro += `$ docker tag ${keepRef(name, i)} ${ref}${r.code === 0 ? '' : `  ✗ ${r.output.trim()}`}\n`;
    }
    const ok = await stacks.action(name, 'up', log, { t, label: 'rollback', intro, noPull: true });
    if (!ok) return false;
    return (await waitHealthy(() => containers(name), { settle: 15e3, timeout: 120e3, ...healthOpts })).ok;
  }

  /** Updates one stack if a newer image is out. Returns what happened. */
  async function updateStack(name, t) {
    const check = await updates.checkStack(name);
    const newer = check.images.filter((i) => i.updateAvailable).map((i) => i.image);
    if (!newer.length) return null;

    const at = new Date().toISOString();
    let log = '';
    const write = (s) => { log = (log + s).slice(-20000); };
    const before = await currentImages(name);
    const beforeIds = (await containers(name)).map((c) => c.Id).sort().join(',');
    await keep(name, before);
    try {
      return await updateKept(name, t, { at, newer, before, beforeIds, write });
    } finally {
      await forget(name, before);
    }
  }

  async function updateKept(name, t, { at, newer, before, beforeIds, write }) {
    const ok = await stacks.action(name, 'update', write, { t, label: 'autoupdate', intro: `${t('auto.log.start', { images: newer.join(', ') })}\n` });

    // Nothing changed (the backup or the download failed): the same containers still run.
    if (!ok) {
      const now = await containers(name);
      const same = now.map((c) => c.Id).sort().join(',') === beforeIds && judgeContainers(now).verdict !== 'fail';
      if (same) return { at, stack: name, result: 'failed', images: newer };
    }

    const health = ok
      ? await waitHealthy(() => containers(name), healthOpts)
      : { ok: false, reason: 'start' };
    if (health.ok) {
      await updates.checkStack(name).catch(() => {});
      return { at, stack: name, result: 'updated', images: newer };
    }
    const reason = t(`auto.reason.${health.reason}`, { service: health.service || '', code: health.code ?? '' });
    const back = await rollback(name, before, reason, t, write);
    return { at, stack: name, result: back ? 'rolledBack' : 'rollbackFailed', images: newer, reason };
  }

  /** Updates all chosen running stacks, one after another. */
  function runAll(kind = 'manual') {
    if (running) return running;
    running = (async () => {
      const t = getT();
      const c = config();
      setState(db, 'autoupdate.current', { kind, startedAt: new Date().toISOString(), stack: null });
      const done = [];
      try {
        // Don't update during a backup (the nightly one may still be running).
        for (let i = 0; i < 240 && backups.busy(); i++) await sleep(30e3);
        for (const s of await stacks.list()) {
          if (isRebooting()) break; // the server is restarting – the rest waits for the next run
          if (c.exclude.includes(s.name) || s.state === 'down' || s.state === 'exited') continue;
          for (let i = 0; i < 60 && stacks.isBusy(s.name); i++) await sleep(10e3);
          setState(db, 'autoupdate.current', { kind, startedAt: new Date().toISOString(), stack: s.name });
          try {
            const r = await updateStack(s.name, t);
            if (r) { addRun({ ...r, kind }); done.push(r); onResult(r); }
          } catch (err) {
            const r = { at: new Date().toISOString(), stack: s.name, result: 'failed', kind, reason: err.key ? t(err.key, err.vars) : err.message };
            addRun(r);
            done.push(r);
            onResult(r);
          }
        }
        setState(db, 'autoupdate.last', { at: new Date().toISOString(), kind, count: done.length });
        return done;
      } finally {
        setState(db, 'autoupdate.current', null);
        running = null;
      }
    })();
    return running;
  }

  function saveConfig(body) {
    const old = config();
    const next = cleanAutoUpdate(body, old);
    saveSettings({ autoUpdate: next });
    return next;
  }

  function status() {
    return {
      config: config(),
      running: running ? getState(db, 'autoupdate.current') : null,
      last: getState(db, 'autoupdate.last'),
      runs: runs().slice(0, 20),
    };
  }

  function startScheduler() {
    const tick = () => {
      const c = config();
      const now = new Date();
      if (!isDue(c, getState(db, 'autoupdate.lastScheduled'), now)) return;
      setState(db, 'autoupdate.lastScheduled', localParts(now, c.timeZone).date);
      runAll('scheduled').catch((err) => console.error('Automatic update failed:', err.message));
    };
    setInterval(tick, 60_000).unref();
  }

  return { runAll, updateStack, status, saveConfig, startScheduler, busy: () => Boolean(running) };
}


export function cleanAutoUpdate(body = {}, old = AUTO_UPDATE_DEFAULTS) {
  const s = cleanSchedule(body, { ...AUTO_UPDATE_DEFAULTS, ...old });
  const exclude = body.exclude === undefined
    ? old.exclude || []
    : [...new Set((Array.isArray(body.exclude) ? body.exclude : []).map(String).filter((n) => /^[a-z0-9][a-z0-9_-]{0,62}$/.test(n)))];
  return { enabled: s.enabled, days: s.days, time: s.time, timeZone: s.timeZone, exclude };
}
