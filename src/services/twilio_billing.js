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
  // ⚠️ `status` arrive avec le vocabulaire Twilio (completed / busy /
  // no-answer…). L'état INTERNE d'un appel terminé est toujours 'ended' :
  // le reste des écrans et des requêtes (« un appel est-il en cours ? »)
  // s'appuie dessus. La cause fournisseur est conservée dans hangup_cause.
  const causeFournisseur = status;

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
    // Mise à jour de l'appel.
    // ⚠️ La table `calls` ne possède PAS de colonne `duration` : la durée
    // brute et la durée facturable vivent dans `billed_sec`. L'ancienne
    // requête écrivait `duration=?` et levait « no such column: duration » à
    // CHAQUE fin d'appel GSM — l'appel restait « en cours » et n'était jamais
    // facturé. Corrigé ici (bug détecté par test/twilio_sms.test.js).
    await t.run(
      `UPDATE calls
       SET status='ended', hangup_cause=?, billed_sec=?, cost_cents=?,
           provider_sid = COALESCE(provider_sid, provider_sid),
           provider_status=?, provider_cost_cents=?, provider_currency=?, ended_at=?,
           answered_at = COALESCE(answered_at, ?)
       WHERE id=?`,
      [
        causeFournisseur,
        billedSec,
        debitCents,
        causeFournisseur,
        providerCents,
        twilioPriceCurrency || null,
        now(),
        status === 'completed' && rawSec > 0 ? now() - rawSec * 1000 : null,
        callId,
      ]
    );

    if (debitCents > 0) {
      // Vérifier que le solde est suffisant (normalement déjà réservé)
      const wallet = await t.get(`SELECT balance_cents FROM wallets WHERE user_id=?`, [userId]);
      if (!wallet) throw new Error('Portefeuille introuvable');

      // Débiter sans jamais passer sous zéro : un appel déjà terminé ne peut
      // pas être « annulé », mais le portefeuille ne doit pas devenir négatif
      // (plancher 0). L'écart éventuel reste visible dans le CDR et la console.
      const G = db.fn.greatest;
      await t.run(
        `UPDATE wallets SET balance_cents = ${G}(0, balance_cents - ?) WHERE user_id=?`,
        [debitCents, userId]
      );

      // ⚠️ Convention du grand livre : un DÉBIT est NÉGATIF (crédits > 0).
      // L'ancien code inserait un montant POSITIF pour un appel GSM : les
      // totaux « dépenses » et « appels » du portefeuille étaient alors faux
      // (dépense du jour à 0, total d'appels négatif).
      const txRef = 'CALL-' + callId.slice(0, 8).toUpperCase();
      await t.run(
        `INSERT INTO transactions
           (id, user_id, type, amount_cents, method, reference, status, created_at)
         VALUES (?, ?, 'call_debit', ?, 'system', ?, 'confirmed', ?)`,
        [uid('tx'), userId, -debitCents, txRef, now()]
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
