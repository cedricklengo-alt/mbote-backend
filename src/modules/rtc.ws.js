/**
 * 🎙️ RTC — signalisation temps réel pour les VRAIS appels voix
 * MboteCall → MboteCall (WebRTC).
 *
 * Le serveur joue le rôle de standardiste : il ne transporte PAS la voix
 * (elle passe en direct de téléphone à téléphone via WebRTC) ; il fait
 * seulement passer les messages techniques entre les deux applications :
 *
 *   offer   : A appelle B (contient l'offre SDP)
 *   answer  : B décroche (contient la réponse SDP)
 *   ice     : candidats réseau (comment se joindre à travers box/4G)
 *   reject  : B refuse l'appel
 *   hangup  : l'un des deux raccroche
 *
 * Connexion : wss://<serveur>/ws?token=<JWT>   (même jeton que l'API)
 */

const WebSocket = require('ws');
const db = require('../db');
const { normalizePhone } = require('../util');
const { verifyToken } = require('../middleware/auth'); // 🔄 double clé (rotation)
const push = require('../services/push');

/** téléphone (normalisé) → { ws, user } */
const online = new Map();

/**
 * 📥 Salle d'attente des appels (app fermée chez l'appelé).
 * Quand B est hors ligne mais joignable par notification : on garde l'offre
 * de A ici, on envoie le push, et dès que B ouvre l'app (connexion WS),
 * l'appel lui est livré comme s'il venait d'arriver.
 * téléphone appelé → { offer, ice: [], caller, ts }
 */
const pending = new Map();
const PENDING_TTL = 50_000; // 50 s : au-delà, l'appelant a déjà raccroché

/**
 * 👻 v2.9.1 — Garde anti-socket fantôme.
 * Android peut tuer l'app SANS fermer la connexion : le serveur croit
 * l'appelé « en ligne », lui transmet l'offre… dans le vide, et l'appelant
 * finit sur « Pas de réponse » alors qu'une notification l'aurait réveillé.
 * Parade : après avoir transmis une offre, on exige le « ringing » de
 * l'appelé sous 4,5 s. Sinon : connexion fantôme → on la ferme et on
 * bascule sur la voie notification (salle d'attente), ICE rejoués.
 * téléphone appelé → { timer, caller, msg, ice: [] }
 */
const awaitingRing = new Map();

function armGhostGuard(callerWs, callerUser, to, msg) {
  const old = awaitingRing.get(to);
  if (old) clearTimeout(old.timer);
  const guard = { caller: callerUser.phone, ice: [] };
  guard.timer = setTimeout(async () => {
    awaitingRing.delete(to);
    if (callerWs.readyState !== WebSocket.OPEN) return; // l'appelant est parti
    // Pas de « ça sonne » → connexion fantôme : on la ferme proprement
    const cur = online.get(to);
    if (cur) {
      try { cur.ws.terminate(); } catch (_) {}
      online.delete(to);
    }
    console.log(`👻 WS fantôme chez ${to} → bascule sur notification push`);
    await handleOffline(callerWs, callerUser, 'offer', to, msg);
    // 🧊 Les candidats réseau émis pendant la fenêtre fantôme sont rejoués
    const p = pending.get(to);
    if (p) for (const c of guard.ice) p.ice.push(c);
  }, 4500);
  awaitingRing.set(to, guard);
}

/** L'appelé a donné signe de vie (ringing/answer/reject) → garde levée */
function clearGhostGuard(calleePhone) {
  const g = awaitingRing.get(calleePhone);
  if (g) { clearTimeout(g.timer); awaitingRing.delete(calleePhone); }
}

/**
 * 📵 v2.9.1 — L'appel en salle d'attente n'aboutira pas (annulé ou expiré) :
 * on REMPLACE la notification « t'appelle » par « Appel manqué » (même tag),
 * pour ne jamais laisser une fausse sonnerie dans la barre du téléphone.
 */
async function notifyMissed(to, p) {
  try {
    const callee = await db.get(
      `SELECT fcm_token FROM users WHERE phone = ? AND status = 'active'`, [to]
    );
    if (push.enabled() && callee && callee.fcm_token) {
      await push.sendMissedCallPush(
        callee.fcm_token, p.offer.from_name, p.caller);
      console.log(`📵 Appel manqué notifié : ${p.caller} → ${to}`);
    }
  } catch (_) {}
}

/** L'utilisateur est-il connecté au canal temps réel ? */
function isOnline(phone) {
  const p = normalizePhone(phone);
  return !!(p && online.has(p));
}

function init(server) {
  const wss = new WebSocket.Server({ server, path: '/ws' });

  wss.on('connection', async (ws, req) => {
    // --- Authentification par jeton (même JWT que l'API REST) ---
    let user;
    try {
      const url = new URL(req.url, 'http://x');
      const payload = verifyToken(url.searchParams.get('token') || '');
      if (!payload) throw new Error('jeton invalide');
      user = await db.get(
        'SELECT id, phone, name, avatar FROM users WHERE id = ?',
        [payload.uid]
      );
    } catch (_) { /* jeton invalide */ }
    if (!user) return ws.close(4001, 'auth');

    // Une seule connexion par numéro : la nouvelle remplace l'ancienne
    const prev = online.get(user.phone);
    if (prev && prev.ws !== ws) { try { prev.ws.close(); } catch (_) {} }
    online.set(user.phone, { ws, user });
    console.log(`🔌 WS connecté : ${user.phone} (${online.size} en ligne)`);
    ws._phone = user.phone;
    ws._alive = true;
    ws.on('pong', () => { ws._alive = true; });

    // 📬 Un appel attendait ce téléphone (notification touchée) → on le livre
    const waiting = pending.get(user.phone);
    if (waiting) {
      pending.delete(user.phone);
      if (Date.now() - waiting.ts <= PENDING_TTL) {
        try {
          ws.send(JSON.stringify(waiting.offer));
          for (const ice of waiting.ice) {
            ws.send(JSON.stringify({
              type: 'ice', call_id: ice.call_id,
              from: waiting.caller, candidate: ice.candidate,
            }));
          }
          console.log(`📬 Appel en attente livré : ${waiting.caller} → ${user.phone}`);
        } catch (_) {}
      }
    }

    ws.on('message', (raw) => {
      // 🛡️ Garde-fou : message anormalement gros → ignoré (anti-abus)
      if (raw.length > 200_000) return;
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
      const type = String(msg.type || '');
      if (!['offer', 'answer', 'ice', 'reject', 'hangup', 'ringing', 'reoffer', 'reanswer'].includes(type)) return;

      const to = normalizePhone(msg.to);
      const dest = to && online.get(to);
      if (type !== 'ice') console.log(`📨 WS ${type} : ${user.phone} → ${to} ${dest ? '✓' : '✗ hors ligne'}`);

      // 👻 v2.9.1 : l'appelé répond au standardiste → sa connexion est vivante
      if (type === 'ringing' || type === 'answer' || type === 'reject') {
        clearGhostGuard(user.phone);
      }
      // 👻 L'appelant renonce pendant la fenêtre fantôme → garde annulée
      if ((type === 'hangup' || type === 'reject') && to) {
        const g = awaitingRing.get(to);
        if (g && g.caller === user.phone) clearGhostGuard(to);
      }

      if (!dest) {
        // Destinataire hors ligne → notification push ou salle d'attente
        handleOffline(ws, user, type, to, msg);
        return;
      }

      // 👻 v2.9.1 : offre transmise à un socket peut-être mort → on arme la
      // garde ; les ICE de l'appelant sont copiés pour rejeu éventuel
      if (type === 'offer') armGhostGuard(ws, user, to, msg);
      if (type === 'ice') {
        const g = awaitingRing.get(to);
        if (g && g.caller === user.phone) {
          g.ice.push({ call_id: msg.call_id, candidate: msg.candidate });
        }
      }

      // On fait suivre, en ajoutant l'identité de l'expéditeur
      const fwd = {
        type,
        call_id: msg.call_id,
        from: user.phone,
        ...(type === 'offer' ? {
          from_name: user.name || '',
          from_avatar: user.avatar || null,
          sdp: msg.sdp,
        } : {}),
        ...(type === 'answer' ? { sdp: msg.sdp } : {}),
        ...(type === 'reoffer' || type === 'reanswer' ? { sdp: msg.sdp } : {}), // 🔄 v2.8.1 relance ICE
        ...(type === 'ice' ? { candidate: msg.candidate } : {}),
      };
      try { dest.ws.send(JSON.stringify(fwd)); } catch (_) {}
    });

    ws.on('close', () => {
      const cur = online.get(ws._phone);
      if (cur && cur.ws === ws) {
        online.delete(ws._phone);
        console.log(`🔌 WS déconnecté : ${ws._phone} (${online.size} en ligne)`);
      }
    });
  });

  // 💓 Battement de cœur : nettoie les connexions mortes (30 s)
  setInterval(() => {
    for (const [phone, { ws }] of online) {
      if (!ws._alive) { try { ws.terminate(); } catch (_) {} online.delete(phone); continue; }
      ws._alive = false;
      try { ws.ping(); } catch (_) {}
    }
    // 🧹 Appels en attente expirés (l'appelant a raccroché depuis longtemps)
    for (const [phone, p] of pending) {
      if (Date.now() - p.ts > PENDING_TTL) {
        pending.delete(phone);
        notifyMissed(phone, p); // 📵 v2.9.1 : « Appel manqué » dans la barre
      }
    }
  }, 30000).unref();

  console.log('🎙️  Canal temps réel /ws prêt (appels voix MboteCall)');
}

/**
 * 📲 L'appelé est hors ligne : si son téléphone est joignable par notification,
 * on garde l'appel au chaud et on le réveille ; sinon → « injoignable ».
 */
async function handleOffline(ws, user, type, to, msg) {
  const p = pending.get(to);

  // L'appelant complète ou annule un appel déjà en salle d'attente
  if (p && p.caller === user.phone) {
    if (type === 'ice') {
      p.ice.push({ call_id: msg.call_id, candidate: msg.candidate });
      return;
    }
    if (type === 'hangup' || type === 'reject') {
      pending.delete(to);
      console.log(`🧹 Appel en attente annulé : ${user.phone} → ${to}`);
      notifyMissed(to, p); // 📵 la notification devient « Appel manqué »
      return;
    }
  }
  if (type !== 'offer') return;

  try {
    const callee = await db.get(
      `SELECT fcm_token FROM users WHERE phone = ? AND status = 'active'`, [to]
    );
    if (push.enabled() && callee && callee.fcm_token) {
      const ok = await push.sendCallPush(callee.fcm_token, user.name, user.phone);
      if (ok) {
        pending.set(to, {
          caller: user.phone,
          ts: Date.now(),
          ice: [],
          offer: {
            type: 'offer',
            call_id: msg.call_id,
            from: user.phone,
            from_name: user.name || '',
            from_avatar: user.avatar || null,
            sdp: msg.sdp,
          },
        });
        console.log(`📲 App fermée chez ${to} → notification envoyée, appel en salle d'attente`);
        try { ws.send(JSON.stringify({ type: 'push-sent', call_id: msg.call_id })); } catch (_) {}
        return;
      }
    }
  } catch (e) {
    console.error('⚠️ Push appel :', e.message);
  }
  // Pas de jeton / push KO → vraiment injoignable
  try { ws.send(JSON.stringify({ type: 'peer-offline', call_id: msg.call_id })); } catch (_) {}
}

module.exports = { init, isOnline };
