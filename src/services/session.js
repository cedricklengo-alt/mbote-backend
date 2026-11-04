/**
 * Service SESSION — sessions persistantes, appareils, audit, refresh tokens.
 *
 * Une session = un jeton d'accès JWT (30 j) + un refresh token opaque stocké
 * (hashé) en base. La rotation du refresh token invalide l'ancienne session :
 * un refresh token volé ne peut être rejoué qu'une fois.
 */
const crypto = require('crypto');
const db = require('../db');
const { uid, now } = require('../util');
const { sign } = require('../middleware/auth');

const REFRESH_TTL_MS = 30 * 24 * 3600 * 1000; // 30 jours, aligné sur le JWT
const MAX_DEVICES_WARN = 5; // au-delà : alerte fraude « multi-appareils » (audit)

function hashToken(t) {
  return crypto.createHash('sha256').update(String(t)).digest('hex');
}

/** Journal d'audit (traçabilité sécurité). */
async function audit(userId, action, meta = {}, req = null) {
  try {
    await db.run(
      `INSERT INTO audit_logs(id, user_id, action, ip, user_agent, meta, created_at)
       VALUES(?,?,?,?,?,?,?)`,
      [uid('a'), userId || null, action,
       req?.ip || null, req ? String(req.headers['user-agent'] || '').slice(0, 255) : null,
       JSON.stringify(meta).slice(0, 2000), now()]
    );
  } catch (e) {
    console.error('audit_logs indisponible:', e.message); // non bloquant
  }
}

/** Enregistre / met à jour l'appareil utilisé. */
async function registerDevice(userId, device, req) {
  if (!device) return;
  const deviceId = String(device.device_id || device.id || '').slice(0, 120);
  if (!deviceId) return;
  await db.run(
    `INSERT INTO devices(id, user_id, device_id, platform, model, app_version, fcm_token, last_seen_at, created_at)
     VALUES(?,?,?,?,?,?,?,?,?)
     ON CONFLICT(user_id, device_id) DO UPDATE SET
       platform=excluded.platform, model=excluded.model, app_version=excluded.app_version,
       fcm_token=COALESCE(excluded.fcm_token, devices.fcm_token), last_seen_at=excluded.last_seen_at`,
    [uid('d'), userId, deviceId,
     String(device.platform || '').slice(0, 20),
     String(device.model || '').slice(0, 120),
     String(device.app_version || '').slice(0, 40),
     device.fcm_token ? String(device.fcm_token).slice(0, 500) : null,
     now(), now()]
  );
  // 🕵️ Détection multi-appareils anormale : alerte audit, non bloquante.
  const c = await db.get('SELECT COUNT(*) AS n FROM devices WHERE user_id = ?', [userId]);
  if ((c?.n || 0) > MAX_DEVICES_WARN) {
    await audit(userId, 'multi_device_warning', { devices: c.n }, req);
  }
}

/** Crée une session (login) et renvoie les jetons. */
async function createSession(user, req, meta = {}) {
  const jti = uid('s');
  const refresh = crypto.randomBytes(32).toString('hex');
  const expires = now() + REFRESH_TTL_MS;
  await db.run(
    `INSERT INTO sessions(id, user_id, refresh_hash, user_agent, ip, created_at, last_used_at, expires_at, revoked)
     VALUES(?,?,?,?,?,?,?,?,0)`,
    [jti, user.id, hashToken(refresh),
     String(req?.headers['user-agent'] || '').slice(0, 255),
     req?.ip || null, now(), now(), expires]
  );
  if (meta.device) await registerDevice(user.id, meta.device, req);
  await audit(user.id, meta.isNew ? 'register' : 'login', meta, req);
  return { access_token: sign(user), refresh_token: refresh, session_id: jti, expires_at: expires };
}

/** Rotation du refresh token : l'ancien est révoqué, un nouveau est émis. */
async function rotateRefresh(refreshToken, req) {
  if (!refreshToken) return null;
  const row = await db.get(
    'SELECT * FROM sessions WHERE refresh_hash = ? AND revoked = 0 AND expires_at > ?',
    [hashToken(refreshToken), now()]
  );
  if (!row) return null;
  const user = await db.get('SELECT * FROM users WHERE id = ?', [row.user_id]);
  if (!user || user.status === 'blocked') return null;
  // Révoque l'ancienne session (rotation) puis en crée une nouvelle.
  await db.run('UPDATE sessions SET revoked = 1 WHERE id = ?', [row.id]);
  await audit(user.id, 'token_refresh', { session_id: row.id }, req);
  return createSession(user, req, {});
}

/** Révoque la session associée au refresh token (déconnexion volontaire). */
async function revokeRefresh(refreshToken, userId, req) {
  if (refreshToken) {
    await db.run('UPDATE sessions SET revoked = 1 WHERE refresh_hash = ?', [hashToken(refreshToken)]);
  }
  if (userId) {
    await db.run('UPDATE sessions SET revoked = 1 WHERE user_id = ? AND revoked = 0', [userId]);
    await audit(userId, 'logout', {}, req);
  }
}

module.exports = { createSession, rotateRefresh, revokeRefresh, audit, registerDevice, hashToken, REFRESH_TTL_MS };
