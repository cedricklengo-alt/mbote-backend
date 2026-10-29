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

/* 🔑 v2.7.1 — Clé API Metered : identifiants TURN FRAIS et temporaires.
 * Variables Render :
 *   METERED_API_KEY   → la clé API du tableau de bord Metered
 *   METERED_SUBDOMAIN → ton application, ex. « mbotecall » ou
 *                       « mbotecall.metered.live » (les deux marchent)
 * Ordre de service : Metered (frais) → TURN_* fixes (repli) → STUN seul.
 * Les identifiants frais sont gardés en cache 6 h (zéro latence ajoutée). */
let meteredCache = { servers: null, until: 0 };

async function freshMeteredServers() {
  const key = process.env.METERED_API_KEY || '';
  let dom = String(process.env.METERED_SUBDOMAIN || '').trim();
  if (!key || !dom) return null;
  if (meteredCache.servers && Date.now() < meteredCache.until) {
    return meteredCache.servers;
  }
  dom = dom.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!dom.includes('.')) dom += '.metered.live';
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 5000);
    const resp = await fetch(
      `https://${dom}/api/v1/turn/credentials?apiKey=${encodeURIComponent(key)}`,
      { signal: ctl.signal });
    clearTimeout(t);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const list = await resp.json();
    if (!Array.isArray(list) || !list.length) throw new Error('réponse vide');
    meteredCache = { servers: list, until: Date.now() + 6 * 3600 * 1000 };
    console.log(`📡 [RTC] TURN Metered rafraîchi (${list.length} serveurs, cache 6 h)`);
    return list;
  } catch (e) {
    console.error(`⚠️ [RTC] API Metered injoignable (${e.message}) → repli TURN fixes/STUN`);
    return null;
  }
}

r.get('/ice', requireAuth, ah(async (req, res) => {
  const servers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun.relay.metered.ca:80' },
  ];

  // 1) 🥇 Identifiants FRAIS via la clé API (temporaires, révocables)
  const fresh = await freshMeteredServers();
  if (fresh) {
    return res.json({ iceServers: [...servers, ...fresh], turn: true });
  }

  // 2) 🥈 Repli : identifiants fixes TURN_* (config historique)
  const urls = String(process.env.TURN_URLS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const user = process.env.TURN_USERNAME || '';
  const cred = process.env.TURN_CREDENTIAL || '';

  if (urls.length && user && cred) {
    for (const u of urls) servers.push({ urls: u, username: user, credential: cred });
    return res.json({ iceServers: servers, turn: true });
  }

  // 3) ⚠️ STUN seul (les réseaux stricts échoueront).
  res.json({ iceServers: servers, turn: false });
}));

/* ──────────────────────────────────────────────────────────────
 * 📲 v3.0 — Réveil d'appel quand l'app était FERMÉE.
 * Le téléphone, réveillé par notification, n'a pas encore de WebSocket :
 * il confirme / refuse l'appel par simple requête HTTP.
 * ────────────────────────────────────────────────────────────── */

/** « Ça sonne chez moi » — le push a bien réveillé l'app. */
r.post('/ack', requireAuth, ah(async (req, res) => {
  const ok = require('./rtc.ws').ackCall(req.user.phone, req.body && req.body.call_id);
  res.json({ ok });
}));

/** « Je refuse » — depuis l'écran d'appel plein écran (app sans connexion). */
r.post('/decline', requireAuth, ah(async (req, res) => {
  const ok = require('./rtc.ws').declineCall(req.user.phone, req.body && req.body.call_id);
  res.json({ ok });
}));

/* 🧪 Diagnostic — UNIQUEMENT en mode simulation (tests automatisés locaux) */
if (String(process.env.PUSH_DEBUG_FAKE || '') === 'true') {
  r.get('/_debug', (req, res) => {
    const push = require('../services/push');
    res.json({ rtc: require('./rtc.ws')._debug(), pushes: push.getSentLog() });
  });
  r.post('/_debug/clear', (req, res) => {
    require('../services/push').clearSentLog();
    res.json({ ok: true });
  });
}

module.exports = r;
