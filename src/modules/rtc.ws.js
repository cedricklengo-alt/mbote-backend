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
const jwt = require('jsonwebtoken');
const db = require('../db');
const { normalizePhone } = require('../util');

const SECRET = process.env.JWT_SECRET || 'dev-secret';

/** téléphone (normalisé) → { ws, user } */
const online = new Map();

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
      const payload = jwt.verify(url.searchParams.get('token') || '', SECRET);
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

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
      const type = String(msg.type || '');
      if (!['offer', 'answer', 'ice', 'reject', 'hangup', 'ringing'].includes(type)) return;

      const to = normalizePhone(msg.to);
      const dest = to && online.get(to);
      if (type !== 'ice') console.log(`📨 WS ${type} : ${user.phone} → ${to} ${dest ? '✓' : '✗ hors ligne'}`);
      if (!dest) {
        // Destinataire hors ligne → on prévient l'appelant
        if (type === 'offer') {
          try { ws.send(JSON.stringify({ type: 'peer-offline', call_id: msg.call_id })); } catch (_) {}
        }
        return;
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
  }, 30000).unref();

  console.log('🎙️  Canal temps réel /ws prêt (appels voix MboteCall)');
}

module.exports = { init, isOnline };
