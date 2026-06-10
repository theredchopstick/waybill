const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const db = new DatabaseSync(process.env.DB_PATH || path.join(__dirname, 'waybill.db'));

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('driver','warehouse','admin')),
    display_name TEXT NOT NULL,
    warehouse_id INTEGER,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS warehouses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    region TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ref TEXT UNIQUE NOT NULL,
    customer TEXT NOT NULL,
    destination TEXT NOT NULL,
    items TEXT NOT NULL,
    priority TEXT NOT NULL DEFAULT 'standard' CHECK (priority IN ('standard','express')),
    warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
    status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received','processing','dispatched','complete','cancelled')),
    created_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ref TEXT UNIQUE NOT NULL,
    order_id INTEGER NOT NULL REFERENCES orders(id),
    warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
    driver_id INTEGER REFERENCES users(id),
    status TEXT NOT NULL DEFAULT 'picking' CHECK (status IN (
      'picking','packed','assigned','in_transit','out_for_delivery',
      'attempted','delivered','exception','lost','returned','rerouted'
    )),
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER REFERENCES jobs(id),
    order_id INTEGER REFERENCES orders(id),
    actor_id INTEGER REFERENCES users(id),
    type TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_jobs_driver ON jobs(driver_id);
  CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
  CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT ''
  );
`);

/* ---------- Migration: expand job statuses if the old constraint is still in place ---------- */
try {
  const col = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='jobs'").get();
  if (col && !col.sql.includes('out_for_delivery')) {
    db.exec(`
      PRAGMA foreign_keys=OFF;
      BEGIN;
      CREATE TABLE jobs_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ref TEXT UNIQUE NOT NULL,
        order_id INTEGER NOT NULL REFERENCES orders(id),
        warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
        driver_id INTEGER REFERENCES users(id),
        status TEXT NOT NULL DEFAULT 'picking' CHECK (status IN (
          'picking','packed','assigned','in_transit','out_for_delivery',
          'attempted','delivered','exception','lost','returned','rerouted'
        )),
        notes TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO jobs_new SELECT * FROM jobs;
      DROP TABLE jobs;
      ALTER TABLE jobs_new RENAME TO jobs;
      CREATE INDEX IF NOT EXISTS idx_jobs_driver ON jobs(driver_id);
      CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
      COMMIT;
      PRAGMA foreign_keys=ON;
    `);
    console.log('Sahara Delivery DB migrated: job statuses expanded');
  }
} catch (e) { console.error('Migration error:', e.message); }

/* ---------- Settings store (key/value, with in-memory cache) ---------- */
const settingsCache = new Map();
let cacheLoaded = false;
function loadCache() {
  for (const row of db.prepare('SELECT key, value FROM settings').all()) settingsCache.set(row.key, row.value);
  cacheLoaded = true;
}
function getSetting(key, fallback = '') {
  if (!cacheLoaded) loadCache();
  const v = settingsCache.get(key);
  return v === undefined || v === '' ? fallback : v;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value || '');
  settingsCache.set(key, value || '');
}

// Stable login secret: env wins; else generate once and persist.
function getOrCreateSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  let s = getSetting('jwt_secret');
  if (!s) {
    s = require('crypto').randomBytes(32).toString('hex');
    setSetting('jwt_secret', s);
  }
  return s;
}

function genRef(prefix) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return `${prefix}-${s}`;
}

module.exports = { db, genRef, getSetting, setSetting, getOrCreateSecret };

