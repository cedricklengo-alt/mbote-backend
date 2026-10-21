/**
 * Module WALLET — solde, recharges, grand livre.
 * En mode démo, le paiement Mobile Money aboutit instantanément.
 * En production : intégrer l'agrégateur (Flutterwave, CinetPay…) avec
 * webhook de confirmation AVANT de créditer.
 */
const express = require('express');
const db = require('../db');
const { uid, now } = require('../util');
const { requireAuth } = require('../middleware/auth');

const r = express.Router();
const METHODS = ['mpesa', 'orange', 'airtel', 'card'];

r.get('/', requireAuth, (req, res) => {
  const w = db.prepare('SELECT * FROM wallets WHERE user_id = ?').get(req.user.id);
  const txs = db.prepare('SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 30').all(req.user.id);
  res.json({ balance_cents: w.balance_cents, currency: w.currency, transactions: txs });
});

r.post('/topup', requireAuth, (req, res) => {
  const amount = Math.round(Number(req.body.amount_cents));
  const method = String(req.body.method || '');
  if (!Number.isFinite(amount) || amount < 100 || amount > 50_000)
    return res.status(400).json({ error: 'Montant entre 1 $ et 500 $' });
  if (!METHODS.includes(method))
    return res.status(400).json({ error: 'Moyen de paiement inconnu' });

  // 🎁 Promo : +10% offerts dès 10 $
  const bonus = amount >= 1000 ? Math.round(amount * 0.10) : 0;

  const credit = db.transaction(() => {
    db.prepare('INSERT INTO transactions(id,user_id,type,amount_cents,method,reference,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(uid('tx'), req.user.id, 'topup', amount, method, 'Recharge ' + method, now());
    if (bonus > 0)
      db.prepare('INSERT INTO transactions(id,user_id,type,amount_cents,method,reference,created_at) VALUES(?,?,?,?,?,?,?)')
        .run(uid('tx'), req.user.id, 'bonus', bonus, 'system', 'Bonus +10%', now());
    db.prepare('UPDATE wallets SET balance_cents = balance_cents + ? WHERE user_id = ?')
      .run(amount + bonus, req.user.id);
  });
  credit();

  const w = db.prepare('SELECT balance_cents FROM wallets WHERE user_id = ?').get(req.user.id);
  res.json({ ok: true, credited_cents: amount + bonus, bonus_cents: bonus, balance_cents: w.balance_cents });
});

module.exports = r;
