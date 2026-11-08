/**
 * Fournisseur FlexPay (flexpay.cd) — agrégateur Mobile Money agréé BCC (RDC).
 * Couvre M-Pesa, Orange Money, Airtel Money, Afrimoney + cartes bancaires.
 *
 * Variables d'environnement requises :
 *   FLEXPAY_MERCHANT = code marchand fourni par FlexPay
 *   FLEXPAY_TOKEN    = jeton d'API fourni par FlexPay
 *   FLEXPAY_URL      = (optionnel) https://backend.flexpay.cd par défaut
 *   PUBLIC_URL       = URL publique du backend (pour le webhook), ex :
 *                      https://mbote-backend-1.onrender.com
 *
 * Flux : paymentService (type 1 = Mobile Money) → USSD Push chez le client →
 * webhook POST /api/payments/webhook + vérification via check/<orderNumber>.
 *
 * ⚠️ RÈGLE D'OR : le webhook n'est jamais cru sur parole — le statut est
 * TOUJOURS revérifié via l'endpoint check avant de créditer le solde.
 *
 * NOTE : les codes de statut ('0' = succès…) suivent la documentation
 * FlexPay v2 et les intégrations open source publiques. À reconfirmer sur la
 * doc officielle remise avec vos clés marchand lors de l'activation réelle.
 */
const BASE = () => process.env.FLEXPAY_URL || 'https://backend.flexpay.cd';

const headers = () => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${process.env.FLEXPAY_TOKEN}`,
});

module.exports = {
  name: 'flexpay',

  async initiate(payment) {
    // type 1 = Mobile Money (USSD Push) · type 2 = carte bancaire (page
    // de paiement hébergée par FlexPay, à laquelle on redirige l'utilisateur).
    const isCard = String(payment.method || '').toLowerCase() === 'card';

    const body = {
      merchant: process.env.FLEXPAY_MERCHANT,
      type: isCard ? 2 : 1,
      reference: payment.reference,
      amount: (payment.amount_cents / 100).toFixed(2),
      currency: payment.currency || 'USD',
      callbackUrl: `${process.env.PUBLIC_URL || ''}/api/payments/webhook`,
    };
    // Le numéro payeur n'existe pas pour une carte : ne jamais envoyer un
    // champ `phone` vide ou null au fournisseur.
    if (!isCard && payment.phone) body.phone = String(payment.phone).replace('+', '');

    const res = await fetch(`${BASE()}/api/rest/v1/paymentService`, {
      method: 'POST', headers: headers(), body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));

    // code '0' = demande acceptée (USSD Push envoyé, ou page carte prête)
    if (String(data.code) !== '0') {
      throw new Error(`FlexPay a refusé le paiement : ${data.message || res.status}`);
    }

    // FlexPay renvoie l'URL de la page de paiement pour les cartes.
    const redirect = data.url || data.redirect_url || data.redirectUrl || null;
    if (isCard && !redirect) {
      // Sans URL, l'utilisateur ne peut pas payer : on échoue explicitement
      // plutôt que d'afficher un paiement « en attente » éternel.
      throw new Error('FlexPay n’a pas renvoyé d’URL de paiement par carte');
    }
    return { order_number: data.orderNumber, redirect_url: redirect };
  },

  async checkStatus(payment) {
    if (!payment.order_number) return 'pending';
    const res = await fetch(`${BASE()}/api/rest/v1/check/${payment.order_number}`, {
      headers: headers(),
    });
    const data = await res.json().catch(() => ({}));
    const t = data.transaction || {};

    // Statuts transaction FlexPay : '0' = succès, '2' = en attente, autre = échec
    if (String(data.code) === '0' && String(t.status) === '0') {
      // Sécurité : le montant confirmé doit correspondre au montant attendu
      const paid = Math.round(parseFloat(t.amount || '0') * 100);
      if (paid && paid < payment.amount_cents) {
        console.error(`⚠️ FlexPay : montant payé (${paid}) < attendu (${payment.amount_cents})`);
        return 'failed';
      }
      return 'success';
    }
    if (String(t.status) === '2' || !data.transaction) return 'pending';
    return 'failed';
  },
};
