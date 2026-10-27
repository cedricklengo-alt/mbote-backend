/**
 * Fournisseur PayPay RDC (cd-paypay.com) — agrégateur Mobile Money RDC.
 * Couvre M-Pesa (Vodacom), Orange Money et Airtel Money par USSD Push.
 *
 * Variables d'environnement :
 *   PAYPAY_API_KEY     = clé API (pk_live_… / sk_…) du compte développeur
 *   PAYPAY_URL         = (optionnel) https://app.cd-paypay.com/api par défaut
 *                        → sandbox : https://sandbox.cd-paypay.com/api
 *   PAYPAY_CDF_PER_USD = taux de conversion (défaut 2800) : PayPay encaisse
 *                        en FRANCS CONGOLAIS (CDF), le portefeuille MboteCall
 *                        est en USD. Mets ici le taux du jour (à rafraîchir
 *                        de temps en temps, léger coussin conseillé).
 *
 * Flux : POST /v1/payments/initiate → USSD Push chez le client → POLLING
 * GET /v1/transactions/{id}/status (les webhooks PayPay sont en maintenance ;
 * notre architecture repose déjà sur le polling → aucun souci).
 *
 * Statuts observés : 'accepted'/ACCEPTED = demande acceptée, en attente du
 * PIN client → pending ; 'completed' → succès ; 'failed' → échec.
 */

const BASE = () => process.env.PAYPAY_URL || 'https://app.cd-paypay.com/api';
const RATE = () => parseFloat(process.env.PAYPAY_CDF_PER_USD || '2800');

const PROVIDERS = {
  mpesa: 'VODACOM_MPESA_COD',
  orange: 'ORANGE_MPESA_COD',
  airtel: 'AIRTEL_MPESA_COD',
};

const headers = () => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${process.env.PAYPAY_API_KEY}`,
});

/** USD (centimes) → CDF entier, minimum 100 CDF, arrondi aux 50 CDF */
function usdCentsToCdf(cents) {
  const cdf = Math.round(((cents / 100) * RATE()) / 50) * 50;
  return Math.max(100, cdf);
}

module.exports = {
  name: 'paypay',

  async initiate(payment) {
    const provider = PROVIDERS[payment.method];
    if (!provider) throw new Error(`PayPay : opérateur inconnu « ${payment.method} »`);

    const amountCdf = usdCentsToCdf(payment.amount_cents);
    const body = {
      phoneNumber: payment.phone.replace('+', ''), // format attendu : 243XXXXXXXXX
      provider,
      amount: amountCdf,
      currency: 'CDF',
      title: `Recharge MboteCall ${payment.reference}`,
    };

    const res = await fetch(`${BASE()}/v1/payments/initiate`, {
      method: 'POST', headers: headers(), body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));

    const tx = data.transaction || data;
    const id = tx.id || data.transactionId;
    if (!res.ok || data.success === false || !id) {
      throw new Error(`PayPay a refusé le paiement : ${data.message || data.error || `HTTP ${res.status}`}`);
    }
    console.log(`💰 [PAYPAY] USSD Push → ${payment.phone} : ${amountCdf} CDF ` +
      `(≈ ${(payment.amount_cents / 100).toFixed(2)} $ au taux ${RATE()}) — tx ${id}`);
    return { order_number: id };
  },

  async checkStatus(payment) {
    if (!payment.order_number) return 'pending';
    const res = await fetch(
      `${BASE()}/v1/transactions/${encodeURIComponent(payment.order_number)}/status`,
      { headers: headers() });
    const data = await res.json().catch(() => ({}));

    const tx = data.transaction || data;
    const s = String(tx.status || data.status || '').toLowerCase();
    const ps = String(tx.payPayStatus || '').toUpperCase();

    if (['completed', 'success', 'succeeded'].includes(s) ||
        ['COMPLETED', 'SUCCESS'].includes(ps)) return 'success';
    if (['failed', 'rejected', 'cancelled', 'canceled', 'expired'].includes(s) ||
        ['FAILED', 'REJECTED', 'CANCELLED', 'EXPIRED'].includes(ps)) return 'failed';
    // 'accepted', 'pending', 'processing'… → le client n'a pas encore tapé son PIN
    return 'pending';
  },
};
