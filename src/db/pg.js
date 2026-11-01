/**
 * Driver PostgreSQL — utilisé en production (DATABASE_URL défini).
 * Données PERSISTANTES : survivent aux redéploiements. (Neon, Render PG, Supabase…)
 */
const { Pool, types } = require('pg');

// PG renvoie les BIGINT/NUMERIC en chaînes → on les convertit en nombres JS
types.setTypeParser(20, (v) => parseInt(v, 10));    // BIGINT (int8)
types.setTypeParser(1700, (v) => parseFloat(v));    // NUMERIC

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
  last_seen_at BIGINT,
  password_hash TEXT,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS wallets (
  user_id       TEXT PRIMARY KEY REFERENCES users(id),
  balance_cents BIGINT NOT NULL DEFAULT 0,
  currency      TEXT NOT NULL DEFAULT 'USD'
);
CREATE TABLE IF NOT EXISTS transactions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id),
  type         TEXT NOT NULL,
  amount_cents BIGINT NOT NULL,
  method       TEXT,
  reference    TEXT,
  status       TEXT NOT NULL DEFAULT 'completed',
  created_at   BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS rates (
  id                  SERIAL PRIMARY KEY,
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
  started_at          BIGINT NOT NULL,
  answered_at         BIGINT,
  ended_at            BIGINT,
  billed_sec          INTEGER DEFAULT 0,
  cost_cents          INTEGER DEFAULT 0,
  hangup_cause        TEXT,
  callee_user_id      TEXT,
  rtc_mode            INTEGER NOT NULL DEFAULT 0,
  with_video          INTEGER NOT NULL DEFAULT 0,
  offer_sdp           TEXT,
  push_notified_at    BIGINT
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
  expires_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS payments (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id),
  amount_cents BIGINT NOT NULL,
  bonus_cents  BIGINT NOT NULL DEFAULT 0,
  currency     TEXT NOT NULL DEFAULT 'USD',
  method       TEXT NOT NULL,
  phone        TEXT NOT NULL,
  provider     TEXT NOT NULL,
  order_number TEXT,
  reference    TEXT UNIQUE NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',
  created_at   BIGINT NOT NULL,
  updated_at   BIGINT
);
CREATE TABLE IF NOT EXISTS promos (
  id           SERIAL PRIMARY KEY,
  title        TEXT NOT NULL,
  discount_pct INTEGER NOT NULL,
  prefix       TEXT NOT NULL DEFAULT '',
  active       INTEGER NOT NULL DEFAULT 1,
  starts_at    BIGINT NOT NULL DEFAULT 0,
  ends_at      BIGINT NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS packages (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  price_cents BIGINT NOT NULL,
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
  expires_at    BIGINT NOT NULL,
  purchased_at  BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS airtime_topups (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id),
  phone        TEXT NOT NULL,
  operator     TEXT,
  amount_cents BIGINT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',
  provider     TEXT NOT NULL,
  reference    TEXT,
  created_at   BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS shop_packages (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  price_cents   BIGINT NOT NULL,
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
  created_at    BIGINT NOT NULL,
  updated_at    BIGINT
);
CREATE TABLE IF NOT EXISTS shop_orders (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id),
  package_id       INTEGER NOT NULL,
  package_name     TEXT NOT NULL,
  package_snapshot TEXT NOT NULL DEFAULT '{}',
  amount_cents     BIGINT NOT NULL,
  currency         TEXT NOT NULL DEFAULT 'USD',
  status           TEXT NOT NULL DEFAULT 'pending',
  payment_id       TEXT,
  recipient_phone  TEXT,
  recipient_name   TEXT,
  created_at       BIGINT NOT NULL,
  expires_at       BIGINT NOT NULL,
  paid_at          BIGINT,
  activated_at     BIGINT
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
  amount_cents  BIGINT NOT NULL,
  currency      TEXT NOT NULL DEFAULT 'USD',
  reference     TEXT NOT NULL UNIQUE,
  order_number  TEXT,
  status        TEXT NOT NULL DEFAULT 'pending',
  created_at    BIGINT NOT NULL,
  updated_at    BIGINT
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
  activated_at    BIGINT NOT NULL,
  expires_at      BIGINT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active',
  UNIQUE(order_id)
);
CREATE INDEX IF NOT EXISTS idx_user_plans_user ON user_plans(user_id, status);
CREATE INDEX IF NOT EXISTS idx_user_plans_expires ON user_plans(expires_at);
CREATE TABLE IF NOT EXISTS pending_gifts (
  order_id        TEXT PRIMARY KEY REFERENCES shop_orders(id),
  recipient_phone TEXT NOT NULL,
  recipient_name  TEXT,
  created_at      BIGINT NOT NULL,
  claimed_at      BIGINT,
  user_id         TEXT REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_pending_gifts_phone ON pending_gifts(recipient_phone);
ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_rewarded INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS presence_visible INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN IF NOT EXISTS notifications_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at BIGINT;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS callee_user_id TEXT;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS rtc_mode INTEGER NOT NULL DEFAULT 0;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS with_video INTEGER NOT NULL DEFAULT 0;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS offer_sdp TEXT;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS push_notified_at BIGINT;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS direction TEXT NOT NULL DEFAULT 'outgoing';
CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY,
  author_id TEXT NOT NULL REFERENCES users(id),
  type TEXT NOT NULL,
  origine TEXT NOT NULL DEFAULT 'rdc',
  duree TEXT NOT NULL DEFAULT 'permanent',
  visibilite TEXT NOT NULL DEFAULT 'public',
  media_url TEXT,
  texte TEXT,
  event_title TEXT,
  event_date BIGINT,
  event_lieu TEXT,
  event_tags TEXT,
  clip_duree_seconds INTEGER,
  likes_count INTEGER NOT NULL DEFAULT 0,
  comments_count INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL
);
ALTER TABLE posts ADD COLUMN IF NOT EXISTS event_lieu TEXT;
CREATE TABLE IF NOT EXISTS stories (
  id TEXT PRIMARY KEY,
  author_id TEXT NOT NULL REFERENCES users(id),
  media_url TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  visibilite TEXT NOT NULL DEFAULT 'contacts'
);
ALTER TABLE stories ADD COLUMN IF NOT EXISTS visibilite TEXT NOT NULL DEFAULT 'contacts';
CREATE TABLE IF NOT EXISTS stories_seen (
  story_id TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  seen_at BIGINT NOT NULL,
  PRIMARY KEY(story_id, user_id)
);
CREATE TABLE IF NOT EXISTS post_likes (
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at BIGINT NOT NULL,
  PRIMARY KEY(post_id, user_id)
);
CREATE TABLE IF NOT EXISTS post_comments (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES users(id),
  texte TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  sender_id TEXT NOT NULL REFERENCES users(id),
  recipient_id TEXT NOT NULL REFERENCES users(id),
  client_id TEXT,
  kind TEXT NOT NULL DEFAULT 'text',
  body TEXT NOT NULL DEFAULT '',
  lang_from TEXT NOT NULL DEFAULT 'fr',
  lang_to TEXT NOT NULL DEFAULT 'fr',
  translation TEXT NOT NULL DEFAULT '',
  transcript TEXT NOT NULL DEFAULT '',
  media_path TEXT,
  media_name TEXT,
  media_mime TEXT,
  media_size BIGINT,
  duration_sec INTEGER,
  wave TEXT,
  created_at BIGINT NOT NULL,
  delivered_at BIGINT,
  read_at BIGINT,
  played_at BIGINT,
  deleted_at BIGINT,
  UNIQUE(sender_id, client_id)
);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS duration_sec INTEGER;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS wave TEXT;
CREATE INDEX IF NOT EXISTS idx_messages_sender_time ON messages(sender_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_recipient_time ON messages(recipient_id, created_at);
CREATE TABLE IF NOT EXISTS message_hidden (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  hidden_at BIGINT NOT NULL,
  PRIMARY KEY(message_id, user_id)
);
CREATE TABLE IF NOT EXISTS device_tokens (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_device_tokens_user ON device_tokens(user_id);
CREATE TABLE IF NOT EXISTS presence_reminders (
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at BIGINT NOT NULL,
  notified_at BIGINT,
  PRIMARY KEY(owner_id, target_id)
);
`;

// Convertit les placeholders « ? » (style SQLite) en « $1, $2… » (style PG)
const toPg = (sql) => {
  let i = 0;
  return sql.replace(/\?/g, () => '$' + ++i);
};

let pool;

const ops = (client) => ({
  get: async (sql, p = []) => (await client.query(toPg(sql), p)).rows[0],
  all: async (sql, p = []) => (await client.query(toPg(sql), p)).rows,
  run: async (sql, p = []) => { await client.query(toPg(sql), p); },
});

module.exports = {
  name: 'postgres',
  fn: {
    greatest: 'GREATEST',
    dateFromMs: (col) => `to_char(to_timestamp(${col}/1000.0),'YYYY-MM-DD')`,
  },

  async init() {
    const url = process.env.DATABASE_URL;
    const local = /localhost|127\.0\.0\.1/.test(url);
    pool = new Pool({
      connectionString: url,
      ssl: local ? false : { rejectUnauthorized: false }, // Neon/Render exigent SSL
      max: 10,
    });
    await pool.query(SCHEMA);
  },

  async close() {
    if (pool) { await pool.end(); pool = null; }
  },

  get: (sql, p) => ops(pool).get(sql, p),
  all: (sql, p) => ops(pool).all(sql, p),
  run: (sql, p) => ops(pool).run(sql, p),

  async tx(fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const r = await fn(ops(client));
      await client.query('COMMIT');
      return r;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  },
};
