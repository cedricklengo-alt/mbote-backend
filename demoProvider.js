/**
 * DemoProvider — simule le réseau télécom.
 * Comportement : l'appel "sonne" 4 secondes puis est "décroché".
 * Tout le reste (tarification, décompte du crédit, CDR) est 100% réel.
 */
const RING_MS = 4000;

module.exports = {
  name: 'demo',

  placeCall({ callId, to }) {
    console.log(`🎭 [DEMO] Appel ${callId} vers ${to} — sonnerie simulée…`);
    return { ok: true };
  },

  getCallState(call) {
    const elapsed = Date.now() - call.started_at;
    return elapsed >= RING_MS ? 'answered' : 'ringing';
  },

  // Heure EXACTE du décroché (même si le statut est interrogé en retard)
  answerTime(call) {
    return call.started_at + RING_MS;
  },

  hangup(call) {
    console.log(`🎭 [DEMO] Fin d'appel ${call.id}`);
    return { ok: true };
  },

  clientToken() {
    return { demo: true, token: null };
  },
};
