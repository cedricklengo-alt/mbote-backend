/**
 * 🗣️ LOKOTA 1 — Notes vocales traduites entre utilisateurs MboteCall
 *
 *   POST /api/lokota/send            { to, audio(dataURI), duration_sec,
 *                                      lang_from, lang_to }
 *   GET  /api/lokota/threads         → fils de discussion (sans l'audio)
 *   GET  /api/lokota/with/:phone     → notes échangées avec un proche
 *   POST /api/lokota/with/:phone/read→ marque les notes reçues comme lues
 *
 * Garde-fous : destinataire MboteCall uniquement, audio ≤ 450 ko,
 * durée ≤ 90 s, langues fr/ln/sw, 20 notes max par heure.
 */

const express = require('express');
const db = require('../db');
const { uid, now, normalizePhone, ah } = require('../util');
const { requireAuth } = require('../middleware/auth');
const { rateLimit } = require('../middleware/ratelimit');
const lokota = require('../services/lokota');

const r = express.Router();
const OK_LANGS = ['fr', 'ln', 'sw'];

const limitSend = rateLimit({
  windowMs: 60 * 60_000, max: 20,
  key: (req) => 'lokota:' + (req.user ? req.user.id : req.ip),
  message: 'Beaucoup de notes d\'un coup 😅 — réessaie dans une heure',
});

/* 📤 Envoyer une note vocale */
r.post('/send', requireAuth, limitSend, ah(async (req, res) => {
  const to = normalizePhone(req.body.to);
  if (!to) return res.status(400).json({ error: 'Numéro invalide (format +243…)' });

  const toUser = await db.get(
    `SELECT id, name, fcm_token FROM users WHERE phone = ? AND role = 'user' AND status = 'active'`, [to]);
  if (!toUser) return res.status(404).json({ error: 'Ce numéro n\'a pas encore MboteCall — invite-le 💚' });
  if (toUser.id === req.user.id) return res.status(400).json({ error: 'Tu ne peux pas t\'envoyer une note à toi-même 😄' });

  const audio = String(req.body.audio || '');
  if (!audio.startsWith('data:audio/')) return res.status(400).json({ error: 'Audio manquant' });
  if (audio.length > 450_000) return res.status(400).json({ error: 'Note trop longue — reste sous 60 secondes' });

  const dur = Math.max(1, Math.min(90, parseInt(req.body.duration_sec, 10) || 1));
  const lf = OK_LANGS.includes(req.body.lang_from) ? req.body.lang_from : 'fr';
  const lt = OK_LANGS.includes(req.body.lang_to) ? req.body.lang_to : 'ln';

  // 🔒 v2.2 Mode privé : le contenu n'est JAMAIS envoyé à l'IA
  const priv = req.body.translate === false;
  const id = uid('vn');
  await db.run(
    `INSERT INTO voice_notes(id, from_id, to_id, audio, duration_sec, lang_from, lang_to, status, created_at)
     VALUES(?,?,?,?,?,?,?,?,?)`,
    [id, req.user.id, toUser.id, audio, dur, lf, lt, priv ? 'no_ai' : 'pending', now()]);

  // 🧠 Traduction en tâche de fond (sauf mode privé)
  if (!priv) setImmediate(() => lokota.processNote(id).catch(() => {}));

  // 🔔 Prévenir le destinataire (app fermée comprise)
  try {
    const push = require('../services/push');
    if (push.enabled() && toUser.fcm_token) {
      push.sendInfoPush(toUser.fcm_token,
        `🎙️ ${req.user.name || req.user.phone}`,
        'Note vocale — touche pour écouter', {
          kind: 'message', from_phone: req.user.phone,
          from_name: req.user.name || '', msg_id: id,
        });
    }
  } catch (_) {}

  console.log(`🗣️ [LOKOTA] Note ${id} : ${req.user.phone} → ${to} (${lf} → ${lt}, ${dur}s)`);
  res.json({ id, status: priv ? 'no_ai' : 'pending', lokota_mode: lokota.mode() });
}));

/* 📚 Fils de discussion (dernière note par proche, sans l'audio) */
r.get('/threads', requireAuth, ah(async (req, res) => {
  const rows = await db.all(
    `SELECT vn.id, vn.from_id, vn.to_id, vn.duration_sec, vn.lang_from, vn.lang_to,
            vn.translation, vn.status, vn.created_at, vn.read_at,
            uf.phone AS from_phone, uf.name AS from_name,
            ut.phone AS to_phone,   ut.name AS to_name
     FROM voice_notes vn
     JOIN users uf ON uf.id = vn.from_id
     JOIN users ut ON ut.id = vn.to_id
     WHERE vn.from_id = ? OR vn.to_id = ?
     ORDER BY vn.created_at DESC LIMIT 200`,
    [req.user.id, req.user.id]);

  const threads = new Map();
  for (const n of rows) {
    const mine = n.from_id === req.user.id;
    const peerPhone = mine ? n.to_phone : n.from_phone;
    const peerName = mine ? n.to_name : n.from_name;
    let t = threads.get(peerPhone);
    if (!t) {
      t = { peer_phone: peerPhone, peer_name: peerName || '',
            last_at: n.created_at, last_status: n.status,
            last_mine: mine, last_duration: n.duration_sec, unread: 0 };
      threads.set(peerPhone, t);
    }
    if (!mine && !n.read_at) t.unread++;
  }
  res.json([...threads.values()]);
}));

/* 💬 Notes échangées avec un proche (audio inclus pour l'écoute) */
r.get('/with/:phone', requireAuth, ah(async (req, res) => {
  const phone = normalizePhone(req.params.phone);
  const peer = await db.get(`SELECT id, name FROM users WHERE phone = ?`, [phone]);
  if (!peer) return res.status(404).json({ error: 'Inconnu' });
  const rows = await db.all(
    `SELECT id, from_id, audio, duration_sec, lang_from, lang_to,
            transcript, translation, status, created_at, read_at
     FROM voice_notes
     WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)
     ORDER BY created_at ASC LIMIT 100`,
    [req.user.id, peer.id, peer.id, req.user.id]);
  res.json({
    peer_name: peer.name || '',
    notes: rows.map((n) => ({ ...n, mine: n.from_id === req.user.id })),
  });
}));

/* ✓✓ Marquer comme lues */
r.post('/with/:phone/read', requireAuth, ah(async (req, res) => {
  const phone = normalizePhone(req.params.phone);
  const peer = await db.get(`SELECT id FROM users WHERE phone = ?`, [phone]);
  if (peer) {
    await db.run(
      `UPDATE voice_notes SET read_at = ? WHERE from_id = ? AND to_id = ? AND read_at IS NULL`,
      [now(), peer.id, req.user.id]);
  }
  res.json({ ok: true });
}));

module.exports = r;
