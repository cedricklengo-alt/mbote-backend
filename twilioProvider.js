/**
 * TwilioProvider — VRAIS appels GSM via Twilio Programmable Voice.
 *
 * Activation : remplir les 5 variables TWILIO_* dans .env + DEMO_MODE=false
 * puis `npm install twilio`. Aucun autre fichier à modifier.
 *
 * Côté app Flutter : utiliser le package `twilio_voice` avec le jeton
 * fourni par clientToken() — l'audio passe alors en WebRTC réel.
 */
let Twilio = null;
try { Twilio = require('twilio'); } catch { /* non installé en mode démo */ }

function client() {
  return Twilio(process.env.TWILIO_API_KEY, process.env.TWILIO_API_SECRET, {
    accountSid: process.env.TWILIO_ACCOUNT_SID,
  });
}

module.exports = {
  name: 'twilio',

  placeCall({ callId, to }) {
    // L'appel média est initié par le SDK côté app (connect({To}));
    // le serveur n'a rien à initier ici. On journalise seulement.
    console.log(`📡 [TWILIO] Appel ${callId} vers ${to}`);
    return { ok: true };
  },

  getCallState(call) {
    // En production : écouter les webhooks de statut Twilio
    // (initiated/ringing/answered/completed) et mettre à jour la table calls.
    return call.answered_at ? 'answered' : 'ringing';
  },

  answerTime() {
    return Date.now(); // sera remplacé par le timestamp du webhook Twilio
  },

  hangup(call) {
    console.log(`📡 [TWILIO] Hangup ${call.id}`);
    return { ok: true };
  },

  clientToken(identity) {
    const AccessToken = Twilio.jwt.AccessToken;
    const token = new AccessToken(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_API_KEY,
      process.env.TWILIO_API_SECRET,
      { identity, ttl: 3600 }
    );
    token.addGrant(new AccessToken.VoiceGrant({
      outgoingApplicationSid: process.env.TWILIO_TWIML_APP_SID,
      incomingAllow: false,
    }));
    return { demo: false, token: token.toJwt() };
  },
};
