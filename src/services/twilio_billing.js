/**
 * Service FACTURATION TWILIO — calcule le débit client après un appel GSM
 * et enregistre la transaction correspondante.
 *
 * RÈGLES DE FACTURATION :
 *   1. Seuls les appels avec statut 'completed' sont facturés.
 *   2. Durée facturable = MAX(durée réelle, MIN_BILLABLE_SEC) si l'appel
 *      est connecté et > 0 sec. (évite de facturer 0s pour un appel
 *      raccroché aussitôt).
 *   3. Coût = CEIL(secondes_facturables / 60) × tarif_par_minute_en_cents.
 *   4. Toujours vérifier le solde AVANT l'appel (réservation) et
 *      régulariser APRÈS via cet endpoint.
 *   5. Ne jamais présenter un coût estimé comme le coût fournisseur final —
 *      Twilio peut consolider ses prix avec jusqu'à 24h de décalage.
 */
const db  = require('../db');
const { uid, now, costFor } = require('../util');

/** Durée minimale facturée pour un appel connecté (en secondes). */
const MIN_BILLABLE_SEC = Number(process.env.MIN_BILLABLE_SEC) || 10;

/**
 * Finalise la facturation d'un appel Twilio (GSM/fixe).
 *
 * @param {object} opts
 * @param {string} opts.callId        - id interne de l'appel (table calls)
 * @param {string} opts.status        - statut Twilio : 'completed' | 'no-answer' | 'busy' | 'failed' | 'canceled'
 * @param {number} opts.durationSec   - durée brute en secondes (0 si non connecté)
 * @param {number} opts.pricePerMinCents - tarif client en cents/minute
 * @param {string} opts.userId        - id de l'utilisateur appelant
 * @param {string} [opts.twilioPrice] - coût fournisseur brut (string USD, ex: "-0.0085") — informatif
 * @param {string} [opts.twilioPriceCurrency] - devise du coût fournisseur
 */
async function finalizeTwilioCall({
  callId,
  status,
  durationSec,
  pricePerMinCents,
  userId,
  twilioPrice,
  twilioPriceCurrency,
}) {
  const rawSec     = Math.max(0, Math.floor(Number(durationSec) || 0));
  const wasConnected = status === 'completed';

  // Durée facturable : minimum MIN_BILLABLE_SEC pour les appels réellement connectés
  const billedSec  = wasConnected && rawSec > 0
    ? Math.max(rawSec, MIN_BILLABLE_SEC)
    : rawSec;

  const debitCents = wasConnected
    ? costFor(billedSec, pricePerMinCents)
    : 0;

  // Coût fournisseur (à titre informatif, peut arriver ultérieurement)
  const providerCents = twilioPrice
    ? Math.round(Math.abs(parseFloat(twilioPrice)) * 100)
    : null;

  return db.tx(async (t) => {
    // Mise à jour de l'appel
    await t.run(
      `UPDATE calls
       SET status=?, duration=?, billed_sec=?, cost_cents=?,
           provider_cost_cents=?, provider_currency=?, ended_at=?
       WHERE id=?`,
      [
        status,
        rawSec,
        billedSec,
        debitCents,
        providerCents,
        twilioPriceCurrency || null,
        now(),
        callId,
      ]
    );

    if (debitCents > 0) {
      // Vérifier que le solde est suffisant (normalement déjà réservé)
      const wallet = await t.get(`SELECT balance_cents FROM wallets WHERE user_id=?`, [userId]);
      if (!wallet) throw new Error('Portefeuille introuvable');

      // Débiter — on n'échoue pas si le solde est négatif (l'appel est déjà terminé)
      // mais on le consigne clairement
      await t.run(
        `UPDATE wallets SET balance_cents = balance_cents - ? WHERE user_id=?`,
        [debitCents, userId]
      );

      const txRef = 'CALL-' + callId.slice(0, 8).toUpperCase();
      await t.run(
        `INSERT INTO transactions
           (id, user_id, type, amount_cents, method, reference, created_at)
         VALUES (?, ?, 'call_debit', ?, 'system', ?, ?)`,
        [uid('tx'), userId, debitCents, txRef, now()]
      );

      // Libération de la réservation si elle existe
      await t.run(
        `UPDATE transactions SET status='released'
         WHERE user_id=? AND type='call_reserve' AND reference=?
           AND status='pending'`,
        [userId, txRef]
      ).catch(() => {}); // ignore si pas de réservation
    }

    return {
      call_id:           callId,
      status,
      billed_sec:        billedSec,
      debit_cents:       debitCents,
      provider_cents:    providerCents,
      min_billable_sec:  MIN_BILLABLE_SEC,
    };
  });
}

/**
 * Réserve un montant estimé avant le départ d'un appel GSM.
 * Empêche le démarrage si le solde est insuffisant.
 *
 * @param {string} userId
 * @param {number} maxMinutes      - durée maximale autorisée (selon tarif)
 * @param {number} pricePerMinCents
 * @param {string} callId
 * @returns {number} montant réservé en cents
 */
async function reserveCallCredit(userId, maxMinutes, pricePerMinCents, callId) {
  const reserveCents = costFor(maxMinutes * 60, pricePerMinCents);

  return db.tx(async (t) => {
    const wallet = await t.get(
      `SELECT balance_cents FROM wallets WHERE user_id=?`, [userId]
    );
    if (!wallet) throw Object.assign(new Error('Portefeuille introuvable'), { status: 404 });
    if (wallet.balance_cents < reserveCents) {
      throw Object.assign(
        new Error(`Solde insuffisant : ${wallet.balance_cents}¢ disponibles, ${reserveCents}¢ requis`),
        { status: 402 }
      );
    }

    // Créer une réservation (n'est PAS un débit définitif)
    const txRef = 'CALL-' + callId.slice(0, 8).toUpperCase();
    await t.run(
      `INSERT INTO transactions
         (id, user_id, type, amount_cents, method, reference, status, created_at)
       VALUES (?, ?, 'call_reserve', ?, 'system', ?, 'pending', ?)`,
      [uid('tx'), userId, reserveCents, txRef, now()]
    );

    return reserveCents;
  });
}

module.exports = { finalizeTwilioCall, reserveCallCredit, MIN_BILLABLE_SEC };
