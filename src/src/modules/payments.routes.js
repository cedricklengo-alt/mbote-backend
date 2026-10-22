/**
 * Module PAYMENTS — webhook de l'agrégateur Mobile Money (FlexPay).
 * Route PUBLIQUE (pas de JWT : c'est FlexPay qui appelle), mais le rappel
 * n'est JAMAIS cru sur parole : le statut est revérifié chez FlexPay
 * (check/<orderNumber>) avant tout crédit.
 */
const express = require('express');
const db = require('../db');
const { ah } = require('../util');
const { pollAndSettle } = require('../services/payments');

const r = express.Router();

r.post('/webhook', ah(async (req, res) => {
  const b = req.body || {};
  console.log('🔔 Webhook paiement reçu :', JSON.stringify(b).slice(0, 300));

  // FlexPay renvoie notre référence et/ou son orderNumber
  const payment =
    (b.reference && await db.get('SELECT * FROM payments WHERE reference = ?', [String(b.reference)])) ||
    (b.orderNumber && await db.get('SELECT * FROM payments WHERE order_number = ?', [String(b.orderNumber)]));

  if (payment && payment.status === 'pending') {
    const state = await pollAndSettle(payment); // revérification systématique
    console.log(`🔔 Paiement ${payment.id} → ${state}`);
  }

  // Toujours 200 : sinon l'agrégateur ré-essaie en boucle
  res.json({ ok: true });
}));

module.exports = r;
