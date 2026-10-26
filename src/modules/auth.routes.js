/**
 * Module AUTH — inscription/connexion par OTP SMS.
 * En mode démo, le code OTP est renvoyé dans la réponse (pas de SMS réel).
 */
const express = require('express');
const db = require('../db');
const { uid, now, normalizePhone, ah } = require('../util');
const { sign, requireAuth } = require('../middleware/auth');
const { rateLimit } = require('../middleware/ratelimit');
const referral = require('../services/referral');

const r = express.Router();
const DEMO = () => String(process.env.DEMO_MODE || 'true') === 'true';

/* 🛡️ Anti-abus : un même numéro ne peut pas demander un code en boucle,
 * ni essayer des codes en rafale (force brute). */
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

  const code = String(Math.floor(100000 + Math.random() * 900000));
  await db.run(
    'INSERT INTO otps(phone, code, expires_at) VALUES(?,?,?) ON CONFLICT(phone) DO UPDATE SET code=?, expires_at=?',
    [phone, code, now() + 5 * 60_000, code, now() + 5 * 60_000]
  );

  if (DEMO()) {
    console.log(`📲 [DEMO] OTP pour ${phone} : ${code}`);
    return res.json({ sent: true, demo_code: code });
  }
  // PRODUCTION : envoyer le SMS ici, ne JAMAIS renvoyer le code
  return res.json({ sent: true });
}));

/* 2) Vérifier le code → compte créé si nouveau → JWT */
r.post('/verify-otp', limitOtpTry, ah(async (req, res) => {
  const phone = normalizePhone(req.body.phone);
  const code = String(req.body.code || '');
  const row = await db.get('SELECT * FROM otps WHERE phone = ?', [phone]);

  if (!row || row.code !== code) return res.status(401).json({ error: 'Code incorrect' });
  if (row.expires_at < now()) return res.status(401).json({ error: 'Code expiré' });
  await db.run('DELETE FROM otps WHERE phone = ?', [phone]);

  let user = await db.get('SELECT * FROM users WHERE phone = ?', [phone]);
  let isNew = false;
  if (!user) {
    isNew = true;
    const id = uid('u');
    await db.tx(async (t) => {
      await t.run('INSERT INTO users(id, phone, name, created_at) VALUES(?,?,?,?)',
        [id, phone, req.body.name || '', now()]);
      // 🎁 Bonus de bienvenue : 0,50 $
      await t.run('INSERT INTO wallets(user_id, balance_cents) VALUES(?, 50)', [id]);
      await t.run(
        'INSERT INTO transactions(id,user_id,type,amount_cents,method,reference,created_at) VALUES(?,?,?,?,?,?,?)',
        [uid('tx'), id, 'bonus', 50, 'system', 'Bonus de bienvenue', now()]
      );
    });
    user = await db.get('SELECT * FROM users WHERE id = ?', [id]);
    // 🤝 Code parrain (facultatif) : lie le compte ; le bonus 1 $ + 1 $
    // sera versé au premier appel facturé du filleul (anti-fraude)
    if (req.body.referral_code) await referral.linkReferral(id, req.body.referral_code);
  }
  if (user.status === 'blocked') return res.status(403).json({ error: 'Compte bloqué — contactez le support' });

  const wallet = await db.get('SELECT * FROM wallets WHERE user_id = ?', [user.id]);
  res.json({
    token: sign(user),
    is_new: isNew,
    user: { id: user.id, phone: user.phone, name: user.name, country: user.country },
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
    currency: w.currency,
  });
}));

r.put('/me', requireAuth, ah(async (req, res) => {
  if (req.body.name !== undefined) {
    const name = String(req.body.name || '').slice(0, 60);
    await db.run('UPDATE users SET name = ? WHERE id = ?', [name, req.user.id]);
  }
  // 📷 Photo de profil : data-URI compressée côté app (max ~300 Ko)
  if (req.body.avatar !== undefined) {
    const av = String(req.body.avatar || '');
    if (av && (!av.startsWith('data:image/') || av.length > 400000))
      return res.status(400).json({ error: 'Photo invalide ou trop lourde' });
    await db.run('UPDATE users SET avatar = ? WHERE id = ?', [av || null, req.user.id]);
  }
  res.json({ ok: true });
}));

/* 🔔 Jeton de notification Firebase (appels app fermée)
 * L'app l'envoie après connexion ; le serveur s'en sert pour réveiller
 * ce téléphone quand quelqu'un l'appelle et que l'app est fermée. */
r.post('/fcm-token', requireAuth, ah(async (req, res) => {
  const token = String(req.body.token || '').slice(0, 4096);
  await db.run('UPDATE users SET fcm_token = ? WHERE id = ?',
    [token || null, req.user.id]);
  res.json({ ok: true });
}));

/* ============================================================
 * 🔐 RÉINITIALISATION DU CODE PIN — protocole de sécurité strict
 * ============================================================
 * Seule la PERSONNE HABILITÉE peut réinitialiser :
 *   1. être connecté sur l'appareil (jeton du compte exigé), ET
 *   2. recevoir un code SMS dédié sur le numéro du compte (la SIM) ;
 *   3. code valable 5 minutes, usage unique, 3 essais maximum ;
 *   4. après 3 codes faux → réinitialisation BLOQUÉE 30 minutes ;
 *   5. le code n'est JAMAIS renvoyé dans la réponse de l'API
 *      (même en mode démo : il n'apparaît que dans les journaux) ;
 *   6. chaque étape est journalisée, et le titulaire est averti par
 *      notification quand son PIN a été réinitialisé.
 */
const pinTries = new Map(); // phone → { n, lockUntil }

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
  const code = String(Math.floor(100000 + Math.random() * 900000));
  await db.run(
    'INSERT INTO otps(phone, code, expires_at) VALUES(?,?,?) ON CONFLICT(phone) DO UPDATE SET code=?, expires_at=?',
    ['pin:' + req.user.phone, code, now() + 5 * 60_000, code, now() + 5 * 60_000]);
  // ⚠️ SÉCURITÉ : jamais dans la réponse — journaux serveur uniquement.
  // PRODUCTION : envoyer ce code par SMS ici.
  console.log(`🔐 [SÉCURITÉ] Code réinitialisation PIN pour ${req.user.phone} : ${code} (5 min, 3 essais)`);
  res.json({ sent: true });
}));

r.post('/pin-reset/verify', requireAuth, ah(async (req, res) => {
  const phone = req.user.phone;
  const t = pinTries.get(phone) || { n: 0, lockUntil: 0 };
  if (t.lockUntil > now()) {
    return res.status(429).json({
      error: 'Réinitialisation bloquée — réessaie dans 30 minutes' });
  }
  const row = await db.get('SELECT * FROM otps WHERE phone = ?', ['pin:' + phone]);
  const code = String(req.body.code || '');
  if (!row || row.expires_at < now()) {
    return res.status(401).json({ error: 'Code expiré — redemande un code' });
  }
  if (row.code !== code) {
    t.n++;
    if (t.n >= 3) {
      t.n = 0;
      t.lockUntil = now() + 30 * 60_000;
      pinTries.set(phone, t);
      await db.run('DELETE FROM otps WHERE phone = ?', ['pin:' + phone]);
      console.log(`🔐 [SÉCURITÉ] 3 codes faux — réinitialisation PIN bloquée 30 min pour ${phone}`);
      return res.status(429).json({ error: '3 codes faux — réinitialisation bloquée 30 minutes' });
    }
    pinTries.set(phone, t);
    console.log(`🔐 [SÉCURITÉ] Code PIN faux pour ${phone} (essai ${t.n}/3)`);
    return res.status(401).json({ error: `Code incorrect — il reste ${3 - t.n} essai(s)` });
  }
  // ✅ Personne habilitée confirmée : usage unique + journal + alerte
  await db.run('DELETE FROM otps WHERE phone = ?', ['pin:' + phone]);
  pinTries.delete(phone);
  console.log(`🔐 [SÉCURITÉ] PIN réinitialisé pour ${phone} — ${new Date().toISOString()}`);
  try {
    const push = require('../services/push');
    if (push.enabled() && req.user.fcm_token) {
      push.sendInfoPush(req.user.fcm_token, '🔐 Code PIN réinitialisé',
        'Le verrou de ton app MboteCall vient d\'être réinitialisé. Si ce n\'est pas toi, contacte le support.');
    }
  } catch (_) {}
  res.json({ ok: true });
}));

module.exports = r;
