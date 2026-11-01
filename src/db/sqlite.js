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
  avatar     TEXT,
  presence_visible INTEGER NOT NULL DEFAULT 1,
  notifications_enabled INTEGER NOT NULL DEFAULT 1,
  last_seen_at INTEGER,
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
  direction           TEXT NOT NULL DEFAULT 'outgoing',
  destination         TEXT,
  price_per_min_cents INTEGER NOT NULL,
  max_sec             INTEGER NOT NULL,
  status              TEXT NOT NULL,
  started_at          INTEGER NOT NULL,
  answered_at         INTEGER,
  ended_at            INTEGER,
  billed_sec          INTEGER DEFAULT 0,
  cost_cents          INTEGER DEFAULT 0,
  hangup_cause        TEXT,
  callee_user_id      TEXT,
  rtc_mode            INTEGER NOT NULL DEFAULT 0,
  with_video          INTEGER NOT NULL DEFAULT 0,
  offer_sdp           TEXT,
  push_notified_at    INTEGER
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
CREATE TABLE IF NOT EXISTS shop_packages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  price_cents   INTEGER NOT NULL,
  currency      TEXT NOT NULL DEFAULT 'USD',
  minutes       INTEGER NOT NULL DEFAULT 0,
  sms_count     INTEGER NOT NULL DEFAULT 0,
  days          INTEGER NOT NULL DEFAULT 30,
  prefix        TEXT NOT NULL DEFAULT '',
  category      TEXT NOT NULL DEFAULT 'credit',
  conditions    TEXT NOT NULL DEFAULT '',
  renewable     INTEGER NOT NULL DEFAULT 0,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER
);
CREATE TABLE IF NOT EXISTS shop_orders (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id),
  package_id       INTEGER NOT NULL,
  package_name     TEXT NOT NULL,
  package_snapshot TEXT NOT NULL DEFAULT '{}',
  amount_cents     INTEGER NOT NULL,
  currency         TEXT NOT NULL DEFAULT 'USD',
  status           TEXT NOT NULL DEFAULT 'pending',
  payment_id       TEXT,
  recipient_phone  TEXT,
  recipient_name   TEXT,
  created_at       INTEGER NOT NULL,
  expires_at       INTEGER NOT NULL,
  paid_at          INTEGER,
  activated_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_shop_orders_user ON shop_orders(user_id);
CREATE INDEX IF NOT EXISTS idx_shop_orders_status ON shop_orders(status);
CREATE TABLE IF NOT EXISTS shop_payments (
  id            TEXT PRIMARY KEY,
  order_id      TEXT NOT NULL REFERENCES shop_orders(id),
  user_id       TEXT NOT NULL REFERENCES users(id),
  provider      TEXT NOT NULL,
  method        TEXT NOT NULL,
  phone         TEXT,
  amount_cents  INTEGER NOT NULL,
  currency      TEXT NOT NULL DEFAULT 'USD',
  reference     TEXT NOT NULL UNIQUE,
  order_number  TEXT,
  status        TEXT NOT NULL DEFAULT 'pending',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_shop_pay_order ON shop_payments(order_id);
CREATE TABLE IF NOT EXISTS user_plans (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id),
  order_id        TEXT NOT NULL REFERENCES shop_orders(id),
  package_id      INTEGER NOT NULL,
  package_name    TEXT NOT NULL,
  prefix          TEXT NOT NULL DEFAULT '',
  minutes_total   INTEGER NOT NULL DEFAULT 0,
  remaining_sec   INTEGER NOT NULL DEFAULT 0,
  consumed_sec    INTEGER NOT NULL DEFAULT 0,
  sms_total       INTEGER NOT NULL DEFAULT 0,
  remaining_sms   INTEGER NOT NULL DEFAULT 0,
  consumed_sms    INTEGER NOT NULL DEFAULT 0,
  unlimited       INTEGER NOT NULL DEFAULT 0,
  recipient_phone TEXT,
  is_gift         INTEGER NOT NULL DEFAULT 0,
  activated_at    INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active',
  UNIQUE(order_id)
);
CREATE INDEX IF NOT EXISTS idx_user_plans_user ON user_plans(user_id, status);
CREATE INDEX IF NOT EXISTS idx_user_plans_expires ON user_plans(expires_at);
CREATE TABLE IF NOT EXISTS pending_gifts (
  order_id        TEXT PRIMARY KEY REFERENCES shop_orders(id),
  recipient_phone TEXT NOT NULL,
  recipient_name  TEXT,
  created_at      INTEGER NOT NULL,
  claimed_at      INTEGER,
  user_id         TEXT REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_pending_gifts_phone ON pending_gifts(recipient_phone);

/* ---- Feed social ---- */
CREATE TABLE IF NOT EXISTS posts (
  id                 TEXT PRIMARY KEY,
  author_id          TEXT NOT NULL REFERENCES users(id),
  type               TEXT NOT NULL,          -- photo | clip | texte | event
  origine            TEXT NOT NULL DEFAULT 'rdc',      -- rdc | diaspora
  duree              TEXT NOT NULL DEFAULT 'permanent', -- h24 | permanent
  visibilite         TEXT NOT NULL DEFAULT 'public',   -- contacts | communauté | public
  media_url          TEXT,
  texte              TEXT,
  event_title        TEXT,
  event_date         INTEGER,
  event_lieu         TEXT,
  event_tags         TEXT,                   -- JSON array
  clip_duree_seconds INTEGER,
  likes_count        INTEGER NOT NULL DEFAULT 0,
  comments_count     INTEGER NOT NULL DEFAULT 0,
  created_at         INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS stories (
  id          TEXT PRIMARY KEY,
  author_id   TEXT NOT NULL REFERENCES users(id),
  media_url   TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  visibilite  TEXT NOT NULL DEFAULT 'contacts'
);
CREATE TABLE IF NOT EXISTS stories_seen (
  story_id TEXT NOT NULL REFERENCES stories(id),
  user_id  TEXT NOT NULL REFERENCES users(id),
  seen_at  INTEGER NOT NULL,
  PRIMARY KEY (story_id, user_id)
);
CREATE TABLE IF NOT EXISTS post_likes (
  post_id    TEXT NOT NULL REFERENCES posts(id),
  user_id    TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (post_id, user_id)
);
CREATE TABLE IF NOT EXISTS post_comments (
  id         TEXT PRIMARY KEY,
  post_id    TEXT NOT NULL REFERENCES posts(id),
  author_id  TEXT NOT NULL REFERENCES users(id),
  texte      TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id            TEXT PRIMARY KEY,
  sender_id     TEXT NOT NULL REFERENCES users(id),
  recipient_id  TEXT NOT NULL REFERENCES users(id),
  client_id     TEXT,
  kind          TEXT NOT NULL DEFAULT 'text',
  body          TEXT NOT NULL DEFAULT '',
  lang_from     TEXT NOT NULL DEFAULT 'fr',
  lang_to       TEXT NOT NULL DEFAULT 'fr',
  translation   TEXT NOT NULL DEFAULT '',
  transcript    TEXT NOT NULL DEFAULT '',
  media_path    TEXT,
  media_name    TEXT,
  media_mime    TEXT,
  media_size    INTEGER,
  duration_sec  INTEGER,
  wave          TEXT,
  created_at    INTEGER NOT NULL,
  delivered_at  INTEGER,
  read_at       INTEGER,
  played_at     INTEGER,
  deleted_at    INTEGER,
  UNIQUE(sender_id, client_id)
);
CREATE INDEX IF NOT EXISTS idx_messages_sender_time ON messages(sender_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_recipient_time ON messages(recipient_id, created_at);
CREATE TABLE IF NOT EXISTS message_hidden (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  hidden_at  INTEGER NOT NULL,
  PRIMARY KEY(message_id, user_id)
);
CREATE TABLE IF NOT EXISTS device_tokens (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_device_tokens_user ON device_tokens(user_id);
CREATE TABLE IF NOT EXISTS presence_reminders (
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  notified_at INTEGER,
  PRIMARY KEY(owner_id, target_id)
);
`;

// Colonnes ajoutées après la V1 (ALTER sans IF NOT EXISTS en SQLite → try/catch)
const MIGRATIONS = [
  `ALTER TABLE users ADD COLUMN referral_code TEXT`,
  `ALTER TABLE users ADD COLUMN referred_by TEXT`,
  `ALTER TABLE users ADD COLUMN referral_rewarded INTEGER DEFAULT 0`,
  `ALTER TABLE users ADD COLUMN avatar TEXT`,
  `ALTER TABLE users ADD COLUMN presence_visible INTEGER NOT NULL DEFAULT 1`,
  `ALTER TABLE users ADD COLUMN notifications_enabled INTEGER NOT NULL DEFAULT 1`,
  `ALTER TABLE users ADD COLUMN last_seen_at INTEGER`,
  `ALTER TABLE calls ADD COLUMN callee_user_id TEXT`,
  `ALTER TABLE calls ADD COLUMN rtc_mode INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE calls ADD COLUMN with_video INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE calls ADD COLUMN offer_sdp TEXT`,
  `ALTER TABLE calls ADD COLUMN push_notified_at INTEGER`,
  `ALTER TABLE calls ADD COLUMN direction TEXT NOT NULL DEFAULT 'outgoing'`,
  `ALTER TABLE stories ADD COLUMN visibilite TEXT NOT NULL DEFAULT 'contacts'`,
  `ALTER TABLE posts ADD COLUMN event_lieu TEXT`,
  `ALTER TABLE messages ADD COLUMN duration_sec INTEGER`,
  `ALTER TABLE messages ADD COLUMN wave TEXT`,
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
    db = new Database(process.env.MBOTE_SQLITE_PATH || path.join(__dirname, '..', '..', 'mbote.db'));
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.exec(SCHEMA);
    for (const m of MIGRATIONS) { try { db.exec(m); } catch { /* colonne déjà présente */ } }
  },

  close: () => lock(async () => { if (db && db.open) db.close(); }),

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
