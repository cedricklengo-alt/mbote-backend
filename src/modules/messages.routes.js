/**
 * MESSAGES (v3.1) — « Chacun écrit dans sa langue, chacun lit dans la sienne »
 *
 *   POST /api/messages/send              { to, text, lang_from, lang_to, client_id }   (texte, photo en data-URI)
 *   POST /api/messages/send-media        corps BRUT (octets) + paramètres d'URL        (photo ou fichier)
 *   GET  /api/messages/threads           → fils UNIFIÉS (textes + notes vocales)
 *   GET  /api/messages/with/:phone       → conversation (?lite=1 : sans les contenus lourds)
 *   GET  /api/messages/media/:id         → contenu d'une pièce jointe / d'une note vocale (octets)
 *   POST /api/messages/with/:phone/read  → marque textes ET notes comme lus
 *   POST /api/messages/delete            { ids:[…], scope:'me'|'all' }                  (suppression groupée)
 *   POST /api/messages/:id/played        → note vocale écoutée par le destinataire
 *   DELETE /api/messages/:id             → supprimer pour tout le monde (ancienne route)
 *
 * Garde-fous : destinataire MboteCall uniquement, texte ≤ 1000 caractères,
 * photo ≤ 1,5 Mo (type vérifié sur les octets), fichier ≤ 5 Mo (types
 * exécutables refusés), langues fr/ln/sw, 120 messages et 40 médias par heure.
 * Si lang_from == lang_to : pas d'appel IA (statut 'done' direct).
 */

const express = require('express');
const path = require('path');
const db = require('../db');
const { uid, now, normalizePhone, ah } = require('../util');
const { requireAuth } = require('../middleware/auth');
const { rateLimit } = require('../middleware/ratelimit');
const lokota = require('../services/lokota');
const { isOnline } = require('./rtc.ws'); // présence en ligne

const r = express.Router();
const OK_LANGS = ['fr', 'ln', 'sw'];

const MAX_IMAGE_BYTES = 1_500_000;
const MAX_FILE_BYTES = 5_000_000;
const MAX_IDS_PER_DELETE = 100;

/** Extensions qui peuvent exécuter du code : jamais relayées */
const BLOCKED_EXT = new Set([
  'apk', 'apkm', 'xapk', 'aab', 'exe', 'msi', 'bat', 'cmd', 'com', 'scr', 'pif',
  'js', 'jse', 'vbs', 'vbe', 'wsf', 'jar', 'sh', 'ps1', 'dll', 'sys', 'lnk', 'reg',
]);

/** Types usuels reconnus par leur extension (quand le téléphone n'en donne pas) */
const MIME_BY_EXT = {
  pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv', rtf: 'application/rtf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text', ods: 'application/vnd.oasis.opendocument.spreadsheet',
  zip: 'application/zip', rar: 'application/vnd.rar', '7z': 'application/x-7z-compressed',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg', aac: 'audio/aac',
  mp4: 'video/mp4', '3gp': 'video/3gpp', mkv: 'video/x-matroska', webm: 'video/webm',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  json: 'application/json', xml: 'application/xml',
};

const limitSend = rateLimit({
  windowMs: 60 * 60_000, max: 120,
  key: (req) => 'msg:' + (req.user ? req.user.id : req.ip),
  message: 'Trop de messages envoyés. Réessaie dans une heure.',
});
const limitMedia = rateLimit({
  windowMs: 60 * 60_000, max: 40,
  key: (req) => 'media:' + (req.user ? req.user.id : req.ip),
  message: 'Trop de fichiers envoyés. Réessaie dans une heure.',
});

/* ───────────────────────── Aides ───────────────────────── */

/** Nom de fichier propre : sans chemin, sans caractères de contrôle, ≤ 120 car. */
function cleanName(raw) {
  let n = path.basename(String(raw || '').replace(/\\/g, '/'));
  n = n.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '').replace(/\s+/g, ' ').trim();
  if (!n || n === '.' || n === '..') return 'fichier';
  if (n.length > 120) {
    const ext = path.extname(n).slice(0, 12);
    n = n.slice(0, 120 - ext.length) + ext;
  }
  return n;
}
const extOf = (name) => path.extname(name).replace('.', '').toLowerCase();

/** Reconnaît une image d'après ses premiers octets (le type annoncé n'est pas cru) */
function sniffImage(b) {
  if (!b || b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG') return 'image/png';
  if (b.toString('latin1', 0, 3) === 'GIF') return 'image/gif';
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/** Extrait { mime, buf } d'une data-URI base64 */
function parseDataUri(uri) {
  const m = /^data:([^;,]+)(?:;[^,]*)*;base64,([\s\S]*)$/.exec(String(uri || ''));
  if (!m) return null;
  return { mime: m[1].toLowerCase(), buf: Buffer.from(m[2], 'base64') };
}

const mmss = (s) => `${Math.floor((s || 0) / 60)}:${String((s || 0) % 60).padStart(2, '0')}`;

/** Texte d'aperçu (notification, liste) — sans emoji, l'app ajoute l'icône */
function previewOf({ type, text, name, duration }) {
  const t = String(text || '').trim();
  switch (type) {
    case 'image': return t ? `Photo · ${t.length > 40 ? t.slice(0, 37) + '…' : t}` : 'Photo';
    case 'file': return `Document · ${name || 'fichier'}`;
    case 'voice': return `Note vocale · ${mmss(duration)}`;
    default: return t.length > 60 ? t.slice(0, 57) + '…' : t;
  }
}

/** Clause « pas masqué pour moi » */
const NOT_HIDDEN = (alias) =>
  `NOT EXISTS (SELECT 1 FROM msg_hidden h WHERE h.user_id = ? AND h.msg_id = ${alias}.id)`;

/** Retrouve un message (texte ou vocal) par son identifiant */
async function findMessage(id) {
  const t = await db.get(
    `SELECT id, from_id, to_id FROM text_messages WHERE id = ?`, [id]);
  if (t) return { ...t, table: 'text_messages' };
  const v = await db.get(
    `SELECT id, from_id, to_id FROM voice_notes WHERE id = ?`, [id]);
  return v ? { ...v, table: 'voice_notes' } : null;
}

async function wipeForEveryone(m) {
  if (m.table === 'text_messages') {
    await db.run(
      `UPDATE text_messages SET deleted=1, body='', translation=NULL, attachment=NULL,
         attachment_type=NULL, att_name=NULL, att_mime=NULL, att_size=NULL WHERE id=?`, [m.id]);
  } else {
    await db.run(
      `UPDATE voice_notes SET deleted=1, audio='', transcript=NULL, translation=NULL, wave=NULL WHERE id=?`, [m.id]);
  }
}

/** Destinataire valide, sinon répond et renvoie null */
async function recipientOr400(req, res, rawTo) {
  const to = normalizePhone(rawTo);
  if (!to) { res.status(400).json({ error: 'Numéro invalide (format +243…)' }); return null; }
  const toUser = await db.get(
    `SELECT id, name, fcm_token FROM users WHERE phone = ? AND role = 'user' AND status = 'active'`, [to]);
  if (!toUser) { res.status(404).json({ error: 'Ce numéro n\'a pas de compte MboteCall' }); return null; }
  if (toUser.id === req.user.id) {
    res.status(400).json({ error: 'Impossible de s\'envoyer un message à soi-même' });
    return null;
  }
  return { ...toUser, phone: to };
}

/**
 * Enregistre un message (texte, photo ou fichier) puis prévient le destinataire.
 * Commun à /send et /send-media. Idempotent grâce à client_id.
 */
async function createMessage(req, res, toUser, m) {
  const lf = OK_LANGS.includes(m.langFrom) ? m.langFrom : 'fr';
  const lt = OK_LANGS.includes(m.langTo) ? m.langTo : 'ln';
  // Mode privé (translate:false) : contenu jamais envoyé à l'IA
  const sameLang = lf === lt || m.translate === false;
  const clientId = String(m.clientId || '').trim().slice(0, 64) || null;

  if (clientId) {
    const dup = await db.get(
      `SELECT id, status FROM text_messages WHERE from_id = ? AND client_id = ?`,
      [req.user.id, clientId]);
    if (dup) {
      return res.json({ id: dup.id, status: dup.status, lokota_mode: lokota.mode(), duplicate: true });
    }
  }

  const id = uid('tm');
  const needsAi = !sameLang && m.text.length > 0; // photo/fichier sans légende : rien à traduire
  try {
    await db.run(
      `INSERT INTO text_messages(id, from_id, to_id, body, lang_from, lang_to, status, created_at,
                                 attachment, attachment_type, att_name, att_mime, att_size, client_id)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, req.user.id, toUser.id, m.text, lf, lt, needsAi ? 'pending' : 'done', now(),
       m.attachment || null, m.attType || null, m.attName || null, m.attMime || null,
       m.attSize || null, clientId]);
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

  if (needsAi) setImmediate(() => lokota.processMessage(id).catch(() => {}));

  const type = m.attType || 'text';
  const preview = previewOf({ type, text: m.text, name: m.attName });
  // Instantané : si son app est ouverte, elle est prévenue par le canal temps réel
  const live = require('./rtc.ws').notifyMessage(toUser.phone, {
    kind: 'message', mtype: type, from_phone: req.user.phone, from_name: req.user.name || '',
    msg_id: id, preview,
  });

  // Prévenir le destinataire (app fermée comprise)
  try {
    const push = require('../services/push');
    if (push.enabled() && toUser.fcm_token) {
      push.sendInfoPush(toUser.fcm_token, req.user.name || req.user.phone, preview, {
        kind: 'message', from_phone: req.user.phone,
        from_name: req.user.name || '', msg_id: id,
      });
      console.log(`[PUSH] Notification message envoyée → ${toUser.phone}${live ? ' (+ temps réel)' : ''}`);
    } else if (!push.enabled()) {
      console.log(`[PUSH] Non envoyé → ${toUser.phone} : service push désactivé (FIREBASE_SERVICE_ACCOUNT ?)`);
    } else {
      console.log(`[PUSH] Non envoyé → ${toUser.phone} : aucun jeton FCM (son app ne s'est pas enregistrée)`);
    }
  } catch (_) {}

  console.log(`[MESSAGES] ${id} (${type}) : ${req.user.phone} → ${toUser.phone} (${lf} → ${lt}, ${m.text.length} car.)`);
  res.json({ id, status: needsAi ? 'pending' : 'done', lokota_mode: lokota.mode() });
}

/* ───────────────────────── Envoi ───────────────────────── */

/* Message écrit (+ photo en data-URI pour les anciennes versions de l'app) */
r.post('/send', requireAuth, limitSend, ah(async (req, res) => {
  const toUser = await recipientOr400(req, res, req.body.to);
  if (!toUser) return;

  const text = String(req.body.text || '').trim();
  const attachment = String(req.body.attachment || '');
  if (attachment) {
    if (!attachment.startsWith('data:image/')) return res.status(400).json({ error: 'Pièce jointe non reconnue (photo uniquement)' });
    if (attachment.length > 400_000) return res.status(400).json({ error: 'Photo trop lourde. Elle sera compressée davantage, réessaie.' });
  }
  if (!text && !attachment) return res.status(400).json({ error: 'Message vide' });
  if (text.length > 1000) return res.status(400).json({ error: 'Message trop long (1000 caractères maximum)' });

  const img = attachment ? parseDataUri(attachment) : null;
  await createMessage(req, res, toUser, {
    text, attachment: attachment || null, attType: attachment ? 'image' : null,
    attMime: img ? img.mime : null, attSize: img ? img.buf.length : null,
    langFrom: req.body.lang_from, langTo: req.body.lang_to,
    translate: req.body.translate, clientId: req.body.client_id,
  });
}));

/** Lecture du corps brut avec message d'erreur clair en cas de dépassement */
function rawBody(req, res, next) {
  express.raw({ type: () => true, limit: '6mb' })(req, res, (err) => {
    if (!err) return next();
    const tooBig = err.status === 413 || err.type === 'entity.too.large';
    res.status(tooBig ? 413 : 400).json({
      error: tooBig ? 'Fichier trop volumineux (5 Mo maximum)' : 'Fichier illisible',
      code: tooBig ? 'TOO_LARGE' : 'BAD_BODY',
    });
  });
}

/* Photo ou fichier : octets BRUTS dans le corps (pas de base64 côté téléphone).
   Paramètres d'URL : to, kind (image|file), name, mime, text, lang_from, lang_to,
   translate (0|1), client_id */
r.post('/send-media', requireAuth, limitMedia, rawBody, ah(async (req, res) => {
  const q = req.query;
  const buf = Buffer.isBuffer(req.body) ? req.body : null;
  if (!buf || buf.length === 0) return res.status(400).json({ error: 'Fichier vide' });

  const toUser = await recipientOr400(req, res, q.to);
  if (!toUser) return;

  const text = String(q.text || '').trim().slice(0, 1000);
  const kind = q.kind === 'image' ? 'image' : 'file';
  let mime;
  let name;
  if (kind === 'image') {
    mime = sniffImage(buf);
    if (!mime) return res.status(400).json({ error: 'Image non reconnue (JPEG, PNG, WebP ou GIF)' });
    if (buf.length > MAX_IMAGE_BYTES) return res.status(413).json({ error: 'Photo trop lourde (1,5 Mo maximum)', code: 'TOO_LARGE' });
    name = cleanName(q.name || 'photo.' + mime.split('/')[1].replace('jpeg', 'jpg'));
  } else {
    if (buf.length > MAX_FILE_BYTES) return res.status(413).json({ error: 'Fichier trop volumineux (5 Mo maximum)', code: 'TOO_LARGE' });
    name = cleanName(q.name);
    const ext = extOf(name);
    if (BLOCKED_EXT.has(ext)) return res.status(400).json({ error: 'Ce type de fichier n\'est pas autorisé', code: 'BLOCKED' });
    const claimed = String(q.mime || '').toLowerCase();
    mime = /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/.test(claimed) ? claimed : (MIME_BY_EXT[ext] || 'application/octet-stream');
  }

  await createMessage(req, res, toUser, {
    text,
    attachment: `data:${mime};base64,${buf.toString('base64')}`,
    attType: kind, attName: name, attMime: mime, attSize: buf.length,
    langFrom: q.lang_from, langTo: q.lang_to,
    translate: q.translate === '0' || q.translate === 'false' ? false : true,
    clientId: q.client_id,
  });
}));

/* ───────────────────────── Fils et conversation ───────────────────────── */

/* Fils de discussion UNIFIÉS (dernier échange par proche, texte ou note) */
r.get('/threads', requireAuth, ah(async (req, res) => {
  const me = req.user.id;
  const notes = await db.all(
    `SELECT vn.id, vn.from_id, vn.duration_sec, vn.created_at, vn.read_at, vn.delivered_at,
            uf.phone AS from_phone, uf.name AS from_name,
            ut.phone AS to_phone,   ut.name AS to_name, vn.deleted
     FROM voice_notes vn
     JOIN users uf ON uf.id = vn.from_id
     JOIN users ut ON ut.id = vn.to_id
     WHERE (vn.from_id = ? OR vn.to_id = ?) AND ${NOT_HIDDEN('vn')}
     ORDER BY vn.created_at DESC LIMIT 200`, [me, me, me]);
  const texts = await db.all(
    `SELECT tm.id, tm.from_id, tm.body, tm.attachment_type, tm.att_name, tm.created_at, tm.read_at, tm.delivered_at, tm.deleted,
            uf.phone AS from_phone, uf.name AS from_name,
            ut.phone AS to_phone,   ut.name AS to_name
     FROM text_messages tm
     JOIN users uf ON uf.id = tm.from_id
     JOIN users ut ON ut.id = tm.to_id
     WHERE (tm.from_id = ? OR tm.to_id = ?) AND ${NOT_HIDDEN('tm')}
     ORDER BY tm.created_at DESC LIMIT 200`, [me, me, me]);

  // Ce que mon téléphone vient de télécharger est LIVRÉ
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
      let type = 'text';
      let preview;
      if (it.deleted) { type = 'deleted'; preview = 'Message supprimé'; }
      else if (it.kind === 'note') { type = 'voice'; preview = previewOf({ type, duration: it.duration_sec }); }
      else if (it.attachment_type === 'image' || it.attachment_type === 'file') {
        type = it.attachment_type;
        preview = previewOf({ type, text: it.body, name: it.att_name });
      } else preview = it.body.length > 44 ? it.body.slice(0, 41) + '…' : it.body;
      t = { peer_phone: peerPhone, peer_name: peerName || '',
            last_at: it.created_at, last_kind: it.kind, last_type: type,
            last_mine: mine, last_preview: preview, unread: 0,
            // état du dernier message envoyé : sent · delivered · read
            last_state: mine
              ? (it.read_at ? 'read' : (it.delivered_at ? 'delivered' : 'sent'))
              : null };
      threads.set(peerPhone, t);
    }
    if (!mine && !it.read_at && !it.deleted) t.unread++;
  }
  // qui est en ligne en ce moment (connexion WebSocket active)
  res.json([...threads.values()].map((t) =>
    ({ ...t, online: isOnline(t.peer_phone) })));
}));

/* Conversation complète avec un proche (textes + notes, triés).
   ?lite=1 → AUCUN contenu lourd (photo, fichier, audio) : l'app les télécharge
   à la demande par /media/:id. ?before=<ms>&limit=<n> → messages plus anciens. */
r.get('/with/:phone', requireAuth, ah(async (req, res) => {
  const phone = normalizePhone(req.params.phone);
  const peer = await db.get(`SELECT id, name FROM users WHERE phone = ?`, [phone]);
  if (!peer) return res.status(404).json({ error: 'Contact inconnu' });
  const me = req.user.id;
  const lite = req.query.lite === '1';
  const before = parseInt(req.query.before, 10) || 0;
  const limit = Math.max(20, Math.min(300, parseInt(req.query.limit, 10) || (lite ? 150 : 100)));

  // livré dès que mon téléphone ouvre le fil
  await db.run(`UPDATE text_messages SET delivered_at=? WHERE to_id=? AND from_id=? AND delivered_at IS NULL`, [now(), me, peer.id]);
  await db.run(`UPDATE voice_notes SET delivered_at=? WHERE to_id=? AND from_id=? AND delivered_at IS NULL`, [now(), me, peer.id]);

  const both = `((from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?))`;
  const pairArgs = [me, peer.id, peer.id, me];
  const beforeSql = before ? ` AND created_at < ?` : '';
  const args = [...pairArgs, me, ...(before ? [before] : []), limit];

  const noteCols = lite
    ? `id, from_id, CASE WHEN audio <> '' THEN 1 ELSE 0 END AS has_media, duration_sec, lang_from, lang_to,
       transcript, translation, status, created_at, read_at, delivered_at, played_at, wave, deleted`
    : `id, from_id, audio, CASE WHEN audio <> '' THEN 1 ELSE 0 END AS has_media, duration_sec, lang_from, lang_to,
       transcript, translation, status, created_at, read_at, delivered_at, played_at, wave, deleted`;
  const textCols = lite
    ? `id, from_id, body, lang_from, lang_to, translation, status, created_at, read_at, delivered_at,
       CASE WHEN attachment IS NOT NULL AND attachment <> '' THEN 1 ELSE 0 END AS has_media,
       attachment_type, att_name, att_mime, att_size, deleted`
    : `id, from_id, body, lang_from, lang_to, translation, status, created_at, read_at, delivered_at,
       attachment, CASE WHEN attachment IS NOT NULL AND attachment <> '' THEN 1 ELSE 0 END AS has_media,
       attachment_type, att_name, att_mime, att_size, deleted`;

  const notes = await db.all(
    `SELECT ${noteCols} FROM voice_notes
     WHERE ${both} AND ${NOT_HIDDEN('voice_notes')}${beforeSql}
     ORDER BY created_at DESC LIMIT ?`, args);
  const texts = await db.all(
    `SELECT ${textCols} FROM text_messages
     WHERE ${both} AND ${NOT_HIDDEN('text_messages')}${beforeSql}
     ORDER BY created_at DESC LIMIT ?`, args);

  let items = [
    ...notes.map((n) => ({ ...n, kind: 'note', mine: n.from_id === me, has_media: !!n.has_media })),
    ...texts.map((t) => ({ ...t, kind: 'text', mine: t.from_id === me, has_media: !!t.has_media })),
  ].sort((a, b) => b.created_at - a.created_at);
  const hasMore = notes.length >= limit || texts.length >= limit || items.length > limit;
  items = items.slice(0, limit).reverse(); // ordre chronologique

  res.json({ peer_name: peer.name || '', peer_online: isOnline(phone), has_more: hasMore, items });
}));

/* Contenu d'une pièce jointe ou d'une note vocale (octets, avec le bon type) */
r.get('/media/:id', requireAuth, ah(async (req, res) => {
  const id = String(req.params.id || '');
  const me = req.user.id;
  let row = await db.get(
    `SELECT from_id, to_id, attachment AS data, att_name AS name, deleted FROM text_messages WHERE id = ?`, [id]);
  if (!row) {
    row = await db.get(`SELECT from_id, to_id, audio AS data, deleted FROM voice_notes WHERE id = ?`, [id]);
  }
  // introuvable OU étranger à la conversation : même réponse (rien ne fuite)
  if (!row || (row.from_id !== me && row.to_id !== me)) {
    return res.status(404).json({ error: 'Contenu introuvable', code: 'NOT_FOUND' });
  }
  const hidden = await db.get(`SELECT 1 AS x FROM msg_hidden WHERE user_id = ? AND msg_id = ?`, [me, id]);
  if (hidden) return res.status(404).json({ error: 'Contenu introuvable', code: 'NOT_FOUND' });
  if (row.deleted || !row.data) {
    return res.status(410).json({ error: 'Contenu supprimé ou expiré', code: 'GONE' });
  }
  const parsed = parseDataUri(row.data);
  if (!parsed) return res.status(410).json({ error: 'Contenu illisible', code: 'GONE' });

  // types actifs (page web, SVG) : jamais servis tels quels
  const risky = /^(text\/html|image\/svg\+xml|application\/xhtml)/.test(parsed.mime);
  res.set({
    'Content-Type': risky ? 'application/octet-stream' : parsed.mime,
    'Content-Length': String(parsed.buf.length),
    'Cache-Control': 'private, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': row.name
      ? `${risky ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(row.name)}`
      : (risky ? 'attachment' : 'inline'),
  });
  res.end(parsed.buf);
}));

/* Marquer comme lus (textes ET notes) */
r.post('/with/:phone/read', requireAuth, ah(async (req, res) => {
  const phone = normalizePhone(req.params.phone);
  const peer = await db.get(`SELECT id FROM users WHERE phone = ?`, [phone]);
  if (!peer) return res.status(404).json({ error: 'Contact inconnu' });
  const unread =
    ((await db.get(`SELECT COUNT(*) AS n FROM text_messages WHERE to_id = ? AND from_id = ? AND read_at IS NULL`,
      [req.user.id, peer.id]))?.n || 0) +
    ((await db.get(`SELECT COUNT(*) AS n FROM voice_notes WHERE to_id = ? AND from_id = ? AND read_at IS NULL`,
      [req.user.id, peer.id]))?.n || 0);
  const t = now();
  await db.run(
    `UPDATE text_messages SET read_at = ? WHERE to_id = ? AND from_id = ? AND read_at IS NULL`,
    [t, req.user.id, peer.id]);
  await db.run(
    `UPDATE voice_notes SET read_at = ? WHERE to_id = ? AND from_id = ? AND read_at IS NULL`,
    [t, req.user.id, peer.id]);
  // l'expéditeur voit ses coches passer en « lu » aussitôt
  if (Number(unread) > 0) {
    require('./rtc.ws').notifyMessage(phone, { kind: 'read', from_phone: req.user.phone });
  }
  res.json({ ok: true });
}));

/* ───────────────────────── Suppression ───────────────────────── */

/* Suppression groupée.
   scope 'me'  : masque pour MOI uniquement (messages reçus comme envoyés)
   scope 'all' : vide le contenu des deux côtés (expéditeur uniquement) */
r.post('/delete', requireAuth, ah(async (req, res) => {
  const ids = Array.isArray(req.body.ids)
    ? [...new Set(req.body.ids.map((x) => String(x)))].slice(0, MAX_IDS_PER_DELETE) : [];
  if (!ids.length) return res.status(400).json({ error: 'Aucun message sélectionné' });
  const scope = req.body.scope === 'all' ? 'all' : 'me';
  const me = req.user.id;

  const results = {};
  const toNotify = new Map(); // id de l'autre personne → identifiants supprimés
  for (const id of ids) {
    const m = await findMessage(id);
    if (!m || (m.from_id !== me && m.to_id !== me)) { results[id] = 'missing'; continue; }
    if (scope === 'all') {
      if (m.from_id !== me) { results[id] = 'forbidden'; continue; }
      await wipeForEveryone(m);
      results[id] = 'deleted';
      if (!toNotify.has(m.to_id)) toNotify.set(m.to_id, []);
      toNotify.get(m.to_id).push(id);
    } else {
      await db.run(
        `INSERT INTO msg_hidden(user_id, msg_id, at) VALUES(?,?,?) ON CONFLICT (user_id, msg_id) DO NOTHING`,
        [me, id, now()]);
      results[id] = 'hidden';
    }
  }
  // l'autre personne voit disparaître le contenu tout de suite
  for (const [peerId, list] of toNotify) {
    const peer = await db.get(`SELECT phone FROM users WHERE id = ?`, [peerId]);
    if (peer) require('./rtc.ws').notifyMessage(peer.phone, { kind: 'deleted', from_phone: req.user.phone, ids: list });
  }
  res.json({ ok: true, scope, results });
}));

/* Ancienne route : supprimer pour tout le monde (expéditeur uniquement) */
r.delete('/:id', requireAuth, ah(async (req, res) => {
  const m = await findMessage(String(req.params.id || ''));
  if (!m || (m.from_id !== req.user.id && m.to_id !== req.user.id)) {
    return res.status(404).json({ error: 'Message introuvable' });
  }
  if (m.from_id !== req.user.id) return res.status(403).json({ error: 'Seul l\'expéditeur peut supprimer ce message' });
  await wipeForEveryone(m);
  const peer = await db.get(`SELECT phone FROM users WHERE id = ?`, [m.to_id]);
  if (peer) require('./rtc.ws').notifyMessage(peer.phone, { kind: 'deleted', from_phone: req.user.phone, ids: [m.id] });
  res.json({ ok: true });
}));

/* ───────────────────────── Écoute d'une note vocale ───────────────────────── */

r.post('/:id/played', requireAuth, ah(async (req, res) => {
  const id = String(req.params.id || '');
  const vn = await db.get(`SELECT id, from_id, to_id, played_at FROM voice_notes WHERE id = ?`, [id]);
  if (!vn || vn.to_id !== req.user.id) return res.status(404).json({ error: 'Note introuvable' });
  if (!vn.played_at) {
    await db.run(`UPDATE voice_notes SET played_at = ? WHERE id = ?`, [now(), id]);
    const sender = await db.get(`SELECT phone FROM users WHERE id = ?`, [vn.from_id]);
    if (sender) require('./rtc.ws').notifyMessage(sender.phone, { kind: 'played', from_phone: req.user.phone, ids: [id] });
  }
  res.json({ ok: true });
}));

module.exports = r;
