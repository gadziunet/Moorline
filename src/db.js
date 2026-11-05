import Database from 'better-sqlite3';

// Schema migrations. Append new ones at the end; never edit existing ones
// (the index is stored in PRAGMA user_version).
const MIGRATIONS = [
  `
  CREATE TABLE users (
    id            INTEGER PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE sessions (
    id         TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE stacks (
    name         TEXT PRIMARY KEY,
    auto_volumes INTEGER NOT NULL DEFAULT 1,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE operations (
    id          INTEGER PRIMARY KEY,
    stack       TEXT NOT NULL,
    action      TEXT NOT NULL,
    status      TEXT NOT NULL,
    output      TEXT,
    started_at  TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at TEXT
  );
  CREATE INDEX operations_stack ON operations(stack, id DESC);
  `,
  `
  CREATE TABLE state (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  `
  CREATE TABLE routes (
    id        INTEGER PRIMARY KEY,
    stack     TEXT NOT NULL,
    subdomain TEXT NOT NULL UNIQUE,
    service   TEXT NOT NULL,
    port      INTEGER NOT NULL
  );
  CREATE INDEX routes_stack ON routes(stack);
  `,
  `
  CREATE TABLE proxies (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    subdomain   TEXT NOT NULL UNIQUE,
    scheme      TEXT NOT NULL DEFAULT 'http',
    host        TEXT NOT NULL,
    port        INTEGER NOT NULL,
    insecure    INTEGER NOT NULL DEFAULT 0,
    host_header INTEGER NOT NULL DEFAULT 0,
    monitor     INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  `,
  // Public addresses through Pangolin (one Pangolin resource + target per row).
  `
  CREATE TABLE pangolin_routes (
    id          INTEGER PRIMARY KEY,
    stack       TEXT NOT NULL,
    service     TEXT NOT NULL,
    port        INTEGER NOT NULL,
    domain_id   TEXT NOT NULL,
    subdomain   TEXT,
    full_domain TEXT NOT NULL,
    sso         INTEGER NOT NULL DEFAULT 1,
    resource_id INTEGER NOT NULL,
    target_id   INTEGER,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX pangolin_routes_stack ON pangolin_routes(stack);
  CREATE UNIQUE INDEX pangolin_routes_domain ON pangolin_routes(full_domain);
  `,
];

export const DEFAULT_SETTINGS = {
  // Owner of folders created automatically for app data.
  puid: 1000,
  pgid: 1000,
  // Host paths the panel does NOT move into the stack folder
  // (e.g. media libraries). They are not backed up.
  hostPathAllowlist: ['/mnt', '/media'],
  // Update checks.
  updateCheck: true,
  updateInterval: 'daily', // 'daily' | 'weekly'
  updateCheckStacks: true,
  // Automatic stack updates (off until the user turns them on) – see autoupdate.js.
  autoUpdate: { enabled: false, days: [0, 1, 2, 3, 4, 5, 6], time: '04:00', timeZone: 'UTC', exclude: [] },
  // Restarting the server on a schedule – see system.js.
  rebootSchedule: { enabled: false, days: [0], time: '05:00', timeZone: 'UTC' },
  // Local domains through Caddy. Empty domain = feature off.
  domain: '',            // e.g. local.example.com -> apps get <name>.local.example.com
  dnsProvider: '',       // provider id from dns-providers.js, or 'internal' for a self-signed CA
  acmeEmail: '',
  httpPort: 80,
  httpsPort: 443,
  panelSubdomain: '',    // e.g. "stackmoor" -> the panel itself at stackmoor.<domain>
  panelDomainOnly: false, // true: opening the panel by IP redirects to the panel's domain
  serverIp: '',          // this server's address in the local network, for the *.<domain> record
  autoDnsRecord: true,   // create/update *.<domain> → serverIp through the DNS provider's API
  serverIpAuto: true,    // detect serverIp when the panel starts (and when the domain is saved)
  propagationSeconds: null, // wait after adding the TXT record; null = the provider's default
};

export function openDb(file) {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  const current = db.pragma('user_version', { simple: true });
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }

  // Operations interrupted by a panel restart must not stay "running" forever.
  db.prepare(
    `UPDATE operations SET status = 'interrupted', finished_at = datetime('now') WHERE status = 'running'`
  ).run();

  return db;
}

export function getSettings(db) {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const out = { ...DEFAULT_SETTINGS };
  for (const { key, value } of rows) {
    if (key in DEFAULT_SETTINGS) {
      try { out[key] = JSON.parse(value); } catch { /* keep the default */ }
    }
  }
  return out;
}

export function saveSettings(db, patch) {
  const stmt = db.prepare(
    'INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  );
  db.transaction(() => {
    for (const [key, value] of Object.entries(patch)) {
      if (key in DEFAULT_SETTINGS) stmt.run(key, JSON.stringify(value));
    }
  })();
  return getSettings(db);
}

// Small internal key/value store (update check results etc.), separate from user settings.
export function getState(db, key, fallback = null) {
  const row = db.prepare('SELECT value FROM state WHERE key = ?').get(key);
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch { return fallback; }
}

export function setState(db, key, value) {
  db.prepare('INSERT INTO state(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));
}
