import os from 'node:os';
import { docker } from './docker.js';
import { getState, setState } from './db.js';
import { UserError } from './errors.js';
import { VERSION, REPO, compareVersions, isSemver, newestTag } from './version.js';
import { remoteDigest, localDigests, parseImageRef } from './registry.js';

const INTERVALS = { daily: 24 * 3600e3, weekly: 7 * 24 * 3600e3 };
const PENDING_RECHECK = 10 * 60e3;

/** The images a release needs: the panel, Caddy and the VPN helper. */
export const imagesFor = (version, repo = REPO) => {
  const v = String(version).replace(/^v/, '');
  return [`ghcr.io/${repo}:${v}`, `ghcr.io/${repo}-caddy:${v}`, `ghcr.io/${repo}-vpn:${v}`];
};

/**
 * A release shows up on GitHub as soon as it is tagged, but its images are built for a few
 * minutes more. Offer the update only when all of them are in the registry.
 */
export async function imagesReady(version, digest = remoteDigest) {
  for (const ref of imagesFor(version)) if (!(await digest(ref))) return false;
  return true;
}
const UPDATER_NAME = 'stackmoor-updater';

async function github(pathname) {
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}${pathname}`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'stackmoor' },
      signal: AbortSignal.timeout(15000),
    });
    return res.ok ? await res.json() : null;
  } catch {
    return null; // offline – report "could not check"
  }
}

async function imageDigests(image) {
  const r = await docker(['image', 'inspect', '--format', '{{json .RepoDigests}}', image]);
  if (r.code !== 0) return null;
  try { return JSON.parse(r.stdout.trim()) || []; } catch { return []; }
}

/** Is a newer image available in the registry than the one present locally? null = can't tell. */
async function imageHasUpdate(image) {
  const img = parseImageRef(image);
  if (!img || img.pinned) return null;
  const local = localDigests(image, await imageDigests(image));
  if (!local.length) return null; // built locally or never pulled
  const remote = await remoteDigest(image);
  if (!remote) return null;
  return !local.includes(remote);
}

export function createUpdates({ db, stacks, getSettings, onChecked = () => {} }) {
  let running = null;

  // ---------- the panel itself ----------

  /** How this panel was started, which decides whether it can update itself. */
  async function selfInfo() {
    const r = await docker(['inspect', '--format', '{{json .}}', os.hostname()]);
    if (r.code !== 0) return { mode: 'none' };
    let c;
    try { c = JSON.parse(r.stdout.trim()); } catch { return { mode: 'none' }; }
    const labels = c.Config?.Labels || {};
    const imageRef = c.Config?.Image || '';
    const info = { imageRef, imageId: c.Image, container: c.Name?.replace(/^\//, '') };
    const tag = parseImageRef(imageRef)?.tag;
    if (tag && isSemver(tag)) return { ...info, mode: 'pinned', tag };
    if (labels['com.docker.compose.project'] && labels['com.docker.compose.project.working_dir']) {
      return {
        ...info,
        mode: 'compose',
        project: labels['com.docker.compose.project'],
        service: labels['com.docker.compose.service'],
        workingDir: labels['com.docker.compose.project.working_dir'],
        configFiles: String(labels['com.docker.compose.project.config_files'] || '').split(',').filter(Boolean),
      };
    }
    if (labels['net.unraid.docker.managed']) return { ...info, mode: 'unraid' };
    return { ...info, mode: 'manual' };
  }

  async function checkPanel() {
    const result = { current: VERSION, checkedAt: new Date().toISOString() };
    const release = await github('/releases/latest');
    if (release?.tag_name) {
      result.latest = release.tag_name.replace(/^v/, '');
      result.notes = String(release.body || '').slice(0, 20000);
      result.url = release.html_url;
    } else {
      const tags = await github('/tags?per_page=100');
      const tag = Array.isArray(tags) ? newestTag(tags.map((t) => t.name)) : null;
      if (tag) {
        result.latest = tag.replace(/^v/, '');
        result.url = `https://github.com/${REPO}/releases/tag/${tag}`;
      }
    }
    const cmp = result.latest ? compareVersions(result.latest, VERSION) : null;
    if (cmp !== null) {
      result.updateAvailable = cmp > 0;
      if (result.updateAvailable && !(await imagesReady(result.latest))) {
        result.updateAvailable = false;
        result.pending = true; // being built – checked again in a few minutes
      }
    } else {
      // edge or dev build: compare the running image with the registry instead
      const self = await selfInfo();
      result.updateAvailable = self.imageRef ? (await imageHasUpdate(self.imageRef)) === true : false;
      result.buildUpdate = result.updateAvailable;
      result.imageId = self.imageId; // to notice later that this build was replaced
    }
    if (!result.latest && result.updateAvailable === undefined) result.error = true;
    setState(db, 'update.panel', result);
    return result;
  }

  // ---------- stacks ----------

  async function scanStack(name) {
    const images = [];
    for (const { svc, image } of await stacks.images(name)) {
      const has = await imageHasUpdate(image);
      if (has !== null) images.push({ svc, image, updateAvailable: has });
    }
    return { checkedAt: new Date().toISOString(), images };
  }

  async function checkStack(name) {
    const result = await scanStack(name);
    const all = getState(db, 'update.stacks', {});
    all[name] = result;
    setState(db, 'update.stacks', all);
    return result;
  }

  async function checkStacks() {
    const all = {};
    for (const { name } of await stacks.list()) {
      try {
        all[name] = await scanStack(name);
      } catch {
        // broken compose file – skip it
      }
    }
    setState(db, 'update.stacks', all);
    return all;
  }

  // ---------- running checks ----------

  async function checkAll() {
    if (running) return running;
    running = (async () => {
      const settings = getSettings();
      try {
        await checkPanel();
        if (settings.updateCheckStacks) await checkStacks();
        setState(db, 'update.lastRun', new Date().toISOString());
        try { onChecked(status()); } catch { /* notifications must not break the check */ }
      } finally {
        running = null;
      }
    })();
    return running;
  }

  function status() {
    // A result saved by an older version (e.g. right before a self-update) must not
    // keep saying "update available" – re-evaluate it against the running version.
    let panel = getState(db, 'update.panel');
    if (panel && panel.current !== VERSION) {
      const cmp = panel.latest ? compareVersions(panel.latest, VERSION) : null;
      panel = { ...panel, current: VERSION, updateAvailable: cmp !== null ? cmp > 0 : false, buildUpdate: false };
      setState(db, 'update.panel', panel);
    }
    const stacksState = getState(db, 'update.stacks', {});
    const stacksWithUpdates = Object.entries(stacksState)
      .filter(([, s]) => s.images.some((i) => i.updateAvailable))
      .map(([name]) => name);
    return {
      checking: Boolean(running),
      lastRun: getState(db, 'update.lastRun'),
      panel,
      stacks: stacksState,
      stacksWithUpdates,
    };
  }

  function startScheduler() {
    const tick = () => {
      const s = getSettings();
      if (!s.updateCheck) return;
      const last = Date.parse(getState(db, 'update.lastRun') || 0) || 0;
      if (Date.now() - last >= (INTERVALS[s.updateInterval] || INTERVALS.daily)) {
        checkAll().catch((err) => console.error('Update check failed:', err.message));
      } else if (getState(db, 'update.panel')?.pending) {
        // A new version whose images are still being built: look again soon.
        const at = Date.parse(getState(db, 'update.panel').checkedAt || 0) || 0;
        if (Date.now() - at >= PENDING_RECHECK) checkPanel().then((p) => { if (p.updateAvailable) onChecked(status()); }).catch(() => {});
      }
    };
    setTimeout(tick, 60e3).unref(); // first check a minute after start
    setInterval(tick, PENDING_RECHECK).unref();
  }

  /**
   * Right after start: a saved "newer build available" for edge refers to the image we were
   * running before. If the image changed (the panel was just updated), check again at once.
   */
  let startup = null;
  function afterStart() {
    setState(db, 'update.applying', null); // a new process means a pending self-update is done
    const saved = getState(db, 'update.panel');
    if (!saved?.buildUpdate) return null;
    startup = (async () => {
      const self = await selfInfo();
      if (self.imageId && self.imageId !== saved.imageId) {
        setState(db, 'update.panel', { ...saved, updateAvailable: false, buildUpdate: false });
        await checkPanel().catch(() => {});
      }
    })().catch(() => {}).finally(() => { startup = null; });
    return startup;
  }
  const ready = () => startup || Promise.resolve();

  // ---------- updating the panel (only after the user confirms) ----------

  async function updatePanel() {
    const self = await selfInfo();
    if (self.mode !== 'compose') throw new UserError('updates.manualOnly', { mode: self.mode });
    // Nothing new to download yet (e.g. the release is still being built): starting would
    // only restart the same version.
    if ((await imageHasUpdate(self.imageRef)) === false) throw new UserError('updates.notReady');
    // A separate short-lived container does the update, because this one is replaced during it.
    await docker(['rm', '-f', UPDATER_NAME]);
    const q = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;
    const compose = ['docker', 'compose', '-p', q(self.project), ...self.configFiles.flatMap((f) => ['-f', q(f)])].join(' ');
    const script = ['sleep 3', `${compose} pull ${q(self.service)}`, `${compose} up -d ${q(self.service)}`].join(' && ');
    const r = await docker([
      'run', '-d', '--rm', '--name', UPDATER_NAME,
      '-v', '/var/run/docker.sock:/var/run/docker.sock',
      '-v', `${self.workingDir}:${self.workingDir}`,
      '-w', self.workingDir,
      '--entrypoint', 'sh',
      self.imageId,
      '-c', script,
    ]);
    if (r.code !== 0) throw new UserError('updates.failed', { output: r.output.trim() });
    setState(db, 'update.applying', { at: new Date().toISOString() });
    return { started: true };
  }

  /** A self-update was started in the last 10 minutes and this process is still the old one. */
  function applying() {
    const a = getState(db, 'update.applying');
    return Boolean(a && Date.now() - Date.parse(a.at) < 10 * 60e3);
  }

  return { checkAll, checkStack, checkPanel, status, startScheduler, selfInfo, updatePanel, afterStart, ready, applying };
}
