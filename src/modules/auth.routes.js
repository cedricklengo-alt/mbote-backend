/**
 * Module AUTH — inscription/connexion par OTP SMS.
 * En mode démo, le code OTP est renvoyé dans la réponse (pas de SMS réel).
 * En production : brancher un fournisseur SMS (Twilio Verify, Infobip…).
 */
const express = require('express');
const db = require('../db');
const { uid, now, normalizePhone } = require('../util');
const { sign, requireAuth } = require('../middleware/auth');

const r = express.Router();
const DEMO = () => String(process.env.DEMO_MODE || 'true') === 'true';

/* 1) Demander un code OTP */
r.post('/request-otp', (req, res) => {
  const phone = normalizePhone(req.body.phone);
  if (!phone) return res.status(400).json({ error: 'Numéro invalide (format +243…)' });

  const code = String(Math.floor(100000 + Math.random() * 900000));
  db.prepare('INSERT INTO otps(phone, code, expires_at) VALUES(?,?,?) ON CONFLICT(phone) DO UPDATE SET code=?, expires_at=?')
    .run(phone, code, now() + 5 * 60_000, code, now() + 5 * 60_000);

  if (DEMO()) {
    console.log(`📲 [DEMO] OTP pour ${phone} : ${code}`);
    return res.json({ sent: true, demo_code: code }); // visible uniquement en démo
  }
  // PRODUCTION : envoyer le SMS ici, ne JAMAIS renvoyer le code
  return res.json({ sent: true });
});

/* 2) Vérifier le code → compte créé si nouveau → JWT */
r.post('/verify-otp', (req, res) => {
  const phone = normalizePhone(req.body.phone);
  const code = String(req.body.code || '');
  const row = db.prepare('SELECT * FROM otps WHERE phone = ?').get(phone);

  if (!row || row.code !== code) return res.status(401).json({ error: 'Code incorrect' });
  if (row.expires_at < now()) return res.status(401).json({ error: 'Code expiré' });
  db.prepare('DELETE FROM otps WHERE phone = ?').run(phone);

  let user = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
  let isNew = false;
  if (!user) {
    isNew = true;
    const id = uid('u');
    db.prepare('INSERT INTO users(id, phone, name, created_at) VALUES(?,?,?,?)')
      .run(id, phone, req.body.name || '', now());
    db.prepare('INSERT INTO wallets(user_id, balance_cents) VALUES(?, 0)').run(id);
    // 🎁 Bonus de bienvenue : 0,50 $ pour tester
    db.prepare('UPDATE wallets SET balance_cents = balance_cents + 50 WHERE user_id = ?').run(id);
    db.prepare('INSERT INTO transactions(id,user_id,type,amount_cents,method,reference,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(uid('tx'), id, 'bonus', 50, 'system', 'Bonus de bienvenue', now());
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  }
  if (user.status === 'blocked') return res.status(403).json({ error: 'Compte bloqué — contactez le support' });

  const wallet = db.prepare('SELECT * FROM wallets WHERE user_id = ?').get(user.id);
  res.json({
    token: sign(user),
    is_new: isNew,
    user: { id: user.id, phone: user.phone, name: user.name, country: user.country },
    balance_cents: wallet.balance_cents,
  });
});

/* 3) Profil */
r.get('/me', requireAuth, (req, res) => {
  const w = db.prepare('SELECT * FROM wallets WHERE user_id = ?').get(req.user.id);
  res.json({
    user: { id: req.user.id, phone: req.user.phone, name: req.user.name, country: req.user.country },
    balance_cents: w.balance_cents,
    currency: w.currency,
  });
});

r.put('/me', requireAuth, (req, res) => {
  const name = String(req.body.name || '').slice(0, 60);
  db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, req.user.id);
  res.json({ ok: true, name });
});

module.exports = r;
