'use strict';
// modules/feed.routes.js — API Feed Mbote v3.2
// Routes :
//   GET  /api/feed              → flux paginé (cursor)
//   GET  /api/feed/stories      → statuts actifs < 24h
//   POST /api/feed/posts        → créer un post
//   POST /api/feed/stories      → publier un statut
//   POST /api/feed/stories/:id/seen
//   POST /api/feed/posts/:id/like
//   GET  /api/feed/posts/:id/comments
//   POST /api/feed/posts/:id/comments

const express        = require('express');
const db             = require('../db');
const { requireAuth} = require('../middleware/auth');
const { uid, now, ah } = require('../util');

const r = express.Router();

// ── Flux principal (cursor-based) ─────────────────────────────────────────
r.get('/', requireAuth, ah(async (req, res) => {
  const userId  = req.user.id;
  const limit   = Math.min(parseInt(req.query.limit) || 20, 50);
  const before  = parseInt(req.query.before) || now();
  const cursor  = req.query.cursor || null;

  // Posts de contacts + communauté + public, triés du plus récent
  const rows = await db.all(
    `SELECT p.*, u.name AS author_name, u.phone AS author_phone, u.avatar AS author_avatar,
            (SELECT 1 FROM post_likes pl WHERE pl.post_id = p.id AND pl.user_id = ?) AS liked,
            (SELECT 1 FROM contacts c WHERE c.user_id = ? AND c.contact_phone = u.phone) AS is_contact
     FROM posts p
     JOIN users u ON u.id = p.user_id
     WHERE p.created_at < ?
       AND (cursor IS NULL OR (p.created_at, p.id) < (?, ?))
       AND (
         p.visibilite = 'public'
         OR p.user_id = ?
         OR (p.visibilite = 'contacts'
             AND EXISTS (SELECT 1 FROM contacts c WHERE c.user_id = ? AND c.contact_phone = u.phone))
         OR p.visibilite = 'communaute'
       )
     ORDER BY p.created_at DESC, p.id DESC
     LIMIT ?`,
    [userId, userId, before, before, cursor || '', userId, userId, limit]
  );

  const items = rows.map(row => _fmtPost(row));
  const next  = items.length === limit
    ? { before: items[items.length - 1].createdAt, cursor: items[items.length - 1].id }
    : null;

  res.json({ items, next });
}));

// ── Statuts (stories) actifs ──────────────────────────────────────────────
r.get('/stories', requireAuth, ah(async (req, res) => {
  const userId  = req.user.id;
  const cutoff  = now() - 86400000; // 24h en ms

  const rows = await db.all(
    `SELECT s.*, u.name AS author_name, u.phone AS author_phone,
            (SELECT 1 FROM stories_seen ss WHERE ss.story_id = s.id AND ss.user_id = ?) AS seen
     FROM stories s
     JOIN users u ON u.id = s.user_id
     WHERE s.created_at > ?
       AND (s.user_id = ?
            OR EXISTS (SELECT 1 FROM contacts c WHERE c.user_id = ? AND c.contact_phone = u.phone))
     ORDER BY seen ASC, s.created_at DESC`,
    [userId, cutoff, userId, userId]
  );

  res.json(rows.map(r => ({
    id:          r.id,
    authorId:    r.user_id,
    authorName:  r.author_name,
    authorPhone: r.author_phone,
    authorAvatar:r.author_avatar || null,
    mediaUrl:    r.media_url,
    texte:       r.texte,
    createdAt:   r.created_at,
    isSeen:      !!r.seen,
    isMe:        r.user_id === userId,
  })));
}));

// ── Créer un post ─────────────────────────────────────────────────────────
r.post('/posts', requireAuth, ah(async (req, res) => {
  const { type, texte, mediaUrl, eventTitle, eventDate, eventLieu,
          eventTags, clipSec, ville, visibilite, origine, duree } = req.body;

  if (!type) return res.status(400).json({ error: 'type requis' });

  const id = uid('pst');
  await db.run(
    `INSERT INTO posts
      (id, user_id, type, texte, media_url, event_title, event_date,
       event_lieu, event_tags, clip_sec, ville, visibilite, origine, duree, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, req.user.id, type, texte || null, mediaUrl || null,
     eventTitle || null, eventDate || null, eventLieu || null,
     JSON.stringify(eventTags || []), clipSec || null,
     ville || null, visibilite || 'contacts', origine || 'rdc',
     duree || 'permanent', now()]
  );

  res.status(201).json({ id });
}));

// ── Publier un statut ─────────────────────────────────────────────────────
r.post('/stories', requireAuth, ah(async (req, res) => {
  const { mediaUrl, texte } = req.body;
  if (!mediaUrl && !texte) return res.status(400).json({ error: 'media_url ou texte requis' });

  const id = uid('sto');
  await db.run(
    `INSERT INTO stories (id, user_id, media_url, texte, created_at) VALUES (?,?,?,?,?)`,
    [id, req.user.id, mediaUrl || null, texte || null, now()]
  );

  res.status(201).json({ id });
}));

// ── Marquer un statut vu ──────────────────────────────────────────────────
r.post('/stories/:id/seen', requireAuth, ah(async (req, res) => {
  const { id } = req.params;
  await db.run(
    `INSERT OR IGNORE INTO stories_seen (story_id, user_id, seen_at) VALUES (?,?,?)`,
    [id, req.user.id, now()]
  );
  res.json({ ok: true });
}));

// ── Like / unlike ─────────────────────────────────────────────────────────
r.post('/posts/:id/like', requireAuth, ah(async (req, res) => {
  const { id } = req.params;
  const userId = req.user.id;

  const existing = await db.get(
    `SELECT 1 FROM post_likes WHERE post_id = ? AND user_id = ?`,
    [id, userId]
  );

  if (existing) {
    await db.run(`DELETE FROM post_likes WHERE post_id = ? AND user_id = ?`, [id, userId]);
    await db.run(`UPDATE posts SET likes = MAX(0, likes - 1) WHERE id = ?`, [id]);
    return res.json({ liked: false });
  }

  await db.run(`INSERT INTO post_likes (post_id, user_id, created_at) VALUES (?,?,?)`, [id, userId, now()]);
  await db.run(`UPDATE posts SET likes = likes + 1 WHERE id = ?`, [id]);
  const post = await db.get(`SELECT likes FROM posts WHERE id = ?`, [id]);
  res.json({ liked: true, likes: post?.likes ?? 0 });
}));

// ── Commentaires (lecture) ────────────────────────────────────────────────
r.get('/posts/:id/comments', requireAuth, ah(async (req, res) => {
  const rows = await db.all(
    `SELECT pc.*, u.name AS author_name FROM post_comments pc
     JOIN users u ON u.id = pc.user_id
     WHERE pc.post_id = ?
     ORDER BY pc.created_at ASC`,
    [req.params.id]
  );

  res.json(rows.map(r => ({
    id:         r.id,
    authorId:   r.user_id,
    authorName: r.author_name,
    texte:      r.texte,
    createdAt:  r.created_at,
  })));
}));

// ── Commentaires (ajout) ──────────────────────────────────────────────────
r.post('/posts/:id/comments', requireAuth, ah(async (req, res) => {
  const { texte } = req.body;
  if (!texte?.trim()) return res.status(400).json({ error: 'texte requis' });

  const id = uid('cmt');
  await db.run(
    `INSERT INTO post_comments (id, post_id, user_id, texte, created_at) VALUES (?,?,?,?,?)`,
    [id, req.params.id, req.user.id, texte.trim(), now()]
  );
  await db.run(`UPDATE posts SET comments = comments + 1 WHERE id = ?`, [req.params.id]);

  res.status(201).json({ id });
}));

// ── Formattage interne ────────────────────────────────────────────────────
function _fmtPost(row) {
  return {
    id:           row.id,
    authorId:     row.user_id,
    authorName:   row.author_name,
    authorPhone:  row.author_phone,
    authorAvatar: row.author_avatar || null,
    type:         row.type,
    texte:        row.texte,
    mediaUrl:     row.media_url,
    eventTitle:   row.event_title,
    eventDate:    row.event_date,
    eventLieu:    row.event_lieu,
    eventTags:    JSON.parse(row.event_tags || '[]'),
    clipSec:      row.clip_sec,
    ville:        row.ville,
    visibilite:   row.visibilite,
    origine:      row.origine,
    duree:        row.duree,
    likes:        row.likes,
    comments:     row.comments,
    liked:        !!row.liked,
    isContact:    !!row.is_contact,
    createdAt:    row.created_at,
  };
}

module.exports = r;
