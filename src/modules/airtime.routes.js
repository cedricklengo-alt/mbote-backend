/**
 * Module AIRTIME — offrir du crédit GSM (Vodacom/Orange/Airtel…) à un proche.
 * Débit du portefeuille MBOTE! → envoi via l'agrégateur (démo ⇄ Reloadly).
 * En cas d'échec de l'opérateur : REMBOURSEMENT automatique.
 */
const express = require('express');
const db = require('../db');
const { uid, now, normalizePhone, ah } = require('../util');
const { requireAuth } = require('../middleware/auth');
const { getAirtimeProvider, detectOperator } = require('../providers/airtime');

const r = express.Router();

r.post('/', requireAuth, ah(async (req, res) => {
  const phone = normalizePhone(req.body.phone);
  const amount = Math.round(Number(req.body.amount_cents));
  if (!phone) return res.status(400).json({ error: 'Numéro invalide (format +243…)' });
  if (!Number.isFinite(amount) || amount < 100 || amount > 10_000)
    return res.status(400).json({ error: 'Montant entre 1 $ et 100 $' });

  const provider = getAirtimeProvider();
  const operator = detectOperator(phone);
  const id = uid('air');

  // 1. Débit ATOMIQUE du portefeuille + enregistrement 'pending'
  const debited = await db.tx(async (t) => {
    const deb = await t.get(
      'UPDATE wallets SET balance_cents = balance_cents - ? WHERE user_id = ? AND balance_cents >= ? RETURNING balance_cents',
      [amount, req.user.id, amount]);
    if (!deb) return null;
    await t.run(
      `INSERT INTO airtime_topups(id,user_id,phone,operator,amount_cents,status,provider,created_at)
       VALUES(?,?,?,?,?,'pending',?,?)`,
      [id, req.user.id, phone, operator, amount, provider.name, now()]);
    await t.run(
      'INSERT INTO transactions(id,user_id,type,amount_cents,method,reference,created_at) VALUES(?,?,?,?,?,?,?)',
      [uid('tx'), req.user.id, 'airtime', -amount, 'wallet', `Crédit GSM ${operator} → ${phone}`, now()]);
    return deb.balance_cents;
  });
  if (debited === null)
    return res.status(402).json({ error: 'Solde insuffisant' });

  // 2. Envoi chez l'opérateur — échec → remboursement intégral
  try {
    const { reference } = await provider.send({ phone, amountCents: amount });
    await db.run(`UPDATE airtime_topups SET status='success', reference=? WHERE id=?`, [reference, id]);
  } catch (e) {
    console.error('💥 Airtime échoué, remboursement :', e.message);
    await db.tx(async (t) => {
      await t.run(`UPDATE airtime_topups SET status='failed' WHERE id=?`, [id]);
      await t.run('UPDATE wallets SET balance_cents = balance_cents + ? WHERE user_id = ?', [amount, req.user.id]);
      await t.run(
        'INSERT INTO transactions(id,user_id,type,amount_cents,method,reference,created_at) VALUES(?,?,?,?,?,?,?)',
        [uid('tx'), req.user.id, 'refund', amount, 'system', 'Remboursement crédit GSM', now()]);
    });
    return res.status(502).json({ error: 'Recharge impossible chez l\'opérateur — tu as été remboursé' });
  }

  const w = await db.get('SELECT balance_cents FROM wallets WHERE user_id = ?', [req.user.id]);
  res.json({ ok: true, phone, operator, amount_cents: amount, balance_cents: w.balance_cents });
}));

/* Historique */
r.get('/', requireAuth, ah(async (req, res) => {
  res.json(await db.all(
    `SELECT id, phone, operator, amount_cents, status, created_at
     FROM airtime_topups WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`, [req.user.id]));
}));

module.exports = r;
