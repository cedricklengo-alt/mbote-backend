/** Module PARRAINAGE — « Invitez vos proches, gagnez 1 $ chacun ». */
const express = require('express');
const db = require('../db');
const { ah, normalizePhone } = require('../util');
const { requireAuth } = require('../middleware/auth');
const { rateLimit } = require('../middleware/ratelimit');
const referral = require('../services/referral');
const sms = require('../services/sms');

const r = express.Router();

/* Mon code + mes statistiques de parrainage */
r.get('/', requireAuth, ah(async (req, res) => {
  res.json(await referral.stats(req.user.id));
}));

/* 📨 v2.8 : inviter un proche par SMS ORDINAIRE (il n'a pas besoin d'Internet
 * pour recevoir l'invitation). Le SMS part du serveur, avec mon code. */
const limitInvite = rateLimit({
  windowMs: 24 * 60 * 60_000, max: 20,
  key: (req) => 'invite:' + (req.user ? req.user.id : req.ip),
  message: 'Beaucoup d\'invitations aujourd\'hui 😅 — réessaie demain',
});

r.post('/invite', requireAuth, limitInvite, ah(async (req, res) => {
  const phone = normalizePhone(req.body.phone);
  if (!phone) return res.status(400).json({ error: 'Numéro invalide (format +243…)' });
  if (phone === req.user.phone) return res.status(400).json({ error: 'C\'est ton propre numéro 😄' });

  const exists = await db.get(
    `SELECT id FROM users WHERE phone = ? AND status = 'active'`, [phone]);
  if (exists) return res.status(400).json({ error: 'Ce proche a déjà MboteCall 🧡 — écris-lui directement !' });

  const code = await referral.ensureCode(req.user.id);
  const name = req.user.name || req.user.phone;
  // SMS volontairement en ASCII simple : 2 segments GSM maximum, lisible partout
  const text = `${name} t'invite sur MboteCall ! Appels gratuits entre membres, `
    + `messages traduits lingala-francais-swahili, tarifs a la seconde vers les GSM. `
    + `Telecharge l'appli et entre le code ${code} a l'inscription : 1 $ offert chacun.`;

  if (sms.enabled()) {
    const envoi = await sms.sendSms(phone, text);
    console.log(`📨 [INVITE] ${req.user.phone} → ${phone} (code ${code})`);
    return res.json({ ok: true, sent: true, provider: envoi || null });
  }
  // Mode démo / SMS non configuré : on confirme quand même (journalisé)
  console.log(`📨 [INVITE][DEMO] SMS à ${phone} : ${text}`);
  res.json({ ok: true, sent: false, demo_text: text });
}));

module.exports = r;
