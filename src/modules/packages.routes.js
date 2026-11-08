/**
 * Module FORFAITS — achat avec le solde du portefeuille.
 *   minutes = 0 → ILLIMITÉ pendant `days` jours.
 */
const express = require('express');
const db = require('../db');
const { uid, now, ah } = require('../util');
const { requireAuth } = require('../middleware/auth');

const r = express.Router();

/* Catalogue public */
r.get('/', ah(async (req, res) => {
  res.json(await db.all('SELECT * FROM packages WHERE active = 1 ORDER BY price_cents'));
}));

/* Mes forfaits actifs */
r.get('/mine', requireAuth, ah(async (req, res) => {
  res.json(await db.all(
    `SELECT id, name, prefix, remaining_sec, unlimited, expires_at
     FROM user_packages
     WHERE user_id = ? AND expires_at > ? AND (unlimited = 1 OR remaining_sec > 0)
     ORDER BY purchased_at DESC`, [req.user.id, now()]));
}));

/* Achat (débité du solde MboteCall) */
r.post('/:id/buy', requireAuth, ah(async (req, res) => {
  const pack = await db.get('SELECT * FROM packages WHERE id = ? AND active = 1', [req.params.id]);
  if (!pack) return res.status(404).json({ error: 'Forfait introuvable' });

  const result = await db.tx(async (t) => {
    const deb = await t.get(
      'UPDATE wallets SET balance_cents = balance_cents - ? WHERE user_id = ? AND balance_cents >= ? RETURNING balance_cents',
      [pack.price_cents, req.user.id, pack.price_cents]);
    if (!deb) return null;

    const id = uid('up');
    await t.run(
      `INSERT INTO user_packages(id,user_id,package_id,name,prefix,remaining_sec,unlimited,expires_at,purchased_at)
       VALUES(?,?,?,?,?,?,?,?,?)`,
      [id, req.user.id, pack.id, pack.name, pack.prefix,
       pack.minutes * 60, pack.minutes === 0 ? 1 : 0,
       now() + pack.days * 86400_000, now()]);
    await t.run(
      'INSERT INTO transactions(id,user_id,type,amount_cents,method,reference,created_at) VALUES(?,?,?,?,?,?,?)',
      [uid('tx'), req.user.id, 'package', -pack.price_cents, 'wallet', pack.name, now()]);
    return deb.balance_cents;
  });

  if (result === null)
    return res.status(402).json({ error: 'Solde insuffisant — recharge ton compte' });
  res.json({ ok: true, name: pack.name, balance_cents: result });
}));

module.exports = r;
