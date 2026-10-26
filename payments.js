/**
 * Service PAIEMENTS — logique partagée entre le portefeuille (polling de
 * l'app) et le webhook FlexPay.
 *
 * Garantie d'IDEMPOTENCE : le crédit du solde se fait dans une transaction
 * qui « réclame » le paiement via UPDATE … WHERE status='pending' RETURNING.
 * Si le webhook et le polling arrivent en même temps, un seul des deux
 * crédite — jamais les deux.
 */
const db = require('../db');
const { uid, now } = require('../util');
const { getPayProvider } = require('../providers/payments');

/* Crée le paiement en attente + déclenche le USSD Push */
async function createPayment({ userId, amountCents, method, phone }) {
  const provider = getPayProvider();
  const id = uid('pay');
  const reference = 'MBOTE-' + id.slice(4).toUpperCase();

  await db.run(
    `INSERT INTO payments(id,user_id,amount_cents,currency,method,phone,provider,reference,status,created_at)
     VALUES(?,?,?,?,?,?,?,?,'pending',?)`,
    [id, userId, amountCents, 'USD', method, phone, provider.name, reference, now()]);

  const payment = await db.get('SELECT * FROM payments WHERE id = ?', [id]);
  try {
    const { order_number } = await provider.initiate(payment);
    await db.run('UPDATE payments SET order_number = ? WHERE id = ?', [order_number, id]);
  } catch (e) {
    await db.run(`UPDATE payments SET status='failed', updated_at=? WHERE id=?`, [now(), id]);
    throw e;
  }
  return db.get('SELECT * FROM payments WHERE id = ?', [id]);
}

/* Crédite le solde — UNE SEULE FOIS, quoi qu'il arrive */
async function settleSuccess(paymentId) {
  return db.tx(async (t) => {
    const p = await t.get(
      `UPDATE payments SET status='success', updated_at=? WHERE id=? AND status='pending' RETURNING *`,
      [now(), paymentId]);
    if (!p) return null; // déjà traité par l'autre chemin (webhook ou polling)

    // 🎁 Promo : +10% offerts dès 10 $
    const bonus = p.amount_cents >= 1000 ? Math.round(p.amount_cents * 0.10) : 0;
    if (bonus > 0) await t.run('UPDATE payments SET bonus_cents=? WHERE id=?', [bonus, p.id]);

    await t.run(
      'INSERT INTO transactions(id,user_id,type,amount_cents,method,reference,created_at) VALUES(?,?,?,?,?,?,?)',
      [uid('tx'), p.user_id, 'topup', p.amount_cents, p.method, p.reference, now()]);
    if (bonus > 0)
      await t.run(
        'INSERT INTO transactions(id,user_id,type,amount_cents,method,reference,created_at) VALUES(?,?,?,?,?,?,?)',
        [uid('tx'), p.user_id, 'bonus', bonus, 'system', 'Bonus +10%', now()]);
    await t.run('UPDATE wallets SET balance_cents = balance_cents + ? WHERE user_id = ?',
      [p.amount_cents + bonus, p.user_id]);

    return { credited_cents: p.amount_cents + bonus, bonus_cents: bonus };
  });
}

async function markFailed(paymentId) {
  await db.run(`UPDATE payments SET status='failed', updated_at=? WHERE id=? AND status='pending'`,
    [now(), paymentId]);
}

/* Interroge le fournisseur et règle le paiement si l'état a changé */
async function pollAndSettle(payment) {
  if (payment.status !== 'pending') return payment.status;
  const state = await getPayProvider().checkStatus(payment);
  if (state === 'success') await settleSuccess(payment.id);
  else if (state === 'failed') await markFailed(payment.id);
  return state;
}

module.exports = { createPayment, settleSuccess, markFailed, pollAndSettle };
