/**
 * Fournisseur de paiement DÉMO — simule le parcours Mobile Money réel :
 *   1. initiate()    : « USSD Push envoyé » (rien de réel)
 *   2. checkStatus() : 'pending' pendant ~8 s (le temps que le client
 *                      « tape son PIN »), puis 'success'.
 *
 * Cas d'échec simulé (pour tester l'écran d'erreur de l'app) :
 *   un numéro payeur se terminant par 0001 → paiement 'failed'.
 */
const CONFIRM_DELAY_MS = 8000;

module.exports = {
  name: 'demo',

  async initiate(payment) {
    console.log(`💰 [DEMO] USSD Push simulé → ${payment.phone} : ` +
      `${(payment.amount_cents / 100).toFixed(2)} $ via ${payment.method}`);
    return { order_number: 'demo_' + payment.id };
  },

  async checkStatus(payment) {
    if (Date.now() - payment.created_at < CONFIRM_DELAY_MS) return 'pending';
    // Carte bancaire : pas de numéro payeur — on ne doit pas planter.
    if (payment.phone && String(payment.phone).endsWith('0001')) return 'failed'; // cas de test
    return 'success';
  },
};
