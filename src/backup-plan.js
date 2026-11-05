// Pure helpers for backups (no Docker, no database) – easy to test.
import path from 'node:path';

// ---------- destinations ----------

// S3-compatible storage. Backblaze B2 is used through its S3 API (recommended by restic).
export const DESTINATIONS = [
  { id: 'b2', name: 'Backblaze B2', endpoint: 's3.{region}.backblazeb2.com', region: 'eu-central-003',
    help: { en: 'Bucket → "Endpoint" shows the address, e.g. s3.eu-central-003.backblazeb2.com. Keys: Application Keys → Add a New Application Key.',
      pl: 'Bucket → „Endpoint” pokazuje adres, np. s3.eu-central-003.backblazeb2.com. Klucze: Application Keys → Add a New Application Key.' } },
  { id: 'aws', name: 'Amazon S3', endpoint: 's3.{region}.amazonaws.com', region: 'eu-central-1',
    help: { en: 'IAM user with access to the bucket → Security credentials → Create access key.',
      pl: 'Użytkownik IAM z dostępem do bucketu → Security credentials → Create access key.' } },
  { id: 'r2', name: 'Cloudflare R2', endpoint: '<account-id>.r2.cloudflarestorage.com', region: 'auto',
    help: { en: 'R2 → Manage API tokens → Create API token (Object Read & Write). The endpoint is shown with the keys.',
      pl: 'R2 → Manage API tokens → Create API token (Object Read & Write). Adres endpointu jest pokazany przy kluczach.' } },
  { id: 'hetzner', name: 'Hetzner Object Storage', endpoint: '{region}.your-objectstorage.com', region: 'fsn1',
    help: { en: 'Cloud Console → Object Storage → S3 credentials. Regions: fsn1, nbg1, hel1.',
      pl: 'Cloud Console → Object Storage → S3 credentials. Regiony: fsn1, nbg1, hel1.' } },
  { id: 'wasabi', name: 'Wasabi', endpoint: 's3.{region}.wasabisys.com', region: 'eu-central-1',
    help: { en: 'Access Keys → Create new access key.', pl: 'Access Keys → Create new access key.' } },
  { id: 's3', name: 'Other S3-compatible (MinIO, Garage, …)', endpoint: '', region: 'us-east-1',
    help: { en: 'Any S3-compatible storage: enter its address, e.g. minio.example.com:9000.',
      pl: 'Dowolna pamięć zgodna z S3: wpisz jej adres, np. minio.example.com:9000.' } },
];

export const destinationById = (id) => DESTINATIONS.find((d) => d.id === id) || null;

/** restic repository URL, e.g. s3:https://s3.eu-central-003.backblazeb2.com/my-bucket/stackmoor */
export function repoUrl(cfg) {
  let endpoint = String(cfg.endpoint || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//.test(endpoint)) endpoint = `https://${endpoint}`;
  const prefix = String(cfg.prefix || '').trim().replace(/^\/+|\/+$/g, '');
  return `s3:${endpoint}/${cfg.bucket}${prefix ? `/${prefix}` : ''}`;
}

// ---------- databases ----------

const imageName = (image = '') => String(image).split('@')[0].split('/').pop().split(':')[0].toLowerCase();

/**
 * What kind of database a service runs: 'postgres' | 'mysql' | 'mongo' | 'redis' | null.
 * A service can say it itself with the label stackmoor.backup.dump (or "none").
 */
export function dumpKind(def = {}) {
  const labels = Array.isArray(def.labels)
    ? Object.fromEntries(def.labels.map((l) => String(l).split('=')))
    : def.labels || {};
  const label = labels['stackmoor.backup.dump'];
  if (label) return ['postgres', 'mysql', 'mongo', 'redis'].includes(label) ? label : null;
  const name = imageName(def.image);
  if (/postgres|postgis|timescale|pgvecto/.test(name)) return 'postgres';
  if (/^(mysql|mariadb|percona)/.test(name)) return 'mysql';
  if (/^mongo(db)?(-community-server)?$/.test(name)) return 'mongo';
  if (/^(redis|valkey|keydb)/.test(name)) return 'redis';
  return null;
}

// Shell snippets run inside the database container (`docker exec <c> sh -c ...`),
// so they can read the container's own variables (POSTGRES_USER, MYSQL_ROOT_PASSWORD, …).
const MYSQL_CREDS = [
  'P="${MARIADB_ROOT_PASSWORD:-$MYSQL_ROOT_PASSWORD}"; U=root; DBS="--all-databases --events"',
  'if [ -z "$P" ]; then U="${MARIADB_USER:-$MYSQL_USER}"; P="${MARIADB_PASSWORD:-$MYSQL_PASSWORD}"; DBS="--databases ${MARIADB_DATABASE:-$MYSQL_DATABASE}"; fi',
].join('; ');
const MONGO_AUTH = 'A=""; if [ -n "$MONGO_INITDB_ROOT_USERNAME" ]; then A="--username $MONGO_INITDB_ROOT_USERNAME --password $MONGO_INITDB_ROOT_PASSWORD --authenticationDatabase admin"; fi';

export const DUMP_FILE = { postgres: 'postgres.sql', mysql: 'mysql.sql', mongo: 'mongo.archive' };

export function dumpCommand(kind) {
  switch (kind) {
    case 'postgres':
      return 'pg_dumpall -U "${POSTGRES_USER:-postgres}"';
    case 'mysql':
      return `${MYSQL_CREDS}; D=$(command -v mariadb-dump || command -v mysqldump); MYSQL_PWD="$P" exec $D -u"$U" $DBS --single-transaction --routines --triggers`;
    case 'mongo':
      return `${MONGO_AUTH}; exec mongodump --archive --quiet $A`;
    case 'redis':
      // No file: Redis writes its own dump.rdb, which is backed up with the data folder.
      return 'redis-cli SAVE >/dev/null 2>&1 || true';
    default:
      return null;
  }
}

/** Reads the dump from stdin. */
export function restoreCommand(kind) {
  switch (kind) {
    case 'postgres':
      return 'exec psql -q -o /dev/null -U "${POSTGRES_USER:-postgres}" -d postgres';
    case 'mysql':
      return `${MYSQL_CREDS}; C=$(command -v mariadb || command -v mysql); MYSQL_PWD="$P" exec $C -u"$U"`;
    case 'mongo':
      return `${MONGO_AUTH}; exec mongorestore --archive --drop --quiet $A`;
    default:
      return null;
  }
}

/**
 * "Is the database ready?" – checked over TCP on purpose: the official images first start a
 * temporary server without networking to initialise, and a restore must not go into that one.
 */
export function readyCommand(kind) {
  switch (kind) {
    case 'postgres':
      return 'pg_isready -q -h 127.0.0.1 -U "${POSTGRES_USER:-postgres}"';
    case 'mysql':
      return `${MYSQL_CREDS}; A=$(command -v mariadb-admin || command -v mysqladmin); MYSQL_PWD="$P" $A -h 127.0.0.1 -u"$U" ping >/dev/null 2>&1`;
    case 'mongo':
      return `${MONGO_AUTH}; (mongosh --quiet $A --eval 'db.runCommand({ping:1}).ok' 2>/dev/null || mongo --quiet $A --eval 'db.runCommand({ping:1}).ok') | grep -q 1`;
    default:
      return null;
  }
}

/**
 * Folders of a database service inside the stack folder. They are left out of the backup
 * when the dump worked: copying the files of a running database gives a broken copy,
 * and the dump is what gets restored.
 */
export function dataFolders(stackDir, def = {}) {
  const root = path.resolve(stackDir);
  return (def.volumes || [])
    .filter((v) => v && v.type === 'bind' && v.source)
    .map((v) => path.resolve(v.source))
    .filter((src) => src !== root && src.startsWith(root + path.sep));
}

export const containerName = (stack, svc, def = {}) => def.container_name || `${stack}-${svc}-1`;

// ---------- retention and schedule ----------

export function retentionArgs(cfg) {
  const n = (v, def) => Math.max(0, Math.min(1000, Number.isInteger(Number(v)) ? Number(v) : def));
  // Grouped by path: every stack (and the panel's own files) keeps its own history,
  // whatever run it was made in. Before-update snapshots are pruned separately (--tag).
  return [
    '--group-by', 'paths',
    '--keep-last', '1',
    '--keep-daily', String(n(cfg.keepDaily, 7)),
    '--keep-weekly', String(n(cfg.keepWeekly, 4)),
    '--keep-monthly', String(n(cfg.keepMonthly, 6)),
  ];
}

/** Day of week (0 = Sunday), "HH:MM" and "YYYY-MM-DD" in the given time zone. */
export function localParts(date, timeZone) {
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timeZone || 'UTC', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(date);
  } catch {
    return localParts(date, 'UTC');
  }
  const get = (type) => parts.find((p) => p.type === type)?.value;
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return { day, time: `${get('hour')}:${get('minute')}`, date: `${get('year')}-${get('month')}-${get('day')}` };
}

const minutes = (hhmm) => {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + m;
};

/**
 * Should the scheduled backup run now? It runs once on each chosen day, at the chosen time
 * or up to an hour later (if the panel was restarted around that time).
 */
export function isDue(cfg, lastRunDate, now = new Date()) {
  if (!cfg.enabled || !Array.isArray(cfg.days) || !cfg.days.length || !/^\d\d:\d\d$/.test(cfg.time || '')) return false;
  const p = localParts(now, cfg.timeZone);
  if (!cfg.days.includes(p.day) || lastRunDate === p.date) return false;
  const diff = minutes(p.time) - minutes(cfg.time);
  return diff >= 0 && diff < 60;
}

// ---------- runs ----------

/** Id shared by all snapshots of one backup run, e.g. 20261030-030012-k3f9. */
export function newRunId(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const d = `${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}`;
  const t = `${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}`;
  return `${d}-${t}-${Math.random().toString(36).slice(2, 6)}`;
}

const tagValue = (tags, prefix) => (tags || []).find((x) => x.startsWith(prefix))?.slice(prefix.length) || null;

/**
 * Groups snapshots into backup runs: one nightly run = the snapshots of all stacks plus the
 * panel's own ("system") snapshot. Snapshots from 0.5 have no run tag – they are grouped by
 * time: stack snapshots up to 3 hours before a system snapshot belong to its run.
 */
export function groupRuns(snapshots) {
  const runs = new Map();
  const add = (id, kind, snap, legacy = false) => {
    if (!runs.has(id)) runs.set(id, { id, kind, legacy, time: snap.time, system: null, stacks: [], size: 0 });
    const r = runs.get(id);
    if (snap.time > r.time) r.time = snap.time;
    if (snap.system) r.system = snap;
    else {
      r.stacks.push(snap);
      r.size += snap.size || 0;
    }
  };

  const legacy = [];
  for (const s of snapshots) {
    const run = tagValue(s.tags, 'run:');
    if (run) add(run, tagValue(s.tags, 'kind:') || (s.preUpdate ? 'pre-update' : 'manual'), s);
    else legacy.push(s);
  }

  // Older snapshots: pre-update ones are runs of their own; others cluster around system snapshots.
  const WINDOW = 3 * 3600_000;
  let pending = [];
  const single = (s) => add(`legacy-${s.id}`, s.preUpdate ? 'pre-update' : 'manual', s, true);
  for (const s of [...legacy].sort((a, b) => a.time.localeCompare(b.time))) {
    if (s.preUpdate) { single(s); continue; }
    if (!s.system) { pending.push(s); continue; }
    const t = Date.parse(s.time);
    const id = `legacy-${s.id}`;
    for (const p of pending) {
      if (t - Date.parse(p.time) <= WINDOW) add(id, 'scheduled', p, true);
      else single(p);
    }
    add(id, 'scheduled', s, true);
    pending = [];
  }
  pending.forEach(single);

  for (const r of runs.values()) r.stacks.sort((a, b) => (a.stack || '').localeCompare(b.stack || ''));
  return [...runs.values()].sort((a, b) => b.time.localeCompare(a.time));
}

// ---------- paths left out of a stack's backup ----------

/**
 * Checks the user's list of paths to leave out (relative to the stack folder, globs allowed,
 * e.g. "data/immich/thumbs" or "data/*\/cache"). Throws UserError-like { key } on a bad one.
 */
export function cleanExcludes(list) {
  const lines = (Array.isArray(list) ? list : String(list ?? '').split('\n'))
    .map((x) => String(x).trim().replace(/^\.\//, '').replace(/\/+$/, ''))
    .filter(Boolean);
  const out = [];
  for (const p of lines) {
    // Never the stack's own files (a backup without them can't be restored) or everything.
    const needed = /^(\*\*?|compose\.ya?ml|docker-compose\.ya?ml|\.env|compose\.stackmoor\.yaml)$/i.test(p);
    if (needed || p.startsWith('/') || p.split('/').includes('..') || p.length > 200 || /[\0\r]/.test(p)) {
      const err = new Error(`bad exclude: ${p}`);
      err.key = 'backup.badExclude';
      err.vars = { path: p };
      throw err;
    }
    if (!out.includes(p)) out.push(p);
  }
  if (out.length > 50) { const err = new Error('too many'); err.key = 'backup.tooManyExcludes'; throw err; }
  return out;
}

/** restic --exclude arguments: each path anchored in the stack folder. */
export const excludeArgs = (dir, patterns) => patterns.flatMap((p) => ['--exclude', `${dir.replace(/\/+$/, '')}/${p}`]);
