/**
 * Module AUTH — inscription/connexion par OTP SMS.
 * En mode démo, le code OTP est renvoyé dans la réponse (pas de SMS réel).
 */
const express = require('express');
const db = require('../db');
const { uid, now, normalizePhone, ah } = require('../util');
const { sign, requireAuth } = require('../middleware/auth');
const referral = require('../services/referral');

const r = express.Router();
const DEMO = () => String(process.env.DEMO_MODE || 'true') === 'true';

/* 1) Demander un code OTP */
r.post('/request-otp', ah(async (req, res) => {
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
r.post('/verify-otp', ah(async (req, res) => {
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

module.exports = r;
