'use strict';

/**
 * FIL RANKÉ MBOTECALL — v4.1
 * ───────────────────────────
 *   GET  /ranked?tab=for_you|following|trending&cursor=&limit=   fil personnalisé
 *   POST /events            événement (view/like/comment/share/profile_visit/scroll)
 *   POST /posts/:id/react   réaction (like|love|haha|wow|sad|angry|care|solidarity)
 *   POST /comments/:id/react réaction sur commentaire
 *   GET  /hashtags/trending hashtags tendance (24 h)
 *   GET  /mentions/search?q= recherche @ dynamique
 *
 * Le score est recalculé à chaque événement et persisté (feed_scores).
 * Aucune route existante n'est modifiée.
 */

const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { uid, now, ah } = require('../util');
const R = require('../services/ranking');
const { predicatVisibilite, predicatNonExpire, normaliserTag, extraireTags } = require('../services/feed_rules');

const r = express.Router();

/** Construit le contexte de ranking d'un utilisateur. */
async function ctxDe(userId) {
  const m = Date.now();
  const prefs = await db.get(`SELECT interests FROM user_preferences WHERE user_id = ?`, [userId]);
  let interests = {};
  try { interests = prefs && prefs.interests ? JSON.parse(prefs.interests) : {}; } catch { interests = {}; }
  const tagsInteret = Object.entries(interests.tags || {})
    .sort((a, b) => b[1] - a[1]).slice(0, 25).map(e => e[0]);
  const affinity = interests.affinity || {};
  const follows = await db.all(`SELECT following_id FROM follows WHERE follower_id = ?`, [userId]);
  const auteursSuivis = follows.map(f => f.following_id);
  const auteur = await db.get(`SELECT ville FROM users WHERE id = ?`, [userId]);
  const likesAuteur = {}, commentairesAuteur = {}, partagesAuteur = {}, profilVisites = {};
  for (const [a, v] of Object.entries(affinity)) {
    likesAuteur[a] = v.likes || 0;
    commentairesAuteur[a] = v.comments || 0;
    partagesAuteur[a] = v.shares || 0;
    profilVisites[a] = v.profilVisites || 0;
  }
  return {
    maintenant: m,
    tagsInteret, auteursSuivis,
    likesAuteur, commentairesAuteur, partagesAuteur, profilVisites,
    ville: auteur && auteur.ville,
    amis: auteursSuivis, // dans MboteCall, suivre = lien social fort
  };
}

/** Posts visibles (réutilise la règle de visibilité existante). */
async function postsVisibles(userId, limit = 300) {
  const me = await db.get(`SELECT phone FROM users WHERE id = ?`, [userId]);
  const rows = await db.all(
    `SELECT p.*, (SELECT COUNT(*) FROM post_likes l WHERE l.post_id = p.id) AS likes,
            (SELECT COUNT(*) FROM post_comments c WHERE c.post_id = p.id) AS comments,
            (SELECT COUNT(*) FROM post_views v WHERE v.post_id = p.id) AS views,
            COALESCE(p.shares, 0) AS shares
     FROM posts p ORDER BY p.created_at DESC LIMIT ?`,
    [limit]
  );
  return rows.filter(p => predicatVisibilite(userId, me && me.phone)(p) && predicatNonExpire(Date.now())(p));
}

// ── Fil ranké ──────────────────────────────────────────────────────────────
r.get('/ranked', requireAuth, ah(async (req, res) => {
  const userId = req.user.id;
  const tab = ['for_you', 'following', 'trending'].includes(req.query.tab) ? req.query.tab : 'for_you';
  const limit = Math.min(50, Math.max(5, parseInt(req.query.limit) || 20));
  const cursor = parseInt(req.query.cursor) || 0;
  const ctx = await ctxDe(userId);

  let posts;
  if (tab === 'following') {
    posts = (await db.all(
      `SELECT p.*, (SELECT COUNT(*) FROM post_likes l WHERE l.post_id = p.id) AS likes,
              (SELECT COUNT(*) FROM post_comments c WHERE c.post_id = p.id) AS comments,
              (SELECT COUNT(*) FROM post_views v WHERE v.post_id = p.id) AS views,
              COALESCE(p.shares, 0) AS shares
       FROM posts p JOIN follows f ON f.following_id = p.user_id AND f.follower_id = ?
       ORDER BY p.created_at DESC LIMIT 300`, [userId])).filter(predicatNonExpire(Date.now()));
    posts = posts.map(p => ({ ...p, _score: 0 })); // chrono pur
  } else if (tab === 'trending') {
    posts = await postsVisibles(userId, 300);
    posts = R.rankPosts(posts, ctx); // triées par popularité globale via score
  } else {
    posts = await postsVisibles(userId, 300);
    posts = R.rankPosts(posts, ctx); // « Pour vous » : ranking complet
    for (const p of posts.slice(0, 50)) {
      await R.persistScore(db, p.id, p._score, p._detail).catch(() => {});
    }
  }
  const page = posts.slice(cursor, cursor + limit);
  res.json({
    tab, posts: page, nextCursor: cursor + limit < posts.length ? String(cursor + limit) : null,
    total: posts.length,
  });
}));

// ── Événements (recalcul auto du score) ────────────────────────────────────
r.post('/events', requireAuth, ah(async (req, res) => {
  const { type, postId, authorId, tag, meta } = req.body || {};
  if (!['view', 'like', 'comment', 'share', 'profile_visit', 'scroll', 'watch'].includes(type)) {
    return res.status(400).json({ error: 'type invalide' });
  }
  await R.recordEvent(db, req.user.id, type, { postId, authorId, tag, meta });
  // rescore différé de la publication concernée
  if (postId) {
    const p = await db.get(`SELECT * FROM posts WHERE id = ?`, [postId]);
    if (p) {
      const ctx = await ctxDe(req.user.id);
      const { score, detail } = R.computeScore({ ...p, likes: 0, comments: 0, views: 0, shares: 0 }, ctx);
      await R.persistScore(db, postId, score, detail).catch(() => {});
    }
  }
  res.json({ ok: true });
}));

// ── Réactions (8 types) ────────────────────────────────────────────────────
r.post('/posts/:id/react', requireAuth, ah(async (req, res) => {
  const type = String(req.body?.type || 'like');
  if (!R.REACTIONS.includes(type)) return res.status(400).json({ error: 'réaction invalide' });
  const id = uid();
  await db.run(
    `INSERT INTO post_reactions (id, post_id, user_id, type, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(post_id, user_id) DO UPDATE SET type=excluded.type, created_at=excluded.created_at`,
    [id, req.params.id, req.user.id, type, now()]);
  // compat : un like de type « like » alimente aussi post_likes
  if (type === 'like') {
    await db.run(`INSERT OR IGNORE INTO post_likes (post_id, user_id, created_at) VALUES (?, ?, ?)`,
      [req.params.id, req.user.id, now()]).catch(() => {});
  } else {
    await db.run(`DELETE FROM post_likes WHERE post_id = ? AND user_id = ?`, [req.params.id, req.user.id]).catch(() => {});
  }
  await R.recordEvent(db, req.user.id, 'like', { postId: req.params.id });
  // 🔔 Push « réaction » avec post_id (deep-linking vers la publication).
  try {
    const push = require('../services/push');
    const post = await db.get('SELECT user_id FROM posts WHERE id = ?', [req.params.id]);
    const auteur = post ? await db.get('SELECT id, fcm_token FROM users WHERE id = ?', [post.user_id]) : null;
    if (auteur && auteur.fcm_token && auteur.id !== req.user.id) {
      push.sendInfoPush(auteur.fcm_token,
        type === 'like' ? 'Nouveau j\u2019aime' : 'Nouvelle réaction',
        `${req.user.name || 'Quelqu\u2019un'} a réagi à votre publication`,
        { kind: type === 'like' ? 'post_like' : 'reaction', post_id: String(req.params.id), from_phone: req.user.phone, from_name: req.user.name || '' })
        .catch(() => {});
    }
  } catch (_) {}
  const counts = await db.all(
    `SELECT type, COUNT(*) n FROM post_reactions WHERE post_id = ? GROUP BY type`, [req.params.id]);
  res.json({ ok: true, reactions: counts });
}));

r.delete('/posts/:id/react', requireAuth, ah(async (req, res) => {
  await db.run(`DELETE FROM post_reactions WHERE post_id = ? AND user_id = ?`, [req.params.id, req.user.id]);
  await db.run(`DELETE FROM post_likes WHERE post_id = ? AND user_id = ?`, [req.params.id, req.user.id]).catch(() => {});
  res.json({ ok: true });
}));

r.post('/comments/:id/react', requireAuth, ah(async (req, res) => {
  const type = String(req.body?.type || 'like');
  // 👍/👎 de commentaire : like ou dislike (les autres réactions restent
  // réservées aux publications).
  if (!['like', 'dislike'].includes(type)) return res.status(400).json({ error: 'réaction invalide' });
  const cmt = await db.get('SELECT id FROM post_comments WHERE id = ?', [req.params.id]);
  if (!cmt) return res.status(404).json({ error: 'Commentaire introuvable' });
  await db.run(
    `INSERT INTO comment_reactions (id, comment_id, user_id, type, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(comment_id, user_id) DO UPDATE SET type=excluded.type, created_at=excluded.created_at`,
    [uid(), req.params.id, req.user.id, type, now()]);
  const counts = await db.all(
    `SELECT type, COUNT(*) n FROM comment_reactions WHERE comment_id = ? GROUP BY type`, [req.params.id]);
  const likes = Number(counts.find((c) => c.type === 'like')?.n || 0);
  const dislikes = Number(counts.find((c) => c.type === 'dislike')?.n || 0);
  res.json({ ok: true, likes, dislikes, mine: type });
}));

r.delete('/comments/:id/react', requireAuth, ah(async (req, res) => {
  await db.run('DELETE FROM comment_reactions WHERE comment_id = ? AND user_id = ?', [req.params.id, req.user.id]);
  const counts = await db.all(
    `SELECT type, COUNT(*) n FROM comment_reactions WHERE comment_id = ? GROUP BY type`, [req.params.id]);
  const likes = Number(counts.find((c) => c.type === 'like')?.n || 0);
  const dislikes = Number(counts.find((c) => c.type === 'dislike')?.n || 0);
  res.json({ ok: true, likes, dislikes, mine: null });
}));

// ── Hashtags tendance ──────────────────────────────────────────────────────
r.get('/hashtags/trending', requireAuth, ah(async (req, res) => {
  const since = Date.now() - 24 * 3600 * 1000;
  const rows = await db.all(
    `SELECT LOWER(t.tag) tag, COUNT(*) n FROM post_tags t
     JOIN posts p ON p.id = t.post_id
     WHERE p.created_at >= ? GROUP BY LOWER(t.tag) ORDER BY n DESC LIMIT 30`, [since]);
  res.json({ tags: rows });
}));

// ── Mentions @ recherche dynamique ─────────────────────────────────────────
r.get('/mentions/search', requireAuth, ah(async (req, res) => {
  const q = String(req.query.q || '').trim().replace(/^@/, '');
  if (!q) return res.json({ users: [] });
  const like = `%${q.toLowerCase()}%`;
  const rows = await db.all(
    `SELECT id, name, handle, avatar FROM users
     WHERE LOWER(name) LIKE ? OR LOWER(handle) LIKE ? LIMIT 10`, [like, like]);
  res.json({ users: rows });
}));

module.exports = r;
