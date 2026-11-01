/**
 * rtc.ws.js — Serveur de signalement WebRTC (appels 1-1 et groupes)
 *
 * Protocole :
 *   Client → serveur : ping | presence | offer | answer | ice | reoffer |
 *                       reanswer | ack | decline | hangup |
 *                       group_join | group_leave | group_invite |
 *                       group_offer | group_answer | group_ice | group_mute
 *   Serveur → client  : pong | ringing | offer | answer | ice | reoffer |
 *                       reanswer | push_sent | peer_offline | reject | hangup |
 *                       group_joined | group_peer_joined | group_peer_left |
 *                       group_invite | group_offer | group_answer | group_ice |
 *                       group_mute | group_error
 *
 * Salles : une salle est créée par son hôte (premier group_join). Seuls l'hôte
 * et les téléphones invités (group_invite) peuvent la rejoindre — connaître un
 * call_id ne suffit pas. Limite : MAX_GROUP_MEMBERS, invitations en attente
 * comprises.
 */

const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const db = require('../db');
const { normalizePhone, now } = require('../util');
const push = require('../services/push');

const SECRET = process.env.JWT_SECRET || 'dev-secret';
const MAX_GROUP_MEMBERS = 4; // limite : créateur compris

// ── État en mémoire ──────────────────────────────────────────────────────────

/** phone → WebSocket (connexion active) */
const online = new Map();

/**
 * callId → {
 *   members : Map<userId, { ws, user: {id,phone,name} }>,
 *   createdAt: number
 * }
 */
const groupCalls = new Map();
const callTimers = new Map();

// ── Authentification ──────────────────────────────────────────────────────────

async function authenticate(req) {
  const raw = req.url || '';
  // Extrait le token du query string manuellement (pas besoin d'URL complète)
  const m = raw.match(/[?&]token=([^&]+)/);
  let token = null;
  try { token = m ? decodeURIComponent(m[1]) : null; } catch { return null; }
  if (!token) return null;
  let payload;
  try {
    payload = jwt.verify(token, SECRET);
  } catch {
    return null;
  }
  const user = await db.get(
    'SELECT id, phone, name, avatar, status, presence_visible FROM users WHERE id = ?',
    [payload.uid]
  );
  if (!user || user.status !== 'active') return null;
  return user;
}

// ── Helpers d'envoi ──────────────────────────────────────────────────────────

function wsSend(ws, msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify(msg)); } catch { /* connexion morte */ }
  }
}

function isForeground(phone) {
  const ws = online.get(phone);
  return !!(ws && ws.readyState === WebSocket.OPEN && ws._fg !== false);
}

function isOnline(phone) {
  const ws = online.get(phone);
  return !!(ws && ws.readyState === WebSocket.OPEN);
}

function sendTo(phone, msg) {
  const ws = online.get(phone);
  if (!ws) return false;
  wsSend(ws, msg);
  return ws.readyState === WebSocket.OPEN;
}

function roomBroadcast(room, msg, excludeUserId = null) {
  const str = JSON.stringify(msg);
  for (const [uid, { ws }] of room.members) {
    if (uid !== excludeUserId && ws.readyState === WebSocket.OPEN) {
      try { ws.send(str); } catch { /* connexion morte */ }
    }
  }
}

/** Liste publique des membres d'une salle, en excluant éventuellement l'un d'eux */
function membersOf(room, excludeUserId) {
  return [...room.members.values()]
    .filter(m => m.user.id !== excludeUserId)
    .map(m => ({ phone: m.user.phone, name: m.user.name }));
}

function callTimeout(callId) {
  const old = callTimers.get(callId);
  if (old) clearTimeout(old);
  const timer = setTimeout(async () => {
    callTimers.delete(callId);
    try {
      const call = await db.get("SELECT * FROM calls WHERE id=? AND rtc_mode=1 AND status='ringing'", [callId]);
      if (!call || now() - call.started_at < 70000) return;
      await db.run("UPDATE calls SET status='ended',ended_at=?,hangup_cause='timeout' WHERE id=? AND status='ringing'", [now(), callId]);
      const caller = await db.get('SELECT phone FROM users WHERE id=?', [call.user_id]);
      const callee = call.callee_user_id ? await db.get('SELECT phone FROM users WHERE id=?', [call.callee_user_id]) : null;
      if (caller) sendTo(caller.phone, { type: 'hangup', call_id: callId, reason: 'timeout' });
      if (callee && isOnline(callee.phone)) sendTo(callee.phone, { type: 'hangup', call_id: callId, reason: 'timeout' });
      if (callee && !isForeground(callee.phone)) {
        await push.sendUser(call.callee_user_id, {
          data: { kind: 'call_cancel', call_id: callId, from_phone: caller?.phone || '', reason: 'timeout' },
          title: 'Appel manqué', body: caller?.phone || 'Appel MboteCall', channel: 'calls',
          collapseKey: `call-${callId}`,
        });
      }
    } catch {
      // L'expiration sera reprise à la prochaine connexion si la base était indisponible.
    }
  }, 75000);
  if (timer.unref) timer.unref();
  callTimers.set(callId, timer);
}

async function deliverPendingOffers(ws, user) {
  const rows = await db.all(`
    SELECT c.id,c.offer_sdp,c.with_video,c.started_at,u.phone AS from_phone,u.name AS from_name,u.avatar AS from_avatar
    FROM calls c JOIN users u ON u.id=c.user_id
    WHERE c.callee_user_id=? AND c.rtc_mode=1 AND c.status='ringing'
      AND c.offer_sdp IS NOT NULL AND c.started_at > ?
    ORDER BY c.started_at ASC
  `, [user.id, now() - 75000]);
  for (const row of rows) {
    let sdp;
    try { sdp = JSON.parse(row.offer_sdp); } catch { continue; }
    wsSend(ws, {
      type: 'offer', call_id: row.id, from: row.from_phone, from_name: row.from_name,
      from_avatar: row.from_avatar || null, has_video: row.with_video === true || row.with_video === 1, sdp,
    });
    callTimeout(row.id);
  }
}

async function notifyPresenceReminders(user) {
  const reminders = await db.all(`
    SELECT pr.owner_id, u.name, u.phone
    FROM presence_reminders pr JOIN users u ON u.id=pr.owner_id
    WHERE pr.target_id=? AND pr.notified_at IS NULL AND u.notifications_enabled=1
  `, [user.id]);
  for (const reminder of reminders) {
    const data = {
      kind: 'presence_available', peer_phone: user.phone, peer_name: user.name || user.phone,
      from_phone: user.phone, from_name: user.name || user.phone, preview: 'De nouveau en ligne',
    };
    sendTo(reminder.phone, { type: 'msg', ...data, from_phone: user.phone });
    const sent = isForeground(reminder.phone) || await push.sendUser(reminder.owner_id, {
      data, title: user.name || user.phone,
      body: `${user.name || user.phone} est de nouveau en ligne`,
      channel: 'messages', collapseKey: `presence-${user.id}`,
    });
    if (sent) await db.run('UPDATE presence_reminders SET notified_at=? WHERE owner_id=? AND target_id=? AND notified_at IS NULL', [now(), reminder.owner_id, user.id]);
  }
}

function deliverPendingGroupInvites(ws, user) {
  for (const [callId, room] of groupCalls) {
    if (!room.invited.has(user.phone) || room.members.has(user.id)) continue;
    const host = [...room.members.values()].find((m) => m.user.phone === room.creator);
    if (!host) continue;
    wsSend(ws, {
      type: 'group_invite', call_id: callId, from: host.user.phone,
      from_name: host.user.name, with_video: room.withVideo === true,
      members: membersOf(room, null),
    });
  }
}

// ── Gestion des salles de groupe ─────────────────────────────────────────────

/**
 * Retire un utilisateur de TOUTES ses salles actives.
 * Idempotent — sans effet si l'utilisateur n'est dans aucune salle.
 */
function leaveAllRooms(userId) {
  for (const [callId, room] of groupCalls) {
    _leaveRoom(callId, room, userId);
  }
}

function _leaveRoom(callId, room, userId) {
  const member = room.members.get(userId);
  if (!member) return;
  room.members.delete(userId);
  roomBroadcast(room, {
    type: 'group_peer_left',
    call_id: callId,
    phone: member.user.phone,
    name: member.user.name,
  });
  if (room.members.size === 0) groupCalls.delete(callId);
}

// ── Gestionnaire de messages WebSocket ───────────────────────────────────────

async function onMessage(ws, user, raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  const type = msg.type;
  if (!type) return;

  switch (type) {

    // ── Ping applicatif (maintien de connexion) ──────────────────────────────
    case 'ping':
      wsSend(ws, { type: 'pong', t: msg.t });
      break;

    // ── Présence (fg / bg) — informatif ────────────────────────────────────
    case 'presence':
      ws._fg = msg.state === 'fg';
      break;

    // ── Signalement 1-1 : chaque échange appartient à un appel autorisé ─────
    case 'offer':
    case 'answer':
    case 'ice':
    case 'reoffer':
    case 'reanswer':
    case 'ringing':
    case 'ack':
    case 'reject':
    case 'decline':
    case 'hangup': {
      const callId = String(msg.call_id || '').slice(0, 120);
      const toPhone = normalizePhone(msg.to);
      if (!callId || !toPhone) break;
      const call = await db.get(`
        SELECT c.*, callee.phone AS callee_phone, caller.phone AS caller_phone,
               caller.name AS caller_name, caller.avatar AS caller_avatar
        FROM calls c
        JOIN users callee ON callee.id=c.callee_user_id
        JOIN users caller ON caller.id=c.user_id
        WHERE c.id=? AND c.rtc_mode=1
      `, [callId]);
      if (!call || call.status === 'ended' || (type === 'offer' && call.status !== 'ringing')) {
        if (type === 'offer') wsSend(ws, { type: 'peer_offline', call_id: callId, to: toPhone });
        break;
      }
      const isCaller = call.user_id === user.id;
      const isCallee = call.callee_user_id === user.id;
      const expectedPhone = isCaller ? call.callee_phone : isCallee ? call.caller_phone : null;
      if (!expectedPhone || toPhone !== expectedPhone) break;
      const target = online.get(toPhone);

      if (type === 'offer') {
        const sdp = msg.sdp;
        if (!isCaller || !sdp || sdp.type !== 'offer' || typeof sdp.sdp !== 'string' || sdp.sdp.length > 250000) break;
        const withVideo = msg.has_video === true;
        await db.run('UPDATE calls SET offer_sdp=?,with_video=? WHERE id=? AND status=\'ringing\'', [JSON.stringify(sdp), withVideo ? 1 : 0, callId]);
        const offer = {
          type: 'offer', call_id: callId, from: user.phone, from_name: user.name,
          from_avatar: user.avatar || null, has_video: withVideo, sdp,
        };
        if (target) wsSend(target, offer);
        if (!target || !isForeground(toPhone)) {
          const delivered = await push.sendUser(call.callee_user_id, {
            data: { kind: 'incoming_call', call_id: callId, from_phone: user.phone, from_name: user.name || user.phone, with_video: withVideo ? '1' : '0' },
            title: withVideo ? 'Appel vidéo MboteCall' : 'Appel MboteCall',
            body: `${user.name || user.phone} t’appelle`, channel: 'calls', collapseKey: `call-${callId}`,
          });
          if (delivered) wsSend(ws, { type: 'push-sent', call_id: callId });
          else if (!target) wsSend(ws, { type: 'peer_offline', call_id: callId, to: toPhone });
        }
        callTimeout(callId);
        break;
      }

      if (type === 'answer') {
        const sdp = msg.sdp;
        if (!isCallee || !sdp || sdp.type !== 'answer' || typeof sdp.sdp !== 'string' || sdp.sdp.length > 250000) break;
        await db.run("UPDATE calls SET status='answered',answered_at=COALESCE(answered_at,?) WHERE id=? AND status='ringing'", [now(), callId]);
        clearTimeout(callTimers.get(callId));
        callTimers.delete(callId);
        if (target) wsSend(target, { ...msg, from: user.phone });
        if (!isForeground(call.caller_phone)) await push.sendUser(call.user_id, {
          data: { kind: 'call_cancel', call_id: callId, from_phone: call.callee_phone, reason: 'answered' },
          title: 'Appel répondu', body: 'Ton appel a été répondu', channel: 'calls', collapseKey: `call-${callId}`,
        });
        break;
      }

      if (type === 'reject' || type === 'decline' || type === 'hangup') {
        if (type !== 'hangup' && !isCallee) break;
        const reason = type === 'hangup' ? (msg.reason === 'timeout' ? 'timeout' : 'cancel') : (msg.reason === 'busy' ? 'busy' : 'declined');
        await db.run("UPDATE calls SET status='ended',ended_at=?,hangup_cause=? WHERE id=? AND status!='ended'", [now(), reason, callId]);
        clearTimeout(callTimers.get(callId));
        callTimers.delete(callId);
        if (target) wsSend(target, { type: type === 'hangup' ? 'hangup' : 'reject', call_id: callId, reason, from: user.phone });
        else {
          const targetId = isCaller ? call.callee_user_id : call.user_id;
          const fromPhone = isCaller ? call.caller_phone : call.callee_phone;
          await push.sendUser(targetId, {
            data: { kind: 'call_cancel', call_id: callId, from_phone: fromPhone, reason },
            title: reason === 'declined' ? 'Appel refusé' : 'Appel terminé',
            body: reason === 'declined' ? 'Ton appel a été refusé' : 'L’appel est terminé',
            channel: 'calls', collapseKey: `call-${callId}`,
          });
        }
        break;
      }

      if (type === 'ringing' && !isCallee) break;
      if (type === 'reoffer' && !isCaller) break;
      if (type === 'reanswer' && !isCallee) break;
      if (type === 'ice' && !isCaller && !isCallee) break;
      if (type === 'reoffer' || type === 'reanswer') {
        const expectedType = type === 'reoffer' ? 'offer' : 'answer';
        if (!msg.sdp || msg.sdp.type !== expectedType || typeof msg.sdp.sdp !== 'string' || msg.sdp.sdp.length > 250000) break;
      }
      if (type === 'ice' && (!msg.candidate || typeof msg.candidate !== 'object' ||
          (typeof msg.candidate.candidate === 'string' && msg.candidate.candidate.length > 10000))) break;
      if (target) wsSend(target, { ...msg, from: user.phone });
      else if (type === 'ringing') wsSend(ws, { type: 'peer_offline', call_id: callId, to: toPhone });
      break;
    }

    // ── Appel de groupe : rejoindre ──────────────────────────────────────────
    case 'group_join': {
      const callId = String(msg.call_id || '');
      if (!/^[A-Za-z0-9_-]{1,120}$/.test(callId)) break;

      let room = groupCalls.get(callId);

      // Salle inexistante → l'émetteur la crée et en devient l'hôte
      if (!room) {
        room = {
          members: new Map(),
          invited: new Set(),   // téléphones autorisés à rejoindre
          allowed: new Set(),
          withVideo: msg.with_video === true,
          creator: user.phone,
          createdAt: Date.now(),
        };
        groupCalls.set(callId, room);
      }

      // Idempotent : déjà dans la salle → on renvoie l'état actuel
      if (room.members.has(user.id)) {
        wsSend(ws, {
          type: 'group_joined',
          call_id: callId,
          members: membersOf(room, user.id),
        });
        break;
      }

      // 🔒 Autorisation : seuls l'hôte et les invités entrent. Sans ce
      // contrôle, connaître un call_id suffirait pour écouter une salle.
      if (room.creator !== user.phone && !room.allowed.has(user.phone)) {
        wsSend(ws, {
          type: 'group_error',
          call_id: callId,
          reason: 'not_authorized',
        });
        break;
      }

      // Salle pleine
      if (room.members.size >= MAX_GROUP_MEMBERS) {
        wsSend(ws, { type: 'group_error', call_id: callId, reason: 'room_full' });
        break;
      }

      // Notifier les membres existants
      roomBroadcast(room, {
        type: 'group_peer_joined',
        call_id: callId,
        phone: user.phone,
        name: user.name,
      });

      // Ajouter le membre
      room.members.set(user.id, { ws, user });
      room.invited.delete(user.phone); // invitation consommée

      // Envoyer la liste des membres actuels au nouvel arrivant
      wsSend(ws, {
        type: 'group_joined',
        call_id: callId,
        members: membersOf(room, user.id),
      });
      break;
    }

    // ── Appel de groupe : inviter un contact ────────────────────────────────
    case 'group_invite': {
      const callId = String(msg.call_id || '');
      const toPhone = normalizePhone(msg.to);
      if (!/^[A-Za-z0-9_-]{1,120}$/.test(callId) || !toPhone) break;

      const room = groupCalls.get(callId);
      // Seul un membre de la salle peut inviter
      if (!room || !room.members.has(user.id)) {
        wsSend(ws, {
          type: 'group_error',
          call_id: callId,
          reason: 'not_authorized',
        });
        break;
      }

      if (toPhone === user.phone) break; // s'inviter soi-même : sans objet

      // Déjà présent → rien à faire
      const already = [...room.members.values()]
        .some(m => m.user.phone === toPhone);
      if (already) break;
      if (room.invited.has(toPhone)) break;

      // La place doit exister : membres présents + invitations en attente
      if (room.members.size + room.invited.size >= MAX_GROUP_MEMBERS) {
        wsSend(ws, { type: 'group_error', call_id: callId, reason: 'room_full' });
        break;
      }

      const target = online.get(toPhone);
      const invitee = await db.get('SELECT id,status FROM users WHERE phone=?', [toPhone]);
      if (!invitee || invitee.status === 'blocked') {
        room.invited.delete(toPhone);
        room.allowed.delete(toPhone);
        wsSend(ws, { type: 'group_error', call_id: callId, reason: 'unknown_user', phone: toPhone });
        break;
      }
      room.invited.add(toPhone);
      room.allowed.add(toPhone);
      room.withVideo = room.withVideo || msg.with_video === true;
      const invitation = {
        type: 'group_invite', call_id: callId, from: user.phone, from_name: user.name,
        with_video: room.withVideo, members: membersOf(room, null),
      };
      if (target) {
        wsSend(target, invitation);
        if (!isForeground(toPhone)) await push.sendUser(invitee.id, {
          data: { kind: 'group_invite', call_id: callId, from_phone: user.phone, from_name: user.name || user.phone, with_video: room.withVideo ? '1' : '0' },
          title: 'Invitation Mbote Famille',
          body: `${user.name || user.phone} t’invite à un appel de groupe`,
          channel: 'calls', collapseKey: `group-${callId}`,
        });
      } else {
        const delivered = await push.sendUser(invitee.id, {
          data: { kind: 'group_invite', call_id: callId, from_phone: user.phone, from_name: user.name || user.phone, with_video: room.withVideo ? '1' : '0' },
          title: 'Invitation Mbote Famille',
          body: `${user.name || user.phone} t’invite à un appel de groupe`,
          channel: 'calls', collapseKey: `group-${callId}`,
        });
        if (!delivered) {
          room.invited.delete(toPhone);
          room.allowed.delete(toPhone);
          wsSend(ws, { type: 'group_error', call_id: callId, reason: 'peer_offline', phone: toPhone });
        }
      }
      break;
    }

    // ── Appel de groupe : quitter ────────────────────────────────────────────
    case 'group_leave': {
      const callId = msg.call_id;
      if (!callId) break;
      const room = groupCalls.get(callId);
      if (room) _leaveRoom(callId, room, user.id);
      break;
    }

    // ── Signalement de groupe (offre / réponse / ICE) ───────────────────────
    case 'group_offer':
    case 'group_answer':
    case 'group_ice': {
      const callId = String(msg.call_id || '');
      const toPhone = normalizePhone(msg.to);
      if (!/^[A-Za-z0-9_-]{1,120}$/.test(callId) || !toPhone) break;

      if (type === 'group_offer' || type === 'group_answer') {
        const expectedType = type === 'group_offer' ? 'offer' : 'answer';
        if (!msg.sdp || msg.sdp.type !== expectedType || typeof msg.sdp.sdp !== 'string' || msg.sdp.sdp.length > 250000) break;
      } else if (!msg.candidate || typeof msg.candidate !== 'object' ||
          (typeof msg.candidate.candidate === 'string' && msg.candidate.candidate.length > 10000)) break;

      const room = groupCalls.get(callId);
      if (!room || !room.members.has(user.id)) break; // expéditeur doit être dans la salle

      const target = [...room.members.values()].find(m => m.user.phone === toPhone);
      if (!target) break;

      wsSend(target.ws, { ...msg, from: user.phone });
      break;
    }

    // ── Mise à jour micro/caméra ─────────────────────────────────────────────
    case 'group_mute': {
      const callId = msg.call_id;
      if (!callId) break;
      const room = groupCalls.get(callId);
      if (!room || !room.members.has(user.id)) break;
      roomBroadcast(room, { ...msg, from: user.phone }, user.id);
      break;
    }
  }
}

// ── Entretien : salles vides ou abandonnées ─────────────────────────────────

/** Durée au-delà de laquelle une salle sans membre connecté est jetée */
const ROOM_MAX_AGE_MS = 12 * 60 * 60 * 1000; // 12 h

function sweepRooms() {
  const now = Date.now();
  for (const [callId, room] of groupCalls) {
    // Purge les membres dont la connexion est morte sans événement 'close'
    for (const [uid, m] of room.members) {
      if (!m.ws || m.ws.readyState !== WebSocket.OPEN) _leaveRoom(callId, room, uid);
    }
    if (room.members.size === 0 || now - room.createdAt > ROOM_MAX_AGE_MS) {
      groupCalls.delete(callId);
    }
  }
}

async function endCall(callId, reason = 'cancel') {
  clearTimeout(callTimers.get(callId));
  callTimers.delete(callId);
  const call = await db.get('SELECT * FROM calls WHERE id=? AND rtc_mode=1', [callId]);
  if (!call) return false;
  const caller = await db.get('SELECT phone,name FROM users WHERE id=?', [call.user_id]);
  const callee = call.callee_user_id ? await db.get('SELECT phone,name FROM users WHERE id=?', [call.callee_user_id]) : null;
  const declined = reason === 'declined' || reason === 'busy';
  const targetId = declined ? call.user_id : call.callee_user_id;
  const target = declined ? caller : callee;
  if (!targetId || !target) return false;
  const type = declined ? 'reject' : 'hangup';
  const msg = { type, call_id: callId, reason, from: declined ? callee.phone : caller.phone };
  if (isOnline(target.phone)) sendTo(target.phone, msg);
  if (!isForeground(target.phone)) await push.sendUser(targetId, {
    data: { kind: 'call_cancel', call_id: callId, from_phone: declined ? callee.phone : caller.phone, reason },
    title: declined ? 'Appel refusé' : 'Appel terminé',
    body: declined ? 'Ton appel a été refusé' : 'L’appel est terminé',
    channel: 'calls', collapseKey: `call-${callId}`,
  });
  return true;
}

async function sweepExpiredCalls() {
  const expired = await db.all("SELECT id,user_id,callee_user_id FROM calls WHERE rtc_mode=1 AND status='ringing' AND started_at <= ?", [now() - 75000]);
  for (const call of expired) {
    await db.run("UPDATE calls SET status='ended',ended_at=?,hangup_cause='timeout' WHERE id=? AND status='ringing'", [now(), call.id]);
    const caller = await db.get('SELECT phone FROM users WHERE id=?', [call.user_id]);
    const callee = call.callee_user_id ? await db.get('SELECT phone FROM users WHERE id=?', [call.callee_user_id]) : null;
    if (caller) sendTo(caller.phone, { type: 'hangup', call_id: call.id, reason: 'timeout' });
    if (callee && isOnline(callee.phone)) sendTo(callee.phone, { type: 'hangup', call_id: call.id, reason: 'timeout' });
    if (callee && !isForeground(callee.phone)) await push.sendUser(call.callee_user_id, {
      data: { kind: 'call_cancel', call_id: call.id, from_phone: caller?.phone || '', reason: 'timeout' },
      title: 'Appel manqué', body: caller?.phone || 'Appel MboteCall', channel: 'calls',
      collapseKey: `call-${call.id}`,
    });
  }
}

let sweepTimer = null;

// ── Initialisation du serveur WebSocket ─────────────────────────────────────

function init(server) {
  const wss = new WebSocket.Server({ server, path: '/ws', maxPayload: 1024 * 1024 });

  wss.on('connection', async (ws, req) => {
    const user = await authenticate(req);
    if (!user) {
      ws.close(4001, 'Unauthorized');
      return;
    }

    // Remplacer une session existante (multi-appareil : code 4002)
    const prev = online.get(user.phone);
    const wasOnline = !!(prev && prev.readyState === WebSocket.OPEN);
    if (prev && prev !== ws && prev.readyState === WebSocket.OPEN) {
      prev.close(4002, 'Replaced');
    }
    ws._fg = true;
    online.set(user.phone, ws);
    await db.run('UPDATE users SET last_seen_at=? WHERE id=?', [now(), user.id]);
    if (!wasOnline && user.presence_visible !== 0) await notifyPresenceReminders(user);

    ws.on('message', (data) => {
      onMessage(ws, user, data.toString()).catch(() => console.error('WS message processing failed'));
    });

    deliverPendingOffers(ws, user).catch(() => {});
    deliverPendingGroupInvites(ws, user);

    ws.on('close', () => {
      if (online.get(user.phone) === ws) {
        online.delete(user.phone);
        db.run('UPDATE users SET last_seen_at=? WHERE id=?', [now(), user.id]).catch(() => {});
        leaveAllRooms(user.id);
      }
    });

    ws.on('error', (e) => console.error(`WS [${user.phone}] error:`, e.message));
  });

  if (!sweepTimer) {
    sweepTimer = setInterval(sweepRooms, 5 * 60 * 1000); // toutes les 5 min
    if (sweepTimer.unref) sweepTimer.unref(); // ne retient pas le process
  }
  const callSweep = setInterval(() => sweepExpiredCalls().catch(() => {}), 15000);
  if (callSweep.unref) callSweep.unref();

  console.log('✅ Signalement WebSocket actif sur /ws');
}

// ── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  init,
  isOnline,
  isForeground,
  /** Envoyer un message à un utilisateur connecté (depuis un autre module) */
  sendTo: (phone, msg) => {
    return sendTo(phone, msg);
  },
  endCall,
  /** Accès debug (tests) */
  _groupCalls: groupCalls,
  _sweepRooms: sweepRooms,
};
