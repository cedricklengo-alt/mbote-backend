/**
 * 🎙️ RTC — signalisation temps réel des appels voix MboteCall → MboteCall.
 * v3.0 — « standardiste » complet.
 *
 * La voix ne passe PAS par ce serveur (WebRTC direct de téléphone à
 * téléphone). Le serveur fait passer les messages techniques ET garantit que
 * le téléphone appelé SONNE, quel que soit son état :
 *
 *   app ouverte        → l'offre arrive par WebSocket ;
 *   app en arrière-plan→ offre par WebSocket + réveil par push (data-only) ;
 *   app fermée         → réveil par push, l'offre attend en « salle
 *                        d'attente » et est livrée dès que l'app se connecte ;
 *   socket fantôme     → (Android tue l'app sans fermer la connexion) pas de
 *                        « ringing » sous 4,5 s → on bascule sur le push ;
 *   push sans effet    → pas d'acquittement sous 5 s → notification visible.
 *
 * Messages client → serveur :
 *   offer · answer · ice · ringing · reject · hangup · reoffer · reanswer
 *   presence {state:'fg'|'bg'}   l'app est-elle au premier plan ?
 *   ping                         → réponse « pong » (test de vie)
 *   typing {to}                  « écrit… » (messagerie)
 *
 * Messages serveur → client (en plus du relais) :
 *   push-sent · peer-offline · pong · typing · msg
 *
 * Connexion : wss://<serveur>/ws?token=<JWT>
 */

const WebSocket = require('ws');
const db = require('../db');
const { normalizePhone } = require('../util');
const { verifyToken } = require('../middleware/auth');
const push = require('../services/push');

/** téléphone → { ws, user, fg, fgAt } */
const online = new Map();

/** call_id → appel suivi par le standardiste */
const calls = new Map();

/** Abonnements présence : targetPhone → Set<watcherId> (en mémoire, s'efface à la reconnexion) */
const presenceWatches = new Map(); // targetPhone → Set<userId>

/** Appels de groupe en cours : callId → { members: Map<phone,{ws,user}> } */
const groupCalls = new Map();

const RING_TTL = Number(process.env.RTC_RING_TTL_MS) || 55_000; // un appel sonne 55 s au maximum (réglable pour les tests)
const GHOST_MS = 4_500;         // pas de « ringing » sous 4,5 s → socket fantôme
const WAKE_ACK_MS = 5_000;      // pas d'acquittement du push sous 5 s → renfort visible
const CALLER_GONE_MS = 8_000;   // l'appelant a disparu → on arrête de sonner
const ENDED_KEEP_MS = 60_000;   // mémoire d'un appel terminé (ignore les signaux tardifs)
const ANSWERED_MAX_MS = 5 * 3600_000;
const MAX_CALL_ICE = 80;
const MAX_GROUP_MEMBERS = 4;    // appel de groupe « Mbote Famille », hôte compris

const log = (...a) => console.log(...a);
const warn = (...a) => console.error(...a);

/* ───────────── Utilitaires ───────────── */

function send(ws, obj) {
  try {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj));
      return true;
    }
  } catch (_) { /* socket mourante */ }
  return false;
}

function sendTo(phone, obj) {
  const e = online.get(phone);
  return e ? send(e.ws, obj) : false;
}

async function getUser(phone) {
  const u = await db.get(
    `SELECT id, name, fcm_token FROM users WHERE phone = ? AND status = 'active'`,
    [phone]);
  if (!u) return null;
  // 📱 Le jeton vit dans device_tokens (POST /api/auth/fcm-token) : l'ancienne
  // colonne users.fcm_token n'est plus alimentée par l'app.
  if (!u.fcm_token) u.fcm_token = await push.primaryToken(u.id);
  return u;
}

/** L'utilisateur est-il connecté au canal temps réel ? */
function isOnline(phone) {
  const p = normalizePhone(phone);
  return !!(p && online.has(p));
}

/**
 * L'application est-elle au PREMIER PLAN ?
 * L'app annonce son état juste après la connexion (message `presence`).
 * Sert à décider s'il faut doubler le message temps réel par un push :
 * inutile de réveiller un téléphone dont l'écran est déjà ouvert.
 */
function isForeground(phone) {
  const p = normalizePhone(phone);
  if (!p) return false;
  const e = online.get(p);
  return !!(e && e.ws && e.ws.readyState === WebSocket.OPEN && e.fg);
}

/* 🛡️ Anti-abus : chaque offre déclenche un push chez l'appelé */
const offerBuckets = new Map(); // téléphone → { n, reset }
function allowOffer(phone) {
  const t = Date.now();
  let b = offerBuckets.get(phone);
  if (!b || t > b.reset) { b = { n: 0, reset: t + 60_000 }; offerBuckets.set(phone, b); }
  return ++b.n <= 12; // 12 appels / minute / numéro
}

/* ───────────── Cycle de vie d'un appel ───────────── */

function clearTimers(call) {
  clearTimeout(call.ghostTimer);
  clearTimeout(call.wakeTimer);
  clearTimeout(call.ttlTimer);
  call.ghostTimer = call.wakeTimer = call.ttlTimer = null;
}

/** Appel terminé (quelle qu'en soit la raison) : on garde une trace brève */
function finish(call) {
  if (call.state === 'ended') return;
  call.state = 'ended';
  call.endedAt = Date.now();
  call.ice = [];
  call.offerMsg = null; // libère le SDP / la photo
  clearTimers(call);
}

/** L'appelé a donné signe de vie : plus de doute, plus de renfort */
function onRingAck(call) {
  if (call.state !== 'ringing' || call.ringAck) return;
  call.ringAck = true;
  clearTimeout(call.ghostTimer);
  clearTimeout(call.wakeTimer);
  call.ghostTimer = call.wakeTimer = null;
  sendTo(call.caller, { type: 'ringing', call_id: call.id, from: call.callee });
}

/**
 * 📲 Réveille le téléphone de l'appelé par notification (data-only).
 * Si l'app ne confirme pas sous 5 s → notification VISIBLE en renfort.
 * → true si un push est parti (ou l'était déjà).
 */
async function wake(call) {
  if (call.pushSent) return true;
  if (!push.enabled()) return false;
  const callee = await getUser(call.callee);
  if (!callee || !callee.fcm_token || call.state !== 'ringing') return false;
  const info = { callId: call.id, fromName: call.callerName, fromPhone: call.caller };
  const ok = await push.sendCallPush(callee.fcm_token, info);
  if (!ok) return false;
  call.pushSent = true;
  log(`📲 Réveil push → ${call.callee} (appel ${call.id})`);
  call.wakeTimer = setTimeout(async () => {
    call.wakeTimer = null;
    if (call.state !== 'ringing' || call.ringAck) return;
    try {
      const c = await getUser(call.callee);
      if (c && c.fcm_token && call.state === 'ringing' && !call.ringAck) {
        await push.sendCallFallbackPush(c.fcm_token, info);
        call.fallbackSent = true;
        log(`🔔 Pas d'acquittement → notification visible → ${call.callee}`);
      }
    } catch (_) {}
  }, WAKE_ACK_MS);
  if (call.wakeTimer.unref) call.wakeTimer.unref();
  return true;
}

/** 👻 L'appelé a un socket qui ne répond pas → on le ferme et on passe au push */
function armGhostGuard(call) {
  clearTimeout(call.ghostTimer);
  call.ghostTimer = setTimeout(async () => {
    call.ghostTimer = null;
    if (call.state !== 'ringing' || call.ringAck) return;
    const cur = online.get(call.callee);
    if (cur) {
      try { cur.ws.terminate(); } catch (_) {}
      online.delete(call.callee);
    }
    log(`👻 WS fantôme chez ${call.callee} → bascule sur notification push`);
    call.delivered = false;
    const ok = await wake(call);
    if (call.state !== 'ringing') return;
    if (ok) {
      sendTo(call.caller, { type: 'push-sent', call_id: call.id });
    } else {
      finish(call);
      sendTo(call.caller, { type: 'peer-offline', call_id: call.id });
    }
  }, GHOST_MS);
  if (call.ghostTimer.unref) call.ghostTimer.unref();
}

/**
 * 🚫 Fait disparaître l'écran d'appel chez l'appelé (push d'annulation) et
 * laisse « Appel manqué » dans sa barre. Seulement si on l'avait réveillé.
 */
async function notifyCancelled(call) {
  if (!call.pushSent) return;
  try {
    const callee = await getUser(call.callee);
    if (!callee || !callee.fcm_token) return;
    await push.sendCallCancelPush(callee.fcm_token,
      { callId: call.id, fromPhone: call.caller, reason: 'cancel' });
    await push.sendMissedCallPush(callee.fcm_token, call.callerName, call.caller);
    log(`📵 Appel manqué notifié : ${call.caller} → ${call.callee}`);
  } catch (_) {}
}

/** L'appelant renonce (hangup, déconnexion…) pendant que ça sonne */
function cancelByCaller(call, reason) {
  if (call.state !== 'ringing') return;
  finish(call);
  sendTo(call.callee, {
    type: 'hangup', call_id: call.id, from: call.caller, reason: reason || 'cancel',
  });
  notifyCancelled(call).catch(() => {});
  log(`🧹 Appel annulé (${reason || 'hangup'}) : ${call.caller} → ${call.callee}`);
}

/** Personne n'a décroché dans le délai */
function expireCall(call) {
  if (call.state !== 'ringing') return;
  finish(call);
  sendTo(call.callee, { type: 'hangup', call_id: call.id, from: call.caller, reason: 'timeout' });
  sendTo(call.caller, { type: 'peer-offline', call_id: call.id });
  notifyCancelled(call).catch(() => {});
  log(`⌛ Appel expiré : ${call.caller} → ${call.callee}`);
}

/* ───────────── API HTTP (app tuée : pas de WebSocket) ───────────── */

/** Le téléphone appelé confirme qu'il sonne (réveil par push réussi) */
function ackCall(phone, callId) {
  const call = calls.get(String(callId || ''));
  if (!call || call.callee !== phone || call.state !== 'ringing') return false;
  onRingAck(call);
  log(`✅ Acquittement HTTP : ${phone} sonne (appel ${call.id})`);
  return true;
}

/** Refus depuis la notification d'appel (l'app n'a pas de WebSocket) */
function declineCall(phone, callId) {
  const call = calls.get(String(callId || ''));
  if (!call || call.callee !== phone || call.state !== 'ringing') return false;
  finish(call);
  sendTo(call.caller, { type: 'reject', call_id: call.id, from: phone, reason: 'declined' });
  log(`🙅 Refus HTTP : ${phone} → ${call.caller}`);
  return true;
}

/** 💬 Prévient l'appli du destinataire (instantané, sans passer par FCM) */
function notifyMessage(toPhone, payload) {
  const p = normalizePhone(toPhone);
  return p ? sendTo(p, { type: 'msg', ...payload }) : false;
}

/**
 * ☎️ Clôture d'un appel depuis un module HTTP (annulation depuis
 * /calls/:id/cancel, refus depuis /rtc/decline) : l'autre partie est
 * prévenue en temps réel et, si son app n'est pas au premier plan, par push.
 * → true si un destinataire a été trouvé et notifié.
 */
async function endCall(callId, reason = 'cancel') {
  const id = String(callId || '');
  if (!id) return false;

  const live = calls.get(id);
  if (live) finish(live); // l'état en mémoire ne doit pas rester « sonne »

  const row = await db.get('SELECT user_id, callee_user_id FROM calls WHERE id = ?', [id])
    .catch(() => null);
  const declined = reason === 'declined' || reason === 'busy';

  const callerId = (row && row.user_id) || null;
  const calleeId = (row && row.callee_user_id) || null;
  const caller = await phoneOf(callerId, live && live.caller);
  const callee = await phoneOf(calleeId, live && live.callee);

  const targetId = declined ? callerId : calleeId;
  const target = declined ? caller : callee;
  if (!target) return false;

  const from = (declined ? callee : caller) || '';
  sendTo(target, {
    type: declined ? 'reject' : 'hangup',
    call_id: id,
    from,
    reason,
  });

  if (!isForeground(target) && targetId) {
    await push.sendUser(targetId, {
      data: { kind: 'call_cancel', call_id: id, from_phone: from, reason },
      title: declined ? 'Appel refusé' : 'Appel terminé',
      body: declined ? 'Ton appel a été refusé' : 'L’appel est terminé',
      channel: 'calls',
      collapseKey: `call-${id}`,
    }).catch(() => {});
  }

  log(`☎️ Appel clos (${reason}) : ${id}`);
  return true;
}

/** Téléphone d'un utilisateur (ou valeur de repli si déjà connue). */
async function phoneOf(userId, fallback) {
  if (fallback) return fallback;
  if (!userId) return null;
  const u = await db.get('SELECT phone FROM users WHERE id = ?', [userId]).catch(() => null);
  return u ? u.phone : null;
}

/* ───────────── Relais générique (appels inconnus du standardiste) ───────────── */

function forward(user, type, msg, to) {
  const fwd = {
    type,
    call_id: msg.call_id,
    from: user.phone,
    ...(msg.reason ? { reason: String(msg.reason).slice(0, 30) } : {}),
    ...(type === 'offer' ? {
      from_name: user.name || '', from_avatar: user.avatar || null, sdp: msg.sdp,
      // 📹 Le mode vidéo doit suivre l'offre : sans ce drapeau, l'appelé ne
      // saurait pas qu'il reçoit un appel vidéo et ouvrirait sa caméra… ou pas.
      video: msg.video === true,
    } : {}),
    ...((type === 'answer' || type === 'reoffer' || type === 'reanswer') ? { sdp: msg.sdp } : {}),
    ...(type === 'ice' ? { candidate: msg.candidate } : {}),
  };
  return sendTo(to, fwd);
}

/* ───────────── Traitement des messages ───────────── */

async function onOffer(ws, user, msg, to) {
  const callId = String(msg.call_id || '');
  if (!callId || callId.length > 80 || !to || to === user.phone) return;
  if (calls.has(callId)) return; // offre déjà reçue (renvoi) : idempotent

  if (!allowOffer(user.phone)) {
    send(ws, { type: 'reject', call_id: callId, from: to, reason: 'busy' });
    return;
  }
  // 📵 Un autre appelant fait déjà sonner ce numéro → « occupé » immédiat
  for (const c of calls.values()) {
    if (c.callee === to && c.state === 'ringing' && c.caller !== user.phone) {
      send(ws, { type: 'reject', call_id: callId, from: to, reason: 'busy' });
      log(`📵 Occupé : ${to} sonne déjà pour ${c.caller} (refus de ${user.phone})`);
      return;
    }
  }
  // Un ancien appel du même appelant vers le même numéro est abandonné
  for (const c of calls.values()) {
    if (c.caller === user.phone && c.state === 'ringing') cancelByCaller(c, 'replaced');
  }

  const call = {
    id: callId, caller: user.phone, callerName: user.name || '', callee: to,
    state: 'ringing', createdAt: Date.now(),
    offerMsg: {
      type: 'offer', call_id: callId, from: user.phone,
      from_name: user.name || '', from_avatar: user.avatar || null, sdp: msg.sdp,
      video: msg.video === true, // 📹 conservé pour l'appelé réveillé par push
    },
    ice: [], ringAck: false, pushSent: false, fallbackSent: false, delivered: false,
    ghostTimer: null, wakeTimer: null, ttlTimer: null,
  };
  calls.set(callId, call);
  call.ttlTimer = setTimeout(() => expireCall(call), RING_TTL);
  if (call.ttlTimer.unref) call.ttlTimer.unref();

  const entry = online.get(to);
  if (entry && send(entry.ws, call.offerMsg)) {
    call.delivered = true;
    armGhostGuard(call);
    // 📱 App connectée mais pas au premier plan : l'écran ne s'allumera pas
    // tout seul → on réveille AUSSI par notification.
    if (!entry.fg) {
      wake(call).catch((e) => warn('⚠️ wake :', e.message));
    }
    return;
  }
  // 💤 App fermée : réveil par push, l'offre attend en salle d'attente
  const ok = await wake(call);
  if (call.state !== 'ringing') return;
  if (ok) {
    log(`📲 App fermée chez ${to} → réveil envoyé, appel en salle d'attente`);
    send(ws, { type: 'push-sent', call_id: callId });
  } else {
    finish(call);
    send(ws, { type: 'peer-offline', call_id: callId });
  }
}

async function onMessage(ws, user, raw) {
  // 🛡️ Garde-fous : message trop gros ou rafale anormale → ignoré
  if (raw.length > 200_000) return;
  const t = Date.now();
  if (!ws._win || t > ws._win.reset) ws._win = { n: 0, reset: t + 10_000 };
  if (++ws._win.n > 400) return;

  let msg;
  try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
  if (!msg || typeof msg !== 'object') return;
  const type = String(msg.type || '');

  if (type === 'ping') { send(ws, { type: 'pong', t: msg.t }); return; }
  if (type === 'presence') {
    const e = online.get(user.phone);
    if (e && e.ws === ws) { e.fg = msg.state === 'fg'; e.fgAt = Date.now(); }
    return;
  }
  if (type === 'typing') {
    const to = normalizePhone(msg.to);
    if (to) sendTo(to, { type: 'typing', from: user.phone });
    return;
  }
  // ── Présence : "Rappelle-moi quand X se connecte" ──
  if (type === 'watch') {
    const target = normalizePhone(msg.target);
    if (!target) return;
    let set = presenceWatches.get(target);
    if (!set) { set = new Set(); presenceWatches.set(target, set); }
    set.add(user.id);
    log(`👁️  watch : ${user.phone} surveille ${target}`);
    return;
  }
  if (type === 'unwatch') {
    const target = normalizePhone(msg.target);
    if (target) { presenceWatches.get(target)?.delete(user.id); }
    return;
  }

  // ── Appels de groupe (Mesh P2P) ──
  if (type === 'group_join') {
    const gId = String(msg.call_id || '');
    if (!gId) return;
    let g = groupCalls.get(gId);

    // Salle absente → l'émetteur la crée et en devient l'hôte
    if (!g) {
      g = { members: new Map(), invited: new Set(), host: user.phone, createdAt: Date.now(),
            // 📹 mode de la salle : un invité rejoint en audio OU en vidéo,
            // l'invitation doit le lui dire (sinon il ouvrirait la caméra
            // d'un appel qui n'en veut pas, ou l'inverse).
            video: msg.video === true };
      groupCalls.set(gId, g);
    }

    // Déjà dedans : on renvoie simplement l'état courant (idempotent)
    if (g.members.has(user.phone)) {
      send(ws, {
        type: 'group_joined', call_id: gId,
        peers: [...g.members.keys()].filter(p => p !== user.phone),
      });
      return;
    }

    // 🔒 Autorisation : seuls l'hôte et les invités entrent. Sans ce contrôle,
    // connaître un call_id suffirait pour écouter une conversation privée.
    if (g.host !== user.phone && !g.invited.has(user.phone)) {
      send(ws, { type: 'group_error', call_id: gId, reason: 'not_authorized' });
      return;
    }

    // 🚧 Limite de participants
    if (g.members.size >= MAX_GROUP_MEMBERS) {
      send(ws, { type: 'group_error', call_id: gId, reason: 'room_full' });
      return;
    }

    // Prévenir les membres existants qu'un pair vient d'arriver
    for (const [, m] of g.members) {
      send(m.ws, { type: 'group_peer_joined', call_id: gId, from: user.phone, from_name: user.name });
    }
    g.members.set(user.phone, { ws, user });
    g.invited.delete(user.phone);   // invitation consommée
    // Renvoyer la liste des membres actuels à l'arrivant
    const peers = [...g.members.keys()].filter(p => p !== user.phone);
    send(ws, { type: 'group_joined', call_id: gId, peers });
    log(`👥 group_join : ${user.phone} → ${gId} (${g.members.size}/${MAX_GROUP_MEMBERS})`);
    return;
  }
  if (type === 'group_leave') {
    const gId = String(msg.call_id || '');
    const g = groupCalls.get(gId);
    if (g) {
      g.members.delete(user.phone);
      for (const [, m] of g.members) {
        send(m.ws, { type: 'group_peer_left', call_id: gId, from: user.phone });
      }
      if (g.members.size === 0) groupCalls.delete(gId);
    }
    return;
  }
  // 👥 Invitation : enregistre l'autorisation puis relaie
  if (type === 'group_invite') {
    const gId = String(msg.call_id || '');
    const to  = normalizePhone(msg.to);
    const g   = groupCalls.get(gId);
    // Seul un membre de la salle peut inviter
    if (!g || !g.members.has(user.phone)) {
      send(ws, { type: 'group_error', call_id: gId, reason: 'not_authorized' });
      return;
    }
    if (!to || to === user.phone) return;
    if (g.members.has(to)) return;             // déjà présent
    // La place doit exister : membres + invitations en attente
    if (g.members.size + g.invited.size >= MAX_GROUP_MEMBERS) {
      send(ws, { type: 'group_error', call_id: gId, reason: 'room_full' });
      return;
    }
    g.invited.add(to);
    const toEntry = online.get(to);
    if (toEntry) {
      send(toEntry.ws, {
        ...msg, from: user.phone, from_name: user.name,
        video: msg.video === true || g.video === true,
        peers: [...g.members.keys()],
      });
    } else {
      // Pas de réveil par push pour les invitations de groupe : on le dit à
      // l'inviteur plutôt que de laisser l'invitation disparaître en silence.
      send(ws, { type: 'group_error', call_id: gId, reason: 'peer_offline', phone: to });
    }
    return;
  }

  // 🔇 État micro/caméra diffusé aux autres membres (badges distants)
  if (type === 'group_mute') {
    const gId = String(msg.call_id || '');
    const g   = groupCalls.get(gId);
    if (!g || !g.members.has(user.phone)) return;
    for (const [ph, m] of g.members) {
      if (ph !== user.phone) send(m.ws, { ...msg, from: user.phone });
    }
    return;
  }

  if (['group_offer', 'group_answer', 'group_ice'].includes(type)) {
    const gId = String(msg.call_id || '');
    const to  = normalizePhone(msg.to);
    const g   = groupCalls.get(gId);
    // Émetteur ET destinataire doivent être dans la salle : sinon n'importe
    // quel compte connecté pourrait injecter du SDP dans une conversation.
    if (!g || !g.members.has(user.phone)) return;
    if (to && g.members.has(to)) {
      const toEntry = online.get(to);
      if (toEntry) send(toEntry.ws, { ...msg, from: user.phone });
    }
    return;
  }

  if (!['offer', 'answer', 'ice', 'reject', 'hangup', 'ringing', 'reoffer', 'reanswer'].includes(type)) return;

  const callId = String(msg.call_id || '');
  const call = calls.get(callId);
  let to = normalizePhone(msg.to);

  // 🗒️ Journal : le destinataire réel est résolu PLUS BAS (à partir de l'appel
  // suivi). L'ancienne ligne affichait « → null ✗ hors ligne » dès que le
  // client n'envoyait pas `to` dans son message `ringing`, ce qui faisait
  // croire à un échec alors que le message était bien routé.
  const cible = call
    ? (user.phone === call.caller ? call.callee : call.caller)
    : to;
  const etat = call
    ? (cible && online.has(cible) ? '✓' : '✗ hors ligne')
    : ' (appel inconnu du standardiste)';
  if (type !== 'ice') {
    log(`📨 WS ${type} : ${user.phone} → ${cible ?? '?'} ${etat}`);
  }

  if (type === 'offer') { await onOffer(ws, user, msg, to); return; }

  /* ── Appel connu du standardiste : routage strict entre les deux parties ── */
  if (call) {
    const isCaller = user.phone === call.caller;
    const isCallee = user.phone === call.callee;
    if (!isCaller && !isCallee) return; // un tiers ne peut rien injecter
    to = isCaller ? call.callee : call.caller;
    if (call.state === 'ended' && type !== 'hangup') {
      // Signal tardif. Si l'appelé décroche un appel déjà expiré/annulé, on le
      // lui dit tout de suite (sinon il resterait bloqué sur « connexion »).
      if (type === 'answer' && isCallee) {
        send(ws, { type: 'hangup', call_id: call.id, from: call.caller, reason: 'ended' });
      }
      return;
    }

    switch (type) {
      case 'ringing':
        if (isCallee) onRingAck(call);
        return;

      case 'answer':
        if (!isCallee || call.state !== 'ringing') return;
        call.state = 'answered';
        call.answeredAt = Date.now();
        call.ringAck = true;
        clearTimers(call);
        call.ice = [];
        call.offerMsg = null;
        forward(user, 'answer', msg, to);
        // 🔕 Réponse : tout écran d'appel resté ailleurs (push) doit disparaître
        if (call.pushSent) {
          getUser(call.callee).then((c) => {
            if (c && c.fcm_token) push.sendCallCancelPush(c.fcm_token,
              { callId: call.id, fromPhone: call.caller, reason: 'answered' });
          }).catch(() => {});
        }
        return;

      case 'ice':
        if (call.state === 'ringing' && isCaller) {
          // Mémorisé pour rejeu (socket fantôme, app réveillée par push…)
          if (call.ice.length < MAX_CALL_ICE) {
            call.ice.push({ call_id: call.id, candidate: msg.candidate });
          }
        }
        forward(user, 'ice', msg, to);
        return;

      case 'reject':
        if (!isCallee || call.state !== 'ringing') return;
        finish(call);
        forward(user, 'reject', msg, to);
        return;

      case 'hangup':
        if (call.state === 'ringing') {
          if (isCaller) { cancelByCaller(call, msg.reason); return; }
          // l'appelé raccroche pendant la sonnerie = refus
          finish(call);
          forward(user, 'reject', { ...msg, reason: msg.reason || 'declined' }, to);
          return;
        }
        if (call.state === 'answered') finish(call); // trace brève puis purge
        forward(user, 'hangup', msg, to);
        return;

      default: // reoffer / reanswer
        forward(user, type, msg, to);
        return;
    }
  }

  /* ── Appel inconnu (serveur redémarré en pleine conversation) : relais simple ── */
  if (!to) return;
  forward(user, type, msg, to);
}

/* ───────────── Initialisation ───────────── */

function init(server) {
  const wss = new WebSocket.Server({ server, path: '/ws', maxPayload: 256 * 1024 });

  wss.on('connection', async (ws, req) => {
    let user;
    try {
      const url = new URL(req.url, 'http://x');
      const payload = verifyToken(url.searchParams.get('token') || '');
      if (!payload) throw new Error('jeton invalide');
      user = await db.get(
        `SELECT id, phone, name, avatar FROM users WHERE id = ? AND status = 'active'`,
        [payload.uid]);
    } catch (_) { /* jeton invalide */ }
    if (!user) return ws.close(4001, 'auth');

    // Une seule connexion par numéro : la nouvelle remplace l'ancienne.
    // Code 4002 = « remplacée » : l'ancien appareil ne boucle pas en reconnexion.
    const prev = online.get(user.phone);
    if (prev && prev.ws !== ws) { try { prev.ws.close(4002, 'replaced'); } catch (_) {} }
    // fg=false par défaut : l'app annonce son état juste après (presence)
    online.set(user.phone, { ws, user, fg: false, fgAt: 0 });
    log(`🔌 WS connecté : ${user.phone} (${online.size} en ligne)`);
    ws._phone = user.phone;
    ws._alive = true;
    ws.on('pong', () => { ws._alive = true; });

    // 📬 Appels qui attendaient ce téléphone (réveil par push, reconnexion…)
    for (const call of calls.values()) {
      if (call.callee !== user.phone || call.state !== 'ringing' || !call.offerMsg) continue;
      if (Date.now() - call.createdAt > RING_TTL) continue;
      if (send(ws, call.offerMsg)) {
        call.delivered = true;
        for (const i of call.ice) {
          send(ws, { type: 'ice', call_id: i.call_id, from: call.caller, candidate: i.candidate });
        }
        log(`📬 Appel en attente livré : ${call.caller} → ${user.phone}`);
      }
    }

    // 📡 Présence : notifier les watchers que ce contact est de retour
    {
      const set = presenceWatches.get(user.phone);
      if (set && set.size > 0) {
        const watchers = [...set];
        set.clear();  // une seule notification par session off→on
        presenceWatches.delete(user.phone);
        for (const watcherId of watchers) {
          // Notifier en temps réel si le watcher est connecté
          for (const [ph, e] of online) {
            if (e.user.id === watcherId) {
              send(e.ws, { type: 'contact_online', phone: user.phone, name: user.name });
            }
          }
          // Notifier par push si le watcher est hors ligne
          push.primaryToken(watcherId).then(token => {
            if (token) {
              push.sendData(token, {
                kind: 'contact_online',
                from_phone: user.phone,
                from_name: user.name || '',
              }).catch(() => {});
            }
          }).catch(() => {});
        }
      }
    }

    ws.on('message', (raw) => {
      onMessage(ws, user, raw).catch((e) => warn('⚠️ WS message :', e.message));
    });

    ws.on('close', () => {
      const cur = online.get(ws._phone);
      if (cur && cur.ws === ws) {
        online.delete(ws._phone);
        log(`🔌 WS déconnecté : ${ws._phone} (${online.size} en ligne)`);
        // 📅 Horodater la dernière vue
        db.run('UPDATE users SET last_seen_at = ? WHERE phone = ?', [Date.now(), ws._phone]).catch(() => {});
        // 🗑️ Retirer ce téléphone des appels de groupe actifs
        for (const [gId, g] of groupCalls) {
          if (g.members.has(ws._phone)) {
            g.members.delete(ws._phone);
            for (const [, m] of g.members) {
              send(m.ws, { type: 'group_peer_left', call_id: gId, from: ws._phone });
            }
            if (g.members.size === 0) groupCalls.delete(gId);
          }
        }
        // 🏃 L'appelant a disparu en pleine sonnerie ? Délai de grâce (micro-coupure)
        const phone = ws._phone;
        const timer = setTimeout(() => {
          if (online.has(phone)) return; // il est revenu
          for (const c of calls.values()) {
            if (c.caller === phone && c.state === 'ringing') cancelByCaller(c, 'caller_gone');
          }
        }, CALLER_GONE_MS);
        if (timer.unref) timer.unref();
      }
    });
  });

  // 💓 Battement de cœur (30 s) + ménage
  setInterval(() => {
    for (const [phone, { ws }] of online) {
      if (!ws._alive) { try { ws.terminate(); } catch (_) {} online.delete(phone); continue; }
      ws._alive = false;
      try { ws.ping(); } catch (_) {}
    }
    const t = Date.now();
    for (const [id, c] of calls) {
      if (c.state === 'ended' && t - c.endedAt > ENDED_KEEP_MS) calls.delete(id);
      else if (c.state === 'answered' && t - c.answeredAt > ANSWERED_MAX_MS) calls.delete(id);
      else if (c.state === 'ringing' && t - c.createdAt > RING_TTL + 30_000) { finish(c); }
    }
    for (const [p, b] of offerBuckets) if (t > b.reset) offerBuckets.delete(p);
  }, 30_000).unref();

  log('🎙️  Canal temps réel /ws prêt (appels voix MboteCall)');
}

/** 🧪 Diagnostic (tests) */
function _debug() {
  return {
    online: [...online.entries()].map(([p, e]) => ({ phone: p, fg: e.fg })),
    calls: [...calls.values()].map((c) => ({
      id: c.id, caller: c.caller, callee: c.callee, state: c.state,
      ringAck: c.ringAck, pushSent: c.pushSent, fallbackSent: c.fallbackSent,
    })),
  };
}

/** Statut de présence d'un téléphone : {online: bool, lastSeenAt: number|null} */
async function getPresence(phones) {
  const result = {};
  for (const phone of phones) {
    const norm = normalizePhone(phone);
    if (!norm) continue;
    if (online.has(norm)) {
      result[norm] = { online: true, lastSeenAt: null };
    } else {
      const u = await db.get('SELECT last_seen_at FROM users WHERE phone = ?', [norm]);
      result[norm] = { online: false, lastSeenAt: u ? u.last_seen_at : null };
    }
  }
  return result;
}

module.exports = {
  init, isOnline, isForeground,
  /** Envoyer un message à un utilisateur connecté (depuis un autre module) */
  sendTo,
  ackCall, declineCall, endCall,
  notifyMessage, getPresence, presenceWatches, _debug,
};
