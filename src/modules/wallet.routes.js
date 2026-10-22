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

/* 3) Historique des recharges */
r.get('/payments', requireAuth, ah(async (req, res) => {
  res.json(await db.all(
    `SELECT id, amount_cents, bonus_cents, method, phone, status, reference, created_at
     FROM payments WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`, [req.user.id]));
}));

module.exports = r;
