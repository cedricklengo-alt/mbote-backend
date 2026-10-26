/**
 * 📲 SMS RÉELS — Africa's Talking
 * --------------------------------
 * Envoie les codes OTP (inscription) et les codes de réinitialisation PIN
 * par vrai SMS dès que les variables d'environnement sont présentes :
 *
 *   AT_USERNAME   → nom d'utilisateur de l'app Africa's Talking
 *                   ("sandbox" = environnement de test AT, aucun vrai SMS)
 *   AT_API_KEY    → clé API (Dashboard → Settings → API Key)
 *   AT_SENDER_ID  → optionnel : expéditeur alphanumérique approuvé
 *                   (sinon l'expéditeur par défaut AFRICASTKNG est utilisé)
 *
 * Sans ces variables : rien ne change (mode démo = code dans les logs).
 * API : POST /version1/messaging, corps form-encodé, header apiKey.
 * Codes succès par destinataire : 100 (traité), 101 (envoyé), 102 (en file).
 */

const AT_KEY = process.env.AT_API_KEY || '';
const AT_USER = process.env.AT_USERNAME || '';
const AT_FROM = process.env.AT_SENDER_ID || '';
const SANDBOX = AT_USER === 'sandbox';
const BASE = SANDBOX
  ? 'https://api.sandbox.africastalking.com'
  : 'https://api.africastalking.com';

/** Le canal SMS réel est-il configuré ? */
function enabled() {
  return Boolean(AT_KEY && AT_USER);
}

/**
 * Envoie un SMS. Ne lève jamais d'exception : renvoie { ok, status, cost }.
 * Les échecs sont journalisés (solde insuffisant, sender refusé, réseau…).
 */
async function sendSms(phone, message) {
  if (!enabled()) return { ok: false, status: 'non configuré' };
  try {
    const body = new URLSearchParams({
      username: AT_USER,
      to: phone,
      message,
      bulkSMSMode: '1',
    });
    if (AT_FROM) body.set('from', AT_FROM);

    const r = await fetch(BASE + '/version1/messaging', {
      method: 'POST',
      headers: {
        apiKey: AT_KEY,
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });
    const j = await r.json().catch(() => ({}));
    const rec = (((j || {}).SMSMessageData || {}).Recipients || [])[0] || {};
    const ok = [100, 101, 102].includes(Number(rec.statusCode));
    if (ok) {
      console.log(`📲 [SMS] Envoyé à ${phone} — ${rec.status}${rec.cost ? ', coût ' + rec.cost : ''}${SANDBOX ? ' (SANDBOX, aucun vrai SMS)' : ''}`);
    } else {
      const raison = rec.status || ((j || {}).SMSMessageData || {}).Message || `HTTP ${r.status}`;
      console.error(`📲 [SMS] ÉCHEC vers ${phone} : ${raison}`);
    }
    return { ok, status: rec.status || '', cost: rec.cost || '' };
  } catch (e) {
    console.error(`📲 [SMS] Erreur réseau Africa's Talking : ${e.message}`);
    return { ok: false, status: e.message };
  }
}

module.exports = { enabled, sendSms, SANDBOX };
