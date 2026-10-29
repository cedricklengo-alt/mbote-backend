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
  destination         TEXT,
  price_per_min_cents INTEGER NOT NULL,
  max_sec             INTEGER NOT NULL,
  status              TEXT NOT NULL,
  started_at          BIGINT NOT NULL,
  answered_at         BIGINT,
  ended_at            BIGINT,
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
  expires_at BIGINT NOT NULL
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
  created_at   BIGINT NOT NULL,
  read_at      BIGINT
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
  created_at   BIGINT NOT NULL,
  read_at      BIGINT
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
CREATE TABLE IF NOT EXISTS invites (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  phone      TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_rewarded INTEGER DEFAULT 0;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS user_package_id TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar TEXT;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS direction TEXT DEFAULT 'out';
ALTER TABLE users ADD COLUMN IF NOT EXISTS fcm_token TEXT;
ALTER TABLE text_messages ADD COLUMN IF NOT EXISTS attachment TEXT;
ALTER TABLE text_messages ADD COLUMN IF NOT EXISTS attachment_type TEXT;
ALTER TABLE text_messages ADD COLUMN IF NOT EXISTS deleted INTEGER DEFAULT 0;
ALTER TABLE voice_notes ADD COLUMN IF NOT EXISTS deleted INTEGER DEFAULT 0;
ALTER TABLE text_messages ADD COLUMN IF NOT EXISTS delivered_at BIGINT;
ALTER TABLE voice_notes ADD COLUMN IF NOT EXISTS delivered_at BIGINT;
ALTER TABLE text_messages ADD COLUMN IF NOT EXISTS client_id TEXT;
ALTER TABLE voice_notes ADD COLUMN IF NOT EXISTS client_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_tm_client ON text_messages(from_id, client_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_vn_client ON voice_notes(from_id, client_id);
ALTER TABLE text_messages ADD COLUMN IF NOT EXISTS att_name TEXT;
ALTER TABLE text_messages ADD COLUMN IF NOT EXISTS att_mime TEXT;
ALTER TABLE text_messages ADD COLUMN IF NOT EXISTS att_size INTEGER;
ALTER TABLE voice_notes ADD COLUMN IF NOT EXISTS wave TEXT;
ALTER TABLE voice_notes ADD COLUMN IF NOT EXISTS played_at BIGINT;
CREATE TABLE IF NOT EXISTS msg_hidden (
  user_id TEXT NOT NULL,
  msg_id  TEXT NOT NULL,
  at      BIGINT NOT NULL,
  PRIMARY KEY (user_id, msg_id)
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
