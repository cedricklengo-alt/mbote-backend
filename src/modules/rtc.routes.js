/**
 * rtc.routes.js — Routes HTTP liées au transport WebRTC
 *
 * GET /api/rtc/ice  →  Configuration STUN/TURN pour les clients Flutter
 */

const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { now, ah } = require('../util');
const rtcWs = require('./rtc.ws');

const r = express.Router();

/**
 * Retourne la liste des serveurs ICE à utiliser pour les connexions WebRTC
 * (appels 1-1 et appels de groupe).
 *
 * En production, enrichir avec des credentials TURN rotatifs :
 *   { urls: 'turn:turn.example.com', username: '…', credential: '…' }
 */
r.get('/ice', requireAuth, (req, res) => {
  const iceServers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.relay.metered.ca:80' },
  ];
  const urls = String(process.env.TURN_URLS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const secret = process.env.TURN_SHARED_SECRET;
  if (urls.length && secret) {
    // Coturn REST credentials: username expires after one hour.
    const username = `${Math.floor(Date.now() / 1000) + 3600}:${req.user.id}`;
    const credential = crypto.createHmac('sha1', secret).update(username).digest('base64');
    iceServers.push({ urls, username, credential });
  }
  res.json({
    iceServers,
  });
});

// Accusé d'affichage de la sonnerie système après un réveil FCM.
r.post('/ack', requireAuth, ah(async (req, res) => {
  const callId = String(req.body.call_id || '').trim().slice(0, 120);
  if (!callId) return res.status(400).json({ error: 'Identifiant d’appel requis' });
  const call = await db.get('SELECT id,status,started_at FROM calls WHERE id=? AND callee_user_id=? AND rtc_mode=1', [callId, req.user.id]);
  if (!call || call.status !== 'ringing' || now() - call.started_at > 75000)
    return res.json({ ok: false });
  await db.run('UPDATE calls SET push_notified_at=COALESCE(push_notified_at,?) WHERE id=?', [now(), callId]);
  res.json({ ok: true });
}));

// Refus depuis CallKit quand le processus Flutter n'a pas encore repris.
r.post('/decline', requireAuth, ah(async (req, res) => {
  const callId = String(req.body.call_id || '').trim().slice(0, 120);
  if (!callId) return res.status(400).json({ error: 'Identifiant d’appel requis' });
  const call = await db.get("SELECT id,status FROM calls WHERE id=? AND callee_user_id=? AND rtc_mode=1", [callId, req.user.id]);
  if (!call || call.status === 'ended') return res.json({ ok: false });
  await db.run("UPDATE calls SET status='ended',ended_at=?,hangup_cause='declined' WHERE id=? AND status!='ended'", [now(), callId]);
  await rtcWs.endCall(callId, 'declined');
  res.json({ ok: true });
}));

module.exports = r;
