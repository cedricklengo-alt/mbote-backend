/**
 * Fournisseur Reloadly (reloadly.com) — agrégateur airtime : Vodacom,
 * Orange, Airtel, Africell (RDC) + 140 pays. Compte gratuit, paiement à
 * l'usage, marge possible sur chaque recharge.
 *
 * Env requis : RELOADLY_CLIENT_ID, RELOADLY_CLIENT_SECRET
 *              RELOADLY_SANDBOX=true (optionnel, pour les tests)
 *
 * Flux : OAuth token → auto-détection opérateur → topup.
 * NOTE : endpoints conformes à la doc publique Reloadly v1 ; à revalider
 * avec votre compte lors de l'activation réelle.
 */
const SANDBOX = () => String(process.env.RELOADLY_SANDBOX || 'false') === 'true';
const API = () => SANDBOX() ? 'https://topups-sandbox.reloadly.com' : 'https://topups.reloadly.com';
const AUTH = 'https://auth.reloadly.com/oauth/token';

let cached = { token: null, exp: 0 };

async function token() {
  if (cached.token && Date.now() < cached.exp) return cached.token;
  const res = await fetch(AUTH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.RELOADLY_CLIENT_ID,
      client_secret: process.env.RELOADLY_CLIENT_SECRET,
      grant_type: 'client_credentials',
      audience: API(),
    }),
  });
  const d = await res.json();
  if (!d.access_token) throw new Error('Reloadly : authentification refusée');
  cached = { token: d.access_token, exp: Date.now() + 50 * 60_000 };
  return d.access_token;
}

module.exports = {
  name: 'reloadly',
  async send({ phone, amountCents }) {
    const tk = await token();
    const h = { Authorization: `Bearer ${tk}`, 'Content-Type': 'application/json' };
    const digits = String(phone).replace('+', '');

    // 1. Auto-détection de l'opérateur du numéro
    const op = await (await fetch(
      `${API()}/operators/auto-detect/phone/${digits}/countries/CD?suggestedAmountsMap=true`,
      { headers: h })).json();
    if (!op.operatorId) throw new Error('Reloadly : opérateur introuvable pour ce numéro');

    // 2. Envoi de la recharge (montant en USD)
    const res = await fetch(`${API()}/topups`, {
      method: 'POST', headers: h,
      body: JSON.stringify({
        operatorId: op.operatorId,
        amount: (amountCents / 100).toFixed(2),
        useLocalAmount: false,
        recipientPhone: { countryCode: 'CD', number: digits },
      }),
    });
    const d = await res.json();
    if (!res.ok || d.errorCode) throw new Error(`Reloadly : ${d.message || res.status}`);
    return { reference: String(d.transactionId) };
  },
};
