/**
 * ============================================================================
 *  SERVICE SMS — envoi facturé vers le réseau GSM
 * ============================================================================
 *
 * Un SMS payant suit exactement la même discipline qu'un appel :
 *   1. destination valide et couverte par la grille tarifaire ;
 *   2. forfait SMS éligible (quota) → sinon crédit du portefeuille ;
 *   3. réservation/débit ATOMIQUE (jamais de solde négatif, jamais deux
 *      requêtes concurrentes qui passeraient toutes les deux) ;
 *   4. envoi au fournisseur (Twilio) ;
 *   5. « accepté » ≠ « livré » : le statut est suivi jusqu'à
 *      queued/sent/delivered/failed/undelivered ;
 *   6. échec côté fournisseur → remboursement marqué et traçable.
 *
 * IDEMPOTENCE : `client_id` (généré par l'app) est unique par utilisateur.
 * Un renvoi après coupure réseau renvoie la ligne existante au lieu d'envoyer
 * (et de facturer) deux fois le même message.
 *
 * TARIFS : aucun prix n'est inventé. Si `rates.sms_price_cents` est NULL pour
 * la destination, l'envoi est refusé avec un code explicite
 * (`SMS_RATE_MISSING`) au lieu de débiter un montant arbitraire.
 */
'use strict';

const db = require('../db');
const { uid, now, normalizePhone } = require('../util');
const { findRate } = require('../modules/rating.routes');
const shop = require('./shop');
const twilio = require('./twilio');

/** Longueur maximale acceptée (au-delà : 3 segments, refusé volontairement). */
const MAX_TEXT = 320;

/** Statuts finaux considérés comme un échec (→ remboursement). */
const FAILED_STATUSES = ['failed', 'undelivered'];

function httpError(status, message, code) {
  return Object.assign(new Error(message), { status, code, expose: true });
}

/** Le préfixe utilisé pour l'éligibilité d'un forfait (chiffres sans « + »). */
function prefixOf(phone) {
  return String(phone || '').replace('+', '');
}

/**
 * Devis d'un SMS : ce que l'utilisateur paiera, et avec quoi.
 * @returns {Promise<{to:string,destination:string,sms_price_cents:number|null,
 *                    covered_by_plan:boolean, plan_id:string|null,
 *                    can_send:boolean, reason:string|null}>}
 */
async function quote(userId, to) {
  const phone = normalizePhone(to);
  if (!phone) throw httpError(400, 'Numéro invalide (format +243…)', 'BAD_PHONE');

  const rate = await findRate(phone);
  if (!rate) throw httpError(404, 'Destination non couverte par la grille tarifaire', 'NO_RATE');

  const plans = await shop.userActivePlans(userId);
  const plan = (plans || []).find(
    (p) => (p.sms_total > 0 || p.unlimited) && (!p.prefix || prefixOf(phone).startsWith(p.prefix)),
  ) || null;

  const price = rate.sms_price_cents == null ? null : Number(rate.sms_price_cents);
  const covered = Boolean(plan);
  const can = covered || price != null;

  return {
    to: phone,
    destination: rate.destination,
    flag: rate.flag || '',
    sms_price_cents: price,
    covered_by_plan: covered,
    plan_id: plan ? plan.id : null,
    can_send: can,
    reason: can ? null : 'SMS_RATE_MISSING',
    provider_ready: twilio.smsAvailable(),
  };
}

/** Débite le portefeuille de façon atomique. Renvoie false si solde insuffisant. */
async function debitWalletInsideTx(t, userId, cents, reference) {
  const deb = await t.get(
    'UPDATE wallets SET balance_cents = balance_cents - ? WHERE user_id = ? AND balance_cents >= ? RETURNING balance_cents',
    [cents, userId, cents],
  );
  if (!deb) return null;
  await t.run(
    `INSERT INTO transactions(id,user_id,type,amount_cents,method,reference,status,created_at)
     VALUES(?,?,?,?,'wallet',?,'confirmed',?)`,
    [uid('tx'), userId, 'sms_debit', -cents, reference, now()],
  );
  return Number(deb.balance_cents);
}

/**
 * Envoie un SMS en respectant forfait → crédit, avec idempotence.
 *
 * @param {{userId:string, to:string, text:string, clientId?:string}} opts
 */
async function send({ userId, to, text, clientId }) {
  const body = String(text == null ? '' : text).trim();
  if (!body) throw httpError(400, 'Message vide', 'EMPTY');
  if (body.length > MAX_TEXT) throw httpError(400, `Message trop long (${MAX_TEXT} caractères maximum)`, 'TOO_LONG');

  const phone = normalizePhone(to);
  if (!phone) throw httpError(400, 'Numéro invalide (format +243…)', 'BAD_PHONE');

  // ── 0. Idempotence : même client_id → même message, jamais deux envois
  const cid = clientId ? String(clientId).slice(0, 64) : null;
  if (cid) {
    const already = await db.get('SELECT * FROM sms_messages WHERE user_id=? AND client_id=?', [userId, cid]);
    if (already) return { message: already, duplicate: true };
  }

  // ── 1. Destination couverte ?
  const rate = await findRate(phone);
  if (!rate) throw httpError(404, 'Destination non couverte par la grille tarifaire', 'NO_RATE');

  // ── 2. Fournisseur prêt ? (on vérifie AVANT de débiter quoi que ce soit)
  if (!twilio.smsAvailable()) {
    throw Object.assign(
      httpError(409, 'L’envoi de SMS n’est pas encore activé sur ce serveur (Twilio non configuré).', 'SMS_NOT_CONFIGURED'),
    );
  }

  // ── 3. Forfait SMS d'abord (aucun débit monétaire si le quota couvre)
  const planUse = await shop.consumeSms(userId, prefixOf(phone), 1);
  let chargedCents = 0;
  let planId = planUse ? planUse.plan_id : null;

  if (!planUse) {
    const price = rate.sms_price_cents == null ? null : Number(rate.sms_price_cents);
    if (price == null) {
      throw httpError(409, `Tarif SMS non configuré pour ${rate.destination}. Aucun montant n’est débité.`, 'SMS_RATE_MISSING');
    }
    if (price < 0) throw httpError(500, 'Tarif SMS invalide en base', 'BAD_RATE');
    chargedCents = price;
  }

  // ── 4. Enregistrement local (statut « queued ») + débit atomique
  const id = uid('sms');
  const reference = 'SMS-' + id.slice(4).toUpperCase();
  const createdAt = now();

  const row = await db.tx(async (t) => {
    if (chargedCents > 0) {
      const balance = await debitWalletInsideTx(t, userId, chargedCents, reference);
      if (balance === null) {
        throw httpError(402, 'Crédit insuffisant pour ce SMS — rechargez votre portefeuille', 'NO_CREDIT');
      }
    }
    await t.run(
      `INSERT INTO sms_messages
         (id, user_id, to_phone, from_phone, body, status, provider, price_cents,
          charged_cents, plan_id, reference, client_id, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, userId, phone, twilio.config().fromNumber || null, body, 'queued',
       twilio.SERVICE, chargedCents, chargedCents, planId, reference, cid, createdAt, createdAt],
    );
    return t.get('SELECT * FROM sms_messages WHERE id = ?', [id]);
  });

  // ── 5. Envoi chez le fournisseur
  try {
    const sent = await twilio.sendSms({ to: phone, body });
    await db.run(
      `UPDATE sms_messages
          SET provider_sid=?, status=?, segments=?, price_cents=?, updated_at=?
        WHERE id=?`,
      [sent.sid, sent.status || 'queued', sent.num_segments,
       sent.price == null ? row.price_cents : Math.round(Math.abs(sent.price) * 100),
       now(), id],
    );
  } catch (e) {
    // Échec TOTAL d'envoi → remboursement immédiat et traçable
    await refund(id, `envoi impossible : ${(e && e.message) || 'erreur fournisseur'}`);
    await db.run(`UPDATE sms_messages SET status='failed', error_message=?, updated_at=? WHERE id=?`,
      [String((e && e.message) || 'erreur fournisseur').slice(0, 300), now(), id]);
  }

  const message = await db.get('SELECT * FROM sms_messages WHERE id = ?', [id]);
  return { message, duplicate: false };
}

/**
 * Rembourse un SMS (crédit ou quota), une seule fois.
 * @param {string} id
 * @param {string} raison
 */
async function refund(id, raison) {
  return db.tx(async (t) => {
    const claimed = await t.get(
      `UPDATE sms_messages SET refunded_at=?, updated_at=?
        WHERE id=? AND refunded_at IS NULL
        RETURNING *`,
      [now(), now(), id],
    );
    if (!claimed) return { refunded: false, reason: 'déjà remboursé' };

    if (Number(claimed.charged_cents) > 0) {
      await t.run('UPDATE wallets SET balance_cents = balance_cents + ? WHERE user_id = ?',
        [Number(claimed.charged_cents), claimed.user_id]);
      await t.run(
        `INSERT INTO transactions(id,user_id,type,amount_cents,method,reference,status,created_at)
         VALUES(?,?,?,?,'system',?,'confirmed',?)`,
        [uid('tx'), claimed.user_id, 'sms_refund', Number(claimed.charged_cents),
         `Remboursement ${claimed.reference}`, now()],
      );
    } else if (claimed.plan_id) {
      // Le message était couvert par un forfait : on rend le quota consommé.
      await t.run(
        `UPDATE user_plans
            SET remaining_sms = remaining_sms + 1,
                consumed_sms  = CASE WHEN consumed_sms > 0 THEN consumed_sms - 1 ELSE 0 END,
                status        = CASE WHEN expires_at > ? THEN 'active' ELSE status END
          WHERE id = ?`,
        [now(), claimed.plan_id],
      );
    }
    return { refunded: true, amount_cents: Number(claimed.charged_cents), reason: raison || null };
  });
}

/**
 * Traite un callback de statut Twilio (delivered, undelivered, failed…).
 * Idempotent : un callback répété ne rembourse pas deux fois.
 *
 * @param {{sid:string, status:string, errorCode?:string}} evt
 */
async function applyStatus({ sid, status, errorCode }) {
  if (!sid) return { updated: false, reason: 'sid manquant' };
  const st = String(status || '').toLowerCase();
  if (!st) return { updated: false, reason: 'statut manquant' };

  const msg = await db.get('SELECT * FROM sms_messages WHERE provider_sid = ?', [sid]);
  if (!msg) return { updated: false, reason: 'message inconnu' };

  await db.run(
    `UPDATE sms_messages SET status=?, error_code=?, updated_at=? WHERE id=?`,
    [st, errorCode == null ? null : String(errorCode).slice(0, 40), now(), msg.id],
  );

  if (FAILED_STATUSES.includes(st)) {
    const r = await refund(msg.id, `statut fournisseur : ${st}`);
    return { updated: true, status: st, refunded: r.refunded };
  }
  return { updated: true, status: st, refunded: false };
}

/** Historique des SMS d'un utilisateur (le plus récent d'abord). */
async function list(userId, limit = 50) {
  const n = Math.min(200, Math.max(1, Number(limit) || 50));
  const rows = await db.all(
    `SELECT id, to_phone, from_phone, status, price_cents, charged_cents, plan_id,
            segments, error_message, refunded_at, created_at, updated_at
       FROM sms_messages WHERE user_id = ? ORDER BY created_at DESC LIMIT ${n}`,
    [userId],
  );
  return rows.map((r) => ({
    ...r,
    price_cents: Number(r.price_cents || 0),
    charged_cents: Number(r.charged_cents || 0),
    created_at: Number(r.created_at),
    updated_at: Number(r.updated_at || r.created_at),
  }));
}

/** Détail d'un SMS appartenant à l'utilisateur (jamais celui d'un autre). */
async function get(userId, id) {
  const row = await db.get('SELECT * FROM sms_messages WHERE id=? AND user_id=?', [id, userId]);
  if (!row) throw httpError(404, 'SMS introuvable', 'NOT_FOUND');
  return row;
}

module.exports = { quote, send, refund, applyStatus, list, get, MAX_TEXT, FAILED_STATUSES };
