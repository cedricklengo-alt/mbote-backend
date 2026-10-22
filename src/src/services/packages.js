/**
 * Service FORFAITS — « Pass RDC 100 min », « Pass RDC Illimité »…
 * Priorité dans le moteur d'appel : app-à-app gratuit > forfait > tarif/minute.
 */
const db = require('../db');
const { now } = require('../util');

/** Forfait actif couvrant ce numéro (le plus ancien d'abord = FIFO). */
async function findActive(userId, phoneE164) {
  const digits = String(phoneE164 || '').replace('+', '');
  const rows = await db.all(
    `SELECT * FROM user_packages
     WHERE user_id = ? AND expires_at > ? AND (unlimited = 1 OR remaining_sec > 0)
     ORDER BY purchased_at`, [userId, now()]);
  return rows.find((p) => !p.prefix || digits.startsWith(p.prefix)) || null;
}

/** Décompte des secondes consommées (appelé DANS la transaction de fin d'appel). */
async function consumeInsideTx(t, userPackageId, seconds) {
  const G = db.fn.greatest;
  await t.run(
    `UPDATE user_packages SET remaining_sec = ${G}(0, remaining_sec - ?)
     WHERE id = ? AND unlimited = 0`, [seconds, userPackageId]);
}

module.exports = { findActive, consumeInsideTx };
