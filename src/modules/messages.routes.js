/**
 * 💬 v2.0 MESSAGES — « Chacun écrit dans sa langue, chacun lit dans la sienne »
 *
 *   POST /api/messages/send             { to, text, lang_from, lang_to }
 *   GET  /api/messages/threads          → fils UNIFIÉS (textes + notes Lokota)
 *   GET  /api/messages/with/:phone      → conversation complète avec un proche
 *   POST /api/messages/with/:phone/read → marque textes ET notes comme lus
 *
 * Garde-fous : destinataire MboteCall uniquement, texte ≤ 1000 caractères,
 * langues fr/ln/sw, 120 messages max par heure.
 * Si lang_from == lang_to : pas d'appel IA (statut 'done' direct).
 */

const express = require('express');
const db = require('../db');
const { uid, now, normalizePhone, ah } = require('../util');
const { requireAuth } = require('../middleware/auth');
const { rateLimit } = require('../middleware/ratelimit');
const lokota = require('../services/lokota');
const { isOnline } = require('./rtc.ws'); // 🟢 v2.8 : présence en ligne

const r = express.Router();
const OK_LANGS = ['fr', 'ln', 'sw'];

const limitSend = rateLimit({
  windowMs: 60 * 60_000, max: 120,
  key: (req) => 'msg:' + (req.user ? req.user.id : req.ip),
  message: 'Beaucoup de messages d\'un coup 😅 — réessaie dans une heure',
});

/* 📤 Envoyer un message écrit */
r.post('/send', requireAuth, limitSend, ah(async (req, res) => {
  const to = normalizePhone(req.body.to);
  if (!to) return res.status(400).json({ error: 'Numéro invalide (format +243…)' });

  const toUser = await db.get(
    `SELECT id, name, fcm_token FROM users WHERE phone = ? AND role = 'user' AND status = 'active'`, [to]);
  if (!toUser) return res.status(404).json({ error: 'Ce numéro n\'a pas encore MboteCall — invite-le 💚' });
  if (toUser.id === req.user.id) return res.status(400).json({ error: 'Tu ne peux pas t\'écrire à toi-même 😄' });

  const text = String(req.body.text || '').trim();
  // 📎 v2.3 : photo jointe (data URI compressée côté app)
  const attachment = String(req.body.attachment || '');
  if (attachment) {
    if (!attachment.startsWith('data:image/')) return res.status(400).json({ error: 'Pièce jointe non reconnue (photo uniquement)' });
    if (attachment.length > 400_000) return res.status(400).json({ error: 'Photo trop lourde — réessaie, elle sera compressée davantage' });
  }
  if (!text && !attachment) return res.status(400).json({ error: 'Message vide' });
  if (text.length > 1000) return res.status(400).json({ error: 'Message trop long (1000 caractères max)' });

  const lf = OK_LANGS.includes(req.body.lang_from) ? req.body.lang_from : 'fr';
  const lt = OK_LANGS.includes(req.body.lang_to) ? req.body.lang_to : 'ln';
  // 🔒 v2.2 Mode privé (translate:false) : contenu jamais envoyé à l'IA
  const sameLang = lf === lt || req.body.translate === false;

  // 🔁 v3.0 : clé d'idempotence fournie par l'app (réutilisée à chaque renvoi).
  // Si la 1re requête a bien été reçue mais que la réponse s'est perdue
  // (réseau lent), le renvoi ne crée PAS de second message.
  const clientId = String(req.body.client_id || '').trim().slice(0, 64) || null;
  if (clientId) {
    const dup = await db.get(
      `SELECT id, status FROM text_messages WHERE from_id = ? AND client_id = ?`,
      [req.user.id, clientId]);
    if (dup) {
      return res.json({ id: dup.id, status: dup.status, lokota_mode: lokota.mode(), duplicate: true });
    }
  }

  const id = uid('tm');
  const needsAi = !sameLang && text.length > 0; // photo seule : rien à traduire
  try {
    await db.run(
      `INSERT INTO text_messages(id, from_id, to_id, body, lang_from, lang_to, status, created_at, attachment, attachment_type, client_id)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      [id, req.user.id, toUser.id, text, lf, lt, needsAi ? 'pending' : 'done', now(),
       attachment || null, attachment ? 'image' : null, clientId]);
  } catch (e) {
    // Deux envois simultanés avec la même clé : le second retrouve le premier
    const again = clientId && await db.get(
      `SELECT id, status FROM text_messages WHERE from_id = ? AND client_id = ?`,
      [req.user.id, clientId]);
    if (again) {
      return res.json({ id: again.id, status: again.status, lokota_mode: lokota.mode(), duplicate: true });
    }
    throw e;
  }

  // 🧠 Traduction en tâche de fond (seulement si les langues diffèrent)
  if (needsAi) setImmediate(() => lokota.processMessage(id).catch(() => {}));

  // ⚡ Instantané : si son app est ouverte, elle est prévenue par le canal temps réel
  // (indépendant de Firebase → le message apparaît tout de suite)
  const preview = attachment ? '📷 Photo' : (text.length > 60 ? text.slice(0, 57) + '…' : text);
  const live = require('./rtc.ws').notifyMessage(to, {
    kind: 'message', from_phone: req.user.phone, from_name: req.user.name || '', msg_id: id,
    preview,
  });

  // 🔔 Prévenir le destinataire (app fermée comprise)
  try {
    const push = require('../services/push');
    if (push.enabled() && toUser.fcm_token) {
      push.sendInfoPush(toUser.fcm_token, req.user.name || req.user.phone, preview, {
        kind: 'message', from_phone: req.user.phone,
        from_name: req.user.name || '', msg_id: id,
      });
      console.log(`🔔 [PUSH] Notification message envoyée → ${to}${live ? ' (+ temps réel)' : ''}`);
    } else if (!push.enabled()) {
      // 🔎 Diagnostic : le service push n'est pas actif sur ce serveur
      console.log(`🔕 [PUSH] Non envoyé → ${to} : service push DÉSACTIVÉ (FIREBASE_SERVICE_ACCOUNT ?)`);
    } else {
      // 🔎 Diagnostic : ce destinataire ne s'est jamais enregistré pour les push
      console.log(`🔕 [PUSH] Non envoyé → ${to} : AUCUN jeton FCM (son app ne s'est pas enregistrée)`);
    }
  } catch (_) {}

  console.log(`💬 [MESSAGES] ${id} : ${req.user.phone} → ${to} (${lf} → ${lt}, ${text.length} car.)`);
  res.json({ id, status: needsAi ? 'pending' : 'done', lokota_mode: lokota.mode() });
}));

/* 📚 Fils de discussion UNIFIÉS (dernier échange par proche, texte ou note) */
r.get('/threads', requireAuth, ah(async (req, res) => {
  const me = req.user.id;
  const notes = await db.all(
    `SELECT vn.id, vn.from_id, vn.duration_sec, vn.created_at, vn.read_at, vn.delivered_at,
            uf.phone AS from_phone, uf.name AS from_name,
            ut.phone AS to_phone,   ut.name AS to_name, vn.deleted
     FROM voice_notes vn
     JOIN users uf ON uf.id = vn.from_id
     JOIN users ut ON ut.id = vn.to_id
     WHERE vn.from_id = ? OR vn.to_id = ?
     ORDER BY vn.created_at DESC LIMIT 200`, [me, me]);
  const texts = await db.all(
    `SELECT tm.id, tm.from_id, tm.body, tm.attachment_type, tm.created_at, tm.read_at, tm.delivered_at, tm.deleted,
            uf.phone AS from_phone, uf.name AS from_name,
            ut.phone AS to_phone,   ut.name AS to_name
     FROM text_messages tm
     JOIN users uf ON uf.id = tm.from_id
     JOIN users ut ON ut.id = tm.to_id
     WHERE tm.from_id = ? OR tm.to_id = ?
     ORDER BY tm.created_at DESC LIMIT 200`, [me, me]);

  // 📬 v2.7 : ce que mon téléphone vient de télécharger est LIVRÉ
  // (l'expéditeur verra le point plein au prochain rafraîchissement)
  await db.run(`UPDATE text_messages SET delivered_at=? WHERE to_id=? AND delivered_at IS NULL`, [now(), me]);
  await db.run(`UPDATE voice_notes SET delivered_at=? WHERE to_id=? AND delivered_at IS NULL`, [now(), me]);

  const items = [
    ...notes.map((n) => ({ ...n, kind: 'note' })),
    ...texts.map((t) => ({ ...t, kind: 'text' })),
  ].sort((a, b) => b.created_at - a.created_at);

  const threads = new Map();
  for (const it of items) {
    const mine = it.from_id === me;
    const peerPhone = mine ? it.to_phone : it.from_phone;
    const peerName = mine ? it.to_name : it.from_name;
    let t = threads.get(peerPhone);
    if (!t) {
      const preview = it.deleted ? '🚫 Message supprimé'
        : it.kind === 'text'
        ? (it.attachment_type === 'image' && !it.body ? '📷 Photo'
           : (it.body.length > 44 ? it.body.slice(0, 41) + '…' : it.body))
        : `🎙️ ${it.duration_sec}s`;
      t = { peer_phone: peerPhone, peer_name: peerName || '',
            last_at: it.created_at, last_kind: it.kind,
            last_mine: mine, last_preview: preview, unread: 0,
            // ☀ v2.8 : état du dernier message envoyé (○ parti · ● reçu · ☀ lu)
            last_state: mine
              ? (it.read_at ? 'read' : (it.delivered_at ? 'delivered' : 'sent'))
              : null };
      threads.set(peerPhone, t);
    }
    if (!mine && !it.read_at) t.unread++;
  }
  // 🟢 v2.8 : qui est en ligne en ce moment (connexion WebSocket active)
  res.json([...threads.values()].map((t) =>
    ({ ...t, online: isOnline(t.peer_phone) })));
}));

/* 💬 Conversation complète avec un proche (textes + notes, triés) */
r.get('/with/:phone', requireAuth, ah(async (req, res) => {
  const phone = normalizePhone(req.params.phone);
  const peer = await db.get(`SELECT id, name FROM users WHERE phone = ?`, [phone]);
  if (!peer) return res.status(404).json({ error: 'Inconnu' });
  const me = req.user.id;

  // 📬 livré dès que mon téléphone ouvre le fil
  await db.run(`UPDATE text_messages SET delivered_at=? WHERE to_id=? AND from_id=? AND delivered_at IS NULL`, [now(), me, peer.id]);
  await db.run(`UPDATE voice_notes SET delivered_at=? WHERE to_id=? AND from_id=? AND delivered_at IS NULL`, [now(), me, peer.id]);

  const notes = await db.all(
    `SELECT id, from_id, audio, duration_sec, lang_from, lang_to,
            transcript, translation, status, created_at, read_at, delivered_at, deleted
     FROM voice_notes
     WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)
     ORDER BY created_at ASC LIMIT 100`, [me, peer.id, peer.id, me]);
  const texts = await db.all(
    `SELECT id, from_id, body, lang_from, lang_to, translation, status, created_at, read_at, delivered_at,
            attachment, attachment_type, deleted
     FROM text_messages
     WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)
     ORDER BY created_at ASC LIMIT 200`, [me, peer.id, peer.id, me]);

  const items = [
    ...notes.map((n) => ({ ...n, kind: 'note', mine: n.from_id === me })),
    ...texts.map((t) => ({ ...t, kind: 'text', mine: t.from_id === me })),
  ].sort((a, b) => a.created_at - b.created_at);

  // 🟢 v2.8 : l'écran de conversation affiche « en ligne » en direct
  res.json({ peer_name: peer.name || '', peer_online: isOnline(phone), items });
}));

/* ✓✓ Marquer comme lus (textes ET notes) */
r.post('/with/:phone/read', requireAuth, ah(async (req, res) => {
  const phone = normalizePhone(req.params.phone);
  const peer = await db.get(`SELECT id FROM users WHERE phone = ?`, [phone]);
  if (!peer) return res.status(404).json({ error: 'Inconnu' });
  const t = now();
  await db.run(
    `UPDATE text_messages SET read_at = ? WHERE to_id = ? AND from_id = ? AND read_at IS NULL`,
    [t, req.user.id, peer.id]);
  await db.run(
    `UPDATE voice_notes SET read_at = ? WHERE to_id = ? AND from_id = ? AND read_at IS NULL`,
    [t, req.user.id, peer.id]);
  res.json({ ok: true });
}));

/* 🗑️ v2.4 : supprimer pour tout le monde (expéditeur uniquement).
   Le contenu est vidé des deux côtés — comme WhatsApp. */
r.delete('/:id', requireAuth, ah(async (req, res) => {
  const id = String(req.params.id || '');
  const me = req.user.id;
  const txt = await db.get(`SELECT id, from_id FROM text_messages WHERE id = ?`, [id]);
  if (txt) {
    if (txt.from_id !== me) return res.status(403).json({ error: 'Seul l\'expéditeur peut supprimer ce message' });
    await db.run(
      `UPDATE text_messages SET deleted=1, body='', translation=NULL, attachment=NULL, attachment_type=NULL WHERE id=?`, [id]);
    return res.json({ ok: true });
  }
  const vn = await db.get(`SELECT id, from_id FROM voice_notes WHERE id = ?`, [id]);
  if (vn) {
    if (vn.from_id !== me) return res.status(403).json({ error: 'Seul l\'expéditeur peut supprimer ce message' });
    await db.run(
      `UPDATE voice_notes SET deleted=1, audio='', transcript=NULL, translation=NULL WHERE id=?`, [id]);
    return res.json({ ok: true });
  }
  res.status(404).json({ error: 'Message introuvable' });
}));

module.exports = r;
