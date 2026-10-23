/**
 * Driver SQLite — utilisé en développement local (aucune configuration).
 * Expose la même interface asynchrone que le driver PostgreSQL.
 */
const Database = require('better-sqlite3');
const path = require('path');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,
  phone      TEXT UNIQUE NOT NULL,
  name       TEXT DEFAULT '',
  country    TEXT DEFAULT 'CD',
  role       TEXT DEFAULT 'user',
  status     TEXT DEFAULT 'active',
  password_hash TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS wallets (
  user_id       TEXT PRIMARY KEY REFERENCES users(id),
  balance_cents INTEGER NOT NULL DEFAULT 0,
  currency      TEXT NOT NULL DEFAULT 'USD'
);
CREATE TABLE IF NOT EXISTS transactions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id),
  type         TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  method       TEXT,
  reference    TEXT,
  status       TEXT NOT NULL DEFAULT 'completed',
  created_at   INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS rates (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  prefix              TEXT NOT NULL,
  destination         TEXT NOT NULL,
  flag                TEXT DEFAULT '',
  price_per_min_cents INTEGER NOT NULL,
  active              INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS calls (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL REFERENCES users(id),
  callee              TEXT NOT NULL,
  destination         TEXT,
  price_per_min_cents INTEGER NOT NULL,
  max_sec             INTEGER NOT NULL,
  status              TEXT NOT NULL,
  started_at          INTEGER NOT NULL,
  answered_at         INTEGER,
  ended_at            INTEGER,
  billed_sec          INTEGER DEFAULT 0,
  cost_cents          INTEGER DEFAULT 0,
  hangup_cause        TEXT
);
CREATE TABLE IF NOT EXISTS contacts (
  id        TEXT PRIMARY KEY,
  user_id   TEXT NOT NULL REFERENCES users(id),
  name      TEXT NOT NULL,
  phone     TEXT NOT NULL,
  favorite  INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS otps (
  phone      TEXT PRIMARY KEY,
  code       TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS payments (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id),
  amount_cents INTEGER NOT NULL,
  bonus_cents  INTEGER NOT NULL DEFAULT 0,
  currency     TEXT NOT NULL DEFAULT 'USD',
  method       TEXT NOT NULL,
  phone        TEXT NOT NULL,
  provider     TEXT NOT NULL,
  order_number TEXT,
  reference    TEXT UNIQUE NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER
);
CREATE TABLE IF NOT EXISTS promos (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  title        TEXT NOT NULL,
  discount_pct INTEGER NOT NULL,
  prefix       TEXT NOT NULL DEFAULT '',
  active       INTEGER NOT NULL DEFAULT 1,
  starts_at    INTEGER NOT NULL DEFAULT 0,
  ends_at      INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS packages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  prefix      TEXT NOT NULL DEFAULT '',
  minutes     INTEGER NOT NULL DEFAULT 0,
  days        INTEGER NOT NULL DEFAULT 30,
  active      INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS user_packages (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  package_id    INTEGER NOT NULL,
  name          TEXT NOT NULL,
  prefix        TEXT NOT NULL DEFAULT '',
  remaining_sec INTEGER NOT NULL DEFAULT 0,
  unlimited     INTEGER NOT NULL DEFAULT 0,
  expires_at    INTEGER NOT NULL,
  purchased_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS airtime_topups (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id),
  phone        TEXT NOT NULL,
  operator     TEXT,
  amount_cents INTEGER NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',
  provider     TEXT NOT NULL,
  reference    TEXT,
  created_at   INTEGER NOT NULL
);
`;

// Colonnes ajoutées après la V1 (ALTER sans IF NOT EXISTS en SQLite → try/catch)
const MIGRATIONS = [
  `ALTER TABLE users ADD COLUMN referral_code TEXT`,
  `ALTER TABLE users ADD COLUMN referred_by TEXT`,
  `ALTER TABLE users ADD COLUMN referral_rewarded INTEGER DEFAULT 0`,
  `ALTER TABLE calls ADD COLUMN user_package_id TEXT`,
  `ALTER TABLE users ADD COLUMN avatar TEXT`,
  `ALTER TABLE calls ADD COLUMN direction TEXT DEFAULT 'out'`,
  `ALTER TABLE users ADD COLUMN fcm_token TEXT`,
];

let db;

// File d'attente : sérialise les opérations pour garantir l'atomicité des transactions
let chain = Promise.resolve();
const lock = (fn) => {
  const p = chain.then(fn);
  chain = p.catch(() => {});
  return p;
};

// Opérations brutes (synchrones), utilisées À L'INTÉRIEUR des transactions
const raw = {
  get: async (sql, p = []) => db.prepare(sql).get(...p),
  all: async (sql, p = []) => db.prepare(sql).all(...p),
  run: async (sql, p = []) => { db.prepare(sql).run(...p); },
};

module.exports = {
  name: 'sqlite',
  // Différences de dialecte SQL exposées aux modules
  fn: {
    greatest: 'MAX',
    dateFromMs: (col) => `date(${col}/1000,'unixepoch')`,
  },

  async init() {
    db = new Database(path.join(__dirname, '..', '..', 'mbote.db'));
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.exec(SCHEMA);
    for (const m of MIGRATIONS) { try { db.exec(m); } catch { /* colonne déjà présente */ } }
  },

  get: (sql, p) => lock(() => raw.get(sql, p)),
  all: (sql, p) => lock(() => raw.all(sql, p)),
  run: (sql, p) => lock(() => raw.run(sql, p)),

  tx: (fn) =>
    lock(async () => {
      db.exec('BEGIN');
      try {
        const r = await fn(raw);
        db.exec('COMMIT');
        return r;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    }),
};
