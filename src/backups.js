import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { docker } from './docker.js';
import { getState, setState } from './db.js';
import { UserError } from './errors.js';
import { encrypt, decrypt, mask, initSecrets } from './secrets.js';
import {
  DESTINATIONS, destinationById, repoUrl, dumpKind, dumpCommand, restoreCommand, readyCommand,
  DUMP_FILE, dataFolders, containerName, retentionArgs, isDue, localParts, newRunId, groupRuns, cleanExcludes, excludeArgs,
  snapshotStack, cleanManifest,
} from './backup-plan.js';

// Backups with restic, the Cloudron way:
// - one encrypted repository (one bucket) for all stacks and the panel's own files,
// - databases are dumped first while the apps keep running; the dump is backed up
//   instead of the database's raw files,
// - each stack is its own snapshot (tag "stack:<name>"), so it can be restored alone,
// - old snapshots are removed by the retention rules, and every run is checked
//   (restic stores every piece under its SHA-256 checksum; `check` verifies them).

const DUMPS = '.stackmoor-dumps';
const HOST = 'stackmoor';
const MAX_LOG = 100_000;

const DEFAULTS = {
  enabled: false,
  destination: 'b2',
  endpoint: '',
  region: '',
  bucket: '',
  prefix: 'stackmoor',
  days: [0, 1, 2, 3, 4, 5, 6],
  time: '03:00',
  timeZone: 'UTC',
  keepDaily: 7,
  keepWeekly: 4,
  keepMonthly: 6,
  beforeUpdate: true,
  verifyWeekly: true,
};

/** Runs a command; stdout/stdin can go to/from files (database dumps can be large). */
function run(cmd, args, { env, stdoutFile, stdinFile, onStdout, onStderr } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { env, stdio: [stdinFile ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    } catch (err) {
      return resolve({ code: 127, stdout: '', stderr: err.message });
    }
    let stdout = '';
    let stderr = '';
    let out = null;
    if (stdoutFile) {
      out = fs.createWriteStream(stdoutFile, { mode: 0o600 });
      child.stdout.pipe(out);
    } else {
      child.stdout.on('data', (d) => {
        const s = d.toString();
        if (stdout.length < 5_000_000) stdout += s;
        onStdout?.(s);
      });
    }
    child.stderr.on('data', (d) => {
      const s = d.toString();
      stderr = (stderr + s).slice(-20_000);
      onStderr?.(s);
    });
    if (stdinFile) {
      const input = fs.createReadStream(stdinFile);
      input.on('error', () => child.stdin.end());
      child.stdin.on('error', () => {});
      input.pipe(child.stdin);
    }
    child.on('error', (err) => { stderr += `\n${err.message}`; });
    child.on('close', (code) => {
      const done = () => resolve({ code: code ?? 1, stdout, stderr });
      if (out) out.close(done); else done();
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

export function createBackups({ db, stacks, stacksDir, dataDir, sqlite }) {
  const cacheDir = path.join(dataDir, 'restic-cache');

  // ---------- configuration ----------

  const config = () => ({ ...DEFAULTS, ...(getState(db, 'backup.config') || {}) });
  const secrets = () => decrypt(getState(db, 'backup.secrets')) || {};
  const configured = (c = config(), s = secrets()) =>
    Boolean(c.endpoint && c.bucket && s.accessKey && s.secretKey && s.password);

  function publicConfig() {
    const c = config();
    const s = secrets();
    return {
      ...c,
      accessKey: s.accessKey || '',
      secretKey: mask(s.secretKey),
      password: mask(s.password),
      configured: configured(c, s),
      initialized: Boolean(getState(db, 'backup.initialized')),
      destinations: DESTINATIONS,
    };
  }

  function saveConfig(body = {}) {
    const old = config();
    const oldSecrets = secrets();
    const str = (v) => String(v ?? '').trim();
    const c = {
      enabled: Boolean(body.enabled),
      destination: destinationById(body.destination) ? body.destination : 's3',
      endpoint: str(body.endpoint).replace(/^https?:\/\//, '').replace(/\/+$/, ''),
      region: str(body.region),
      bucket: str(body.bucket),
      prefix: str(body.prefix).replace(/^\/+|\/+$/g, ''),
      days: [...new Set((Array.isArray(body.days) ? body.days : []).map(Number))].filter((d) => d >= 0 && d <= 6).sort(),
      time: /^([01]\d|2[0-3]):[0-5]\d$/.test(str(body.time)) ? str(body.time) : DEFAULTS.time,
      timeZone: str(body.timeZone) || old.timeZone,
      keepDaily: Number(body.keepDaily),
      keepWeekly: Number(body.keepWeekly),
      keepMonthly: Number(body.keepMonthly),
      beforeUpdate: body.beforeUpdate === undefined ? old.beforeUpdate : Boolean(body.beforeUpdate),
      verifyWeekly: body.verifyWeekly === undefined ? old.verifyWeekly : Boolean(body.verifyWeekly),
    };
    try { new Intl.DateTimeFormat('en', { timeZone: c.timeZone }); } catch { c.timeZone = 'UTC'; }
    for (const k of ['keepDaily', 'keepWeekly', 'keepMonthly']) {
      if (!Number.isInteger(c[k]) || c[k] < 0 || c[k] > 1000) throw new UserError('backup.badRetention');
    }
    if (c.keepDaily + c.keepWeekly + c.keepMonthly === 0) throw new UserError('backup.badRetention');
    if (c.endpoint && !/^[a-z0-9.-]+(:\d+)?$/i.test(c.endpoint)) throw new UserError('backup.badEndpoint');
    if (c.bucket && !/^[a-z0-9][a-z0-9.-]{1,62}$/.test(c.bucket)) throw new UserError('backup.badBucket');
    if (/[^a-zA-Z0-9._/-]/.test(c.prefix)) throw new UserError('backup.badPrefix');

    // Secrets: empty or masked fields keep the saved value.
    const keep = (v, prev) => (str(v) === '' || str(v).startsWith('••••••') ? prev || '' : str(v));
    const s = {
      accessKey: str(body.accessKey) || oldSecrets.accessKey || '',
      secretKey: keep(body.secretKey, oldSecrets.secretKey),
      password: keep(body.password, oldSecrets.password),
    };
    if (s.password && s.password.length < 12) throw new UserError('backup.shortPassword');
    if (c.enabled && !configured(c, s)) throw new UserError('backup.incomplete');

    // A different place (or password) is a different repository.
    const where = (x, y) => `${repoUrl(x)}|${y.accessKey}|${y.password}`;
    if (where(c, s) !== where(old, oldSecrets)) {
      setState(db, 'backup.initialized', false);
      setState(db, 'backup.snapshots', null);
    }
    setState(db, 'backup.config', c);
    setState(db, 'backup.secrets', encrypt(s));
    return publicConfig();
  }

  const revealPassword = () => secrets().password || '';

  // ---------- restic ----------

  function resticEnv() {
    const c = config();
    const s = secrets();
    return {
      ...process.env,
      // STACKMOOR_RESTIC_REPOSITORY: any restic repository (e.g. a local folder) – for tests
      // and advanced setups; the storage fields in the UI are then only placeholders.
      RESTIC_REPOSITORY: process.env.STACKMOOR_RESTIC_REPOSITORY || repoUrl(c),
      RESTIC_PASSWORD: s.password,
      AWS_ACCESS_KEY_ID: s.accessKey,
      AWS_SECRET_ACCESS_KEY: s.secretKey,
      AWS_DEFAULT_REGION: c.region || 'us-east-1',
      RESTIC_CACHE_DIR: cacheDir,
      RESTIC_PROGRESS_FPS: '0.2',
    };
  }

  async function restic(args, log = () => {}, { quiet = false } = {}) {
    const r = await run('restic', args, {
      env: resticEnv(),
      onStderr: quiet ? undefined : log,
    });
    if (r.code === 127 || /ENOENT/.test(r.stderr)) throw new UserError('backup.noRestic');
    return r;
  }

  const resticError = (r) => r.stderr.trim().split('\n').slice(-6).join('\n').slice(0, 1500);

  async function ensureRepo(log) {
    if (!configured()) throw new UserError('backup.incomplete');
    if (getState(db, 'backup.initialized')) return false;
    const cat = await restic(['cat', 'config'], log, { quiet: true });
    if (cat.code === 0) {
      setState(db, 'backup.initialized', true);
      return false;
    }
    if (!/does not exist|Is there a repository|unable to open config|repository not found|NoSuchKey|key does not exist/i.test(cat.stderr)) {
      if (/wrong password|no key found/i.test(cat.stderr)) throw new UserError('backup.wrongPassword');
      throw new UserError('backup.repoError', { output: resticError(cat) });
    }
    log('$ restic init\n');
    const init = await restic(['init'], log);
    if (init.code !== 0) throw new UserError('backup.repoError', { output: resticError(init) });
    setState(db, 'backup.initialized', true);
    return true;
  }

  // ---------- jobs (one at a time) ----------

  let queue = Promise.resolve();
  let queued = 0;
  let current = null;
  let lastLog = '';

  function history() { return getState(db, 'backup.history', []); }
  function addHistory(entry) { setState(db, 'backup.history', [entry, ...history()].slice(0, 50)); }

  /** Queues a job. extraLog() also receives the output (e.g. the update stream). */
  function job(kind, stack, t, fn, extraLog) {
    queued += 1;
    const p = queue.then(async () => {
      queued -= 1;
      current = { kind, stack, startedAt: new Date().toISOString(), log: '' };
      const log = (s) => {
        current.log = (current.log + s).slice(-MAX_LOG);
        extraLog?.(s);
      };
      const started = Date.now();
      try {
        const result = await fn(log);
        const entry = { at: current.startedAt, kind, stack, ok: !result?.failed?.length, durationMs: Date.now() - started, ...result };
        addHistory(entry);
        try { hooks.afterJob?.(entry); } catch { /* notifications must not change the result */ }
        return result;
      } catch (err) {
        const entry = { at: current.startedAt, kind, stack, ok: false, durationMs: Date.now() - started, error: err.key ? t(err.key, err.vars) : err.message };
        addHistory(entry);
        try { hooks.afterJob?.(entry); } catch { /* notifications must not change the result */ }
        throw err;
      } finally {
        // Refresh the saved list of snapshots before the job counts as finished,
        // so the UI shows the new state as soon as it sees the job end.
        if (kind !== 'verify') await loadSnapshots().catch(() => {});
        lastLog = current.log;
        current = null;
      }
    });
    queue = p.catch(() => {});
    return p;
  }

  // ---------- backing up ----------

  async function isRunning(container) {
    const r = await docker(['inspect', '--format', '{{.State.Running}}', container]);
    return r.code === 0 && r.stdout.trim() === 'true';
  }

  /** Dumps the stack's databases into <stack>/.stackmoor-dumps. Returns folders to leave out. */
  async function dumpDatabases(name, cfg, log, t) {
    const dir = stacks.stackDir(name);
    const dumps = path.join(dir, DUMPS);
    fs.rmSync(dumps, { recursive: true, force: true });
    const manifest = [];
    const excludes = [];
    for (const [svc, def] of Object.entries(cfg.services || {})) {
      const kind = dumpKind(def);
      if (!kind) continue;
      const container = containerName(name, svc, def);
      if (!await isRunning(container)) {
        // A stopped database has consistent files – they are backed up as they are.
        log(t('backup.log.dbStopped', { service: svc }) + '\n');
        continue;
      }
      if (kind === 'redis') {
        await docker(['exec', container, 'sh', '-c', dumpCommand(kind)]);
        continue;
      }
      fs.mkdirSync(dumps, { recursive: true, mode: 0o700 });
      const file = path.join(dumps, `${svc}.${DUMP_FILE[kind]}`);
      log(t('backup.log.dumping', { service: svc, kind }) + '\n');
      const r = await run('docker', ['exec', container, 'sh', '-c', dumpCommand(kind)], { stdoutFile: file });
      const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
      if (r.code !== 0 || size === 0) {
        throw new UserError('backup.dumpFailed', { service: svc, output: r.stderr.trim().slice(-800) });
      }
      manifest.push({ service: svc, kind, file: path.basename(file), size });
      excludes.push(...dataFolders(dir, def));
    }
    if (manifest.length) {
      fs.writeFileSync(path.join(dumps, 'manifest.json'), JSON.stringify({ version: 1, dumps: manifest }, null, 2));
    }
    return { dumps, excludes, manifest };
  }

  function summaryOf(stdout) {
    for (const line of stdout.trim().split('\n').reverse()) {
      try {
        const j = JSON.parse(line);
        if (j.message_type === 'summary') return j;
      } catch { /* progress lines */ }
    }
    return null;
  }

  async function backupStack(name, tags, log, t) {
    const dir = stacks.stackDir(name);
    let cfg = { services: {} };
    try { cfg = await stacks.config(name); } catch { log(t('backup.log.noConfig') + '\n'); }
    const { dumps, excludes } = await dumpDatabases(name, cfg, log, t);
    const skipped = stackExcludes(name);
    try {
      const args = ['backup', dir, '--host', HOST, '--json', '--exclude-caches',
        ...['stack:' + name, ...tags].flatMap((tag) => ['--tag', tag]),
        ...excludes.flatMap((e) => ['--exclude', e]),
        ...excludeArgs(dir, skipped)];
      log(`$ restic backup ${dir}\n`);
      if (skipped.length) log(`${t('backup.log.skipped', { paths: skipped.join(', ') })}\n`);
      const r = await restic(args, log, { quiet: true });
      if (r.code !== 0 && r.code !== 3) throw new UserError('backup.resticFailed', { output: resticError(r) });
      // Exit code 3: some files could not be read – the snapshot exists but is incomplete.
      if (r.code === 3) log(t('backup.log.someUnreadable') + '\n' + resticError(r) + '\n');
      const sum = summaryOf(r.stdout);
      log(t('backup.log.stackDone', {
        stack: name,
        size: formatBytes(sum?.total_bytes_processed || 0),
        added: formatBytes(sum?.data_added || 0),
      }) + '\n');
      return { added: sum?.data_added || 0, size: sum?.total_bytes_processed || 0, snapshot: sum?.snapshot_id?.slice(0, 8) };
    } finally {
      fs.rmSync(dumps, { recursive: true, force: true });
    }
  }

  /** The panel's own files: settings database (a consistent copy), its key, Caddy's files. */
  async function backupSystem(tags, log, t) {
    const staging = path.join(dataDir, 'backup-system');
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
    try {
      sqlite.exec(`VACUUM INTO '${path.join(staging, 'panel.db').replace(/'/g, "''")}'`);
      const key = path.join(dataDir, 'secret.key');
      if (fs.existsSync(key)) fs.copyFileSync(key, path.join(staging, 'secret.key'));
      const paths = [staging];
      const own = path.join(stacksDir, '.stackmoor');
      if (fs.existsSync(own)) paths.push(own);
      log('$ restic backup (system)\n');
      const r = await restic(['backup', ...paths, '--host', HOST, '--json',
        ...['system', ...tags].flatMap((tag) => ['--tag', tag])], log, { quiet: true });
      if (r.code !== 0 && r.code !== 3) throw new UserError('backup.resticFailed', { output: resticError(r) });
      log(t('backup.log.systemDone') + '\n');
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  }

  /**
   * Retention: regular snapshots ("auto") and before-update snapshots are kept separately,
   * each stack by its own history (grouped by path). Then unused data is removed once.
   */
  async function forget(log) {
    await tagLegacy(log);
    log('$ restic forget\n');
    for (const tag of ['auto', 'pre-update']) {
      const r = await restic(['forget', '--host', HOST, '--tag', tag, ...retentionArgs(config())], log, { quiet: true });
      if (r.code !== 0) log(resticError(r) + '\n');
    }
    log('$ restic prune\n');
    const p = await restic(['prune'], log, { quiet: true });
    if (p.code !== 0) log(resticError(p) + '\n');
  }

  /** Snapshots made by 0.5 have no "auto" tag – add it, so the retention rules see them. */
  async function tagLegacy(log) {
    const r = await restic(['snapshots', '--json', '--host', HOST], log, { quiet: true });
    if (r.code !== 0) return;
    const ids = (JSON.parse(r.stdout || '[]') || [])
      .filter((x) => !(x.tags || []).includes('auto') && !(x.tags || []).includes('pre-update'))
      .map((x) => x.id);
    if (ids.length) await restic(['tag', '--add', 'auto', ...ids], log, { quiet: true });
  }

  /** mode: 'quick' (structure), 'subset' (10% of the data), 'full' (all data). */
  async function verify(mode, log, t) {
    const args = ['check', ...(mode === 'subset' ? ['--read-data-subset=10%'] : mode === 'full' ? ['--read-data'] : [])];
    log(`$ restic ${args.join(' ')}\n`);
    const r = await restic(args, log, { quiet: mode === 'quick' });
    const result = { at: new Date().toISOString(), mode, ok: r.code === 0, error: r.code === 0 ? '' : resticError(r) };
    setState(db, 'backup.verify', result);
    if (mode !== 'quick') setState(db, 'backup.verifyData', result);
    log(t(result.ok ? 'backup.log.verifyOk' : 'backup.log.verifyFailed', { mode: t(`backup.mode.${mode}`) }) + '\n');
    if (!result.ok) log(result.error + '\n');
    return result;
  }

  async function runAll(kind, t, extraLog) {
    return job(kind, null, t, async (log) => {
      await ensureRepo(log);
      await restic(['unlock'], log, { quiet: true }); // removes stale locks only
      const failed = [];
      let added = 0;
      const tags = ['auto', `run:${newRunId()}`, `kind:${kind}`];
      for (const s of await stacks.list()) {
        try {
          added += (await backupStack(s.name, tags, log, t)).added;
        } catch (err) {
          failed.push(s.name);
          log(t('backup.log.stackFailed', { stack: s.name, message: err.key ? t(err.key, err.vars) : err.message }) + '\n');
        }
      }
      try { await backupSystem(tags, log, t); } catch (err) {
        failed.push('system');
        log((err.key ? t(err.key, err.vars) : err.message) + '\n');
      }
      await forget(log);
      const check = await verify('quick', log, t);
      // Once a week also read back part of the data and compare checksums.
      const last = getState(db, 'backup.verifyData');
      if (config().verifyWeekly && (!last || Date.now() - Date.parse(last.at) > 7 * 86_400_000)) {
        await verify('subset', log, t);
      }
      if (!check.ok) failed.push('check');
      return { failed, added };
    }, extraLog);
  }

  function backupOne(name, t, { preUpdate = false, extraLog } = {}) {
    stacks.assertName(name);
    const kind = preUpdate ? 'pre-update' : 'manual';
    const tags = [preUpdate ? 'pre-update' : 'auto', `run:${newRunId()}`, `kind:${kind}`];
    return job(kind, name, t, async (log) => {
      await ensureRepo(log);
      await restic(['unlock'], log, { quiet: true });
      const r = await backupStack(name, tags, log, t);
      return { added: r.added, snapshot: r.snapshot };
    }, extraLog);
  }

  // Before updating a stack (hooked into stacks.action).
  stacks.hooks.beforeUpdate = async (name, log, t) => {
    const c = config();
    if (!c.beforeUpdate || !configured(c)) return;
    log(t('backup.log.beforeUpdate') + '\n');
    await backupOne(name, t, { preUpdate: true, extraLog: log });
  };

  // ---------- snapshots and restore ----------

  /**
   * The list of snapshots is kept in the panel's database: reading it from the bucket takes
   * a few seconds, and it only changes when the panel itself backs up, prunes or restores
   * (the list is refreshed after every job). fresh = read it from the bucket now.
   */
  async function snapshots({ fresh = false } = {}) {
    if (!configured()) return [];
    const saved = getState(db, 'backup.snapshots');
    if (saved && !fresh) return saved.list;
    return loadSnapshots();
  }

  async function loadSnapshots() {
    if (!configured()) return [];
    const r = await restic(['snapshots', '--json', '--host', HOST], () => {}, { quiet: true });
    if (r.code !== 0) {
      if (/does not exist|Is there a repository|unable to open config/i.test(r.stderr)) return [];
      throw new UserError('backup.repoError', { output: resticError(r) });
    }
    const list = (JSON.parse(r.stdout || '[]') || [])
      // A snapshot whose stack tag is not a stack name could restore outside the stacks folder.
      .filter((s) => snapshotStack(s.tags) !== false)
      .map((s) => ({
        id: s.id,
        shortId: s.short_id || s.id.slice(0, 8),
        time: s.time,
        tags: s.tags || [],
        paths: s.paths || [],
        stack: snapshotStack(s.tags),
        system: (s.tags || []).includes('system'),
        preUpdate: (s.tags || []).includes('pre-update'),
        run: (s.tags || []).find((x) => x.startsWith('run:'))?.slice(4) || null,
        size: s.summary?.total_bytes_processed ?? null,
      }))
      .sort((a, b) => b.time.localeCompare(a.time));
    setState(db, 'backup.snapshots', { at: new Date().toISOString(), list });
    return list;
  }

  async function waitReady(container, kind, log, t) {
    const cmd = readyCommand(kind);
    const deadline = Date.now() + 300_000;
    let seen = 0;
    log(t('backup.log.waitingDb', { container }) + '\n');
    while (Date.now() < deadline) {
      const r = await docker(['exec', container, 'sh', '-c', cmd]);
      // Ready twice in a row, a few seconds apart (first start runs the init scripts).
      if (r.code === 0) { if (++seen >= 2) return; } else seen = 0;
      await sleep(3000);
    }
    throw new UserError('backup.dbNotReady', { container });
  }

  /** Finds a snapshot by id (saved list first, then the bucket). */
  async function findSnapshot(id) {
    const match = (list) => list.find((s) => s.id === id || s.shortId === id);
    return match(await snapshots()) || match(await snapshots({ fresh: true })) || null;
  }

  /** Restores one stack snapshot into stack `name`. Writes to out(). */
  async function restoreStack(snap, name, log, t) {
    // The name becomes a folder in the stacks folder: never anything else (e.g. from a snapshot tag).
    stacks.assertName(name);
    // Everything is written to log() and also kept for the stack's history.
    let output = '';
    const out = (text) => { output += text; log(text); };
    const work = async () => {
      const dir = stacks.stackDir(name);
      if (fs.existsSync(dir)) {
        if (stacks.exists(name)) await stacks.compose(name, ['down', '--remove-orphans'], out);
        // Nothing is deleted: the current folder goes to the trash.
        const trash = path.join(stacksDir, '.trash');
        fs.mkdirSync(trash, { recursive: true });
        const dest = path.join(trash, `${name}-before-restore-${stamp()}`);
        fs.renameSync(dir, dest);
        out(t('log.movedToTrash', { path: dest }) + '\n');
      }
      out(`$ restic restore ${snap.shortId}\n`);
      const r = await restic(['restore', `${snap.id}:${snap.paths[0]}`, '--target', dir], out);
      if (r.code !== 0) throw new UserError('backup.resticFailed', { output: resticError(r) });

      const dumps = path.join(dir, DUMPS);
      let manifest = [];
      try { manifest = JSON.parse(fs.readFileSync(path.join(dumps, 'manifest.json'), 'utf8')).dumps || []; } catch { /* no databases */ }
      if (manifest.length) {
        // Databases start empty (their files were not in the backup) and get the dump.
        await stacks.prepare(name, out, t);
        const cfg = await stacks.config(name);
        manifest = cleanManifest(manifest, Object.keys(cfg.services || {}));
        const up = await stacks.compose(name, ['up', '-d', ...manifest.map((m) => m.service)], out);
        if (up.code !== 0) throw new UserError('step.exitCode', { code: up.code });
        for (const m of manifest) {
          const container = containerName(name, m.service, cfg.services?.[m.service]);
          await waitReady(container, m.kind, out, t);
          out(t('backup.log.importing', { service: m.service }) + '\n');
          const imp = await run('docker', ['exec', '-i', container, 'sh', '-c', restoreCommand(m.kind)], {
            stdinFile: path.join(dumps, m.file), onStdout: out,
          });
          if (imp.code !== 0) throw new UserError('backup.importFailed', { service: m.service, output: imp.stderr.trim().slice(-800) });
        }
      }
      fs.rmSync(dumps, { recursive: true, force: true });
      await stacks.prepare(name, out, t);
      const all = await stacks.compose(name, ['up', '-d', '--remove-orphans'], out);
      if (all.code !== 0) throw new UserError('step.exitCode', { code: all.code });
      out(t('backup.log.restored', { stack: name, time: snap.time.slice(0, 16).replace('T', ' ') }) + '\n');
    };
    try {
      await (stacks.exists(name) ? stacks.exclusive(name, work) : work());
      stacks.recordOperation(name, 'restore', true, output);
    } catch (err) {
      out(t('log.error', { message: err.key ? t(err.key, err.vars) : err.message }) + '\n');
      stacks.recordOperation(name, 'restore', false, output);
      throw err;
    }
  }

  /** Restores a snapshot into stack `target` (default: the stack it came from). */
  async function restore(snapshotId, target, t, extraLog) {
    const snap = await findSnapshot(snapshotId);
    if (!snap || !snap.stack) throw new UserError('backup.noSnapshot', {}, 404);
    const name = target || snap.stack;
    stacks.assertName(name);
    return job('restore', name, t, async (log) => {
      await restoreStack(snap, name, log, t);
      return { snapshot: snap.shortId };
    }, extraLog);
  }

  async function runs({ fresh = false } = {}) {
    return groupRuns(await snapshots({ fresh }));
  }

  async function findRun(id) {
    const match = (list) => list.find((r) => r.id === id);
    return match(await runs()) || match(await runs({ fresh: true })) || null;
  }

  /** Restores every stack of one run (stacks only – the panel's settings stay as they are). */
  async function restoreRun(runId, t) {
    const r = await findRun(runId);
    if (!r || !r.stacks.length) throw new UserError('backup.noSnapshot', {}, 404);
    return job('restore-run', null, t, async (log) => {
      const failed = [];
      for (const snap of r.stacks) {
        log(`\n— ${snap.stack} —\n`);
        try { await restoreStack(snap, snap.stack, log, t); } catch { failed.push(snap.stack); }
      }
      return { failed, stacks: r.stacks.length };
    });
  }

  // ---------- restoring a whole server (setup wizard) ----------

  // Hooks set by server.js (domains are created after backups).
  const hooks = {};
  let serverRestore = null;

  /** Copies the panel's settings from a restored database into the running one. */
  function importPanelDb(file) {
    const quoted = file.replace(/'/g, "''");
    sqlite.exec(`ATTACH DATABASE '${quoted}' AS r`);
    try {
      const tables = (schema) => sqlite.prepare(`SELECT name FROM ${schema}.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all().map((x) => x.name);
      const theirs = new Set(tables('r'));
      const columns = (schema, table) => sqlite.prepare(`PRAGMA ${schema}.table_info(${table})`).all().map((c) => c.name);
      sqlite.transaction(() => {
        sqlite.exec('DELETE FROM main.sessions');
        for (const table of tables('main')) {
          if (table === 'sessions' || !theirs.has(table)) continue;
          const mine = columns('main', table);
          const common = columns('r', table).filter((c) => mine.includes(c)).map((c) => `"${c}"`).join(', ');
          sqlite.exec(`DELETE FROM main."${table}"`);
          if (common) sqlite.exec(`INSERT INTO main."${table}" (${common}) SELECT ${common} FROM r."${table}"`);
        }
      })();
    } finally {
      sqlite.exec('DETACH DATABASE r');
    }
  }

  /** The panel's own files: settings, encryption key, Caddy's folder (certificates). */
  async function restoreSystem(snap, log, t) {
    const tmp = path.join(dataDir, 'restore-system');
    fs.rmSync(tmp, { recursive: true, force: true });
    const staging = snap.paths.find((p) => p.endsWith('/backup-system'));
    const own = snap.paths.find((p) => p.endsWith('/.stackmoor'));
    if (!staging) throw new UserError('backup.noSnapshot', {}, 404);
    log(`$ restic restore ${snap.shortId} (panel)\n`);
    const r = await restic(['restore', `${snap.id}:${staging}`, '--target', tmp], log, { quiet: true });
    if (r.code !== 0) throw new UserError('backup.resticFailed', { output: resticError(r) });

    // Keep the connection that just worked (it may use another folder or key than the old one).
    const keepConfig = config();
    const keepSecrets = secrets();
    try {
      if (fs.existsSync(path.join(tmp, 'secret.key'))) {
        fs.copyFileSync(path.join(tmp, 'secret.key'), path.join(dataDir, 'secret.key'));
        fs.chmodSync(path.join(dataDir, 'secret.key'), 0o600);
        initSecrets(dataDir);
      }
      importPanelDb(path.join(tmp, 'panel.db'));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    const restored = config();
    const conn = ['destination', 'endpoint', 'region', 'bucket', 'prefix'];
    setState(db, 'backup.config', { ...restored, ...Object.fromEntries(conn.map((k) => [k, keepConfig[k]])) });
    setState(db, 'backup.secrets', encrypt(keepSecrets));
    setState(db, 'backup.initialized', true);
    log(t('backup.log.panelRestored') + '\n');

    if (own) {
      const dest = path.join(stacksDir, '.stackmoor');
      if (fs.existsSync(dest)) {
        const trash = path.join(stacksDir, '.trash');
        fs.mkdirSync(trash, { recursive: true });
        fs.renameSync(dest, path.join(trash, `.stackmoor-before-restore-${stamp()}`));
      }
      const c = await restic(['restore', `${snap.id}:${own}`, '--target', dest], log, { quiet: true });
      if (c.code !== 0) log(resticError(c) + '\n');
    }
  }

  /** Setup wizard: panel settings, then every stack of the run, then Caddy. */
  async function restoreServer(runId, t) {
    if (serverRestore && !serverRestore.done) throw new UserError('backup.busy', {}, 409);
    const r = await findRun(runId);
    if (!r || !r.system) throw new UserError('backup.noSnapshot', {}, 404);
    serverRestore = { runId, time: r.time, total: r.stacks.length, current: 0, stack: null, phase: 'panel', done: false, failed: [], error: null, log: '' };
    const p = job('restore-server', null, t, async (jobLog) => {
      // The wizard shows only this restore's own output, never the log of a later job.
      const log = (s) => {
        serverRestore.log = (serverRestore.log + s).slice(-MAX_LOG);
        jobLog(s);
      };
      try {
        await restoreSystem(r.system, log, t);
        serverRestore.phase = 'stacks';
        for (const snap of r.stacks) {
          serverRestore.current += 1;
          serverRestore.stack = snap.stack;
          log(`\n— ${snap.stack} —\n`);
          try { await restoreStack(snap, snap.stack, log, t); } catch { serverRestore.failed.push(snap.stack); }
        }
        serverRestore.phase = 'domains';
        serverRestore.stack = null;
        if (hooks.afterServerRestore) {
          try { await hooks.afterServerRestore(log, t); } catch (err) { log((err.key ? t(err.key, err.vars) : err.message) + '\n'); }
        }
        serverRestore.phase = 'done';
        return { failed: serverRestore.failed, stacks: r.stacks.length };
      } catch (err) {
        serverRestore.error = err.key ? t(err.key, err.vars) : err.message;
        throw err;
      } finally {
        serverRestore.done = true;
      }
    });
    p.catch(() => {});
    return serverRestore;
  }

  /** For the wizard: connect to an existing repository (never creates one). */
  async function connectExisting(body) {
    const pick = ['destination', 'endpoint', 'region', 'bucket', 'prefix', 'accessKey', 'secretKey', 'password'];
    saveConfig({ ...config(), ...Object.fromEntries(pick.map((k) => [k, body[k]])), enabled: false });
    if (!configured()) throw new UserError('backup.incomplete');
    const cat = await restic(['cat', 'config'], () => {}, { quiet: true });
    if (cat.code !== 0) {
      if (/wrong password|no key found/i.test(cat.stderr)) throw new UserError('backup.wrongPasswordRestore');
      if (/does not exist|Is there a repository|unable to open config|NoSuchKey|key does not exist/i.test(cat.stderr)) throw new UserError('backup.noRepo');
      throw new UserError('backup.repoError', { output: resticError(cat) });
    }
    setState(db, 'backup.initialized', true);
    const list = await runs({ fresh: true });
    return list.filter((x) => x.system).map((x) => ({ id: x.id, time: x.time, kind: x.kind, stacks: x.stacks.map((s) => s.stack), size: x.size }));
  }

  function serverRestoreStatus() {
    if (!serverRestore) return null;
    return { ...serverRestore, failed: [...serverRestore.failed] };
  }

  // ---------- status and schedule ----------

  function status() {
    return {
      configured: configured(),
      enabled: config().enabled,
      running: current ? { kind: current.kind, stack: current.stack, startedAt: current.startedAt } : null,
      queued,
      log: current ? current.log : lastLog,
      snapshotsAt: getState(db, 'backup.snapshots')?.at || null,
      history: history().slice(0, 15),
      verify: getState(db, 'backup.verify'),
      verifyData: getState(db, 'backup.verifyData'),
    };
  }

  async function test() {
    let log = '';
    const created = await ensureRepo((s) => { log += s; });
    return { ok: true, created, log };
  }

  function verifyNow(t) {
    return job('verify', null, t, async (log) => {
      await ensureRepo(log);
      const r = await verify('full', log, t);
      return { failed: r.ok ? [] : ['check'] };
    });
  }

  /** t() is called at run time, so scheduled logs use the language the admin last used. */
  function startScheduler(getT) {
    const tick = () => {
      const c = config();
      if (!configured(c)) return;
      const now = new Date();
      if (isDue(c, getState(db, 'backup.lastScheduled'), now)) {
        setState(db, 'backup.lastScheduled', localParts(now, c.timeZone).date);
        runAll('scheduled', getT()).catch(() => {});
      }
    };
    setInterval(tick, 60_000).unref();
  }

  // ---------- paths the user leaves out of a stack's backup ----------

  function stackExcludes(name) { return getState(db, 'backup.excludes', {})[name] || []; }

  function setStackExcludes(name, list) {
    let clean;
    try { clean = cleanExcludes(list); } catch (err) { throw new UserError(err.key, err.vars || {}); }
    const all = getState(db, 'backup.excludes', {});
    if (clean.length) all[name] = clean; else delete all[name];
    setState(db, 'backup.excludes', all);
    return clean;
  }

  return {
    stackExcludes, setStackExcludes,
    publicConfig, saveConfig, revealPassword, test, status, snapshots, runs, runAll, backupOne, restore,
    restoreRun, restoreServer, serverRestoreStatus, connectExisting, verifyNow, startScheduler, hooks,
    busy: () => Boolean(current),
  };
}

export function formatBytes(n) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = Number(n) || 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(v < 10 && i ? 1 : 0)} ${units[i]}`;
}
