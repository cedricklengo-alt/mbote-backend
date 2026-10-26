/**
 * 📡 Configuration ICE (STUN/TURN) servie par le serveur — Phase A.
 * ------------------------------------------------------------------
 * Pourquoi : les identifiants TURN ne doivent PAS être écrits en dur
 * dans l'app. Ici ils vivent dans les variables d'environnement :
 *
 *   TURN_URLS       → liste d'URLs séparées par des virgules, ex :
 *                     turn:standard.relay.metered.ca:80,
 *                     turn:standard.relay.metered.ca:80?transport=tcp,
 *                     turn:standard.relay.metered.ca:443,
 *                     turns:standard.relay.metered.ca:443?transport=tcp
 *   TURN_USERNAME   → identifiant fourni par Metered/coturn
 *   TURN_CREDENTIAL → mot de passe fourni par Metered/coturn
 *
 * Avantages :
 *   - rotation des identifiants TURN sans recompiler l'app ;
 *   - route protégée par jeton → identifiants pas exposés au public ;
 *   - l'app garde un repli STUN intégré si la route est injoignable.
 */
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { ah } = require('../util');

const r = express.Router();

r.get('/ice', requireAuth, ah(async (req, res) => {
  const servers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun.relay.metered.ca:80' },
  ];

  const urls = String(process.env.TURN_URLS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const user = process.env.TURN_USERNAME || '';
  const cred = process.env.TURN_CREDENTIAL || '';

  if (urls.length && user && cred) {
    for (const u of urls) servers.push({ urls: u, username: user, credential: cred });
    return res.json({ iceServers: servers, turn: true });
  }

  // ⚠️ Pas de TURN configuré : STUN seul (les réseaux stricts échoueront).
  // → voir GUIDE-SECURITE-PHASE-A.md pour configurer Metered en 10 min.
  res.json({ iceServers: servers, turn: false });
}));

module.exports = r;
