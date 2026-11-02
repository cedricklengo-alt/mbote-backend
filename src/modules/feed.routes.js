'use strict';

const express  = require('express');
const db       = require('../db');
const { requireAuth } = require('../middleware/auth');
const { uid, now, ah } = require('../util');

const r = express.Router();

// ─── GET /api/feed ────────────────────────────────────────────────────────────
// Fil principal : posts publics + communauté + propres posts.
// Visibilité « contacts » : visible si le poster est dans les contacts de l'utilisateur.
// Pagination curseur : ?before=<ts>&cursor=<id>
r.get('/', requireAuth, ah(async (req, res) => {
  const userId = req.user.id;
  const limit  = 20;
  const before = req.query.before  ? Number(req.query.before) : now() + 1;
  const cursor = req.query.cursor  || '\xff'; // valeur maximale par défaut

  // Placeholders « ? » simples uniquement : le driver PostgreSQL les convertit
  // en $1, $2… séquentiellement, donc une forme numérotée « ?1 » produirait
  // « $11 » et casserait la requête en production.
  const posts = await db.all(`
    SELECT p.*,
           u.name    AS author_name,
           u.country AS author_country,
           CASE WHEN pl.user_id IS NOT NULL THEN 1 ELSE 0 END AS liked
    FROM posts p
    JOIN users u ON u.id = p.user_id
    LEFT JOIN post_likes pl ON pl.post_id = p.id AND pl.user_id = ?
    WHERE (
        p.visibilite IN ('public', 'communauté')
        OR p.user_id = ?
        OR (
          p.visibilite = 'contacts'
          AND p.user_id IN (
            SELECT c.user_id FROM contacts c
            JOIN users uc ON uc.phone = c.phone
            WHERE uc.id = ?
          )
        )
      )
      AND (p.created_at < ? OR (p.created_at = ? AND p.id < ?))
    ORDER BY p.created_at DESC, p.id DESC
    LIMIT ?
  `, [userId, userId, userId, before, before, cursor, limit + 1]);

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
  const cutoff = now() - 24 * 60 * 60 * 1000;

  const stories = await db.all(`
    SELECT s.*,
           u.name    AS author_name,
           u.country AS author_country,
           CASE WHEN ss.user_id IS NOT NULL THEN 1 ELSE 0 END AS seen
    FROM stories s
    JOIN users u ON u.id = s.user_id
    LEFT JOIN stories_seen ss ON ss.story_id = s.id AND ss.user_id = ?
    WHERE s.created_at >= ?
    ORDER BY seen ASC, s.created_at DESC
  `, [userId, cutoff]);

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
  if (type === 'texte'  && !texte)       return res.status(400).json({ error: 'texte requis' });
  if (type === 'photo'  && !media_url)   return res.status(400).json({ error: 'media_url requis' });
  if (type === 'clip'   && !media_url)   return res.status(400).json({ error: 'media_url requis' });
  if (type === 'event'  && !event_title) return res.status(400).json({ error: 'event_title requis' });

  const id = uid('po');
  const ts = now();

  await db.run(`
    INSERT INTO posts
      (id, user_id, type, origine, duree, visibilite,
       media_url, texte, event_title, event_date, event_tags,
       clip_sec, likes, comments, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)
  `, [
    id, req.user.id, type, origine, duree, visibilite,
    media_url      || null,
    texte          || null,
    event_title    || null,
    event_date     || null,
    event_tags     ? JSON.stringify(event_tags) : null,
    clip_duree_seconds || null,
    ts,
  ]);

  const post = await db.get(
    `SELECT p.*, u.name AS author_name, u.country AS author_country
     FROM posts p JOIN users u ON u.id = p.user_id WHERE p.id = ?`,
    [id]);
  res.status(201).json({ post });
}));

// ─── POST /api/feed/stories ───────────────────────────────────────────────────
// Publier une story (expire automatiquement après 24 h).
r.post('/stories', requireAuth, ah(async (req, res) => {
  const { media_url } = req.body;
  if (!media_url) return res.status(400).json({ error: 'media_url requis' });

  const id = uid('st');
  const ts = now();

  // La table stories n'a pas de colonne expires_at : la péremption à 24 h est
  // calculée à la lecture (WHERE created_at >= cutoff).
  await db.run(
    'INSERT INTO stories (id, user_id, media_url, created_at) VALUES (?, ?, ?, ?)',
    [id, req.user.id, media_url, ts],
  );

  const story = await db.get('SELECT * FROM stories WHERE id = ?', [id]);
  res.status(201).json({ story });
}));

// ─── POST /api/feed/stories/:id/seen ─────────────────────────────────────────
r.post('/stories/:id/seen', requireAuth, ah(async (req, res) => {
  const story = await db.get('SELECT id FROM stories WHERE id = ?', [req.params.id]);
  if (!story) return res.status(404).json({ error: 'Story introuvable' });

  await db.run(
    `INSERT INTO stories_seen (story_id, user_id, seen_at) VALUES (?, ?, ?)
     ON CONFLICT (story_id, user_id) DO NOTHING`,
    [req.params.id, req.user.id, now()],
  );
  res.json({ ok: true });
}));

// ─── POST /api/feed/posts/:id/like ───────────────────────────────────────────
// Toggle like — retourne le nouvel état.
r.post('/posts/:id/like', requireAuth, ah(async (req, res) => {
  const { id }   = req.params;
  const userId   = req.user.id;
  const post     = await db.get('SELECT id, likes FROM posts WHERE id = ?', [id]);
  if (!post) return res.status(404).json({ error: 'Post introuvable' });

  const existing = await db.get(
    'SELECT 1 FROM post_likes WHERE post_id = ? AND user_id = ?', [id, userId],
  );

  // MAX() est un agrégat en PostgreSQL : on passe par db.fn.greatest
  // (MAX en SQLite, GREATEST en PostgreSQL). La clé primaire (post_id,user_id)
  // empêche tout doublon de like.
  const G = db.fn.greatest;

  if (existing) {
    await db.tx(async (tx) => {
      await tx.run('DELETE FROM post_likes WHERE post_id = ? AND user_id = ?', [id, userId]);
      await tx.run(`UPDATE posts SET likes = ${G}(0, likes - 1) WHERE id = ?`, [id]);
    });
    res.json({ liked: false, likes: Math.max(0, post.likes - 1) });
  } else {
    await db.tx(async (tx) => {
      await tx.run(
        `INSERT INTO post_likes (post_id, user_id, created_at) VALUES (?, ?, ?)
         ON CONFLICT (post_id, user_id) DO NOTHING`,
        [id, userId, now()],
      );
      await tx.run('UPDATE posts SET likes = likes + 1 WHERE id = ?', [id]);
    });
    res.json({ liked: true, likes: post.likes + 1 });
  }
}));

// ─── GET /api/feed/posts/:id/comments ────────────────────────────────────────
r.get('/posts/:id/comments', requireAuth, ah(async (req, res) => {
  const post = await db.get('SELECT id FROM posts WHERE id = ?', [req.params.id]);
  if (!post) return res.status(404).json({ error: 'Post introuvable' });

  const comments = await db.all(`
    SELECT c.*, u.name AS author_name
    FROM post_comments c
    JOIN users u ON u.id = c.user_id
    WHERE c.post_id = ?
    ORDER BY c.created_at ASC
  `, [req.params.id]);

  res.json({ comments });
}));

// ─── POST /api/feed/posts/:id/comments ───────────────────────────────────────
r.post('/posts/:id/comments', requireAuth, ah(async (req, res) => {
  const { texte } = req.body;
  if (!texte || !texte.trim()) return res.status(400).json({ error: 'texte requis' });

  const post = await db.get('SELECT id FROM posts WHERE id = ?', [req.params.id]);
  if (!post) return res.status(404).json({ error: 'Post introuvable' });

  const cmId = uid('cm');
  const ts   = now();

  await db.tx(async (tx) => {
    await tx.run(
      'INSERT INTO post_comments (id, post_id, user_id, texte, created_at) VALUES (?, ?, ?, ?, ?)',
      [cmId, req.params.id, req.user.id, texte.trim(), ts],
    );
    await tx.run(
      'UPDATE posts SET comments = comments + 1 WHERE id = ?',
      [req.params.id],
    );
  });

  const comment = await db.get(`
    SELECT c.*, u.name AS author_name
    FROM post_comments c
    JOIN users u ON u.id = c.user_id
    WHERE c.id = ?
  `, [cmId]);

  res.status(201).json({ comment });
}));

module.exports = r;
