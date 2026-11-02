/**
 * Feature B — Lien d'invitation magique
 *
 * POST /api/invite                     — générer un token d'invitation (requiert auth)
 * GET  /invite/:token                  — redirect vers l'app ou le store (public)
 * GET  /api/invite/validate/:token     — valider un token post-install (requiert auth)
 */
const router = require('express').Router();
const { requireAuth } = require('../middleware/auth');
const db = require('../db');
const referralSvc = require('../services/referral');
const crypto = require('crypto');

const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 jours
const DEEP_LINK_BASE = process.env.APP_DEEP_LINK || 'https://mbote.app';
const ANDROID_PKG    = process.env.ANDROID_PKG   || 'com.mbote.app';
const IOS_URL        = process.env.IOS_URL        || 'https://apps.apple.com/app/mbote/id0';

/* Génère un token sécurisé et le stocke */
router.post('/api/invite', requireAuth, async (req, res) => {
  try {
    const user = req.user;
    const refCode = await referralSvc.ensureCode(user.id);
    const token   = crypto.randomBytes(20).toString('hex');
    const now     = Date.now();
    await db.run(
      // ON CONFLICT plutôt que INSERT OR REPLACE : cette forme est portable
      // SQLite/PostgreSQL, alors que OR REPLACE est propre à SQLite.
      `INSERT INTO invite_tokens (token, user_id, referral_code, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (token) DO UPDATE SET
         user_id = excluded.user_id,
         referral_code = excluded.referral_code,
         created_at = excluded.created_at,
         expires_at = excluded.expires_at`,
      [token, user.id, refCode, now, now + TOKEN_TTL_MS]
    );
    const link = `${DEEP_LINK_BASE}/invite/${token}`;
    res.json({ token, link });
  } catch (e) {
    console.error('invite POST :', e);
    res.status(500).json({ error: 'Erreur interne' });
  }
});

/* Redirect deep-link vers l'app ou le store */
router.get('/:token', async (req, res) => {
  const { token } = req.params;
  const row = await db.get(
    `SELECT * FROM invite_tokens WHERE token = ? AND expires_at > ? AND used_at IS NULL`,
    [token, Date.now()]
  ).catch(() => null);

  if (!row) {
    return res.status(410).send('<h2>Lien expiré ou invalide</h2>');
  }

  // Universal Link / App Link — l'OS ouvre l'app si installée
  // Sinon on redirige vers le store selon le User-Agent
  const ua = req.get('User-Agent') || '';
  const isIos = /iPhone|iPad|iPod/i.test(ua);
  const isAndroid = /Android/i.test(ua);

  const appLink = `mbote://invite/${token}`;
  const storeUrl = isIos ? IOS_URL
    : isAndroid ? `https://play.google.com/store/apps/details?id=${ANDROID_PKG}&referrer=invite_${token}`
    : `${DEEP_LINK_BASE}/invite/${token}`;

  // Page HTML qui tente le deep-link puis redirige vers le store
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html><head><meta charset="utf-8">
<title>Rejoins Mbote!</title>
<meta http-equiv="refresh" content="2;url=${storeUrl}">
<script>
  window.location = ${JSON.stringify(appLink)};
  setTimeout(() => { window.location = ${JSON.stringify(storeUrl)}; }, 1500);
</script>
</head><body style="font-family:sans-serif;text-align:center;padding:40px">
<h2>📲 Ouvrir Mbote!</h2>
<p>Si l'application ne s'ouvre pas, <a href="${storeUrl}">télécharge-la ici</a>.</p>
</body></html>`);
});

/* Valide le token côté Flutter après installation */
router.get('/api/invite/validate/:token', requireAuth, async (req, res) => {
  try {
    const { token } = req.params;
    const row = await db.get(
      `SELECT * FROM invite_tokens WHERE token = ? AND expires_at > ?`,
      [token, Date.now()]
    );
    if (!row) return res.status(404).json({ error: 'Token invalide ou expiré' });

    // Lier le parrainage si pas encore fait
    if (!row.used_at) {
      await referralSvc.linkReferral(req.user.id, row.referral_code).catch(() => {});
      await db.run(`UPDATE invite_tokens SET used_at = ? WHERE token = ?`, [Date.now(), token]);
    }

    res.json({ ok: true, referral_code: row.referral_code });
  } catch (e) {
    console.error('invite validate :', e);
    res.status(500).json({ error: 'Erreur interne' });
  }
});

module.exports = router;
