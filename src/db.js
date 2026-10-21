/**
 * MBOTE! — Base de données (SQLite pour la V1, schéma compatible PostgreSQL)
 * Toutes les sommes sont en CENTIMES (entiers) pour éviter les erreurs de virgule flottante.
 */
const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, '..', 'mbote.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,
  phone      TEXT UNIQUE NOT NULL,
  name       TEXT DEFAULT '',
  country    TEXT DEFAULT 'CD',
  role       TEXT DEFAULT 'user',          -- user | admin
  status     TEXT DEFAULT 'active',        -- active | blocked
  password_hash TEXT,                      -- admin uniquement
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS wallets (
  user_id       TEXT PRIMARY KEY REFERENCES users(id),
  balance_cents INTEGER NOT NULL DEFAULT 0,
  currency      TEXT NOT NULL DEFAULT 'USD'
);

-- Grand livre (ledger) : append-only, jamais de modification
CREATE TABLE IF NOT EXISTS transactions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id),
  type         TEXT NOT NULL,              -- topup | call_debit | bonus | admin_credit
  amount_cents INTEGER NOT NULL,           -- positif = crédit, négatif = débit
  method       TEXT,                       -- mpesa | orange | airtel | card | system
  reference    TEXT,
  status       TEXT NOT NULL DEFAULT 'completed',
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rates (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  prefix              TEXT NOT NULL,       -- ex: 24381
  destination         TEXT NOT NULL,       -- ex: RDC — Vodacom
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
  status              TEXT NOT NULL,       -- ringing | answered | ended
  started_at          INTEGER NOT NULL,
  answered_at         INTEGER,
  ended_at            INTEGER,
  billed_sec          INTEGER DEFAULT 0,
  cost_cents          INTEGER DEFAULT 0,
  hangup_cause        TEXT                 -- user_hangup | no_credit | rejected
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
`);

module.exports = db;
