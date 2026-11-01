/** Module PARRAINAGE — « Invitez vos proches, gagnez 1 $ chacun ». */
const express = require('express');
const db = require('../db');
const { ah, normalizePhone } = require('../util');
const { requireAuth } = require('../middleware/auth');
const { rateLimit } = require('../middleware/ratelimit');
const referral = require('../services/referral');
const sms = require('../services/sms');

const r = express.Router();

// 🛡️ Un SMS part vers un numéro choisi par l'appelant : sans plafond, la
// route devient un outil d'inondation. 5 invitations par heure et par compte.
const inviteRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  key: (req) => `invite|${req.user?.id || req.ip}`,
  message: 'Trop d’invitations envoyées — réessaie dans une heure',
});

/* Mon code + mes statistiques de parrainage */
r.get('/', requireAuth, ah(async (req, res) => {
  res.json(await referral.stats(req.user.id));
}));

/* Invitation par SMS, avec mon code de parrainage */
r.post('/invite', requireAuth, inviteRateLimit, ah(async (req, res) => {
  const phone = normalizePhone(req.body.phone);
  if (!phone) return res.status(400).json({ error: 'Numéro invalide' });
  if (phone === req.user.phone)
    return res.status(400).json({ error: 'Vous ne pouvez pas vous inviter vous-même' });

  // Déjà inscrit : pas d'invitation à envoyer
  const existing = await db.get('SELECT id FROM users WHERE phone = ?', [phone]);
  if (existing)
    return res.status(409).json({ error: 'Ce numéro utilise déjà MboteCall' });

  const code = await referral.ensureCode(req.user.id);
  const inviter = req.user.name || req.user.phone;
  const message =
    `${inviter} vous invite sur MboteCall : appels et messages gratuits ` +
    `entre utilisateurs. Code parrain ${code} — vous gagnez tous les deux 1 $.`;

  const sent = await sms.sendSms(phone, message);
  res.json({
    ok: sent.ok,
    code,
    sms: sent.ok ? 'envoyé' : (sms.enabled() ? 'échec' : 'non configuré'),
  });
}));

module.exports = r;
