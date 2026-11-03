/**
 * Module AUTH — inscription/connexion par OTP SMS.
 * En mode démo, le code OTP est renvoyé dans la réponse (pas de SMS réel).
 */
const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const social = require('../services/social');
const { uid, now, normalizePhone, ah } = require('../util');
const { sign, requireAuth } = require('../middleware/auth');
const referral = require('../services/referral');
const shop = require('../services/shop');
const sms = require('../services/sms');
const { rateLimit } = require('../middleware/ratelimit');

const r = express.Router();
const DEMO = () => String(process.env.DEMO_MODE || 'true') === 'true';
const limitOtpAsk = rateLimit({
  windowMs: 10 * 60_000, max: 4,
  key: (req) => 'otp-ask:' + (normalizePhone(req.body.phone) || req.ip),
  message: 'Trop de demandes de code — patiente 10 minutes puis réessaie',
});
const limitOtpTry = rateLimit({
  windowMs: 10 * 60_000, max: 8,
  key: (req) => 'otp-try:' + (normalizePhone(req.body.phone) || req.ip),
  message: 'Trop d’essais — patiente 10 minutes puis réessaie',
});
const pinAttempts = new Map();
const limitPinAsk = rateLimit({
  windowMs: 10 * 60_000, max: 3,
  key: (req) => 'pin-ask:' + (req.user?.id || req.ip),
  message: 'Trop de demandes — patiente 10 minutes puis réessaie',
});

/* 1) Demander un code OTP */
r.post('/request-otp', limitOtpAsk, ah(async (req, res) => {
  const phone = normalizePhone(req.body.phone);
  if (!phone) return res.status(400).json({ error: 'Numéro invalide (format +243…)' });
  if (!DEMO() && !sms.enabled())
    return res.status(503).json({ error: 'Envoi SMS non configuré sur le serveur' });

  const code = String(crypto.randomInt(100000, 1000000));
  const expires = now() + 5 * 60_000;
  await db.run(
    'INSERT INTO otps(phone, code, expires_at) VALUES(?,?,?) ON CONFLICT(phone) DO UPDATE SET code=?, expires_at=?',
    [phone, code, expires, code, expires]
  );

  // 🧪 DEMO_MODE : on n'envoie AUCUN SMS réel. Sans ce court-circuit, un
  // crédit SMS épuisé (ou un sender refusé) renvoyait 502 à tout le monde et
  // bloquait la connexion — même en démonstration.
  if (DEMO()) {
    console.log(`📲 [DEMO] OTP pour ${phone} : ${code}`);
    return res.json({ sent: true, demo_code: code });
  }
  if (sms.enabled()) {
    const result = await sms.sendSms(phone, `MboteCall : ton code est ${code}. Valable 5 min. Ne le partage jamais.`);
    if (!result.ok) return res.status(502).json({ error: 'SMS non envoyé — vérifie le numéro et réessaie' });
  }
  res.json({ sent: true });
}));

/* 2) Vérifier le code → compte créé si nouveau → JWT */
r.post('/verify-otp', limitOtpTry, ah(async (req, res) => {
  const phone = normalizePhone(req.body.phone);
  const code = String(req.body.code || '');
  if (!phone || !/^\d{6}$/.test(code)) return res.status(400).json({ error: 'Numéro ou code invalide' });
  const row = await db.get('SELECT * FROM otps WHERE phone = ?', [phone]);

  if (!row || row.code !== code) return res.status(401).json({ error: 'Code incorrect' });
  if (row.expires_at < now()) return res.status(401).json({ error: 'Code expiré' });
  await db.run('DELETE FROM otps WHERE phone = ?', [phone]);

  let user = await db.get('SELECT * FROM users WHERE phone = ?', [phone]);
  let isNew = false;
  if (!user) {
    isNew = true;
    const name = String(req.body.name || '').trim();
    if (name.length > 60) return res.status(400).json({ error: 'Le nom ne peut pas dépasser 60 caractères' });
    const id = uid('u');
    await db.tx(async (t) => {
      await t.run('INSERT INTO users(id, phone, name, created_at) VALUES(?,?,?,?)',
        [id, phone, name, now()]);
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

  await shop.claimGiftPlans(user.id, user.phone);

  const wallet = await db.get('SELECT * FROM wallets WHERE user_id = ?', [user.id]);
  res.json({
    token: sign(user),
    is_new: isNew,
    // `handle` : identifiant public (@cedrick), attribué ici s'il manque encore
    // — un compte neuf est immédiatement mentionnable.
    user: {
      id: user.id, phone: user.phone, name: user.name, country: user.country,
      avatar: user.avatar || null,
      handle: await social.handleDe(user.id),
    },
    balance_cents: wallet.balance_cents,
  });
}));

/* Réinitialisation du verrou PIN local après vérification SMS dédiée. */
r.post('/pin-reset/request', requireAuth, limitPinAsk, ah(async (req, res) => {
  const state = pinAttempts.get(req.user.phone);
  if (state?.lockUntil > now())
    return res.status(429).json({ error: 'Réinitialisation bloquée après 3 codes faux — réessaie dans 30 minutes' });
  if (!DEMO() && !sms.enabled())
    return res.status(503).json({ error: 'Envoi SMS non configuré sur le serveur' });
  const code = String(crypto.randomInt(100000, 1000000));
  const expires = now() + 5 * 60_000;
  if (sms.enabled()) {
    const result = await sms.sendSms(req.user.phone,
      `MboteCall : code de réinitialisation PIN ${code}. Valable 5 min. Si ce n’est pas toi, ignore ce message.`);
    if (!result.ok) return res.status(502).json({ error: 'SMS non envoyé — réessaie dans un instant' });
  }
  await db.run(
    'INSERT INTO otps(phone,code,expires_at) VALUES(?,?,?) ON CONFLICT(phone) DO UPDATE SET code=?,expires_at=?',
    ['pin:' + req.user.phone, code, expires, code, expires],
  );
  if (DEMO()) console.log(`🔐 [DEMO] Code de réinitialisation PIN pour ${req.user.phone} : ${code}`);
  res.json({ sent: true });
}));

r.post('/pin-reset/verify', requireAuth, ah(async (req, res) => {
  const phone = req.user.phone;
  const state = pinAttempts.get(phone) || { count: 0, lockUntil: 0 };
  if (state.lockUntil > now())
    return res.status(429).json({ error: 'Réinitialisation bloquée — réessaie dans 30 minutes' });
  const code = String(req.body.code || '');
  if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: 'Code invalide' });
  const row = await db.get('SELECT code,expires_at FROM otps WHERE phone=?', ['pin:' + phone]);
  if (!row || row.expires_at < now())
    return res.status(401).json({ error: 'Code expiré — redemande un code' });
  if (row.code !== code) {
    state.count += 1;
    if (state.count >= 3) {
      state.count = 0;
      state.lockUntil = now() + 30 * 60_000;
      await db.run('DELETE FROM otps WHERE phone=?', ['pin:' + phone]);
      pinAttempts.set(phone, state);
      return res.status(429).json({ error: '3 codes faux — réinitialisation bloquée 30 minutes' });
    }
    pinAttempts.set(phone, state);
    return res.status(401).json({ error: `Code incorrect — il reste ${3 - state.count} essai(s)` });
  }
  await db.run('DELETE FROM otps WHERE phone=?', ['pin:' + phone]);
  pinAttempts.delete(phone);
  res.json({ ok: true });
}));

/* 3) Profil */
r.get('/me', requireAuth, ah(async (req, res) => {
  const w = await db.get('SELECT * FROM wallets WHERE user_id = ?', [req.user.id]);
  res.json({
    user: {
      id: req.user.id,
      phone: req.user.phone,
      name: req.user.name,
      country: req.user.country,
      avatar: req.user.avatar || null,
      handle: await social.handleDe(req.user.id),
      presence_visible: req.user.presence_visible !== 0,
      notifications_enabled: req.user.notifications_enabled !== 0,
    },
    balance_cents: w?.balance_cents ?? 0,
    currency: w?.currency || 'USD',
  });
}));

r.put('/me', requireAuth, ah(async (req, res) => {
  const fields = [];
  const params = [];
  if (Object.prototype.hasOwnProperty.call(req.body, 'name')) {
    const name = String(req.body.name ?? '').trim();
    if (name.length < 2 || name.length > 60)
      return res.status(400).json({ error: 'Le nom doit contenir de 2 à 60 caractères' });
    fields.push('name = ?');
    params.push(name);
  }
  if (Object.prototype.hasOwnProperty.call(req.body, 'avatar')) {
    const avatar = String(req.body.avatar ?? '');
    if (avatar && (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/.test(avatar) || avatar.length > 420000))
      return res.status(400).json({ error: 'Photo invalide ou trop volumineuse' });
    fields.push('avatar = ?');
    params.push(avatar || null);
  }
  if (Object.prototype.hasOwnProperty.call(req.body, 'presence_visible')) {
    if (typeof req.body.presence_visible !== 'boolean')
      return res.status(400).json({ error: 'Préférence de présence invalide' });
    fields.push('presence_visible = ?');
    params.push(req.body.presence_visible ? 1 : 0);
  }
  if (Object.prototype.hasOwnProperty.call(req.body, 'notifications_enabled')) {
    if (typeof req.body.notifications_enabled !== 'boolean')
      return res.status(400).json({ error: 'Préférence de notification invalide' });
    fields.push('notifications_enabled = ?');
    params.push(req.body.notifications_enabled ? 1 : 0);
  }
  if (!fields.length) return res.status(400).json({ error: 'Aucune modification reçue' });
  params.push(req.user.id);
  await db.run(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, params);
  res.json({ ok: true });
}));

/* Jetons push par appareil. Un jeton vide déconnecte tous les appareils du compte. */
r.post('/fcm-token', requireAuth, ah(async (req, res) => {
  const token = String(req.body.token || '').trim();
  if (!token) {
    await db.run('DELETE FROM device_tokens WHERE user_id = ?', [req.user.id]);
    return res.json({ ok: true, removed: true });
  }
  if (token.length > 4096 || /\s/.test(token))
    return res.status(400).json({ error: 'Jeton de notification invalide' });
  await db.run(
    `INSERT INTO device_tokens(token, user_id, updated_at) VALUES(?,?,?)
     ON CONFLICT(token) DO UPDATE SET user_id=excluded.user_id, updated_at=excluded.updated_at`,
    [token, req.user.id, now()],
  );
  res.json({ ok: true });
}));

r.delete('/fcm-token', requireAuth, ah(async (req, res) => {
  const token = String(req.query.token || '').trim();
  if (!token) return res.status(400).json({ error: 'Jeton de notification requis' });
  await db.run('DELETE FROM device_tokens WHERE token=? AND user_id=?', [token, req.user.id]);
  res.json({ ok: true });
}));

module.exports = r;
