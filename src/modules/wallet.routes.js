/**
 * Module WALLET — solde, recharges Mobile Money, grand livre.
 *
 * Nouveau flux de recharge (identique au vrai parcours FlexPay) :
 *   1. POST /topup            → paiement 'pending' + USSD Push chez le client
 *   2. GET  /topup/:id/status → l'app interroge toutes les 2 s
 *   3. Le client tape son PIN M-Pesa/Orange/Airtel sur SON téléphone
 *   4. success → solde crédité (+ bonus 10% dès 10 $) | failed → rien débité
 */
const express = require('express');
const db = require('../db');
const { normalizePhone, ah } = require('../util');
const { requireAuth } = require('../middleware/auth');
const { createPayment, pollAndSettle } = require('../services/payments');
const { getPayProvider } = require('../providers/payments');

const r = express.Router();
const METHODS = ['mpesa', 'orange', 'airtel', 'card'];

r.get('/', requireAuth, ah(async (req, res) => {
  const w = await db.get('SELECT * FROM wallets WHERE user_id = ?', [req.user.id]);
  const txs = await db.all(
    'SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 30', [req.user.id]);
  res.json({ balance_cents: w.balance_cents, currency: w.currency, transactions: txs });
}));

/* 1) Lancer une recharge : crée le paiement + déclenche le USSD Push */
r.post('/topup', requireAuth, ah(async (req, res) => {
  const amount = Math.round(Number(req.body.amount_cents));
  const method = String(req.body.method || '');
  // Numéro Mobile Money payeur : celui fourni, sinon le numéro du compte
  const phone = normalizePhone(req.body.phone) || req.user.phone;

  if (!Number.isFinite(amount) || amount < 100 || amount > 50_000)
    return res.status(400).json({ error: 'Montant entre 1 $ et 500 $' });
  if (!METHODS.includes(method))
    return res.status(400).json({ error: 'Moyen de paiement inconnu' });

  let payment;
  try {
    payment = await createPayment({ userId: req.user.id, amountCents: amount, method, phone });
  } catch (e) {
    console.error('💥 Échec initiation paiement :', e.message);
    return res.status(502).json({ error: 'Le service de paiement est indisponible — réessayez' });
  }

  res.json({
    payment_id: payment.id,
    status: 'pending',
    provider: getPayProvider().name,
    message: `Confirmez le paiement sur le téléphone ${phone} (tapez votre code PIN ${method === 'mpesa' ? 'M-Pesa' : method === 'orange' ? 'Orange Money' : method === 'airtel' ? 'Airtel Money' : ''})`,
  });
}));

/* 2) Suivi du paiement (l'app interroge toutes les 2 s) */
r.get('/topup/:id/status', requireAuth, ah(async (req, res) => {
  const payment = await db.get('SELECT * FROM payments WHERE id = ? AND user_id = ?',
    [req.params.id, req.user.id]);
  if (!payment) return res.status(404).json({ error: 'Paiement introuvable' });

  const state = await pollAndSettle(payment);
  const p = await db.get('SELECT * FROM payments WHERE id = ?', [payment.id]);
  const w = await db.get('SELECT balance_cents FROM wallets WHERE user_id = ?', [req.user.id]);

  res.json({
    status: state,                      // pending | success | failed
    amount_cents: p.amount_cents,
    bonus_cents: p.bonus_cents,
    credited_cents: state === 'success' ? p.amount_cents + p.bonus_cents : 0,
    balance_cents: w.balance_cents,
  });
}));

/* 3) 💸 Transfert de crédit MBOTE → MBOTE (le différenciateur diaspora) */
r.post('/transfer', requireAuth, ah(async (req, res) => {
  const toPhone = normalizePhone(req.body.to_phone);
  const amount = Math.round(Number(req.body.amount_cents));

  if (!toPhone) return res.status(400).json({ error: 'Numéro du bénéficiaire invalide' });
  if (toPhone === req.user.phone) return res.status(400).json({ error: 'Impossible de s\'envoyer du crédit à soi-même' });
  if (!Number.isFinite(amount) || amount < 50 || amount > 50_000)
    return res.status(400).json({ error: 'Montant entre 0,50 $ et 500 $' });

  const dest = await db.get(`SELECT id, name, phone, status FROM users WHERE phone = ? AND role = 'user'`, [toPhone]);
  if (!dest) return res.status(404).json({ error: 'Ce numéro n\'a pas encore de compte MBOTE! — invitez-le avec votre code parrain 🎁' });
  if (dest.status === 'blocked') return res.status(403).json({ error: 'Le compte du bénéficiaire est bloqué' });

  const { uid: mkId, now: ts } = require('../util');
  const result = await db.tx(async (t) => {
    // Débit ATOMIQUE : échoue si le solde est insuffisant (pas de découvert possible)
    const deb = await t.get(
      'UPDATE wallets SET balance_cents = balance_cents - ? WHERE user_id = ? AND balance_cents >= ? RETURNING balance_cents',
      [amount, req.user.id, amount]);
    if (!deb) return null;

    await t.run('UPDATE wallets SET balance_cents = balance_cents + ? WHERE user_id = ?', [amount, dest.id]);
    await t.run(
      'INSERT INTO transactions(id,user_id,type,amount_cents,method,reference,created_at) VALUES(?,?,?,?,?,?,?)',
      [mkId('tx'), req.user.id, 'transfer_out', -amount, 'wallet', `Envoyé à ${dest.name || dest.phone}`, ts()]);
    await t.run(
      'INSERT INTO transactions(id,user_id,type,amount_cents,method,reference,created_at) VALUES(?,?,?,?,?,?,?)',
      [mkId('tx'), dest.id, 'transfer_in', amount, 'wallet', `Reçu de ${req.user.name || req.user.phone}`, ts()]);
    return deb.balance_cents;
  });

  if (result === null)
    return res.status(402).json({ error: 'Solde insuffisant pour ce transfert' });

  res.json({
    ok: true,
    sent_cents: amount,
    to: { name: dest.name, phone: dest.phone },
    balance_cents: result,
  });
}));

/* 4) Historique des recharges */
r.get('/payments', requireAuth, ah(async (req, res) => {
  res.json(await db.all(
    `SELECT id, amount_cents, bonus_cents, method, phone, status, reference, created_at
     FROM payments WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`, [req.user.id]));
}));

module.exports = r;
