import fs from 'node:fs';
import path from 'node:path';
import { docker, parseJsonLines } from './docker.js';
import { normalizeCompose, addImageVolumes, isFileLikeTarget } from './compose.js';
import { UserError } from './errors.js';
import { publishedPorts, findConflicts, portFromDockerError } from './ports.js';
import { NAME_RE } from './names.js';

export { NAME_RE };

const COMPOSE_FILES = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'];
const ACTIONS = new Set(['up', 'stop', 'restart', 'down', 'update']);

function writeAtomic(file, content) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

function parseLsStatus(status = '') {
  let running = 0;
  let total = 0;
  for (const m of String(status).matchAll(/(\w+)\((\d+)\)/g)) {
    const n = Number(m[2]);
    total += n;
    if (m[1] === 'running') running += n;
  }
  const state = total === 0 ? 'down' : running === total ? 'running' : running > 0 ? 'partial' : 'exited';
  return { state, running, total };
}

// t = translate function from i18n.js, passed in from the request (user's language).
export function createStacks({ db, stacksDir, getSettings }) {
  const locks = new Set();
  // Set by other modules: hooks.beforeUpdate (backups), hooks.beforeUp / afterUp (VPN) – (name, log, t).
  const hooks = {};

  const stackDir = (name) => path.join(stacksDir, name);

  function assertName(name) {
    if (!NAME_RE.test(String(name || ''))) throw new UserError('stack.badName');
  }

  function composeFile(name) {
    const dir = stackDir(name);
    for (const f of COMPOSE_FILES) {
      if (fs.existsSync(path.join(dir, f))) return path.join(dir, f);
    }
    return null;
  }

  function requireStack(name) {
    assertName(name);
    const file = composeFile(name);
    if (!file) throw new UserError('stack.notFound', {}, 404);
    return file;
  }

  function autoVolumes(name) {
    const row = db.prepare('SELECT auto_volumes FROM stacks WHERE name = ?').get(name);
    return row ? row.auto_volumes === 1 : true;
  }

  // Stackmoor-generated additions (e.g. joining the "stackmoor" network for domains)
  // live in a separate override file, so the user's compose.yaml stays untouched.
  const OVERRIDE = 'compose.stackmoor.yaml';
  const base = (name, file, { raw = false } = {}) => {
    const args = [
      'compose', '--ansi', 'never', '--progress', 'plain',
      '-p', name, '--project-directory', stackDir(name), '-f', file,
    ];
    const override = path.join(stackDir(name), OVERRIDE);
    if (!raw && fs.existsSync(override)) args.push('-f', override);
    return args;
  };

  // ---------- read ----------

  async function list() {
    let entries = [];
    try {
      entries = fs.readdirSync(stacksDir, { withFileTypes: true });
    } catch {
      return [];
    }
    const names = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && NAME_RE.test(e.name))
      .map((e) => e.name)
      .filter((n) => composeFile(n));

    const ls = await docker(['compose', 'ls', '--all', '--format', 'json']);
    const statusByName = new Map(parseJsonLines(ls.stdout).map((p) => [p.Name, p.Status]));

    return names.sort().map((name) => ({
      name,
      ...parseLsStatus(statusByName.get(name)),
      busy: locks.has(name),
    }));
  }

  async function get(name) {
    const file = requireStack(name);
    const envFile = path.join(stackDir(name), '.env');
    const ps = await docker([...base(name, file), 'ps', '--all', '--format', 'json']);
    const containers = parseJsonLines(ps.stdout).map((c) => ({
      name: c.Name,
      service: c.Service,
      image: c.Image,
      state: c.State,
      status: c.Status,
      ports: c.Publishers
        ? c.Publishers.filter((p) => p.PublishedPort).map((p) => `${p.PublishedPort}→${p.TargetPort}/${p.Protocol}`)
        : [],
    }));
    return {
      name,
      file: path.basename(file),
      compose: fs.readFileSync(file, 'utf8'),
      env: fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '',
      autoVolumes: autoVolumes(name),
      busy: locks.has(name),
      containers,
    };
  }

  // ---------- write ----------

  async function validate(name, composeText, envText) {
    const dir = stackDir(name);
    const check = path.join(dir, '.compose.check.yaml');
    const envCheck = path.join(dir, '.env.check');
    fs.writeFileSync(check, composeText);
    fs.writeFileSync(envCheck, envText);
    try {
      const r = await docker([
        'compose', '-p', name, '--project-directory', dir,
        '-f', check, '--env-file', envCheck, 'config', '--quiet',
      ]);
      if (r.code !== 0) {
        const output = r.output.replaceAll(check, 'compose.yaml').replaceAll(envCheck, '.env').trim();
        throw new UserError('compose.rejected', { output });
      }
    } finally {
      fs.rmSync(check, { force: true });
      fs.rmSync(envCheck, { force: true });
    }
  }

  // Returns { compose, changes[{key,vars}], warnings[{key,vars}] }.
  async function save(name, { compose, env = '', autoVolumes: auto }, { create = false } = {}) {
    assertName(name);
    if (locks.has(name)) throw new UserError('stack.busy', {}, 409);
    const dir = stackDir(name);
    const existed = fs.existsSync(dir);
    if (create && existed && composeFile(name)) throw new UserError('stack.exists', {}, 409);
    if (!create && !composeFile(name)) throw new UserError('stack.notFound', {}, 404);

    const useAuto = auto === undefined ? autoVolumes(name) : Boolean(auto);

    let result = { text: String(compose ?? ''), changes: [], warnings: [] };
    if (useAuto) result = normalizeCompose(compose, getSettings());

    fs.mkdirSync(dir, { recursive: true });
    try {
      await validate(name, result.text, String(env));
    } catch (err) {
      if (create && !existed) fs.rmSync(dir, { recursive: true, force: true });
      throw err;
    }

    const file = composeFile(name) ?? path.join(dir, 'compose.yaml');
    writeAtomic(file, result.text);
    const envFile = path.join(dir, '.env');
    if (String(env).trim() || fs.existsSync(envFile)) writeAtomic(envFile, String(env));

    db.prepare(
      `INSERT INTO stacks(name, auto_volumes) VALUES (?, ?)
       ON CONFLICT(name) DO UPDATE SET auto_volumes = excluded.auto_volumes`
    ).run(name, useAuto ? 1 : 0);

    return { compose: result.text, changes: result.changes, warnings: result.warnings };
  }

  // ---------- preparing a start ----------

  async function resolvedConfig(name, file, opts = {}) {
    const r = await docker([...base(name, file, opts), 'config', '--format', 'json']);
    if (r.code !== 0) throw new UserError('compose.configFailed', { output: r.output.trim() });
    return JSON.parse(r.stdout);
  }

  async function imageVolumes(image) {
    const r = await docker(['image', 'inspect', '--format', '{{json .Config.Volumes}}', image]);
    if (r.code !== 0) return null; // image not present locally
    try {
      return Object.keys(JSON.parse(r.stdout.trim()) || {});
    } catch {
      return [];
    }
  }

  function mkdirOwned(target, stopAt, uid, gid) {
    // Create missing folders and set their owner (only the newly created ones).
    const created = [];
    let p = target;
    while (p.startsWith(stopAt) && p !== stopAt && !fs.existsSync(p)) {
      created.unshift(p);
      p = path.dirname(p);
    }
    for (const dir of created) {
      fs.mkdirSync(dir);
      try { fs.chownSync(dir, uid, gid); } catch { /* e.g. macOS or panel not running as root */ }
    }
    return created.length > 0;
  }

  async function prepare(name, log, t) {
    let file = requireStack(name);
    const dir = stackDir(name);
    const settings = getSettings();

    if (autoVolumes(name)) {
      const cfg = await resolvedConfig(name, file);
      const missing = {};
      for (const [svc, def] of Object.entries(cfg.services || {})) {
        if (!def.image) continue;
        let declared = await imageVolumes(def.image);
        if (declared === null) {
          log(t('log.pulling', { image: def.image }) + '\n');
          await docker([...base(name, file), 'pull', svc], { onData: log });
          declared = (await imageVolumes(def.image)) ?? [];
        }
        const covered = new Set((def.volumes || []).map((v) => String(v.target).replace(/\/+$/, '')));
        const todo = declared.filter((p) => !covered.has(p.replace(/\/+$/, '')));
        if (todo.length) missing[svc] = todo;
      }
      if (Object.keys(missing).length) {
        const res = addImageVolumes(fs.readFileSync(file, 'utf8'), missing);
        writeAtomic(file, res.text);
        for (const c of res.changes) log(`[volumes] ${t(c.key, c.vars)}\n`);
        file = requireStack(name);
      }
    }

    // Create data folders before Docker does (it would create them owned by root).
    const cfg = await resolvedConfig(name, file);
    const missingFiles = [];
    for (const [svc, def] of Object.entries(cfg.services || {})) {
      for (const v of def.volumes || []) {
        if (v.type !== 'bind' || !v.source) continue;
        const src = path.resolve(v.source);
        if (!src.startsWith(dir + path.sep)) continue;
        if (fs.existsSync(src)) continue;
        if (isFileLikeTarget(v.target)) {
          missingFiles.push(`  - ${svc}: ${path.relative(dir, src)} → ${v.target}`);
          continue;
        }
        if (mkdirOwned(src, dir, settings.puid, settings.pgid)) {
          log(t('log.created', { path: path.relative(dir, src), owner: `${settings.puid}:${settings.pgid}` }) + '\n');
        }
      }
    }
    if (missingFiles.length) throw new UserError('files.missing', { list: missingFiles.join('\n') });

    await checkPorts(name, cfg);
    // Stacks with a domain join the shared "stackmoor" network; make sure it exists.
    if (fs.existsSync(path.join(dir, OVERRIDE))) {
      const net = await docker(['network', 'inspect', 'stackmoor']);
      if (net.code !== 0) await docker(['network', 'create', 'stackmoor']);
    }
    return file;
  }

  // Fails early with a readable message when a host port is already used by another container.
  async function checkPorts(name, cfg) {
    const wanted = publishedPorts(cfg);
    if (!wanted.length) return;
    const ps = await docker(['ps', '--format', '{{json .}}']);
    if (ps.code !== 0) return; // let Docker report it
    const conflicts = findConflicts(wanted, parseJsonLines(ps.stdout), name);
    if (conflicts.length) throw new UserError('ports.conflicts', { conflicts });
  }

  // ---------- actions ----------

  /** label: the name saved in the history (e.g. 'autoupdate'); intro: first lines of its log. */
  async function action(name, act, write, { signal, t, label = act, intro = '', noPull = false }) {
    if (!ACTIONS.has(act)) throw new UserError('action.unknown');
    let file = requireStack(name);
    if (locks.has(name)) throw new UserError('stack.busy', {}, 409);
    locks.add(name);

    const op = db.prepare(`INSERT INTO operations(stack, action, status) VALUES (?, ?, 'running')`).run(name, label);
    let output = '';
    const log = (s) => {
      output += s;
      if (output.length > 60_000) output = output.slice(-40_000);
      write(s);
    };
    if (intro) log(intro);
    const step = async (args) => {
      log(`$ docker compose ${args.join(' ')}\n`);
      const r = await docker([...base(name, file), ...args], { onData: log, signal });
      if (r.code !== 0) {
        const port = portFromDockerError(r.output);
        if (port) throw new UserError('ports.inUseHost', { port });
        throw new UserError('step.exitCode', { code: r.code });
      }
    };

    let ok = false;
    try {
      switch (act) {
        case 'up':
          file = await prepare(name, log, t);
          if (hooks.beforeUp) await hooks.beforeUp(name, log, t);
          // noPull: going back to kept images must not download the new ones again (pull_policy: always).
          await step(['up', '-d', '--remove-orphans', ...(noPull ? ['--pull', 'never'] : [])]);
          if (hooks.afterUp) await hooks.afterUp(name, log, t);
          break;
        case 'update':
          // Backup first (if set up); a failed backup stops the update.
          if (hooks.beforeUpdate) await hooks.beforeUpdate(name, log, t);
          await step(['pull']);
          file = await prepare(name, log, t);
          if (hooks.beforeUp) await hooks.beforeUp(name, log, t);
          await step(['up', '-d', '--remove-orphans']);
          if (hooks.afterUp) await hooks.afterUp(name, log, t);
          break;
        case 'stop':
          await step(['stop']);
          break;
        case 'restart':
          await step(['restart']);
          break;
        case 'down':
          await step(['down', '--remove-orphans']);
          break;
      }
      ok = true;
      log(`\n${t('log.done')}\n`);
    } catch (err) {
      const message = err instanceof UserError ? t(err.key, err.vars) : err.message;
      log(`\n${t('log.error', { message })}\n`);
    } finally {
      db.prepare(`UPDATE operations SET status = ?, output = ?, finished_at = datetime('now') WHERE id = ?`)
        .run(ok ? 'ok' : 'error', output, op.lastInsertRowid);
      locks.delete(name);
    }
    return ok;
  }

  async function logs(name, { tail = 200, follow = false, service = '' }, write, signal) {
    const file = requireStack(name);
    const n = Math.min(Math.max(parseInt(tail, 10) || 200, 1), 5000);
    const args = [...base(name, file), 'logs', '--no-color', '--timestamps', '--tail', String(n)];
    if (follow) args.push('--follow');
    if (service) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(service)) throw new UserError('dns.badService', { service });
      args.push('--', service);
    }
    await docker(args, { onData: write, signal });
  }

  async function remove(name, write, t) {
    const file = requireStack(name);
    if (locks.has(name)) throw new UserError('stack.busy', {}, 409);
    locks.add(name);
    try {
      write(`$ docker compose down --remove-orphans\n`);
      const r = await docker([...base(name, file), 'down', '--remove-orphans'], { onData: write });
      if (r.code !== 0) throw new UserError('remove.stopFailed');
      // Never delete data permanently: the folder goes to the trash.
      const trash = path.join(stacksDir, '.trash');
      fs.mkdirSync(trash, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const dest = path.join(trash, `${name}-${stamp}`);
      fs.renameSync(stackDir(name), dest);
      db.prepare('DELETE FROM stacks WHERE name = ?').run(name);
      write(t('log.movedToTrash', { path: dest }) + '\n');
    } finally {
      locks.delete(name);
    }
  }

  function operations(name, limit = 20) {
    return db.prepare(
      `SELECT id, action, status, started_at, finished_at FROM operations
       WHERE stack = ? ORDER BY id DESC LIMIT ?`
    ).all(name, limit);
  }

  /** The latest operations of all stacks (for the dashboard). */
  function recentOperations(limit = 8) {
    return db.prepare(
      'SELECT id, stack, action, status, started_at FROM operations ORDER BY id DESC LIMIT ?'
    ).all(limit);
  }

  function operationOutput(id) {
    return db.prepare('SELECT * FROM operations WHERE id = ?').get(id);
  }

  // Images used by a stack (after variables are resolved), for update checks.
  async function images(name) {
    const file = requireStack(name);
    const cfg = await resolvedConfig(name, file);
    return Object.entries(cfg.services || {})
      .filter(([, def]) => def.image)
      .map(([svc, def]) => ({ svc, image: def.image }));
  }

  // Resolved config of a stack (with variables and the override applied).
  /** The stack's resolved compose config. raw: without Stackmoor's override (the user's own setup). */
  async function config(name, opts = {}) {
    return resolvedConfig(name, requireStack(name), opts);
  }

  /** Runs fn while the stack is locked (no start/stop/update at the same time). */
  async function exclusive(name, fn) {
    if (locks.has(name)) throw new UserError('stack.busy', {}, 409);
    locks.add(name);
    try { return await fn(); } finally { locks.delete(name); }
  }

  /** `docker compose <args>` for an existing stack. */
  async function compose(name, args, log = () => {}) {
    const file = requireStack(name);
    log(`$ docker compose ${args.join(' ')}\n`);
    return docker([...base(name, file), ...args], { onData: log });
  }

  /** Records a finished operation (e.g. a restore) in the stack's history. */
  function recordOperation(name, act, ok, output) {
    db.prepare(`INSERT INTO operations(stack, action, status, output, finished_at) VALUES (?, ?, ?, ?, datetime('now'))`)
      .run(name, act, ok ? 'ok' : 'error', String(output).slice(-60_000));
  }

  const exists = (name) => NAME_RE.test(String(name || '')) && Boolean(composeFile(name));

  return {
    list, get, save, action, logs, remove, operations, recentOperations, operationOutput, assertName, images, config, stackDir,
    hooks, exclusive, compose, prepare, recordOperation, exists, isBusy: (name) => locks.has(name),
  };
}
