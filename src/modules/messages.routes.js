'use strict';

const express = require('express');
const scamDetect     = require('../services/scam_detect');
const fs = require('fs');
const path = require('path');
const db = require('../db');
const { uid, now, normalizePhone, ah } = require('../util');
const { requireAuth } = require('../middleware/auth');
const rtcWs = require('./rtc.ws');
const push = require('../services/push');
const lokotatr = require('../services/lokota');
const { sansEmoji } = lokotatr;


const router = express.Router();
const lokota = express.Router();
const mediaDir = process.env.MBOTE_MESSAGE_STORAGE || path.join(__dirname, '..', '..', 'storage', 'messages');
fs.mkdirSync(mediaDir, { recursive: true });

async function getPeer(phone) {
  const normalized = normalizePhone(phone);
  if (!normalized) return null;
  return db.get('SELECT id, phone, name, avatar, status, presence_visible, last_seen_at FROM users WHERE phone = ?', [normalized]);
}

function safeStatus(row, userId) {
  if (row.deleted_at) return 'deleted';
  if (row.sender_id !== userId) return 'done';
  if (row.read_at) return 'read';
  if (row.delivered_at) return 'delivered';
  return 'sent';
}

function forClient(row, userId, reactions = []) {
  const deleted = !!row.deleted_at;
  const kind = row.kind === 'voice' ? 'note' : row.kind;
  return {
    id: row.id,
    kind: deleted ? 'deleted' : kind,
    mine: row.sender_id === userId,
    body: deleted ? '' : (row.body || ''),
    // Filtre à l'AFFICHAGE en plus du filtre à l'écriture : les traductions
    // enregistrées avant le correctif gardaient leurs emojis, et elles
    // seraient restées visibles pour toujours.
    translation: deleted ? '' : sansEmoji(row.translation),
    transcript: deleted ? '' : (row.transcript || ''),
    lang_from: row.lang_from,
    lang_to: row.lang_to,
    status: safeStatus(row, userId),
    created_at: row.created_at,
    delivered_at: row.delivered_at || 0,
    read_at: row.read_at || 0,
    played_at: row.played_at || 0,
    deleted: deleted ? 1 : 0,
    has_media: !deleted && !!row.media_path,
    attachment_type: row.kind === 'image' || row.kind === 'file' || row.kind === 'video' ? row.kind : null,
    att_name: row.media_name || null,
    att_mime: row.media_mime || null,
    att_size: row.media_size || null,
    duration_sec: row.duration_sec || null,
    wave: row.wave ? (() => { try { return JSON.parse(row.wave); } catch { return null; } })() : null,
    // Reply / Quote
    reply_to_id: row.reply_to_id || null,
    reply_preview: row.reply_preview || null,
    reply_sender_name: row.reply_sender_name || null,
    // Réactions
    reactions,
    // Forward
    forwarded: row.forwarded === 1,
    // Étoilé
    starred: row.starred === 1,
    // Link preview
    link_url: row.link_url || null,
    link_title: row.link_title || null,
    link_description: row.link_description || null,
    link_image: row.link_image || null,
    att_thumb: row.kind === 'video' ? (row.link_image || null) : null,
    // Éphémère
    expires_at: row.expires_at || null,
  };
}

async function insertMessage({ sender, peer, body = '', kind = 'text', clientId, langFrom = 'fr', langTo = 'fr', media = null, duration = null, wave = null, replyToId = null, replyPreview = null, replySenderName = null, forwarded = 0, linkUrl = null, linkTitle = null, linkDescription = null, linkImage = null, expiresAt = null }) {
  if (clientId) {
    const existing = await db.get('SELECT * FROM messages WHERE sender_id = ? AND client_id = ?', [sender.id, clientId]);
    if (existing) return { row: existing, duplicate: true };
  }
  const id = uid('msg');
  const createdAt = now();
  const deliveredAt = rtcWs.isOnline(peer.phone) ? createdAt : null;
  await db.run(`
    INSERT INTO messages
      (id,sender_id,recipient_id,client_id,kind,body,lang_from,lang_to,translation,transcript,
       media_path,media_name,media_mime,media_size,created_at,delivered_at,duration_sec,wave,
       reply_to_id,reply_preview,reply_sender_name,forwarded,link_url,link_title,link_description,link_image,expires_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(sender_id,client_id) DO NOTHING
  `, [id, sender.id, peer.id, clientId || null, kind, body, langFrom, langTo, '', '',
    media?.path || null, media?.name || null, media?.mime || null, media?.size || null,
    createdAt, deliveredAt, duration, wave,
    replyToId, replyPreview, replySenderName, forwarded ? 1 : 0,
    linkUrl, linkTitle, linkDescription, linkImage, expiresAt]);
  const row = clientId
    ? await db.get('SELECT * FROM messages WHERE sender_id = ? AND client_id = ?', [sender.id, clientId])
    : await db.get('SELECT * FROM messages WHERE id = ?', [id]);
  return { row, duplicate: row.id !== id };
}

/**
 * Aperçu lisible d'un message, pour la liste des conversations, la
 * notification temps réel et le push. Un média n'a pas de `body` : sans
 * cette projection l'aperçu serait vide.
 */
function previewOf(row) {
  if (!row) return '';
  if (row.deleted_at) return 'Message supprimé';
  return row.kind === 'voice' ? 'Note vocale'
    : row.kind === 'image' ? 'Photo'
      : row.kind === 'video' ? '📹 Vidéo'
      : row.kind === 'file' ? (row.media_name || 'Fichier')
        : String(row.body || '').trim().slice(0, 100);
}

async function notifyRecipient(row, sender, peer) {
  if (!row || row.deleted_at) return;
  const preview = previewOf(row);
  const data = {
    type: 'msg', kind: 'message', msg_id: row.id,
    from: sender.phone, from_phone: sender.phone,
    from_name: sender.name || sender.phone, preview,
  };
  rtcWs.sendTo(peer.phone, data);
  if (!rtcWs.isForeground(peer.phone)) {
    await push.sendUser(peer.id, {
      data: { kind: 'message', msg_id: row.id, from_phone: sender.phone, from_name: sender.name || sender.phone, preview },
      title: sender.name || sender.phone,
      body: preview,
      channel: 'messages',
      collapseKey: `messages-${sender.id}`,
    });
  }
}

async function sendText(req, res) {
  const peer = await getPeer(req.body.to);
  if (!peer) return res.status(400).json({ error: 'Numéro invalide (format +243…)' });
  if (peer.id === req.user.id) return res.status(400).json({ error: 'Tu ne peux pas t’envoyer un message' });
  if (!peer || peer.status === 'blocked') return res.status(404).json({ error: 'Compte MboteCall introuvable' });
  const kind = req.body.kind === 'video' ? 'video' : 'text';
  const text = String(req.body.text || '').trim();
  if (kind === 'text' && (!text || text.length > 5000)) return res.status(400).json({ error: 'Le message doit contenir de 1 à 5 000 caractères' });
  if (kind === 'video' && text.length > 500) return res.status(400).json({ error: 'Nom de fichier trop long' });
  const clientId = String(req.body.client_id || '').trim();
  if (clientId && (clientId.length > 120 || !/^[A-Za-z0-9_.-]+$/.test(clientId)))
    return res.status(400).json({ error: 'Identifiant de message invalide' });
  const langFrom = String(req.body.lang_from || 'fr').slice(0, 12);
  const langTo = String(req.body.lang_to || 'fr').slice(0, 12);
  // Reply/Quote
  const replyToId = String(req.body.reply_to_id || '').trim() || null;
  let replyPreview = null, replySenderName = null;
  if (replyToId) {
    const orig = await db.get('SELECT body, kind, sender_id FROM messages WHERE id=?', [replyToId]);
    if (orig) {
      replyPreview = orig.body ? orig.body.slice(0, 100) : (orig.kind === 'voice' ? '🎤 Note vocale' : '📎 Fichier');
      const senderUser = await db.get('SELECT name FROM users WHERE id=?', [orig.sender_id]);
      replySenderName = senderUser?.name || null;
    }
  }
  // Link preview
  const linkUrl = String(req.body.link_url || '').trim() || null;
  const linkTitle = String(req.body.link_title || '').trim() || null;
  const linkDescription = String(req.body.link_description || '').trim() || null;
  const linkImage = String(req.body.link_image || '').trim() || null;
  // Éphémère : calculer expires_at si la conversation a un TTL
  const convRow = await db.get('SELECT disappear_ttl_sec FROM conversations WHERE peer_phone=?', [peer.phone]);
  const ttl = convRow?.disappear_ttl_sec || 0;
  const expiresAt = ttl > 0 ? (now() + ttl * 1000) : null;
  const result = await insertMessage({ sender: req.user, peer, body: text, kind, clientId: clientId || null, langFrom, langTo, replyToId, replyPreview, replySenderName, linkUrl, linkTitle, linkDescription, linkImage, expiresAt });
  if (!result.duplicate) {
    await notifyRecipient(result.row, req.user, peer);
    // Traduction Lokota (tâche de fond) — uniquement si lang_from ≠ lang_to
    if (langFrom !== langTo && !result.duplicate) {
      setImmediate(() => lokotatr.processMessage(result.row.id).catch(() => {}));
    }
  }
  // ── Détection d'arnaque (heuristiques légères) ──────────────────────────
  const ctx = { isNewContact: false, accountAgeMs: 0 };
  try {
    const senderInfo = await db.get(
      'SELECT created_at FROM users WHERE id=?', [peer.id]
    );
    if (senderInfo) ctx.accountAgeMs = now() - senderInfo.created_at;
    const inContacts = await db.get(
      'SELECT 1 FROM contacts WHERE user_id=? AND phone=?',
      [req.user.id, peer.phone]
    );
    ctx.isNewContact = !inContacts;
  } catch (_) {}
  const scam = scamDetect.analyser(text, ctx);
  const responseMsg = { ...forClient(result.row, req.user.id), id: result.row.id };
  if (scam.level !== 'none') {
    responseMsg.scam_risk = { level: scam.level, score: scam.score };
  }
  res.status(result.duplicate ? 200 : 201).json(responseMsg);
}

router.post('/send', requireAuth, ah(sendText));

// Upload privé de pièce jointe, lisible seulement par les deux participants.
router.post('/send-media', requireAuth, express.raw({ type: 'application/octet-stream', limit: '20mb' }), ah(async (req, res) => {
  const peer = await getPeer(req.query.to);
  if (!peer) return res.status(400).json({ error: 'Numéro invalide (format +243…)' });
  if (peer.id === req.user.id) return res.status(400).json({ error: 'Tu ne peux pas t’envoyer un fichier' });
  if (peer.status === 'blocked') return res.status(404).json({ error: 'Compte MboteCall introuvable' });
  const kind = String(req.query.kind || '');
  const mime = String(req.query.mime || '').toLowerCase().slice(0, 120);
  const name = path.basename(String(req.query.name || 'piece-jointe')).replace(/[\u0000-\u001f]/g, '').slice(0, 180);
  const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (!['image', 'file'].includes(kind) || !bytes.length) return res.status(400).json({ error: 'Fichier invalide' });
  if (bytes.length > 20 * 1024 * 1024) return res.status(413).json({ error: 'Fichier trop volumineux (20 Mo maximum)' });
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mime))
    return res.status(400).json({ error: 'Type de fichier invalide' });
  if (kind === 'image' && !['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(mime))
    return res.status(400).json({ error: 'Format photo non pris en charge' });
  if (kind === 'image') {
    const signatures = {
      'image/jpeg': bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
      'image/png': bytes.length >= 8 && Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]).equals(bytes.subarray(0, 8)),
      'image/gif': bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii')),
      'image/webp': bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP',
    };
    if (!signatures[mime]) return res.status(400).json({ error: 'Le contenu ne correspond pas au format photo annoncé' });
  }
  if (kind === 'file' && !(mime.startsWith('application/') || mime.startsWith('text/')))
    return res.status(400).json({ error: 'Type de fichier non pris en charge' });
  const clientId = String(req.query.client_id || '').trim();
  if (clientId && (clientId.length > 120 || !/^[A-Za-z0-9_.-]+$/.test(clientId)))
    return res.status(400).json({ error: 'Identifiant de message invalide' });
  if (clientId) {
    const existing = await db.get('SELECT * FROM messages WHERE sender_id = ? AND client_id = ?', [req.user.id, clientId]);
    if (existing) return res.json({ ...forClient(existing, req.user.id), id: existing.id });
  }
  const id = uid('msg');
  const ext = path.extname(name).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 12) || '.bin';
  const storedPath = path.join(mediaDir, `${id}${ext}`);
  await fs.promises.writeFile(storedPath, bytes, { flag: 'wx' });
  try {
    const result = await insertMessage({
      sender: req.user, peer, kind, body: String(req.query.text || '').slice(0, 1000), clientId: clientId || null,
      langFrom: String(req.query.lang_from || 'fr').slice(0, 12),
      langTo: String(req.query.lang_to || 'fr').slice(0, 12),
      media: { path: storedPath, name, mime, size: bytes.length },
    });
    if (result.duplicate) await fs.promises.unlink(storedPath).catch(() => {});
    else await notifyRecipient(result.row, req.user, peer);
    res.status(result.duplicate ? 200 : 201).json({ ...forClient(result.row, req.user.id), id: result.row.id });
  } catch (error) {
    await fs.promises.unlink(storedPath).catch(() => {});
    throw error;
  }
}));

async function getThreads(req, res) {
  const peers = await db.all(`
    SELECT DISTINCT CASE WHEN sender_id = ? THEN recipient_id ELSE sender_id END AS peer_id
    FROM messages WHERE sender_id = ? OR recipient_id = ?
  `, [req.user.id, req.user.id, req.user.id]);
  const threads = [];
  for (const { peer_id: peerId } of peers) {
    const peer = await db.get('SELECT id,phone,name,avatar,presence_visible,last_seen_at FROM users WHERE id = ?', [peerId]);
    if (!peer) continue;
    const last = await db.get(`
      SELECT m.* FROM messages m
      WHERE ((m.sender_id = ? AND m.recipient_id = ?) OR (m.sender_id = ? AND m.recipient_id = ?))
        AND NOT EXISTS (SELECT 1 FROM message_hidden h WHERE h.message_id=m.id AND h.user_id=?)
      ORDER BY m.created_at DESC, m.id DESC LIMIT 1
    `, [req.user.id, peerId, peerId, req.user.id, req.user.id]);
    if (!last) continue;
    const unread = await db.get(`SELECT COUNT(*) AS n FROM messages m WHERE m.sender_id=? AND m.recipient_id=? AND m.read_at IS NULL AND m.deleted_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM message_hidden h WHERE h.message_id=m.id AND h.user_id=?)`, [peerId, req.user.id, req.user.id]);
    threads.push({
      peer_id: peer.id, peer_phone: peer.phone, peer_name: peer.name || peer.phone,
      peer_avatar: peer.avatar || null,
      online: rtcWs.isOnline(peer.phone),
      last_seen_at: peer.presence_visible ? peer.last_seen_at : null,
      last_at: last.created_at, last_type: last.deleted_at ? 'deleted' : last.kind,
      last_body: last.deleted_at ? '' : last.body,
      // Clé lue par l'écran des conversations. `last_body` est vide pour une
      // note vocale, une photo ou un fichier : l'aperçu doit être projeté.
      last_preview: previewOf(last),
      last_mine: last.sender_id === req.user.id,
      last_state: safeStatus(last, req.user.id),
      unread: Number(unread.n || 0),
    });
  }
  threads.sort((a, b) => b.last_at - a.last_at);
  res.json(threads);
}
router.get('/threads', requireAuth, ah(getThreads));

/**
 * 🔄 SYNCHRO LOCAL-FIRST — messages depuis un curseur (ms epoch).
 * Utilisé par l'app au retour de connexion pour récupérer les messages
 * reçus hors ligne. Idempotent côté client (dédup par id / client_id).
 * Le curseur n'est avancé par le client qu'après persistance du lot.
 */
async function getSince(req, res) {
  const since = Number(req.query.since ?? 0);
  const limit = Math.min(Number(req.query.limit ?? 200) || 200, 500);
  if (!Number.isSafeInteger(since) || since < 0)
    return res.status(400).json({ error: 'Curseur invalide' });
  const rows = await db.all(`
    SELECT m.*, u.phone AS peer_phone, u.name AS peer_name
    FROM messages m
    JOIN users u ON u.id = CASE WHEN m.sender_id = ? THEN m.recipient_id ELSE m.sender_id END
    WHERE (m.sender_id = ? OR m.recipient_id = ?)
      AND m.created_at > ?
      AND NOT EXISTS (SELECT 1 FROM message_hidden h WHERE h.message_id = m.id AND h.user_id = ?)
    ORDER BY m.created_at ASC, m.id ASC
    LIMIT ?
  `, [req.user.id, req.user.id, req.user.id, since, req.user.id, limit + 1]);
  const hasMore = rows.length > limit;
  const items = (hasMore ? rows.slice(0, limit) : rows)
    .map((row) => ({ ...forClient(row, req.user.id), peer_phone: row.peer_phone, peer_name: row.peer_name, sender_id: row.sender_id, recipient_id: row.recipient_id, client_id: row.client_id }));
  res.json({ items, has_more: hasMore, server_now: Date.now() });
}
router.get('/since', requireAuth, ah(getSince));

/**
 * 📬 Le destinataire ouvre la conversation : les messages qu'il n'avait pas
 * encore REÇUS (son app était fermée au moment de l'envoi) passent de
 * « envoyé » à « reçu », et l'expéditeur est prévenu en direct.
 * Sans cela, le double ✓ « reçu » n'apparaissait qu'au marquage « lu ».
 */
async function markDeliveredFrom(peer, me) {
  const rows = await db.all(
    `SELECT id FROM messages
      WHERE sender_id = ? AND recipient_id = ? AND delivered_at IS NULL AND deleted_at IS NULL`,
    [peer.id, me.id],
  );
  if (!rows.length) return;
  await db.run(
    'UPDATE messages SET delivered_at = ? WHERE sender_id = ? AND recipient_id = ? AND delivered_at IS NULL',
    [now(), peer.id, me.id],
  );
  for (const m of rows) {
    rtcWs.sendTo(peer.phone, {
      type: 'msg', kind: 'delivered', msg_id: m.id,
      from: me.phone, from_phone: me.phone,
    });
  }
}

async function getConversation(req, res) {
  const peer = await getPeer(req.params.phone);
  if (!peer || peer.status === 'blocked' || peer.id === req.user.id)
    return res.status(404).json({ error: 'Compte MboteCall introuvable' });
  const before = req.query.before == null ? null : Number(req.query.before);
  if (before != null && (!Number.isSafeInteger(before) || before < 0))
    return res.status(400).json({ error: 'Curseur invalide' });

  // Ouverture du fil = réception implicite (accusé « reçu »).
  await markDeliveredFrom(peer, req.user);
  const params = [req.user.id, peer.id, peer.id, req.user.id, req.user.id];
  let beforeSql = '';
  if (before != null) { beforeSql = ' AND m.created_at < ?'; params.push(before); }
  params.push(51);
  const rows = await db.all(`
    SELECT m.* FROM messages m
    WHERE ((m.sender_id=? AND m.recipient_id=?) OR (m.sender_id=? AND m.recipient_id=?))
      AND NOT EXISTS (SELECT 1 FROM message_hidden h WHERE h.message_id=m.id AND h.user_id=?)
      ${beforeSql}
    ORDER BY m.created_at DESC, m.id DESC LIMIT ?
  `, params);
  const hasMore = rows.length > 50;
  const items = (hasMore ? rows.slice(0, 50) : rows).reverse().map((row) => forClient(row, req.user.id));
  res.json({
    peer_phone: peer.phone,
    peer_name: peer.name || peer.phone,
    peer_online: rtcWs.isOnline(peer.phone),
    peer_last_seen_at: peer.presence_visible ? peer.last_seen_at : null,
    has_more: hasMore,
    items,
  });
}
router.get('/with/:phone', requireAuth, ah(getConversation));

async function markRead(req, res) {
  const peer = await getPeer(req.params.phone);
  if (!peer) return res.status(404).json({ error: 'Compte MboteCall introuvable' });
  // Vérifier si le destinataire a activé les confirmations de lecture
  const me = await db.get('SELECT read_receipts_enabled FROM users WHERE id = ?', [req.user.id]);
  const receiptsEnabled = me?.read_receipts_enabled !== 0;
  const unread = await db.all('SELECT id,sender_id FROM messages WHERE sender_id=? AND recipient_id=? AND read_at IS NULL AND deleted_at IS NULL', [peer.id, req.user.id]);
  if (receiptsEnabled) {
    await db.run('UPDATE messages SET delivered_at=COALESCE(delivered_at,?), read_at=COALESCE(read_at,?) WHERE sender_id=? AND recipient_id=? AND read_at IS NULL', [now(), now(), peer.id, req.user.id]);
    for (const m of unread) rtcWs.sendTo(peer.phone, { type: 'msg', kind: 'read', msg_id: m.id, from: req.user.phone, from_phone: req.user.phone });
  } else {
    // Marquer comme livré seulement, pas comme lu
    await db.run('UPDATE messages SET delivered_at=COALESCE(delivered_at,?) WHERE sender_id=? AND recipient_id=? AND delivered_at IS NULL', [now(), peer.id, req.user.id]);
  }
  res.json({ ok: true, count: unread.length });
}
router.post('/with/:phone/read', requireAuth, ah(markRead));

const downloadMedia = ah(async (req, res) => {
  const row = await db.get('SELECT * FROM messages WHERE id = ?', [req.params.id]);
  if (!row || row.deleted_at || !row.media_path || ![row.sender_id, row.recipient_id].includes(req.user.id))
    return res.status(404).json({ error: 'Contenu indisponible' });
  if (!fs.existsSync(row.media_path)) return res.status(404).json({ error: 'Contenu indisponible' });
  res.setHeader('Content-Type', row.media_mime || 'application/octet-stream');
  res.setHeader('Content-Length', row.media_size || fs.statSync(row.media_path).size);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(row.media_name || 'fichier')}`);
  fs.createReadStream(row.media_path).pipe(res);
});
// URL utilisée par les versions courantes de Flutter et compatibilité V1.
router.get('/media/:id', requireAuth, downloadMedia);
router.get('/:id/media', requireAuth, downloadMedia);

router.post('/delete', requireAuth, ah(async (req, res) => {
  const ids = [...new Set(Array.isArray(req.body.ids) ? req.body.ids.map(String).slice(0, 100) : [])];
  const scope = req.body.scope;
  if (!ids.length || !['me', 'all'].includes(scope)) return res.status(400).json({ error: 'Sélection de messages invalide' });
  const results = {};
  for (const id of ids) {
    const row = await db.get('SELECT * FROM messages WHERE id=? AND (sender_id=? OR recipient_id=?)', [id, req.user.id, req.user.id]);
    if (!row) { results[id] = 'missing'; continue; }
    if (scope === 'all') {
      if (row.sender_id !== req.user.id) { results[id] = 'forbidden'; continue; }
      await db.run('UPDATE messages SET deleted_at=?, body=\'\', translation=\'\', transcript=\'\', media_path=NULL, media_name=NULL, media_mime=NULL, media_size=NULL WHERE id=?', [now(), id]);
      if (row.media_path) await fs.promises.unlink(row.media_path).catch(() => {});
      const peerId = row.sender_id === req.user.id ? row.recipient_id : row.sender_id;
      const peer = await db.get('SELECT phone FROM users WHERE id=?', [peerId]);
      if (peer) rtcWs.sendTo(peer.phone, { type: 'msg', kind: 'deleted', msg_id: id, from_phone: req.user.phone });
      results[id] = 'deleted';
    } else {
      await db.run('INSERT INTO message_hidden(message_id,user_id,hidden_at) VALUES(?,?,?) ON CONFLICT(message_id,user_id) DO NOTHING', [id, req.user.id, now()]);
      results[id] = 'hidden';
    }
  }
  res.json({ results });
}));

// ── Suppression groupée : POST /messages/bulk-delete { ids, scope: 'me'|'all' } ──
router.post('/bulk-delete', requireAuth, ah(async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String).filter(Boolean).slice(0, 200) : [];
  if (!ids.length) return res.status(400).json({ error: 'ids requis' });
  const scope = req.body?.scope === 'all' ? 'all' : 'me';
  const q = ids.map(() => '?').join(',');
  let supprimes = 0;
  for (const id of ids) {
    const row = await db.get('SELECT * FROM messages WHERE id = ?', [id]);
    if (!row) continue;
    const moi = row.sender_id === req.user.id || row.recipient_id === req.user.id;
    if (!moi) continue;
    if (scope === 'all' && row.sender_id !== req.user.id) continue; // « pour tous » = auteur seul
    if (scope === 'all') {
      await db.run('DELETE FROM messages WHERE id = ?', [id]);
      const peerId = row.sender_id === req.user.id ? row.recipient_id : row.sender_id;
      const peer = await db.get('SELECT phone FROM users WHERE id = ?', [peerId]);
      if (peer) rtcWs.sendTo(peer.phone, { type: 'msg', kind: 'deleted', msg_id: id, from_phone: req.user.phone });
    } else {
      await db.run('UPDATE messages SET deleted_at = COALESCE(deleted_at, ?), body = \'\', translation = \'\', transcript = \'\' WHERE id = ?', [now(), id]);
      await db.run('INSERT OR IGNORE INTO message_hidden (message_id, user_id) VALUES (?, ?)', [id, req.user.id]);
    }
    supprimes++;
  }
  res.json({ ok: true, supprimes });
}));

router.delete('/:id', requireAuth, ah(async (req, res) => {
  const row = await db.get('SELECT * FROM messages WHERE id=? AND sender_id=?', [req.params.id, req.user.id]);
  if (!row) return res.status(404).json({ error: 'Message introuvable' });
  await db.run('UPDATE messages SET deleted_at=?, body=\'\', translation=\'\', transcript=\'\', media_path=NULL, media_name=NULL, media_mime=NULL, media_size=NULL WHERE id=?', [now(), row.id]);
  if (row.media_path) await fs.promises.unlink(row.media_path).catch(() => {});
  const peer = await db.get('SELECT phone FROM users WHERE id=?', [row.recipient_id]);
  if (peer) rtcWs.sendTo(peer.phone, { type: 'msg', kind: 'deleted', msg_id: row.id, from_phone: req.user.phone });
  res.json({ ok: true });
}));

router.post('/:id/played', requireAuth, ah(async (req, res) => {
  const row = await db.get("SELECT * FROM messages WHERE id=? AND recipient_id=? AND kind='voice' AND deleted_at IS NULL", [req.params.id, req.user.id]);
  if (!row) return res.status(404).json({ error: 'Note vocale introuvable' });
  await db.run('UPDATE messages SET played_at=COALESCE(played_at,?) WHERE id=?', [now(), row.id]);
  const sender = await db.get('SELECT phone FROM users WHERE id=?', [row.sender_id]);
  if (sender) rtcWs.sendTo(sender.phone, { type: 'msg', kind: 'played', msg_id: row.id, from_phone: req.user.phone });
  res.json({ ok: true });
}));

// Routes de compatibilité Lokota : les notes vocales restent dans le même fil.
lokota.post('/send', requireAuth, ah(async (req, res) => {
  const peer = await getPeer(req.body.to);
  if (!peer || peer.status === 'blocked') return res.status(404).json({ error: 'Compte MboteCall introuvable' });
  if (peer.id === req.user.id) return res.status(400).json({ error: 'Destinataire invalide' });
  const match = /^data:audio\/(?:m4a|mp4|aac|mpeg|wav|ogg|webm);base64,([A-Za-z0-9+/]+={0,2})$/.exec(String(req.body.audio || ''));
  if (!match) return res.status(400).json({ error: 'Note vocale invalide' });
  const bytes = Buffer.from(match[1], 'base64');
  if (!bytes.length || bytes.length > 8 * 1024 * 1024) return res.status(413).json({ error: 'Note vocale trop volumineuse' });
  const clientId = String(req.body.client_id || '').trim();
  if (clientId && (clientId.length > 120 || !/^[A-Za-z0-9_.-]+$/.test(clientId))) return res.status(400).json({ error: 'Identifiant de message invalide' });
  if (clientId) {
    const existing = await db.get('SELECT * FROM messages WHERE sender_id=? AND client_id=?', [req.user.id, clientId]);
    if (existing) return res.json({ ...forClient(existing, req.user.id), id: existing.id });
  }
  let wave = req.body.wave;
  if (typeof wave === 'string') { try { wave = JSON.parse(wave); } catch { wave = null; } }
  if (Array.isArray(wave)) {
    wave = wave.slice(0, 80).map((v) => Number(v)).filter(Number.isFinite).map((v) => Math.max(0, Math.min(100, Math.round(v))));
  } else wave = null;
  const id = uid('msg');
  const storedPath = path.join(mediaDir, `${id}.m4a`);
  await fs.promises.writeFile(storedPath, bytes, { flag: 'wx' });
  try {
    const result = await insertMessage({
      sender: req.user, peer, kind: 'voice', clientId: clientId || null,
      langFrom: String(req.body.lang_from || 'fr').slice(0, 12),
      langTo: String(req.body.lang_to || 'fr').slice(0, 12),
      duration: Math.max(1, Math.min(90, Number(req.body.duration_sec) || 1)),
      // SQLite n'accepte que des valeurs simples : la forme d'onde part en JSON.
      wave: wave && wave.length ? JSON.stringify(wave) : null,
      media: { path: storedPath, name: 'note.m4a', mime: 'audio/mp4', size: bytes.length },
    });
    if (result.duplicate) await fs.promises.unlink(storedPath).catch(() => {});
    else await notifyRecipient(result.row, req.user, peer);
    res.status(result.duplicate ? 200 : 201).json({ ...forClient(result.row, req.user.id), id: result.row.id });
  } catch (error) {
    await fs.promises.unlink(storedPath).catch(() => {});
    throw error;
  }
}));
lokota.get('/threads', requireAuth, ah(getThreads));
lokota.get('/with/:phone', requireAuth, ah(async (req, res) => getConversation(req, res)));
lokota.post('/with/:phone/read', requireAuth, ah(async (req, res) => markRead(req, res)));


// ══════════════════ v4.1 — AMÉLIORATIONS WHATSAPP ══════════════════

// ── 2. Réactions aux messages ─────────────────────────────────────
router.post('/:id/react', requireAuth, ah(async (req, res) => {
  const { id } = req.params;
  const emoji = String(req.body.emoji || '').trim();
  const ALLOWED = ['❤️','😂','😮','😢','😡','👍'];
  if (!ALLOWED.includes(emoji)) return res.status(400).json({ error: 'Emoji non autorisé' });
  const msg = await db.get('SELECT * FROM messages WHERE id=? AND deleted_at IS NULL', [id]);
  if (!msg) return res.status(404).json({ error: 'Message introuvable' });
  if (msg.sender_id !== req.user.id && msg.recipient_id !== req.user.id)
    return res.status(403).json({ error: 'Accès refusé' });
  const { uid: genUid } = require('../util');
  await db.run(
    `INSERT INTO message_reactions (id,message_id,user_id,emoji,created_at)
     VALUES(?,?,?,?,?) ON CONFLICT(message_id,user_id) DO UPDATE SET emoji=excluded.emoji, created_at=excluded.created_at`,
    [genUid('rxn'), id, req.user.id, emoji, require('../util').now()]
  );
  const reactions = await db.all('SELECT emoji, user_id FROM message_reactions WHERE message_id=?', [id]);
  // Notifier l'autre participant
  const otherId = msg.sender_id === req.user.id ? msg.recipient_id : msg.sender_id;
  const other = await db.get('SELECT phone FROM users WHERE id=?', [otherId]);
  if (other) rtcWs.sendTo(other.phone, { type: 'msg', kind: 'reaction', msg_id: id, emoji, from_phone: req.user.phone });
  res.json({ reactions });
}));

router.delete('/:id/react', requireAuth, ah(async (req, res) => {
  const { id } = req.params;
  await db.run('DELETE FROM message_reactions WHERE message_id=? AND user_id=?', [id, req.user.id]);
  const reactions = await db.all('SELECT emoji, user_id FROM message_reactions WHERE message_id=?', [id]);
  res.json({ reactions });
}));

// ── 5. Messages étoilés ───────────────────────────────────────────
router.patch('/:id/star', requireAuth, ah(async (req, res) => {
  const msg = await db.get('SELECT * FROM messages WHERE id=? AND deleted_at IS NULL', [req.params.id]);
  if (!msg) return res.status(404).json({ error: 'Message introuvable' });
  if (msg.sender_id !== req.user.id && msg.recipient_id !== req.user.id)
    return res.status(403).json({ error: 'Accès refusé' });
  const newVal = msg.starred ? 0 : 1;
  await db.run('UPDATE messages SET starred=? WHERE id=?', [newVal, msg.id]);
  res.json({ starred: newVal === 1 });
}));

router.get('/starred', requireAuth, ah(async (req, res) => {
  const rows = await db.all(
    `SELECT m.*, u.name AS peer_name FROM messages m
     LEFT JOIN users u ON (u.id = CASE WHEN m.sender_id=? THEN m.recipient_id ELSE m.sender_id END)
     WHERE (m.sender_id=? OR m.recipient_id=?) AND m.starred=1 AND m.deleted_at IS NULL
     ORDER BY m.created_at DESC LIMIT 100`,
    [req.user.id, req.user.id, req.user.id]
  );
  res.json(rows.map(r => ({ ...forClient(r, req.user.id), peer_name: r.peer_name })));
}));

// ── 4. Mute conversation ──────────────────────────────────────────
router.patch('/conversations/:phone/mute', requireAuth, ah(async (req, res) => {
  const { phone } = req.params;
  const until = Number(req.body.until) || 0;  // ms epoch ; 0 = démuter
  await db.run(
    `INSERT INTO conversations (peer_phone, muted_until) VALUES (?,?)
     ON CONFLICT(peer_phone) DO UPDATE SET muted_until=excluded.muted_until`,
    [phone, until]
  );
  res.json({ muted_until: until });
}));

// ── 3. Transfert de message (Forward) ────────────────────────────
router.post('/forward', requireAuth, ah(async (req, res) => {
  const msgId = String(req.body.message_id || '').trim();
  const tos = Array.isArray(req.body.to) ? req.body.to.slice(0, 10) : [];
  if (!msgId || !tos.length) return res.status(400).json({ error: 'message_id et to[] requis' });
  const orig = await db.get('SELECT * FROM messages WHERE id=? AND deleted_at IS NULL', [msgId]);
  if (!orig) return res.status(404).json({ error: 'Message introuvable' });
  if (orig.sender_id !== req.user.id && orig.recipient_id !== req.user.id)
    return res.status(403).json({ error: 'Accès refusé' });
  const results = [];
  for (const phone of tos) {
    const peer = await getPeer(phone);
    if (!peer) continue;
    const result = await insertMessage({
      sender: req.user, peer,
      body: orig.body || '', kind: orig.kind === 'voice' ? 'text' : orig.kind,
      forwarded: 1,
    });
    if (!result.duplicate) await notifyRecipient(result.row, req.user, peer);
    results.push(forClient(result.row, req.user.id));
  }
  res.json({ forwarded: results.length, results });
}));

// ── 7. Aperçu de lien ────────────────────────────────────────────
router.get('/link-preview', requireAuth, ah(async (req, res) => {
  const rawUrl = String(req.query.url || '').trim();
  if (!rawUrl) return res.status(400).json({ error: 'url requis' });
  let parsed;
  try { parsed = new URL(rawUrl); } catch { return res.status(400).json({ error: 'URL invalide' }); }
  if (!['http:', 'https:'].includes(parsed.protocol)) return res.status(400).json({ error: 'Protocole non autorisé' });
  // Cache léger en mémoire (TTL 1h)
  if (!router._lpCache) router._lpCache = new Map();
  const cached = router._lpCache.get(rawUrl);
  if (cached && cached.at > Date.now() - 3600000) return res.json(cached.data);
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const resp = await fetch(rawUrl, { signal: ctrl.signal, headers: { 'User-Agent': 'MboteBot/1.0' } });
    clearTimeout(timer);
    if (!resp.ok) return res.status(422).json({ error: 'Page inaccessible' });
    const html = await resp.text();
    const get = (prop) => {
      const m = html.match(new RegExp(`<meta[^>]+(?:property|name)=["\'"](?:og:|twitter:)?${prop}["\'"][^>]+content=["\'"]([^\"']+)["\'"]`, 'i'))
              || html.match(new RegExp(`<meta[^>]+content=["\'"]([^\"']+)["\'"][^>]+(?:property|name)=["\'"](?:og:|twitter:)?${prop}["\'"]`, 'i'));
      return m ? m[1].trim() : null;
    };
    const titleTag = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    const preview = {
      url: rawUrl,
      title: get('title') || (titleTag ? titleTag[1].trim() : null),
      description: get('description'),
      image: get('image'),
    };
    router._lpCache.set(rawUrl, { at: Date.now(), data: preview });
    res.json(preview);
  } catch (e) {
    res.status(422).json({ error: 'Aperçu indisponible' });
  }
}));

// ── 6. Messages éphémères (TTL par conversation) ─────────────────
router.patch('/conversations/:phone/disappear', requireAuth, ah(async (req, res) => {
  const ttl = Number(req.body.ttl_sec) || 0;  // 0=désactivé, 86400=24h, 604800=7j, 7776000=90j
  const { phone } = req.params;
  await db.run(
    `INSERT INTO conversations (peer_phone, disappear_ttl_sec) VALUES (?,?)
     ON CONFLICT(peer_phone) DO UPDATE SET disappear_ttl_sec=excluded.disappear_ttl_sec`,
    [phone, ttl]
  );
  res.json({ disappear_ttl_sec: ttl });
}));

// ── 10 & 11. Confidentialité & confirmations de lecture ──────────
router.patch('/privacy', requireAuth, ah(async (req, res) => {
  const updates = {};
  const vals = [];
  if (req.body.last_seen_visibility !== undefined) {
    const v = String(req.body.last_seen_visibility);
    if (!['everyone','contacts','nobody'].includes(v)) return res.status(400).json({ error: 'Valeur invalide' });
    updates.last_seen_visibility = v;
  }
  if (req.body.read_receipts_enabled !== undefined) {
    updates.read_receipts_enabled = req.body.read_receipts_enabled ? 1 : 0;
  }
  if (!Object.keys(updates).length) return res.status(400).json({ error: 'Rien à mettre à jour' });
  const setClauses = Object.keys(updates).map(k => `${k}=?`).join(',');
  Object.values(updates).forEach(v => vals.push(v));
  vals.push(req.user.id);
  await db.run(`UPDATE users SET ${setClauses} WHERE id=?`, vals);
  res.json({ ok: true, ...updates });
}));

module.exports = { router, lokota };
