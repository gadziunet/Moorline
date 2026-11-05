// The server itself: restart it (now or on a schedule), its state (uptime, a pending restart
// after patches) and automatic system patches on Debian/Ubuntu.
// The panel runs in a container, so commands for the host run in a short-lived privileged
// helper container that enters the host (the panel controls Docker already, so this gives
// it nothing new).
import fs from 'node:fs';
import { docker } from './docker.js';
import { getState, setState } from './db.js';
import { UserError } from './errors.js';
import { isDue, localParts, cleanSchedule } from './schedule.js';

export const REBOOT_DEFAULTS = { enabled: false, days: [0], time: '05:00', timeZone: 'UTC' };
const HELPER = 'stackmoor-host';
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Inside the helper: busybox nsenter enters the host's namespaces; chroot is the fallback.
const ENTER = 'if command -v nsenter >/dev/null 2>&1; then exec nsenter -t 1 -m -u -i -n -- sh -c "$HOST_SCRIPT"; '
  + 'else exec chroot /proc/1/root sh -c "$HOST_SCRIPT"; fi';

const INFO_SCRIPT = [
  '. /etc/os-release 2>/dev/null; echo "os=${PRETTY_NAME:-$ID}"',
  '[ -f /var/run/reboot-required ] && echo reboot=1',
  '[ -f /var/run/reboot-required.pkgs ] && echo "pkgs=$(sort -u /var/run/reboot-required.pkgs | head -n 20 | tr \'\\n\' \' \')"',
  'command -v systemctl >/dev/null 2>&1 && echo systemd=1',
  'command -v apt-get >/dev/null 2>&1 && echo apt=1',
  '[ -f /etc/unraid-version ] && echo unraid=1',
  'dpkg-query -W -f=\'${Status}\' unattended-upgrades 2>/dev/null | grep -q "install ok installed" && echo uu=1',
  'command -v apt-config >/dev/null 2>&1 && apt-config dump 2>/dev/null | grep -E "^(APT::Periodic::Unattended-Upgrade|Unattended-Upgrade::Automatic-Reboot|Unattended-Upgrade::Automatic-Reboot-Time) "',
  'true',
].join('\n');

/** Turns the helper's output into the server's state. */
export function parseHostInfo(stdout) {
  const out = { os: '', rebootRequired: false, packages: [], systemd: false, apt: false, unraid: false, patches: { installed: false, enabled: false, autoReboot: false, rebootTime: '' } };
  for (const line of String(stdout).split('\n')) {
    const kv = line.match(/^(\w+)=(.*)$/);
    if (kv) {
      const [, k, v] = kv;
      if (k === 'os') out.os = v.trim();
      if (k === 'reboot') out.rebootRequired = true;
      if (k === 'pkgs') out.packages = v.trim().split(/\s+/).filter(Boolean);
      if (k === 'systemd') out.systemd = true;
      if (k === 'apt') out.apt = true;
      if (k === 'unraid') out.unraid = true;
      if (k === 'uu') out.patches.installed = true;
      continue;
    }
    const apt = line.match(/^([\w:-]+) "(.*)";$/);
    if (!apt) continue;
    const on = /^(1|true|yes|on)$/i.test(apt[2]);
    if (apt[1] === 'APT::Periodic::Unattended-Upgrade') out.patches.enabled = on;
    if (apt[1] === 'Unattended-Upgrade::Automatic-Reboot') out.patches.autoReboot = on;
    if (apt[1] === 'Unattended-Upgrade::Automatic-Reboot-Time') out.patches.rebootTime = apt[2];
  }
  out.patches.enabled = out.patches.enabled && out.patches.installed;
  return out;
}

/** Host uptime in seconds (containers see the host's /proc/uptime). */
export function readUptime(file = '/proc/uptime') {
  try { return Math.round(Number(fs.readFileSync(file, 'utf8').split(' ')[0])); } catch { return null; }
}

/** Changes with every boot of the server (shared by all containers). */
export function readBootId(file = '/proc/sys/kernel/random/boot_id') {
  try { return fs.readFileSync(file, 'utf8').trim() || null; } catch { return null; }
}

export function patchesConfig(enabled) {
  const v = enabled ? '1' : '0';
  return `APT::Periodic::Update-Package-Lists "${v}";\nAPT::Periodic::Unattended-Upgrade "${v}";\n`;
}

export function autoRebootConfig(enabled, time) {
  return `// Written by Stackmoor – restart the server when a patch needs it.\n`
    + `Unattended-Upgrade::Automatic-Reboot "${enabled ? 'true' : 'false'}";\n`
    + `Unattended-Upgrade::Automatic-Reboot-Time "${time}";\n`;
}

export function createSystem({ db, stacks, updates, backups, autoUpdate, getSettings, saveSettings, getT, readBoot = readBootId, pause = sleep, onBooted = () => {}, onRebootRequired = () => {} }) {
  let cache = null;
  let snapshotTimer = null;

  const schedule = () => ({ ...REBOOT_DEFAULTS, ...(getSettings().rebootSchedule || {}) });

  async function helperImage() {
    const self = await updates.selfInfo();
    if (!self.imageId) throw new UserError('system.noHost');
    return self.imageId;
  }

  /** Runs a shell script on the host. detach: don't wait (for the restart itself). */
  async function hostRun(script, { onData, detach = false } = {}) {
    const image = await helperImage();
    const args = ['run', '--privileged', '--pid=host', '--net=host',
      '--label', 'stackmoor.helper=host', '-e', `HOST_SCRIPT=${script}`, '--entrypoint', 'sh'];
    if (detach) {
      // Kept after it ends (no --rm), so the panel can see whether the command worked.
      await docker(['rm', '-f', HELPER]);
      args.push('-d', '--name', HELPER);
    } else {
      args.push('--rm');
    }
    const r = await docker([...args, image, '-c', ENTER], { onData });
    if (r.code !== 0 && /^(nsenter|chroot): .*(permission denied|operation not permitted|cannot open)/im.test(r.output)) throw new UserError('system.noAccess');
    return r;
  }

  async function info({ fresh = false } = {}) {
    if (!fresh && cache && Date.now() - cache.at < 5 * 60e3) return cache.value;
    const base = { uptime: readUptime(), reboots: getState(db, 'system.reboots', []).slice(0, 5), schedule: schedule() };
    let host = null;
    let error = null;
    try {
      const r = await hostRun(INFO_SCRIPT);
      if (r.code === 0) host = parseHostInfo(r.stdout);
      else error = 'system.noAccess';
    } catch (err) {
      error = err.key || 'system.noAccess';
    }
    const value = { ...base, host, error };
    cache = { at: Date.now(), value };
    return value;
  }

  // ---------- stacks that were running before a restart ----------

  async function saveRunning() {
    const bootId = readBoot();
    if (!bootId) return;
    const names = (await stacks.list()).filter((s) => s.state === 'running' || s.state === 'partial').map((s) => s.name);
    setState(db, 'system.running', { at: new Date().toISOString(), bootId, names });
  }

  /**
   * After the server restarted: start the stacks that ran before it, also those without
   * `restart:` in their compose file (Docker leaves them stopped).
   */
  async function afterBoot() {
    const saved = getState(db, 'system.running');
    const bootId = readBoot();
    if (!saved?.names?.length || !bootId || saved.bootId === bootId) return [];
    await pause(20e3); // let Docker start the ones with a restart policy first
    const t = getT();
    const started = [];
    for (const s of await stacks.list()) {
      if (!saved.names.includes(s.name) || s.state === 'running' || s.state === 'partial' || s.busy) continue;
      try {
        if (await stacks.action(s.name, 'up', () => {}, { t, label: 'boot', intro: `${t('sys.log.boot')}\n` })) started.push(s.name);
      } catch (err) {
        console.error(`Starting ${s.name} after the restart failed:`, err.message);
      }
    }
    return started;
  }

  /** Once per boot: tell when the system needs a restart (e.g. after a kernel patch). */
  async function checkRebootRequired() {
    const bootId = readBoot();
    if (!bootId || getState(db, 'system.rebootNotified') === bootId) return false;
    const i = await info({ fresh: true });
    if (!i.host?.rebootRequired) return false;
    setState(db, 'system.rebootNotified', bootId);
    onRebootRequired({ packages: i.host.packages });
    return true;
  }

  function startMonitor() {
    docker(['rm', '-f', HELPER]).catch(() => {}); // left from the restart before this boot
    const saved = getState(db, 'system.running');
    const rebooted = Boolean(saved?.bootId && readBoot() && saved.bootId !== readBoot());
    setTimeout(() => checkRebootRequired().catch(() => {}), 10 * 60e3).unref?.();
    setInterval(() => checkRebootRequired().catch(() => {}), 6 * 3600e3).unref?.();
    afterBoot().then((started) => { if (rebooted) onBooted({ started }); }).catch(() => {}).finally(() => {
      saveRunning().catch(() => {});
      clearInterval(snapshotTimer);
      snapshotTimer = setInterval(() => saveRunning().catch(() => {}), 5 * 60e3);
      snapshotTimer.unref?.();
    });
    setInterval(tick, 60_000).unref();
  }

  // ---------- restarting ----------

  function busyReason() {
    if (backups.busy()) return 'system.busyBackup';
    if (autoUpdate.busy()) return 'system.busyUpdate';
    return null;
  }

  let rebooting = false;
  async function reboot(kind = 'manual') {
    if (rebooting) throw new UserError('system.rebooting', {}, 409);
    if (busyReason()) throw new UserError(busyReason(), {}, 409);
    rebooting = true; // from now on automatic updates don't start
    try {
      await helperImage();
      if (busyReason()) throw new UserError(busyReason(), {}, 409);
      await saveRunning().catch(() => {});
      // A few seconds' delay so the panel can still answer this request.
      const r = await hostRun('sleep 3; sync; systemctl reboot 2>/dev/null || reboot', { detach: true });
      if (r.code !== 0) throw new UserError('system.rebootFailed', { output: r.output.trim().slice(0, 300) });
      // Did the restart command work? The helper ends with 0 when the system accepted it.
      for (let i = 0; i < 10; i++) {
        await pause(2000);
        const st = await docker(['inspect', '--format', '{{.State.Status}} {{.State.ExitCode}}', HELPER]);
        if (st.code !== 0) break; // Docker is already stopping – the server is going down
        const [status, code] = st.stdout.trim().split(' ');
        if (status !== 'exited') continue;
        if (code === '0') break;
        const logs = await docker(['logs', '--tail', '20', HELPER]);
        await docker(['rm', '-f', HELPER]);
        throw new UserError('system.rebootFailed', { output: logs.output.trim().slice(-300) || `exit ${code}` });
      }
      setState(db, 'system.reboots', [{ at: new Date().toISOString(), kind }, ...getState(db, 'system.reboots', [])].slice(0, 20));
      return { started: true };
    } catch (err) {
      rebooting = false;
      throw err;
    }
  }

  let scheduled = null;
  function tick() {
    const c = schedule();
    const now = new Date();
    if (scheduled || !isDue(c, getState(db, 'system.lastScheduled'), now)) return;
    // Never twice in a row: right after a restart the server is fresh anyway.
    if ((readUptime() ?? Infinity) < 3600) return;
    setState(db, 'system.lastScheduled', localParts(now, c.timeZone).date);
    scheduled = (async () => {
      // Wait (up to 2 hours) for a backup or an automatic update to finish.
      for (let i = 0; i < 240; i++) {
        if (!busyReason()) {
          try {
            return await reboot('scheduled');
          } catch (err) {
            if (err.status !== 409) throw err; // something started just now – keep waiting
          }
        }
        await sleep(30e3);
      }
    })().catch((err) => console.error('Scheduled restart failed:', err.message)).finally(() => { scheduled = null; });
  }

  function saveSchedule(body) {
    const next = cleanSchedule(body, schedule());
    saveSettings({ rebootSchedule: { enabled: next.enabled, days: next.days, time: next.time, timeZone: next.timeZone } });
    return schedule();
  }

  // ---------- system patches (Debian/Ubuntu) ----------

  async function setPatches(enabled, write, t) {
    const script = enabled
      ? ['set -e', 'export DEBIAN_FRONTEND=noninteractive', 'command -v apt-get >/dev/null || { echo "apt-get not found"; exit 3; }',
        'echo "$ apt-get install unattended-upgrades"', 'apt-get update -qq', 'apt-get install -y -qq unattended-upgrades',
        `printf '%s' '${patchesConfig(true)}' > /etc/apt/apt.conf.d/20auto-upgrades`, 'echo "✓ /etc/apt/apt.conf.d/20auto-upgrades"'].join('\n')
      : [`printf '%s' '${patchesConfig(false)}' > /etc/apt/apt.conf.d/20auto-upgrades`, 'echo "✓ /etc/apt/apt.conf.d/20auto-upgrades"'].join('\n');
    const r = await hostRun(script, { onData: write });
    cache = null;
    if (r.code !== 0) throw new UserError('step.exitCode', { code: r.code });
    write(`\n${t('log.done')}\n`);
  }

  async function setAutoReboot(body = {}) {
    const time = String(body.time || '04:00');
    if (!TIME_RE.test(time)) throw new UserError('system.badTime');
    const r = await hostRun(`printf '%s' '${autoRebootConfig(Boolean(body.enabled), time)}' > /etc/apt/apt.conf.d/52stackmoor-reboot`);
    cache = null;
    if (r.code !== 0) throw new UserError('step.exitCode', { code: r.code });
    return info({ fresh: true });
  }

  return { info, reboot, saveSchedule, setPatches, setAutoReboot, startMonitor, afterBoot, saveRunning, checkRebootRequired, isRebooting: () => rebooting };
}
