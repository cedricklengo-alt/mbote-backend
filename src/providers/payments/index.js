/**
 * PayProvider — l'interface qui isole la couche paiement Mobile Money.
 * Point de bascule : démo → FlexPay (agrégateur RDC : M-Pesa, Orange Money, Airtel Money).
 *
 * Contrat :
 *   initiate(payment)    -> { order_number } : déclenche le USSD Push chez le client
 *   checkStatus(payment) -> 'pending' | 'success' | 'failed'
 *   name                 -> 'demo' | 'flexpay'
 *
 * Activation du VRAI argent (par ordre de priorité) :
 *   - PAYPAY_API_KEY présent                    → PayPay RDC (cd-paypay.com)
 *   - FLEXPAY_MERCHANT + FLEXPAY_TOKEN présents → FlexPay (flexpay.cd)
 *   - sinon                                     → simulation (démo)
 * Rien d'autre à changer.
 */
const demo = require('./demoPayProvider');
const flexpay = require('./flexpayProvider');
const paypay = require('./paypayProvider');

function getPayProvider() {
  if (process.env.PAYPAY_API_KEY) return paypay;
  if (process.env.FLEXPAY_MERCHANT && process.env.FLEXPAY_TOKEN) return flexpay;
  return demo;
}

module.exports = { getPayProvider };
