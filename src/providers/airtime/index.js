/**
 * AirtimeProvider — recharge de crédit GSM pour un proche.
 * Bascule : démo → Reloadly (agrégateur airtime mondial, 140+ pays).
 * Activation réelle : RELOADLY_CLIENT_ID + RELOADLY_CLIENT_SECRET dans l'env.
 *
 * Contrat : send({phone, amountCents}) -> { reference }  (lève une erreur si échec)
 */
const demo = require('./demoAirtime');
const reloadly = require('./reloadlyAirtime');

function getAirtimeProvider() {
  if (process.env.RELOADLY_CLIENT_ID && process.env.RELOADLY_CLIENT_SECRET) return reloadly;
  return demo;
}

/* Détection de l'opérateur congolais par préfixe (affichage) */
function detectOperator(phoneE164) {
  const d = String(phoneE164 || '').replace('+', '');
  if (/^243(81|82)/.test(d)) return 'Vodacom';
  if (/^243(89|84|85)/.test(d)) return 'Orange';
  if (/^243(99|97)/.test(d)) return 'Airtel';
  if (/^243(90|91)/.test(d)) return 'Africell';
  if (d.startsWith('243')) return 'RDC';
  return 'International';
}

module.exports = { getAirtimeProvider, detectOperator };
