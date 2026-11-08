/**
 * Service PROMOS / HAPPY HOURS — remises pilotées depuis la console admin.
 *   - discount_pct : 30 = −30 % sur le prix/minute
 *   - prefix : '' = toutes destinations, '243' = RDC seulement, etc.
 *   - fenêtre temporelle starts_at/ends_at (0 = sans limite)
 * S'il y a plusieurs promos applicables, la MEILLEURE remise gagne.
 */
const db = require('../db');
const { now } = require('../util');

async function activePromos() {
  const t = now();
  const rows = await db.all('SELECT * FROM promos WHERE active = 1');
  return rows.filter((p) =>
    (Number(p.starts_at) === 0 || Number(p.starts_at) <= t) &&
    (Number(p.ends_at) === 0 || Number(p.ends_at) >= t));
}

/** Meilleure promo pour un numéro E.164 (+243…) ; null si aucune. */
async function bestPromoFor(phoneE164) {
  const digits = String(phoneE164 || '').replace('+', '');
  const list = (await activePromos()).filter(
    (p) => !p.prefix || digits.startsWith(p.prefix));
  if (!list.length) return null;
  return list.reduce((a, b) => (b.discount_pct > a.discount_pct ? b : a));
}

/** Applique la remise (prix plancher : 1 centime/min). */
function discounted(priceCents, promo) {
  if (!promo) return priceCents;
  return Math.max(1, Math.round(priceCents * (100 - promo.discount_pct) / 100));
}

module.exports = { activePromos, bestPromoFor, discounted };
