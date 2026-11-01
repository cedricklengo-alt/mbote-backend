/**
 * PayProvider — l'interface qui isole la couche paiement Mobile Money.
 * Point de bascule : démo → FlexPay (agrégateur RDC : M-Pesa, Orange Money, Airtel Money).
 *
 * Contrat :
 *   initiate(payment)    -> { order_number } : déclenche le USSD Push chez le client
 *   checkStatus(payment) -> 'pending' | 'success' | 'failed'
 *   name                 -> 'demo' | 'flexpay'
 *
 * Activation du VRAI argent : renseigner FLEXPAY_MERCHANT + FLEXPAY_TOKEN
 * dans les variables d'environnement. Rien d'autre à changer.
 */
const demo = require('./demoPayProvider');
const flexpay = require('./flexpayProvider');

function getPayProvider() {
  if (process.env.FLEXPAY_MERCHANT && process.env.FLEXPAY_TOKEN) return flexpay;
  return demo;
}

module.exports = { getPayProvider };
