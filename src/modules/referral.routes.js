/** Module PARRAINAGE — « Invitez vos proches, gagnez 1 $ chacun ».
 *  v2.8 : + POST /invite → SMS d'invitation avec code parrain
 *  (pour les contacts qui n'ont pas encore MboteCall). */
const express = require('express');
const db = require('../db');
const { uid, now, normalizePhone, ah } = require('../util');
const { requireAuth } = require('../middleware/auth');
const referral = require('../services/referral');
const sms = require('../services/sms');

const r = express.Router();

/* Mon code + mes statistiques de parrainage */
r.get('/', requireAuth, ah(async (req, res) => {
  res.json(await referral.stats(req.user.id));
}));

/* 📨 v2.8 : inviter un proche par SMS ordinaire (il n'a pas l'app)
 * Garde-fous : numéro valide · pas soi-même · pas déjà inscrit ·
 * pas de doublon · maximum 20 invitations par jour. */
r.post('/invite', requireAuth, ah(async (req, res) => {
  const phone = normalizePhone(String(req.body.phone || ''));
  if (!phone) {
    return res.status(400).json({ error: 'Numéro invalide (format +243…)' });
  }
  if (phone === req.user.phone) {
    return res.status(400).json({ error: 'C\'est ton propre numéro' });
  }
  const existing = await db.get(`SELECT id FROM users WHERE phone = ?`, [phone]);
  if (existing) {
    return res.status(400).json({ error: 'Ce numéro est déjà sur MboteCall' });
  }
  const dup = await db.get(
    `SELECT id FROM invites WHERE user_id = ? AND phone = ?`,
    [req.user.id, phone]);
  if (dup) {
    return res.status(400).json({ error: 'Invitation déjà envoyée à ce numéro' });
  }
  const cnt = await db.get(
    `SELECT COUNT(*) AS n FROM invites WHERE user_id = ? AND created_at > ?`,
    [req.user.id, now() - 24 * 3600 * 1000]);
  if (Number(cnt && cnt.n) >= 20) {
    return res.status(429).json({ error: 'Limite de 20 invitations par jour atteinte — réessaie demain' });
  }

  const code = await referral.ensureCode(req.user.id);
  // ⚠️ ASCII simple : un emoji ferait basculer le SMS en UCS-2 (2× plus cher)
  const name = (req.user.name || '').replace(/[^\x20-\x7E]/g, '').trim() || 'Un proche';
  const message =
    `${name} t'invite sur MboteCall : appels a la seconde et messages ` +
    `traduits (lingala/francais). Telecharge l'app et entre le code ${code} ` +
    `a l'inscription : 1$ offert a chacun !`;

  let via = 'demo';
  if (sms.enabled()) {
    await sms.sendSms(phone, message);
    via = 'sms';
  } else {
    console.log(`📨 [INVITE démo] ${phone} ← ${message}`);
  }
  await db.run(
    `INSERT INTO invites(id, user_id, phone, created_at) VALUES (?,?,?,?)`,
    [uid(), req.user.id, phone, now()]);
  console.log(`💌 [PARRAINAGE] ${req.user.phone} invite ${phone} (${via})`);
  res.json({ ok: true, via, code });
}));

module.exports = r;
