'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const db = require('../db');
const { uid, now, normalizePhone, ah } = require('../util');
const { requireAuth } = require('../middleware/auth');
const rtcWs = require('./rtc.ws');
const push = require('../services/push');
const lokotatr = require('../services/lokota');


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

function forClient(row, userId) {
  const deleted = !!row.deleted_at;
  const kind = row.kind === 'voice' ? 'note' : row.kind;
  return {
    id: row.id,
    kind: deleted ? 'deleted' : kind,
    mine: row.sender_id === userId,
    body: deleted ? '' : (row.body || ''),
    translation: deleted ? '' : (row.translation || ''),
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
    attachment_type: row.kind === 'image' || row.kind === 'file' ? row.kind : null,
    att_name: row.media_name || null,
    att_mime: row.media_mime || null,
    att_size: row.media_size || null,
    duration_sec: row.duration_sec || null,
    wave: row.wave ? (() => { try { return JSON.parse(row.wave); } catch { return null; } })() : null,
  };
}

async function insertMessage({ sender, peer, body = '', kind = 'text', clientId, langFrom = 'fr', langTo = 'fr', media = null, duration = null, wave = null }) {
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
       media_path,media_name,media_mime,media_size,created_at,delivered_at,duration_sec,wave)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(sender_id,client_id) DO NOTHING
  `, [id, sender.id, peer.id, clientId || null, kind, body, langFrom, langTo, '', '',
    media?.path || null, media?.name || null, media?.mime || null, media?.size || null,
    createdAt, deliveredAt, duration, wave]);
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
  const text = String(req.body.text || '').trim();
  if (!text || text.length > 5000) return res.status(400).json({ error: 'Le message doit contenir de 1 à 5 000 caractères' });
  const clientId = String(req.body.client_id || '').trim();
  if (clientId && (clientId.length > 120 || !/^[A-Za-z0-9_.-]+$/.test(clientId)))
    return res.status(400).json({ error: 'Identifiant de message invalide' });
  const langFrom = String(req.body.lang_from || 'fr').slice(0, 12);
  const langTo = String(req.body.lang_to || 'fr').slice(0, 12);
  const result = await insertMessage({ sender: req.user, peer, body: text, clientId: clientId || null, langFrom, langTo });
  if (!result.duplicate) {
    await notifyRecipient(result.row, req.user, peer);
    // Traduction Lokota (tâche de fond) — uniquement si lang_from ≠ lang_to
    if (langFrom !== langTo && !result.duplicate) {
      setImmediate(() => lokotatr.processMessage(result.row.id).catch(() => {}));
    }
  }
  res.status(result.duplicate ? 200 : 201).json({ ...forClient(result.row, req.user.id), id: result.row.id });
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
    const peer = await db.get('SELECT id,phone,name,presence_visible,last_seen_at FROM users WHERE id = ?', [peerId]);
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

async function getConversation(req, res) {
  const peer = await getPeer(req.params.phone);
  if (!peer || peer.status === 'blocked' || peer.id === req.user.id)
    return res.status(404).json({ error: 'Compte MboteCall introuvable' });
  const before = req.query.before == null ? null : Number(req.query.before);
  if (before != null && (!Number.isSafeInteger(before) || before < 0))
    return res.status(400).json({ error: 'Curseur invalide' });
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
  const unread = await db.all('SELECT id,sender_id FROM messages WHERE sender_id=? AND recipient_id=? AND read_at IS NULL AND deleted_at IS NULL', [peer.id, req.user.id]);
  await db.run('UPDATE messages SET delivered_at=COALESCE(delivered_at,?), read_at=COALESCE(read_at,?) WHERE sender_id=? AND recipient_id=? AND read_at IS NULL', [now(), now(), peer.id, req.user.id]);
  for (const m of unread) rtcWs.sendTo(peer.phone, { type: 'msg', kind: 'read', msg_id: m.id, from: req.user.phone, from_phone: req.user.phone });
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
      wave,
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

module.exports = { router, lokota };
