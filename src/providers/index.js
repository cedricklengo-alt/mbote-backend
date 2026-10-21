/**
 * CallProvider — l'interface qui isole la couche télécom.
 * C'est le point de bascule démo → Twilio → (plus tard) Kamailio/FreeSWITCH.
 *
 * Contrat :
 *   placeCall({callId, to})   -> démarre l'appel côté opérateur
 *   getCallState(call)        -> 'ringing' | 'answered'
 *   hangup(call)              -> coupe l'appel côté opérateur
 *   clientToken(identity)     -> jeton pour le SDK voix côté app (Twilio)
 */
const demo = require('./demoProvider');
const twilio = require('./twilioProvider');

function getProvider() {
  const demoMode = String(process.env.DEMO_MODE || 'true') === 'true';
  if (!demoMode && process.env.TWILIO_ACCOUNT_SID) return twilio;
  return demo;
}

module.exports = { getProvider };
