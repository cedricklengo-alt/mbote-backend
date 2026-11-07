/**
 * Driver PostgreSQL — utilisé en production (DATABASE_URL défini).
 * Données PERSISTANTES : survivent aux redéploiements. (Neon, Render PG, Supabase…)
 */
const { Pool, types } = require('pg');
const { AsyncLocalStorage } = require('async_hooks');

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
ALTER TABLE users ADD COLUMN IF NOT EXISTS dial_code TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login BIGINT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS app_version TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS language TEXT;
CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  refresh_hash  TEXT NOT NULL,
  user_agent    TEXT,
  ip            TEXT,
  created_at    BIGINT NOT NULL,
  last_used_at  BIGINT,
  expires_at    BIGINT NOT NULL,
  revoked       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id, revoked);
CREATE TABLE IF NOT EXISTS devices (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id),
  device_id    TEXT NOT NULL,
  platform     TEXT,
  model        TEXT,
  app_version  TEXT,
  fcm_token    TEXT,
  last_seen_at BIGINT,
  created_at   BIGINT NOT NULL,
  UNIQUE(user_id, device_id)
);
CREATE TABLE IF NOT EXISTS user_preferences (
  user_id    TEXT PRIMARY KEY REFERENCES users(id),
  language   TEXT DEFAULT 'fr',
  theme      TEXT DEFAULT 'fleuve',
  text_scale DOUBLE PRECISION DEFAULT 1.0,
  updated_at BIGINT
);
CREATE TABLE IF NOT EXISTS user_security (
  user_id      TEXT PRIMARY KEY REFERENCES users(id),
  pin_hash     TEXT,
  otp_attempts INTEGER DEFAULT 0,
  locked_until BIGINT DEFAULT 0,
  updated_at   BIGINT
);
CREATE TABLE IF NOT EXISTS audit_logs (
  id         TEXT PRIMARY KEY,
  user_id    TEXT,
  action     TEXT NOT NULL,
  ip         TEXT,
  user_agent TEXT,
  meta       TEXT,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs(user_id, created_at);
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

-- v3.3 BOUTIQUE — cadeaux de forfaits
ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS recipient_phone TEXT;
ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS recipient_name TEXT;
ALTER TABLE user_plans ADD COLUMN IF NOT EXISTS recipient_phone TEXT;
ALTER TABLE user_plans ADD COLUMN IF NOT EXISTS is_gift BOOLEAN DEFAULT FALSE;

-- v3.2 FEED — publications, stories, likes, commentaires ─────────────────────
CREATE TABLE IF NOT EXISTS posts (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        TEXT NOT NULL DEFAULT 'texte',
  texte       TEXT,
  media_url   TEXT,
  event_title TEXT,
  event_date  TEXT,
  event_lieu  TEXT,
  event_tags  TEXT DEFAULT '[]',
  clip_sec    INTEGER DEFAULT 0,
  ville       TEXT DEFAULT '',
  visibilite  TEXT NOT NULL DEFAULT 'public',
  origine     TEXT NOT NULL DEFAULT 'rdc',
  duree       TEXT NOT NULL DEFAULT 'permanent',
  likes       INTEGER NOT NULL DEFAULT 0,
  comments    INTEGER NOT NULL DEFAULT 0,
  created_at  BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS stories (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  media_url   TEXT,
  texte       TEXT,
  created_at  BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS stories_seen (
  story_id    TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  seen_at     BIGINT NOT NULL,
  PRIMARY KEY (story_id, user_id)
);

CREATE TABLE IF NOT EXISTS post_likes (
  post_id     TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  BIGINT NOT NULL,
  PRIMARY KEY (post_id, user_id)
);

CREATE TABLE IF NOT EXISTS post_comments (
  id          TEXT PRIMARY KEY,
  post_id     TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  texte       TEXT NOT NULL,
  created_at  BIGINT NOT NULL
);

/* ─── Tables présentes dans le driver SQLite mais absentes ici ───────────────
 * Sans elles, en production (DATABASE_URL defini) : toute la boutique, les
 * rappels de presence, les appels programmes et les liens d'invitation
 * echouent a l'execution bien que leurs routes existent.
 * CREATE TABLE IF NOT EXISTS est idempotent : aucune donnee existante n'est
 * touchee. Horodatages en BIGINT (millisecondes), comme le reste du schema. */

CREATE TABLE IF NOT EXISTS shop_packages (
  id            SERIAL PRIMARY KEY,
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
  created_at    BIGINT NOT NULL,
  updated_at    BIGINT
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
  created_at       BIGINT NOT NULL,
  expires_at       BIGINT NOT NULL,
  paid_at          BIGINT,
  activated_at     BIGINT
);
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
  created_at    BIGINT NOT NULL,
  updated_at    BIGINT
);
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
  is_gift         INTEGER DEFAULT 0,
  activated_at    BIGINT NOT NULL,
  expires_at      BIGINT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active'
);
CREATE TABLE IF NOT EXISTS watches (
  id           TEXT PRIMARY KEY,
  watcher_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_phone TEXT NOT NULL,
  created_at   BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS dial_later (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_phone TEXT NOT NULL,
  target_name  TEXT NOT NULL DEFAULT '',
  scheduled_at BIGINT NOT NULL,
  tz_offset    INTEGER NOT NULL DEFAULT 0,
  reminded     INTEGER NOT NULL DEFAULT 0,
  cancelled    INTEGER NOT NULL DEFAULT 0,
  created_at   BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS invite_tokens (
  token         TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  referral_code TEXT NOT NULL,
  created_at    BIGINT NOT NULL,
  expires_at    BIGINT NOT NULL,
  used_at       BIGINT
);

/* Colonnes manquantes cote PG (le driver SQLite les ajoutait deja) */
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at BIGINT;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS user_plan_id TEXT;


-- v3.4 MESSAGES — messagerie unifiée (remplace text_messages + voice_notes pour les échanges bi-directs)
CREATE TABLE IF NOT EXISTS messages (
  id           TEXT PRIMARY KEY,
  sender_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id    TEXT,
  kind         TEXT NOT NULL DEFAULT 'text',
  body         TEXT NOT NULL DEFAULT '',
  lang_from    TEXT NOT NULL DEFAULT 'fr',
  lang_to      TEXT NOT NULL DEFAULT 'fr',
  translation  TEXT NOT NULL DEFAULT '',
  transcript   TEXT NOT NULL DEFAULT '',
  media_path   TEXT,
  media_name   TEXT,
  media_mime   TEXT,
  media_size   INTEGER,
  duration_sec INTEGER,
  wave         TEXT,
  created_at   BIGINT NOT NULL,
  delivered_at BIGINT,
  read_at      BIGINT,
  played_at    BIGINT,
  deleted_at   BIGINT,
  UNIQUE (sender_id, client_id)
);
CREATE TABLE IF NOT EXISTS message_hidden (
  message_id  TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  hidden_at   BIGINT NOT NULL,
  PRIMARY KEY (message_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_messages_sender    ON messages(sender_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_recipient ON messages(recipient_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_client    ON messages(sender_id, client_id) WHERE client_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_watches_target    ON watches(target_phone);
CREATE INDEX IF NOT EXISTS idx_dial_later_user   ON dial_later(user_id, cancelled);
CREATE INDEX IF NOT EXISTS idx_shop_orders_user  ON shop_orders(user_id);
CREATE INDEX IF NOT EXISTS idx_user_plans_user   ON user_plans(user_id, status);
CREATE INDEX IF NOT EXISTS idx_user_plans_order  ON user_plans(order_id);
CREATE INDEX IF NOT EXISTS idx_posts_created   ON posts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_user      ON posts(user_id);
CREATE INDEX IF NOT EXISTS idx_stories_user    ON stories(user_id);
CREATE INDEX IF NOT EXISTS idx_stories_created ON stories(created_at DESC);

-- ── v3.5 TOKENS APPAREILS (FCM / push notifications) ─────────────────────
CREATE TABLE IF NOT EXISTS device_tokens (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_device_tokens_user ON device_tokens(user_id);

-- ── v3.5 RAPPELS DE PRÉSENCE ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS presence_reminders (
  owner_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  BIGINT NOT NULL,
  notified_at BIGINT,
  PRIMARY KEY (owner_id, target_id)
);

-- ── v3.5 COLONNES UTILISATEURS — visibilité présence & notifications ──────
ALTER TABLE users ADD COLUMN IF NOT EXISTS presence_visible      INTEGER DEFAULT 1;
ALTER TABLE users ADD COLUMN IF NOT EXISTS notifications_enabled INTEGER DEFAULT 1;

-- ── v3.5 COLONNES APPELS — appelé, mode RTC, vidéo ───────────────────────
ALTER TABLE calls ADD COLUMN IF NOT EXISTS callee_user_id TEXT;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS rtc_mode       INTEGER DEFAULT 0;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS with_video     INTEGER DEFAULT 0;

-- ── v3.5 CADEAUX EN ATTENTE ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pending_gifts (
  order_id        TEXT PRIMARY KEY REFERENCES shop_orders(id) ON DELETE CASCADE,
  recipient_phone TEXT NOT NULL,
  recipient_name  TEXT,
  user_id         TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at      BIGINT NOT NULL,
  claimed_at      BIGINT
);
CREATE INDEX IF NOT EXISTS idx_pending_gifts_phone ON pending_gifts(recipient_phone) WHERE claimed_at IS NULL;

-- ── v3.6 TWILIO / SMS / HISTORIQUE ─────────────────────────────────────
ALTER TABLE rates ADD COLUMN IF NOT EXISTS sms_price_cents INTEGER;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS provider_sid    TEXT;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS provider_status TEXT;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS hidden_at       INTEGER;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS redirect_url TEXT;
ALTER TABLE shop_payments ADD COLUMN IF NOT EXISTS redirect_url TEXT;
CREATE INDEX IF NOT EXISTS idx_calls_provider_sid ON calls(provider_sid);

CREATE TABLE IF NOT EXISTS sms_messages (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id),
  to_phone       TEXT NOT NULL,
  from_phone     TEXT,
  body           TEXT NOT NULL DEFAULT '',
  status         TEXT NOT NULL DEFAULT 'queued',
  provider       TEXT NOT NULL DEFAULT 'twilio',
  provider_sid   TEXT,
  segments       INTEGER,
  price_cents    INTEGER DEFAULT 0,
  charged_cents  INTEGER DEFAULT 0,
  plan_id        TEXT,
  reference      TEXT NOT NULL,
  client_id      TEXT,
  error_code     TEXT,
  error_message  TEXT,
  refunded_at    BIGINT,
  created_at     BIGINT NOT NULL,
  updated_at     BIGINT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sms_client ON sms_messages(user_id, client_id);
CREATE INDEX IF NOT EXISTS idx_sms_user ON sms_messages(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_sms_sid ON sms_messages(provider_sid);

/* ─── v3.4 FIL DE PUBLICATIONS — découverte (vues, abonnements, mots-clés) ──
 * Le fil ne savait rien faire d'autre qu'afficher les publications dans
 * l'ordre du temps : aucune vue, aucun abonnement, aucun mot-clé. Ces trois
 * tables apportent l'essentiel de ce qu'on attend d'un fil public. */

ALTER TABLE posts ADD COLUMN IF NOT EXISTS vues INTEGER DEFAULT 0;

/* Miniature de la vidéo, capturée automatiquement à l'envoi du fichier. */
ALTER TABLE posts ADD COLUMN IF NOT EXISTS thumb_url TEXT;

/* Nombre de partages : lien copié ou publication envoyée à une autre app. */
ALTER TABLE posts ADD COLUMN IF NOT EXISTS shares INTEGER DEFAULT 0;
-- 📞 v3.7 : opt-in d'appel (case « Autoriser les appels » à la publication)
ALTER TABLE posts ADD COLUMN IF NOT EXISTS allow_calls INTEGER DEFAULT 1;
-- ✏️ v3.8 : édition de publication (« Modifié » côté client)
ALTER TABLE posts ADD COLUMN IF NOT EXISTS edited_at BIGINT;

/* Une ligne par (publication, lecteur) : le compteur ne peut pas être gonflé
 * en rafraîchissant la page. */
CREATE TABLE IF NOT EXISTS post_views (
  post_id    TEXT NOT NULL,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (post_id, user_id)
);

/* Abonnements : « suivre » un auteur sans échange de numéro. */
CREATE TABLE IF NOT EXISTS follows (
  follower_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  followee_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  BIGINT NOT NULL,
  PRIMARY KEY (follower_id, followee_id)
);

/* Mots-clés extraits à la publication : alimente les tendances et le filtrage
 * par #mot-clé. */
CREATE TABLE IF NOT EXISTS post_tags (
  post_id TEXT NOT NULL,
  tag     TEXT NOT NULL,
  PRIMARY KEY (post_id, tag)
);

CREATE INDEX IF NOT EXISTS idx_post_tags_tag ON post_tags(tag);
CREATE INDEX IF NOT EXISTS idx_post_views_post ON post_views(post_id);
CREATE INDEX IF NOT EXISTS idx_follows_followee ON follows(followee_id);
CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at);
-- v3.7 SOCIAL — identifiant public (@pseudo), abonnements aux hashtags,
-- mentions et notifications internes.
ALTER TABLE users ADD COLUMN IF NOT EXISTS handle TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_handle ON users(handle);

/* Abonnements aux mots-clés : « suivre #MboteCall » fait remonter les
 * publications qui le portent. */
CREATE TABLE IF NOT EXISTS hashtag_follows (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tag        TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, tag)
);
CREATE INDEX IF NOT EXISTS idx_hashtag_follows_tag ON hashtag_follows(tag);

/* Mentions résolues : une ligne par personne réellement mentionnée, quelle que
 * soit la source (publication, commentaire, statut). Sert aux notifications, au
 * profil « mentions reçues » et aux statistiques — sans relire le texte. */
CREATE TABLE IF NOT EXISTS mentions (
  source_type TEXT NOT NULL,
  source_id   TEXT NOT NULL,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  handle      TEXT NOT NULL,
  created_at  BIGINT NOT NULL,
  PRIMARY KEY (source_type, source_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_mentions_user ON mentions(user_id);
CREATE INDEX IF NOT EXISTS idx_mentions_source ON mentions(source_type, source_id);

/* Notifications internes (boîte de réception de l'application). */
CREATE TABLE IF NOT EXISTS notifications (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sender_id   TEXT,
  type        TEXT NOT NULL,
  post_id     TEXT,
  comment_id  TEXT,
  source_type TEXT,
  source_id   TEXT,
  texte       TEXT,
  lu          INTEGER NOT NULL DEFAULT 0,
  created_at  BIGINT NOT NULL,
  UNIQUE (user_id, type, source_type, source_id)
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_notifications_non_lues ON notifications(user_id, lu);
-- v3.8 NOTIFICATIONS — regroupement des likes et partages, réponses aux
-- commentaires.
ALTER TABLE post_comments ADD COLUMN IF NOT EXISTS parent_id TEXT;
CREATE INDEX IF NOT EXISTS idx_comments_parent ON post_comments(parent_id);

/* Nombre d'auteurs distincts d'une notification groupée (« et 16 autres »).
 * la table notification_acteurs porte le détail ; cette colonne évite de la
 * compter à chaque affichage. */
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS nb_acteurs INTEGER NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS notification_acteurs (
  notification_id TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  created_at      BIGINT NOT NULL,
  PRIMARY KEY (notification_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_notif_acteurs ON notification_acteurs(notification_id);

-- v4.1 : moteur de ranking du fil ──────────────────────────────
CREATE TABLE IF NOT EXISTS feed_scores (
post_id    TEXT PRIMARY KEY REFERENCES posts(id) ON DELETE CASCADE,
score      DOUBLE PRECISION NOT NULL DEFAULT 0,
detail     TEXT,
updated_at BIGINT
);
CREATE TABLE IF NOT EXISTS feed_events (
id         TEXT PRIMARY KEY,
user_id    TEXT REFERENCES users(id) ON DELETE CASCADE,
type       TEXT NOT NULL,
post_id    TEXT,
meta       TEXT,
created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS post_reactions (
id         TEXT PRIMARY KEY,
post_id    TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
type       TEXT NOT NULL,
created_at BIGINT NOT NULL,
UNIQUE(post_id, user_id)
);
CREATE TABLE IF NOT EXISTS comment_reactions (
id         TEXT PRIMARY KEY,
comment_id TEXT NOT NULL REFERENCES post_comments(id) ON DELETE CASCADE,
user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
type       TEXT NOT NULL,
created_at BIGINT NOT NULL,
UNIQUE(comment_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_feed_scores_score ON feed_scores(score DESC);
CREATE INDEX IF NOT EXISTS idx_feed_events_user ON feed_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_post_reactions_post ON post_reactions(post_id);
CREATE INDEX IF NOT EXISTS idx_comment_reactions_comment ON comment_reactions(comment_id)

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

// 🔒 RÉENTRANCE — un db.get/db.run/db.all appelé À L'INTÉRIEUR d'un db.tx doit
// passer par LA MÊME connexion que la transaction. Sinon il lit l'état d'avant
// la transaction (données incohérentes) et peut se bloquer sur un verrou de
// ligne. AsyncLocalStorage porte la connexion courante.
const txContext = new AsyncLocalStorage();
const currentClient = () => txContext.getStore() || pool;

/* ── Réparation de schéma : colonnes historiquement BOOLEAN ───────────────
 * La première version Postgres du schéma déclarait ces colonnes en BOOLEAN
 * (`a1bfca8`). Elles sont depuis passées en INTEGER (0/1), MAIS
 * `CREATE TABLE IF NOT EXISTS` ne modifie jamais une table déjà créée : une
 * base née avant le changement garde des BOOLEAN, et une requête comme
 * `WHERE active = 1` y échoue avec l'erreur Postgres 42883
 * « operator does not exist: boolean = integer ».
 *
 * Constaté sur le déploiement Render le 3 novembre 2026 :
 *   GET  /api/shop/catalog → 500 {"error":"Erreur interne","code":"42883"}
 *   POST /api/shop/orders  → 500 (même cause)
 * Autrement dit la boutique était inaccessible en production, alors que tout
 * passait en local (SQLite ne vérifie pas les types).
 *
 * On lit le type réel dans information_schema et on ne convertit QUE si la
 * colonne est encore BOOLEAN : la réparation est idempotente et sans effet sur
 * une base déjà correcte.
 * ------------------------------------------------------------------------ */
const LEGACY_BOOLEAN_COLUMNS = [
  { table: 'shop_packages', column: 'active', defaultValue: 1 },
  { table: 'shop_packages', column: 'renewable', defaultValue: 0 },
  { table: 'user_plans', column: 'unlimited', defaultValue: 0 },
  { table: 'user_plans', column: 'is_gift', defaultValue: 0 },
];

/** Faut-il convertir cette colonne ? (fonction pure : testable sans base) */
function needsBooleanRepair(dataType) {
  return String(dataType || '').toLowerCase() === 'boolean';
}

/** Les ordres SQL qui transforment une colonne BOOLEAN en INTEGER 0/1. */
function booleanRepairSql({ table, column, defaultValue }) {
  return [
    `ALTER TABLE ${table} ALTER COLUMN ${column} DROP DEFAULT`,
    `ALTER TABLE ${table} ALTER COLUMN ${column} TYPE INTEGER ` +
      `USING (CASE WHEN ${column} THEN 1 ELSE 0 END)`,
    `ALTER TABLE ${table} ALTER COLUMN ${column} SET DEFAULT ${defaultValue === 1 ? 1 : 0}`,
  ];
}

/** Applique la réparation sur la base connectée. Ne jette jamais. */
async function repairLegacySchema(client) {
  for (const cible of LEGACY_BOOLEAN_COLUMNS) {
    try {
      const { rows } = await client.query(
        `SELECT data_type FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = $1 AND column_name = $2`,
        [cible.table, cible.column]
      );
      if (!rows.length || !needsBooleanRepair(rows[0].data_type)) continue;
      for (const sql of booleanRepairSql(cible)) await client.query(sql);
      console.log(`🛠️  schéma réparé : ${cible.table}.${cible.column} BOOLEAN → INTEGER`);
    } catch (e) {
      // Une réparation ratée ne doit JAMAIS empêcher le serveur de démarrer.
      console.error(`🛠️  réparation impossible ${cible.table}.${cible.column} :`, e.message);
    }
  }
}


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
    await pool.query(`ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS interests TEXT`).catch(() => {});
    // Rattrape les bases créées avant le passage BOOLEAN → INTEGER.
    await repairLegacySchema(pool);
  },

  get: (sql, p) => ops(currentClient()).get(sql, p),
  all: (sql, p) => ops(currentClient()).all(sql, p),
  run: (sql, p) => ops(currentClient()).run(sql, p),

  /**
   * Transaction atomique. Appelable depuis une transaction en cours : on
   * utilise alors un SAVEPOINT sur la même connexion (pas de nouvelle
   * connexion, pas de blocage).
   */
  async tx(fn) {
    const parent = txContext.getStore();
    if (parent) {
      const name = `sp_${++savepointSeq}`;
      await parent.query(`SAVEPOINT ${name}`);
      try {
        const r = await fn(ops(parent));
        await parent.query(`RELEASE SAVEPOINT ${name}`);
        return r;
      } catch (e) {
        await parent.query(`ROLLBACK TO SAVEPOINT ${name}`).catch(() => {});
        throw e;
      }
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const r = await txContext.run(client, () => fn(ops(client)));
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

let savepointSeq = 0;

/** Points d'entrée exposés uniquement pour les tests (aucune connexion). */
module.exports._schema = {
  LEGACY_BOOLEAN_COLUMNS,
  needsBooleanRepair,
  booleanRepairSql,
  repairLegacySchema,
};
