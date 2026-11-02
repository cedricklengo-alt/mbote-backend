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
CREATE TABLE IF NOT EXISTS voice_notes (
  id           TEXT PRIMARY KEY,
  from_id      TEXT NOT NULL REFERENCES users(id),
  to_id        TEXT NOT NULL REFERENCES users(id),
  audio        TEXT NOT NULL,
  duration_sec INTEGER NOT NULL DEFAULT 0,
  lang_from    TEXT NOT NULL DEFAULT 'fr',
  lang_to      TEXT NOT NULL DEFAULT 'ln',
  transcript   TEXT,
  translation  TEXT,
  status       TEXT NOT NULL DEFAULT 'pending',
  created_at   INTEGER NOT NULL,
  read_at      INTEGER
);
CREATE TABLE IF NOT EXISTS text_messages (
  id           TEXT PRIMARY KEY,
  from_id      TEXT NOT NULL REFERENCES users(id),
  to_id        TEXT NOT NULL REFERENCES users(id),
  body         TEXT NOT NULL,
  lang_from    TEXT NOT NULL DEFAULT 'fr',
  lang_to      TEXT NOT NULL DEFAULT 'ln',
  translation  TEXT,
  status       TEXT NOT NULL DEFAULT 'pending',
  created_at   INTEGER NOT NULL,
  read_at      INTEGER
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
CREATE TABLE IF NOT EXISTS invites (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  phone      TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- ── v3.2 FEED ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS posts (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  type        TEXT NOT NULL DEFAULT 'texte',   -- photo|clip|texte|event
  texte       TEXT,
  media_url   TEXT,
  event_title TEXT,
  event_date  INTEGER,
  event_lieu  TEXT,
  event_tags  TEXT DEFAULT '[]',
  clip_sec    INTEGER,
  ville       TEXT,
  visibilite  TEXT DEFAULT 'contacts',
  origine     TEXT DEFAULT 'rdc',
  duree       TEXT DEFAULT 'permanent',
  likes       INTEGER DEFAULT 0,
  comments    INTEGER DEFAULT 0,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS stories (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  media_url   TEXT,
  texte       TEXT,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS stories_seen (
  story_id    TEXT NOT NULL REFERENCES stories(id),
  user_id     TEXT NOT NULL REFERENCES users(id),
  seen_at     INTEGER NOT NULL,
  PRIMARY KEY (story_id, user_id)
);

CREATE TABLE IF NOT EXISTS post_likes (
  post_id     TEXT NOT NULL REFERENCES posts(id),
  user_id     TEXT NOT NULL REFERENCES users(id),
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (post_id, user_id)
);

CREATE TABLE IF NOT EXISTS post_comments (
  id          TEXT PRIMARY KEY,
  post_id     TEXT NOT NULL REFERENCES posts(id),
  user_id     TEXT NOT NULL REFERENCES users(id),
  texte       TEXT NOT NULL,
  created_at  INTEGER NOT NULL
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
  `ALTER TABLE text_messages ADD COLUMN attachment TEXT`,
  `ALTER TABLE text_messages ADD COLUMN attachment_type TEXT`,
  `ALTER TABLE text_messages ADD COLUMN deleted INTEGER DEFAULT 0`,
  `ALTER TABLE voice_notes ADD COLUMN deleted INTEGER DEFAULT 0`,
  `ALTER TABLE text_messages ADD COLUMN delivered_at INTEGER`,
  `ALTER TABLE voice_notes ADD COLUMN delivered_at INTEGER`,
  // 🔁 v3.0 : clé d'idempotence — un renvoi après timeout ne crée plus de doublon
  `ALTER TABLE text_messages ADD COLUMN client_id TEXT`,
  `ALTER TABLE voice_notes ADD COLUMN client_id TEXT`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_tm_client ON text_messages(from_id, client_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_vn_client ON voice_notes(from_id, client_id)`,
  // 📎 v3.1 : pièces jointes (nom, type, taille), forme d'onde et écoute des vocaux
  `ALTER TABLE text_messages ADD COLUMN att_name TEXT`,
  `ALTER TABLE text_messages ADD COLUMN att_mime TEXT`,
  `ALTER TABLE text_messages ADD COLUMN att_size INTEGER`,
  `ALTER TABLE voice_notes ADD COLUMN wave TEXT`,
  `ALTER TABLE voice_notes ADD COLUMN played_at INTEGER`,
  // 🗑️ v3.1 : « supprimer pour moi » — masque un message pour UN utilisateur
  `CREATE TABLE IF NOT EXISTS msg_hidden (
     user_id TEXT NOT NULL,
     msg_id  TEXT NOT NULL,
     at      INTEGER NOT NULL,
     PRIMARY KEY (user_id, msg_id)
   )`,

  // ── v3.2 BOUTIQUE — catalogue, commandes, paiements, plans utilisateur ──

  // Catalogue des forfaits (géré par l'admin)
  `CREATE TABLE IF NOT EXISTS shop_packages (
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
   )`,

  // Commandes : lien utilisateur ↔ forfait avec prix figé au moment de l'achat
  `CREATE TABLE IF NOT EXISTS shop_orders (
     id               TEXT PRIMARY KEY,
     user_id          TEXT NOT NULL REFERENCES users(id),
     package_id       INTEGER NOT NULL,
     package_name     TEXT NOT NULL,
     package_snapshot TEXT NOT NULL DEFAULT '{}',
     amount_cents     INTEGER NOT NULL,
     currency         TEXT NOT NULL DEFAULT 'USD',
     status           TEXT NOT NULL DEFAULT 'pending',
     payment_id       TEXT,
     created_at       INTEGER NOT NULL,
     expires_at       INTEGER NOT NULL,
     paid_at          INTEGER,
     activated_at     INTEGER
   )`,
  `CREATE INDEX IF NOT EXISTS idx_shop_orders_user ON shop_orders(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_shop_orders_status ON shop_orders(status)`,

  // Paiements boutique (séparés des paiements de rechargement de portefeuille)
  `CREATE TABLE IF NOT EXISTS shop_payments (
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
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_shop_pay_ref ON shop_payments(reference)`,
  `CREATE INDEX IF NOT EXISTS idx_shop_pay_order ON shop_payments(order_id)`,

  // Plans activés (droits accordés à l'utilisateur)
  `CREATE TABLE IF NOT EXISTS user_plans (
     id             TEXT PRIMARY KEY,
     user_id        TEXT NOT NULL REFERENCES users(id),
     order_id       TEXT NOT NULL REFERENCES shop_orders(id),
     package_id     INTEGER NOT NULL,
     package_name   TEXT NOT NULL,
     prefix         TEXT NOT NULL DEFAULT '',
     minutes_total  INTEGER NOT NULL DEFAULT 0,
     remaining_sec  INTEGER NOT NULL DEFAULT 0,
     consumed_sec   INTEGER NOT NULL DEFAULT 0,
     sms_total      INTEGER NOT NULL DEFAULT 0,
     remaining_sms  INTEGER NOT NULL DEFAULT 0,
     consumed_sms   INTEGER NOT NULL DEFAULT 0,
     unlimited      INTEGER NOT NULL DEFAULT 0,
     activated_at   INTEGER NOT NULL,
     expires_at     INTEGER NOT NULL,
     status         TEXT NOT NULL DEFAULT 'active'
   )`,
  `CREATE INDEX IF NOT EXISTS idx_user_plans_user ON user_plans(user_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_user_plans_expires ON user_plans(expires_at)`,

  // ── v3.2 APPELS — colonnes de facturation manquantes ──
  `ALTER TABLE calls ADD COLUMN billed_sec INTEGER DEFAULT 0`,
  `ALTER TABLE calls ADD COLUMN cost_cents INTEGER DEFAULT 0`,
  `ALTER TABLE calls ADD COLUMN provider_cost_cents INTEGER`,
  `ALTER TABLE calls ADD COLUMN provider_currency TEXT`,
  `ALTER TABLE calls ADD COLUMN ended_at INTEGER`,
  `ALTER TABLE calls ADD COLUMN user_plan_id TEXT`,

  // ── v3.2 TRANSACTIONS — statut pour réservations ──
  `ALTER TABLE transactions ADD COLUMN status TEXT DEFAULT 'confirmed'`,

  // ── v3.3 BOUTIQUE — cadeaux de forfaits ──
  `ALTER TABLE shop_orders ADD COLUMN recipient_phone TEXT`,
  `ALTER TABLE shop_orders ADD COLUMN recipient_name TEXT`,
  `ALTER TABLE user_plans ADD COLUMN recipient_phone TEXT`,
  `ALTER TABLE user_plans ADD COLUMN is_gift INTEGER DEFAULT 0`,

  // ── v3.4 — entrées réinsérées ici (étaient collées après module.exports) ──
  // ── v3.4 PRÉSENCE — horodatage de dernière vue ──
  `ALTER TABLE users ADD COLUMN last_seen_at INTEGER`,

  // ── v3.4 PRÉSENCE — abonnements «Rappelle-moi» ──
  `CREATE TABLE IF NOT EXISTS watches (
     id          TEXT PRIMARY KEY,
     watcher_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     target_phone TEXT NOT NULL,
     created_at  INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_watches_target ON watches(target_phone)`,

  // ── v3.4 APPEL PROGRAMMÉ ──
  `CREATE TABLE IF NOT EXISTS dial_later (
     id           TEXT PRIMARY KEY,
     user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     target_phone TEXT NOT NULL,
     target_name  TEXT NOT NULL DEFAULT '',
     scheduled_at INTEGER NOT NULL,
     tz_offset    INTEGER NOT NULL DEFAULT 0,
     reminded     INTEGER NOT NULL DEFAULT 0,
     cancelled    INTEGER NOT NULL DEFAULT 0,
     created_at   INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_dial_later_user ON dial_later(user_id, cancelled)`,

  // ── v3.4 LIENS D'INVITATION ──
  `CREATE TABLE IF NOT EXISTS invite_tokens (
     token        TEXT PRIMARY KEY,
     user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     referral_code TEXT NOT NULL,
     created_at   INTEGER NOT NULL,
     expires_at   INTEGER NOT NULL,
     used_at      INTEGER
  )`,
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
