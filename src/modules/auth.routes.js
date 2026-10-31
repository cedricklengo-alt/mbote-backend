/**
 * Module AUTH — inscription/connexion par OTP SMS.
 *
 * SÉCURITÉ :
 *   • OTP stocké haché (SHA-256 + préfixe applicatif) — jamais en clair en base.
 *   • demo_code n'est JAMAIS inclus dans la réponse quand un SMS réel a été envoyé.
 *   • Rate-limiting anti-abus sur ask et verify.
 */
const crypto  = require('crypto');
const express = require('express');
const db      = require('../db');
const { uid, now, normalizePhone, ah } = require('../util');
const { sign, requireAuth } = require('../middleware/auth');
const { rateLimit } = require('../middleware/ratelimit');
const referral = require('../services/referral');
const sms = require('../services/sms');

const r = express.Router();
const DEMO = () => String(process.env.DEMO_MODE || 'true') === 'true';

// ── B2 : hachage OTP (MASVS MSTG-AUTH-7) ────────────────────────────────────
// Un OTP en clair en base exposerait tous les codes actifs si la DB est compromise.
function hashOtp(code) {
  return crypto.createHash('sha256')
    .update('mbote_otp_v1:' + code)
    .digest('hex');
}

/* 🛡️ Anti-abus */
const limitOtpAsk = rateLimit({
  windowMs: 10 * 60_000, max: 4,
  key: (req) => 'otp-ask:' + (normalizePhone(req.body.phone) || req.ip),
  message: 'Trop de demandes de code — patiente 10 minutes puis réessaie',
});
const limitOtpTry = rateLimit({
  windowMs: 10 * 60_000, max: 8,
  key: (req) => 'otp-try:' + (normalizePhone(req.body.phone) || req.ip),
  message: 'Trop d\'essais — patiente 10 minutes puis réessaie',
});

/* 1) Demander un code OTP */
r.post('/request-otp', limitOtpAsk, ah(async (req, res) => {
  const phone = normalizePhone(req.body.phone);
  if (!phone) return res.status(400).json({ error: 'Numéro invalide (format +243…)' });

  const code     = String(Math.floor(100000 + Math.random() * 900000));
  const codeHash = hashOtp(code);
  const expires  = now() + 5 * 60_000;

  // 🔐 Stocker le hash, jamais le code en clair
  await db.run(
    'INSERT INTO otps(phone, code, expires_at) VALUES(?,?,?) ON CONFLICT(phone) DO UPDATE SET code=?, expires_at=?',
    [phone, codeHash, expires, codeHash, expires]
  );

  // 📲 SMS réel via Africa's Talking
  if (sms.enabled()) {
    const envoi = await sms.sendSms(phone,
      `MboteCall: ton code est ${code}. Valable 5 min. Ne le partage jamais.`);

    if (!envoi.ok && !DEMO()) {
      return res.status(502).json({ error: 'SMS non envoyé — vérifie le numéro et réessaie dans un instant' });
    }

    // ── B3 : demo_code JAMAIS renvoyé quand le SMS réel a été envoyé ──────────
    // En démo, on renvoie le code SEULEMENT si le SMS n'est pas parti (pas de vraie SIM)
    if (DEMO() && !envoi.ok) {
      console.log(`📲 [DEMO] OTP pour ${phone} : ${code} (SMS réel : échec)`);
      return res.json({ sent: true, demo_code: code });
    }

    // SMS envoyé avec succès : le code ne sort JAMAIS de l'API
    console.log(`📲 OTP envoyé par SMS à ${phone}`);
    return res.json({ sent: true });
  }

  // Aucun canal SMS configuré
  if (DEMO()) {
    console.log(`📲 [DEMO] OTP pour ${phone} : ${code}`);
    return res.json({ sent: true, demo_code: code });
  }
  return res.status(503).json({
    error: 'Envoi SMS non configuré sur le serveur (variables AT_USERNAME / AT_API_KEY)',
  });
}));

/* 2) Vérifier le code → compte créé si nouveau → JWT */
r.post('/verify-otp', limitOtpTry, ah(async (req, res) => {
  const phone = normalizePhone(req.body.phone);
  const code  = String(req.body.code || '');
  const row   = await db.get('SELECT * FROM otps WHERE phone = ?', [phone]);

  // 🔐 Comparer avec le hash — jamais le code brut
  if (!row || row.code !== hashOtp(code))
    return res.status(401).json({ error: 'Code incorrect' });
  if (row.expires_at < now())
    return res.status(401).json({ error: 'Code expiré' });

  await db.run('DELETE FROM otps WHERE phone = ?', [phone]);

  let user = await db.get('SELECT * FROM users WHERE phone = ?', [phone]);
  let isNew = false;
  if (!user) {
    isNew = true;
    const id = uid('u');
    await db.tx(async (t) => {
      await t.run('INSERT INTO users(id, phone, name, created_at) VALUES(?,?,?,?)',
        [id, phone, req.body.name || '', now()]);
      await t.run('INSERT INTO wallets(user_id, balance_cents) VALUES(?, 50)', [id]);
      await t.run(
        'INSERT INTO transactions(id,user_id,type,amount_cents,method,reference,created_at) VALUES(?,?,?,?,?,?,?)',
        [uid('tx'), id, 'bonus', 50, 'system', 'Bonus de bienvenue', now()]
      );
    });
    user = await db.get('SELECT * FROM users WHERE id = ?', [id]);
    if (req.body.referral_code) await referral.linkReferral(id, req.body.referral_code);
  }
  if (user.status === 'blocked')
    return res.status(403).json({ error: 'Compte bloqué — contactez le support' });

  const wallet = await db.get('SELECT * FROM wallets WHERE user_id = ?', [user.id]);
  res.json({
    token:         sign(user),
    is_new:        isNew,
    user:          { id: user.id, phone: user.phone, name: user.name, country: user.country },
    balance_cents: wallet.balance_cents,
  });
}));

/* 3) Profil */
r.get('/me', requireAuth, ah(async (req, res) => {
  const w = await db.get('SELECT * FROM wallets WHERE user_id = ?', [req.user.id]);
  res.json({
    user: {
      id: req.user.id, phone: req.user.phone, name: req.user.name,
      country: req.user.country, avatar: req.user.avatar || null,
    },
    balance_cents: w.balance_cents,
    currency:      w.currency,
  });
}));

r.put('/me', requireAuth, ah(async (req, res) => {
  if (req.body.name !== undefined) {
    const name = String(req.body.name || '').slice(0, 60);
    await db.run('UPDATE users SET name = ? WHERE id = ?', [name, req.user.id]);
  }
  if (req.body.avatar !== undefined) {
    const av = String(req.body.avatar || '');
    if (av && (!av.startsWith('data:image/') || av.length > 400000))
      return res.status(400).json({ error: 'Photo invalide ou trop lourde' });
    await db.run('UPDATE users SET avatar = ? WHERE id = ?', [av || null, req.user.id]);
  }
  res.json({ ok: true });
}));

/* 🔔 Jeton FCM */
r.post('/fcm-token', requireAuth, ah(async (req, res) => {
  const token = String(req.body.token || '').slice(0, 4096);
  if (token) {
    await db.run('UPDATE users SET fcm_token = NULL WHERE fcm_token = ? AND id != ?',
      [token, req.user.id]);
  }
  await db.run('UPDATE users SET fcm_token = ? WHERE id = ?', [token || null, req.user.id]);
  // Ne pas logger le jeton FCM complet (données sensibles du téléphone)
  console.log(`📲 [PUSH] FCM token ${token ? 'enregistré' : 'effacé'} pour ${req.user.phone}`);
  res.json({ ok: true });
}));

/* ============================================================
 * 🔐 RÉINITIALISATION DU CODE PIN
 * ============================================================
 */
const pinTries = new Map();

const limitPinReset = rateLimit({
  windowMs: 10 * 60_000, max: 3,
  key: (req) => 'pin-reset:' + (req.user ? req.user.phone : req.ip),
  message: 'Trop de demandes — patiente 10 minutes puis réessaie',
});

r.post('/pin-reset/request', requireAuth, limitPinReset, ah(async (req, res) => {
  const lock = pinTries.get(req.user.phone);
  if (lock && lock.lockUntil > now()) {
    return res.status(429).json({
      error: 'Réinitialisation bloquée après 3 codes faux — réessaie dans 30 minutes' });
  }
  const code     = String(Math.floor(100000 + Math.random() * 900000));
  const codeHash = hashOtp('pin:' + code);
  const expires  = now() + 5 * 60_000;
  await db.run(
    'INSERT INTO otps(phone, code, expires_at) VALUES(?,?,?) ON CONFLICT(phone) DO UPDATE SET code=?, expires_at=?',
    ['pin:' + req.user.phone, codeHash, expires, codeHash, expires]);

  // ⚠️ Le code n'apparaît JAMAIS dans la réponse API
  if (sms.enabled()) {
    const envoi = await sms.sendSms(req.user.phone,
      `MboteCall: code de reinitialisation PIN ${code}. Valable 5 min. Si ce n'est pas toi, ignore ce message.`);
    if (!DEMO() && !envoi.ok) {
      return res.status(502).json({ error: 'SMS non envoyé — réessaie dans un instant' });
    }
  }
  // Journaux uniquement (jamais dans la réponse)
  if (DEMO() || !sms.enabled()) {
    console.log(`🔐 [SÉCURITÉ][DEMO] Code réinitialisation PIN pour ${req.user.phone} : ${code}`);
  }
  res.json({ sent: true });
}));

r.post('/pin-reset/verify', requireAuth, ah(async (req, res) => {
  const phone = req.user.phone;
  const t     = pinTries.get(phone) || { n: 0, lockUntil: 0 };
  if (t.lockUntil > now()) {
    return res.status(429).json({ error: 'Réinitialisation bloquée — réessaie dans 30 minutes' });
  }
  const row  = await db.get('SELECT * FROM otps WHERE phone = ?', ['pin:' + phone]);
  const code = String(req.body.code || '');
  if (!row || row.expires_at < now()) {
    return res.status(401).json({ error: 'Code expiré — redemande un code' });
  }
  // 🔐 Comparer avec le hash du code reçu
  if (row.code !== hashOtp('pin:' + code)) {
    t.n++;
    if (t.n >= 3) {
      t.n = 0;
      t.lockUntil = now() + 30 * 60_000;
      pinTries.set(phone, t);
      await db.run('DELETE FROM otps WHERE phone = ?', ['pin:' + phone]);
      console.log(`🔐 [SÉCURITÉ] 3 codes faux — reset PIN bloqué 30 min pour ${phone}`);
      return res.status(429).json({ error: '3 codes faux — réinitialisation bloquée 30 minutes' });
    }
    pinTries.set(phone, t);
    return res.status(401).json({ error: `Code incorrect — il reste ${3 - t.n} essai(s)` });
  }
  await db.run('DELETE FROM otps WHERE phone = ?', ['pin:' + phone]);
  pinTries.delete(phone);
  console.log(`🔐 [SÉCURITÉ] PIN réinitialisé pour ${phone} — ${new Date().toISOString()}`);
  try {
    const push = require('../services/push');
    if (push.enabled() && req.user.fcm_token) {
      push.sendInfoPush(req.user.fcm_token, 'Code PIN réinitialisé',
        'Le verrou de ton app MboteCall vient d\'être réinitialisé. Si ce n\'est pas toi, contacte le support.');
    }
  } catch (_) {}
  res.json({ ok: true });
}));

module.exports = r;
