'use strict';

const express  = require('express');
const db       = require('../db');
const { requireAuth } = require('../middleware/auth');
const { uid, now, ah } = require('../util');

const r = express.Router();

async function canViewPost(post, userId) {
  if (!post) return false;
  if (post.author_id === userId || post.visibilite === 'public' || post.visibilite === 'communauté') return true;
  if (post.visibilite !== 'contacts') return false;
  return !!(await db.get(
    `SELECT 1 FROM contacts c JOIN users u ON u.phone = c.phone
     WHERE c.user_id = ? AND u.id = ? LIMIT 1`,
    [userId, post.author_id],
  ));
}

// ─── GET /api/feed ────────────────────────────────────────────────────────────
// Fil principal : posts publics + communauté + propres posts.
// Visibilité « contacts » : visible si le poster est dans les contacts de l'utilisateur.
// Pagination curseur : ?before=<ts>&cursor=<id>
r.get('/', requireAuth, ah(async (req, res) => {
  const userId = req.user.id;
  const limit  = 20;
  const before = req.query.before  ? Number(req.query.before) : now() + 1;
  if (!Number.isSafeInteger(before) || before < 0)
    return res.status(400).json({ error: 'Curseur invalide' });
  const cursor = req.query.cursor  || '\xff'; // valeur maximale par défaut

  const posts = await db.all(`
    SELECT p.*,
           u.name    AS author_name,
           u.country AS author_country,
           u.avatar  AS avatar_url,
           CASE WHEN pl.user_id IS NOT NULL THEN 1 ELSE 0 END AS liked
    FROM posts p
    JOIN users u ON u.id = p.author_id
    LEFT JOIN post_likes pl ON pl.post_id = p.id AND pl.user_id = ?
    WHERE (
        p.visibilite IN ('public', 'communauté')
        OR p.author_id = ?
        OR (
          p.visibilite = 'contacts'
          AND p.author_id IN (
            SELECT u2.id FROM contacts c
            JOIN users u2 ON u2.phone = c.phone
            WHERE c.user_id = ?
          )
        )
      )
      AND (p.duree != 'h24' OR p.created_at >= ?)
      AND (p.created_at < ? OR (p.created_at = ? AND p.id < ?))
    ORDER BY p.created_at DESC, p.id DESC
    LIMIT ?
  `, [userId, userId, userId, now() - 24 * 60 * 60 * 1000, before, before, cursor, limit + 1]);

  const hasMore = posts.length > limit;
  const items   = hasMore ? posts.slice(0, limit) : posts;
  const last    = items[items.length - 1];

  res.json({
    posts: items,
    next:  hasMore && last ? { before: last.created_at, cursor: last.id } : null,
  });
}));

// ─── GET /api/feed/stories ────────────────────────────────────────────────────
// Stories actives (< 24h), non vues en premier.
r.get('/stories', requireAuth, ah(async (req, res) => {
  const userId = req.user.id;
  const stories = await db.all(`
    SELECT s.*, u.name AS author_name, u.country AS author_country,
           u.avatar AS avatar_url,
           CASE WHEN ss.user_id IS NOT NULL THEN 1 ELSE 0 END AS seen,
           CASE WHEN s.author_id = ? THEN 1 ELSE 0 END AS is_mine
    FROM stories s
    JOIN users u ON u.id = s.author_id
    LEFT JOIN stories_seen ss ON ss.story_id = s.id AND ss.user_id = ?
    WHERE s.expires_at > ?
      AND (
        s.author_id = ?
        OR s.visibilite IN ('public', 'communauté')
        OR (s.visibilite = 'contacts' AND s.author_id IN (
          SELECT u2.id FROM contacts c JOIN users u2 ON u2.phone = c.phone WHERE c.user_id = ?
        ))
      )
    ORDER BY seen ASC, s.created_at DESC
  `, [userId, userId, now(), userId, userId]);
  res.json({ stories });
}));

// ─── POST /api/feed/posts ─────────────────────────────────────────────────────
// Créer un post.
r.post('/posts', requireAuth, ah(async (req, res) => {
  const {
    type,
    origine            = 'rdc',
    duree              = 'permanent',
    visibilite         = 'public',
    media_url,
    texte,
    event_title,
    event_date,
    event_lieu,
    event_tags,
    clip_duree_seconds,
  } = req.body;

  if (!['photo', 'clip', 'texte', 'event'].includes(type))
    return res.status(400).json({ error: 'Type invalide (photo|clip|texte|event)' });
  if (!['rdc', 'diaspora'].includes(origine))
    return res.status(400).json({ error: 'Origine invalide (rdc|diaspora)' });
  if (!['h24', 'permanent'].includes(duree))
    return res.status(400).json({ error: 'Durée invalide (h24|permanent)' });
  if (!['contacts', 'communauté', 'public'].includes(visibilite))
    return res.status(400).json({ error: 'Visibilité invalide' });
  if (type === 'texte'  && (typeof texte !== 'string' || !texte.trim())) return res.status(400).json({ error: 'texte requis' });
  if (texte != null && (typeof texte !== 'string' || texte.length > 2000))
    return res.status(400).json({ error: 'Le texte ne peut pas dépasser 2 000 caractères' });
  if (type === 'photo'  && !media_url)   return res.status(400).json({ error: 'media_url requis' });
  if (type === 'clip'   && !media_url)   return res.status(400).json({ error: 'media_url requis' });
  if (type === 'event'  && !event_title) return res.status(400).json({ error: 'event_title requis' });
  if (type === 'clip' && clip_duree_seconds != null && (!Number.isInteger(Number(clip_duree_seconds)) || Number(clip_duree_seconds) < 1 || Number(clip_duree_seconds) > 180))
    return res.status(400).json({ error: 'Durée de clip invalide' });
  if (type === 'event' && String(event_title).trim().length > 120)
    return res.status(400).json({ error: 'Titre d’événement trop long' });
  if (event_lieu != null && (typeof event_lieu !== 'string' || event_lieu.trim().length > 160))
    return res.status(400).json({ error: 'Lieu d’événement trop long' });
  if (event_date != null && (!Number.isSafeInteger(Number(event_date)) || Number(event_date) < 0))
    return res.status(400).json({ error: 'Date d’événement invalide' });

  const id = uid('po');
  const ts = now();

  await db.run(`
    INSERT INTO posts
      (id, author_id, type, origine, duree, visibilite,
       media_url, texte, event_title, event_date, event_lieu, event_tags,
       clip_duree_seconds, likes_count, comments_count, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)
  `, [
    id, req.user.id, type, origine, duree, visibilite,
    media_url      || null,
    texte          ? String(texte).trim() : null,
    event_title    ? String(event_title).trim() : null,
    event_date     || null,
    event_lieu     ? String(event_lieu).trim() : null,
    event_tags     ? JSON.stringify(Array.isArray(event_tags) ? event_tags.slice(0, 20).map((x) => String(x).slice(0, 40)) : []) : null,
    clip_duree_seconds ? Number(clip_duree_seconds) : null,
    ts,
  ]);

  const post = await db.get(
    `SELECT p.*, u.name AS author_name, u.country AS author_country, u.avatar AS avatar_url
     FROM posts p JOIN users u ON u.id = p.author_id WHERE p.id = ?`,
    [id]);
  res.status(201).json({ post });
}));

// ─── POST /api/feed/stories ───────────────────────────────────────────────────
// Publier une story (expire automatiquement après 24 h).
r.post('/stories', requireAuth, ah(async (req, res) => {
  const { media_url } = req.body;
  const visibilite = req.body.visibilite || 'contacts';
  if (typeof media_url !== 'string' || !media_url || media_url.length > 2048)
    return res.status(400).json({ error: 'media_url requis' });
  if (!['contacts', 'communauté', 'public'].includes(visibilite))
    return res.status(400).json({ error: 'Visibilité invalide' });

  const id = uid('st');
  const ts = now();

  await db.run(
    'INSERT INTO stories (id, author_id, media_url, created_at, expires_at, visibilite) VALUES (?, ?, ?, ?, ?, ?)',
    [id, req.user.id, media_url, ts, ts + 24 * 60 * 60 * 1000, visibilite],
  );

  const story = await db.get('SELECT * FROM stories WHERE id = ?', [id]);
  res.status(201).json({ story });
}));

// ─── POST /api/feed/stories/:id/seen ─────────────────────────────────────────
r.post('/stories/:id/seen', requireAuth, ah(async (req, res) => {
  const story = await db.get('SELECT id, author_id FROM stories WHERE id = ? AND expires_at > ?', [req.params.id, now()]);
  if (!story) return res.status(404).json({ error: 'Story introuvable' });
  if (story.author_id === req.user.id) return res.json({ ok: true, own_story: true });
  const visible = await db.get(`SELECT 1 FROM stories s WHERE s.id = ? AND (
    s.visibilite IN ('public', 'communauté') OR (s.visibilite = 'contacts' AND s.author_id IN (
      SELECT u.id FROM contacts c JOIN users u ON u.phone = c.phone WHERE c.user_id = ?
    )))`, [req.params.id, req.user.id]);
  if (!visible) return res.status(404).json({ error: 'Story introuvable' });

  await db.run(
    'INSERT INTO stories_seen (story_id, user_id, seen_at) VALUES (?, ?, ?) ON CONFLICT(story_id,user_id) DO NOTHING',
    [req.params.id, req.user.id, now()],
  );
  res.json({ ok: true });
}));

// Les consultations d'un statut ne sont visibles que par son auteur.
r.get('/stories/:id/views', requireAuth, ah(async (req, res) => {
  const story = await db.get('SELECT id, author_id FROM stories WHERE id = ?', [req.params.id]);
  if (!story || story.author_id !== req.user.id)
    return res.status(404).json({ error: 'Story introuvable' });
  const viewers = await db.all(`
    SELECT u.id, u.name, u.avatar, ss.seen_at
    FROM stories_seen ss JOIN users u ON u.id = ss.user_id
    WHERE ss.story_id = ? ORDER BY ss.seen_at DESC LIMIT 200
  `, [req.params.id]);
  res.json({ viewers, count: viewers.length });
}));

// ─── POST /api/feed/posts/:id/like ───────────────────────────────────────────
// Toggle like — retourne le nouvel état.
r.post('/posts/:id/like', requireAuth, ah(async (req, res) => {
  const { id }   = req.params;
  const userId   = req.user.id;
  const post     = await db.get('SELECT id, author_id, visibilite FROM posts WHERE id = ?', [id]);
  if (!post) return res.status(404).json({ error: 'Post introuvable' });
  if (!await canViewPost(post, userId)) return res.status(404).json({ error: 'Post introuvable' });
  const existing = await db.get('SELECT 1 FROM post_likes WHERE post_id = ? AND user_id = ?', [id, userId]);
  const desired = typeof req.body.liked === 'boolean' ? req.body.liked : !existing;
  await db.tx(async (tx) => {
    if (desired) {
      await tx.run(
        'INSERT INTO post_likes(post_id,user_id,created_at) VALUES(?,?,?) ON CONFLICT(post_id,user_id) DO NOTHING',
        [id, userId, now()],
      );
    } else {
      await tx.run('DELETE FROM post_likes WHERE post_id = ? AND user_id = ?', [id, userId]);
    }
    const total = await tx.get('SELECT COUNT(*) AS n FROM post_likes WHERE post_id = ?', [id]);
    await tx.run('UPDATE posts SET likes_count = ? WHERE id = ?', [Number(total.n), id]);
  });
  const total = await db.get('SELECT likes_count FROM posts WHERE id = ?', [id]);
  res.json({ liked: desired, likes: Number(total.likes_count) });
}));

// ─── GET /api/feed/posts/:id/comments ────────────────────────────────────────
r.get('/posts/:id/comments', requireAuth, ah(async (req, res) => {
  const post = await db.get('SELECT id, author_id, visibilite FROM posts WHERE id = ?', [req.params.id]);
  if (!await canViewPost(post, req.user.id)) return res.status(404).json({ error: 'Post introuvable' });

  const comments = await db.all(`
    SELECT c.*, u.name AS author_name
    FROM post_comments c
    JOIN users u ON u.id = c.author_id
    WHERE c.post_id = ?
    ORDER BY c.created_at ASC
  `, [req.params.id]);

  res.json({ comments });
}));

// ─── POST /api/feed/posts/:id/comments ───────────────────────────────────────
r.post('/posts/:id/comments', requireAuth, ah(async (req, res) => {
  const { texte } = req.body;
  if (typeof texte !== 'string' || !texte.trim() || texte.trim().length > 1000)
    return res.status(400).json({ error: 'Le commentaire doit contenir de 1 à 1 000 caractères' });

  const post = await db.get('SELECT id, author_id, visibilite FROM posts WHERE id = ?', [req.params.id]);
  if (!await canViewPost(post, req.user.id)) return res.status(404).json({ error: 'Post introuvable' });

  const cmId = uid('cm');
  const ts   = now();

  await db.tx(async (tx) => {
    await tx.run(
      'INSERT INTO post_comments (id, post_id, author_id, texte, created_at) VALUES (?, ?, ?, ?, ?)',
      [cmId, req.params.id, req.user.id, texte.trim(), ts],
    );
    await tx.run(
      'UPDATE posts SET comments_count = comments_count + 1 WHERE id = ?',
      [req.params.id],
    );
  });

  const comment = await db.get(`
    SELECT c.*, u.name AS author_name
    FROM post_comments c
    JOIN users u ON u.id = c.author_id
    WHERE c.id = ?
  `, [cmId]);

  res.status(201).json({ comment });
}));

module.exports = r;
