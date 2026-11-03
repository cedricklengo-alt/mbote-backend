'use strict';

/**
 * FIL DE PUBLICATIONS MBOTE
 *
 * ── Ce qui n'allait pas ────────────────────────────────────────────────────
 * 1. La visibilité par défaut du formulaire de l'application était
 *    « Mes contacts », et cette visibilité ne montrait la publication qu'aux
 *    gens qui avaient DÉJÀ l'auteur dans leur répertoire téléphonique. Résultat
 *    concret : personne ne voyait rien, sauf l'auteur — parce que la requête du
 *    fil contient toujours « OR p.user_id = moi ».
 * 2. La comparaison de visibilité se faisait sur des chaînes accentuées
 *    écrites à la main : une différence d'encodage suffisait à rendre une
 *    publication invisible sans aucune erreur.
 * 3. Le fil ne savait faire qu'une chose : lister par date. Aucune vue, aucun
 *    abonnement, aucun mot-clé, aucun profil d'auteur — rien de ce qui fait un
 *    fil public digne de ce nom.
 * 4. La durée « 24 h » était enregistrée mais jamais lue : rien n'expirait.
 *
 * ── Ce que fait ce module ─────────────────────────────────────────────────
 *   GET    /                      fil « Pour toi » (chronologique, tout le visible)
 *   GET    /discover              découverte : ?sort=tendances|recent, ?tag=, ?ville=
 *   GET    /following             publications des auteurs que je suis
 *   GET    /tags                  mots-clés en tendance
 *   GET    /tags/:tag             publications d'un mot-clé
 *   GET    /authors/:id           profil public + ses publications visibles
 *   POST   /authors/:id/follow    s'abonner
 *   DELETE /authors/:id/follow    se désabonner
 *   GET    /posts/:id             une publication (lien de partage)
 *   POST   /posts/:id/view        compter une vue (une seule par lecteur)
 *   + création, j'aime, commentaires, suppression, statuts (inchangés)
 */

const express = require('express');
const db      = require('../db');
const { requireAuth } = require('../middleware/auth');
const path    = require('path');
const fs      = require('fs');
const { uid, now, ah } = require('../util');
const {
  canoniserVisibilite, canoniserDuree, extraireTags, normaliserTag,
  predicatVisibilite, predicatNonExpire, trierParInteret,
} = require('../services/feed_rules');


/**
 * Supprime le fichier d'un média quand sa publication disparaît.
 * Ne touche qu'aux fichiers servis par CE serveur (`/uploads/…`) : une URL
 * externe (Cloudinary, autre CDN) n'est jamais effacée.
 */
async function removeUploadedFile(mediaUrl) {
  try {
    if (!mediaUrl || typeof mediaUrl !== 'string') return;
    const marker = '/uploads/';
    const i = mediaUrl.indexOf(marker);
    if (i === -1) return;
    const name = path.basename(mediaUrl.slice(i + marker.length).split('?')[0]);
    if (!name || name.includes('..')) return;
    const file = path.join(__dirname, '..', '..', 'uploads', name);
    await fs.promises.unlink(file).catch(() => {});
  } catch { /* le fichier est peut-être déjà parti : sans gravité */ }
}

// ─── Sélection commune ──────────────────────────────────────────────────────

/**
 * Colonnes renvoyées pour chaque publication.
 *
 * Le numéro de l'auteur n'est exposé que s'il est dans MES contacts (ou s'il
 * s'agit de moi) : c'est ce qui rend le bouton « Appeler » utilisable sans
 * publier les numéros de tout le monde.
 */
function selectPosts(userId) {
  const CONTACT_AUTHORS = `SELECT uc.id FROM contacts c
                             JOIN users uc ON uc.phone = c.phone
                            WHERE c.user_id = ?`;
  return {
    sql: `
      SELECT p.*,
             u.name    AS author_name,
             u.country AS author_country,
             u.avatar  AS author_avatar,
             CASE WHEN p.user_id = ? OR p.user_id IN (${CONTACT_AUTHORS})
                  THEN u.phone ELSE NULL END AS author_phone,
             CASE WHEN pl.user_id IS NOT NULL THEN 1 ELSE 0 END AS liked
        FROM posts p
        JOIN users u ON u.id = p.user_id
        LEFT JOIN post_likes pl ON pl.post_id = p.id AND pl.user_id = ?`,
    params: [userId, userId, userId],
  };
}

/**
 * Ajoute à chaque publication ce que le client ne peut pas deviner :
 * ses mots-clés, le nombre de vues (0 pour les lignes anciennes) et si je suis
 * l'auteur (bouton « Suivre » ou non).
 */
async function enrichir(posts, userId) {
  if (!posts.length) return posts;

  const ids = posts.map((p) => p.id);
  const trous = ids.map(() => '?').join(',');
  const lignes = await db.all(
    `SELECT post_id, tag FROM post_tags WHERE post_id IN (${trous}) ORDER BY tag`, ids);
  const tagsParPost = new Map();
  for (const l of lignes) {
    if (!tagsParPost.has(l.post_id)) tagsParPost.set(l.post_id, []);
    tagsParPost.get(l.post_id).push(l.tag);
  }

  const auteurs = [...new Set(posts.map((p) => String(p.user_id)))];
  const trousAuteurs = auteurs.map(() => '?').join(',');
  const suivis = await db.all(
    `SELECT followee_id FROM follows WHERE follower_id = ? AND followee_id IN (${trousAuteurs})`,
    [userId, ...auteurs]);
  const estSuivi = new Set(suivis.map((s) => String(s.followee_id)));

  return posts.map((p) => ({
    ...p,
    vues: Number(p.vues || 0),
    tags: tagsParPost.get(p.id) || [],
    suivi: estSuivi.has(String(p.user_id)) ? 1 : 0,
    a_moi: String(p.user_id) === String(userId) ? 1 : 0,
  }));
}

/** Enregistre les mots-clés d'une publication (idempotent). */
async function enregistrerTags(postId, tags) {
  for (const tag of tags) {
    await db.run(
      `INSERT INTO post_tags (post_id, tag) VALUES (?, ?)
       ON CONFLICT (post_id, tag) DO NOTHING`, [postId, tag]);
  }
}

const r = express.Router();

// ─── GET /api/feed ───────────────────────────────────────────────────────────
// Fil « Pour toi » : tout ce que j'ai le droit de voir, du plus récent au plus
// ancien. Pagination curseur : ?before=<ts>&cursor=<id>
r.get('/', requireAuth, ah(async (req, res) => {
  const userId = req.user.id;
  const limit  = 20;
  const before = req.query.before ? Number(req.query.before) : now() + 1;
  const cursor = req.query.cursor || '\xff';

  const sel  = selectPosts(userId);
  const vis  = predicatVisibilite(userId, req.user.phone);
  const exp  = predicatNonExpire(now());

  const posts = await db.all(`${sel.sql}
    WHERE ${vis.sql}
      AND ${exp.sql}
      AND (p.created_at < ? OR (p.created_at = ? AND p.id < ?))
    ORDER BY p.created_at DESC, p.id DESC
    LIMIT ?`,
  [...sel.params, ...vis.params, ...exp.params, before, before, cursor, limit + 1]);

  const hasMore = posts.length > limit;
  const items   = hasMore ? posts.slice(0, limit) : posts;
  const last    = items[items.length - 1];

  res.json({
    posts: await enrichir(items, userId),
    next: hasMore && last ? { before: last.created_at, cursor: last.id } : null,
  });
}));

// ─── GET /api/feed/discover ──────────────────────────────────────────────────
// Découverte publique : ?sort=tendances (défaut) | recent, ?tag=, ?ville=
// « tendances » classe par intérêt (j'aime, commentaires, vues) pondéré par la
// fraîcheur ; « recent » est un simple fil chronologique public.
r.get('/discover', requireAuth, ah(async (req, res) => {
  const userId  = req.user.id;
  const sort    = req.query.sort === 'recent' ? 'recent' : 'tendances';
  const limit   = Math.min(Number(req.query.limit) || 20, 50);
  const tag     = req.query.tag ? normaliserTag(req.query.tag) : null;
  const ville   = String(req.query.ville || '').trim();
  const t       = now();

  const sel = selectPosts(userId);
  const exp = predicatNonExpire(t);

  const filtres = [`p.visibilite IN ('public', 'communaute', 'communauté')`, exp.sql];
  const params  = [...exp.params];

  if (tag) {
    filtres.push(`p.id IN (SELECT pt.post_id FROM post_tags pt WHERE pt.tag = ?)`);
    params.push(tag);
  }
  if (ville) {
    filtres.push(`LOWER(COALESCE(p.ville, '')) LIKE ?`);
    params.push(`%${ville.toLowerCase()}%`);
  }

  if (sort === 'recent') {
    const before = req.query.before ? Number(req.query.before) : t + 1;
    const cursor = req.query.cursor || '\xff';
    const rows = await db.all(`${sel.sql}
      WHERE ${filtres.join(' AND ')}
        AND (p.created_at < ? OR (p.created_at = ? AND p.id < ?))
      ORDER BY p.created_at DESC, p.id DESC
      LIMIT ?`,
    [...sel.params, ...params, before, before, cursor, limit + 1]);
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items[items.length - 1];
    return res.json({
      sort, tag, posts: await enrichir(items, userId),
      next: hasMore && last ? { before: last.created_at, cursor: last.id } : null,
    });
  }

  // Tendances : on prend une fenêtre de candidats (14 jours, 300 publications
  // maximum) puis on classe en mémoire — les deux moteurs SQL n'ont pas accès
  // aux mêmes fonctions mathématiques.
  const fenetre = t - 14 * 24 * 60 * 60 * 1000;
  const candidats = await db.all(`${sel.sql}
    WHERE ${filtres.join(' AND ')}
      AND p.created_at >= ?
    ORDER BY p.created_at DESC
    LIMIT 300`, [...sel.params, ...params, fenetre]);

  const classes = trierParInteret(candidats, t);
  const offset  = Math.max(0, Number(req.query.offset) || 0);
  const items   = classes.slice(offset, offset + limit);

  res.json({
    sort, tag, posts: await enrichir(items, userId),
    next: offset + limit < classes.length ? { offset: offset + limit } : null,
  });
}));

// ─── GET /api/feed/following ─────────────────────────────────────────────────
// Les publications des auteurs que je suis (mêmes règles de visibilité).
r.get('/following', requireAuth, ah(async (req, res) => {
  const userId = req.user.id;
  const limit  = 20;
  const before = req.query.before ? Number(req.query.before) : now() + 1;
  const cursor = req.query.cursor || '\xff';

  const sel = selectPosts(userId);
  const vis = predicatVisibilite(userId, req.user.phone);
  const exp = predicatNonExpire(now());

  const posts = await db.all(`${sel.sql}
    WHERE p.user_id IN (SELECT followee_id FROM follows WHERE follower_id = ?)
      AND ${vis.sql}
      AND ${exp.sql}
      AND (p.created_at < ? OR (p.created_at = ? AND p.id < ?))
    ORDER BY p.created_at DESC, p.id DESC
    LIMIT ?`,
  [...sel.params, userId, ...vis.params, ...exp.params, before, before, cursor, limit + 1]);

  const hasMore = posts.length > limit;
  const items   = hasMore ? posts.slice(0, limit) : posts;
  const last    = items[items.length - 1];

  res.json({
    posts: await enrichir(items, userId),
    next: hasMore && last ? { before: last.created_at, cursor: last.id } : null,
  });
}));

// ─── GET /api/feed/tags ──────────────────────────────────────────────────────
// Mots-clés en tendance sur les 7 derniers jours.
r.get('/tags', requireAuth, ah(async (req, res) => {
  const limite = Math.min(Number(req.query.limit) || 20, 50);
  const depuis = now() - 7 * 24 * 60 * 60 * 1000;

  const tags = await db.all(`
    SELECT pt.tag AS tag,
           COUNT(*) AS publications,
           SUM(COALESCE(p.likes, 0) + COALESCE(p.comments, 0)) AS engagement
      FROM post_tags pt
      JOIN posts p ON p.id = pt.post_id
     WHERE p.created_at >= ?
       AND p.visibilite IN ('public', 'communaute', 'communauté')
     GROUP BY pt.tag
     ORDER BY publications DESC, engagement DESC
     LIMIT ?`, [depuis, limite]);

  res.json({
    tags: tags.map((t) => ({
      tag: t.tag,
      publications: Number(t.publications || 0),
      engagement: Number(t.engagement || 0),
    })),
  });
}));

// ─── GET /api/feed/tags/:tag ─────────────────────────────────────────────────
// Publications portant ce mot-clé (délègue à la découverte).
r.get('/tags/:tag', requireAuth, ah(async (req, res) => {
  const tag = normaliserTag(req.params.tag);
  if (!tag) return res.status(400).json({ error: 'Mot-clé invalide' });

  const userId = req.user.id;
  const sel = selectPosts(userId);
  const exp = predicatNonExpire(now());

  const posts = await db.all(`${sel.sql}
    WHERE p.visibilite IN ('public', 'communaute', 'communauté')
      AND ${exp.sql}
      AND p.id IN (SELECT pt.post_id FROM post_tags pt WHERE pt.tag = ?)
    ORDER BY p.created_at DESC
    LIMIT 50`, [...sel.params, ...exp.params, tag]);

  res.json({ tag, posts: await enrichir(posts, userId) });
}));

// ─── GET /api/feed/authors/:id ───────────────────────────────────────────────
// Profil public d'un auteur : ce qu'il faut pour décider de le suivre.
r.get('/authors/:id', requireAuth, ah(async (req, res) => {
  const userId = req.user.id;
  const id     = String(req.params.id);

  const auteur = await db.get(
    'SELECT id, name, avatar, country, phone FROM users WHERE id = ?', [id]);
  if (!auteur) return res.status(404).json({ error: 'Auteur introuvable' });

  const estDansMesContacts = await db.get(
    `SELECT 1 AS ok FROM contacts c JOIN users u ON u.phone = c.phone
      WHERE c.user_id = ? AND u.id = ?`, [userId, id]);

  const expiration = predicatNonExpire(now());
  const [abonnes, abonnements, suivi, publications] = await Promise.all([
    db.get('SELECT COUNT(*) AS n FROM follows WHERE followee_id = ?', [id]),
    db.get('SELECT COUNT(*) AS n FROM follows WHERE follower_id = ?', [id]),
    db.get('SELECT 1 AS ok FROM follows WHERE follower_id = ? AND followee_id = ?', [userId, id]),
    db.get(`SELECT COUNT(*) AS n FROM posts p
             WHERE p.user_id = ? AND ${expiration.sql}`, [id, ...expiration.params]),
  ]);

  const sel = selectPosts(userId);
  const vis = predicatVisibilite(userId, req.user.phone);
  const exp = predicatNonExpire(now());
  const posts = await db.all(`${sel.sql}
    WHERE p.user_id = ? AND ${vis.sql} AND ${exp.sql}
    ORDER BY p.created_at DESC LIMIT 30`,
  [...sel.params, id, ...vis.params, ...exp.params]);

  res.json({
    auteur: {
      id: auteur.id,
      name: auteur.name,
      avatar: auteur.avatar || null,
      country: auteur.country || null,
      // Même règle que dans le fil : le numéro n'est donné qu'à un contact.
      phone: (String(auteur.id) === String(userId) || estDansMesContacts) ? auteur.phone : null,
      abonnes: Number(abonnes && abonnes.n) || 0,
      abonnements: Number(abonnements && abonnements.n) || 0,
      publications: Number(publications && publications.n) || 0,
      suivi: !!suivi,
      a_moi: String(auteur.id) === String(userId),
    },
    posts: await enrichir(posts, userId),
  });
}));

// ─── POST/DELETE /api/feed/authors/:id/follow ────────────────────────────────
r.post('/authors/:id/follow', requireAuth, ah(async (req, res) => {
  const id = String(req.params.id);
  if (id === String(req.user.id))
    return res.status(400).json({ error: 'Tu ne peux pas t’abonner à toi-même' });

  const auteur = await db.get('SELECT id FROM users WHERE id = ?', [id]);
  if (!auteur) return res.status(404).json({ error: 'Auteur introuvable' });

  await db.run(
    `INSERT INTO follows (follower_id, followee_id, created_at) VALUES (?, ?, ?)
     ON CONFLICT (follower_id, followee_id) DO NOTHING`, [req.user.id, id, now()]);

  const n = await db.get('SELECT COUNT(*) AS n FROM follows WHERE followee_id = ?', [id]);
  res.json({ suivi: true, abonnes: Number(n && n.n) || 0 });
}));

r.delete('/authors/:id/follow', requireAuth, ah(async (req, res) => {
  const id = String(req.params.id);
  await db.run('DELETE FROM follows WHERE follower_id = ? AND followee_id = ?',
    [req.user.id, id]);
  const n = await db.get('SELECT COUNT(*) AS n FROM follows WHERE followee_id = ?', [id]);
  res.json({ suivi: false, abonnes: Number(n && n.n) || 0 });
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
           u.avatar  AS author_avatar,
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
    event_lieu,
    event_tags,
    clip_duree_seconds,
    ville,
  } = req.body;

  if (!['photo', 'clip', 'texte', 'event'].includes(type))
    return res.status(400).json({ error: 'Type invalide (photo|clip|texte|event)' });
  if (!['rdc', 'diaspora'].includes(origine))
    return res.status(400).json({ error: 'Origine invalide (rdc|diaspora)' });

  // La visibilité est ramenée à sa forme canonique : `public`, `communaute` ou
  // `contacts`, sans accent. Ainsi « communauté », « Communaute »,
  // « Communauté » et la même chaîne en Unicode décomposé désignent la MÊME
  // chose en base, et la lecture ne peut plus les manquer.
  const vis = canoniserVisibilite(visibilite);
  if (!vis)
    return res.status(400).json({ error: 'Visibilité invalide (public|communaute|contacts)' });
  const dur = canoniserDuree(duree);

  if (type === 'texte'  && !texte)       return res.status(400).json({ error: 'texte requis' });
  if (type === 'photo'  && !media_url)   return res.status(400).json({ error: 'media_url requis' });
  if (type === 'clip'   && !media_url)   return res.status(400).json({ error: 'media_url requis' });
  if (type === 'event'  && !event_title) return res.status(400).json({ error: 'event_title requis' });

  const id = uid('po');
  const ts = now();

  await db.run(`
    INSERT INTO posts
      (id, user_id, type, origine, duree, visibilite,
       media_url, texte, event_title, event_date, event_lieu, event_tags,
       clip_sec, ville, likes, comments, vues, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?)
  `, [
    id, req.user.id, type, origine, dur, vis,
    media_url      || null,
    texte          || null,
    event_title    || null,
    event_date     || null,
    event_lieu     || null,
    event_tags     ? JSON.stringify(event_tags) : null,
    clip_duree_seconds || null,
    // Ville facultative : sert de pastille sur la carte du fil.
    typeof ville === 'string' && ville.trim() ? ville.trim().slice(0, 80) : null,
    ts,
  ]);

  // Mots-clés : les #hashtags du texte et les mots-clés d'événement. Ils
  // alimentent les tendances et le filtrage par mot-clé.
  const tags = extraireTags(texte, event_tags);
  if (tags.length) await enregistrerTags(id, tags);

  const sel = selectPosts(req.user.id);
  const post = await db.get(`${sel.sql} WHERE p.id = ?`, [...sel.params, id]);
  const [enrichi] = await enrichir([post], req.user.id);
  res.status(201).json({ post: enrichi });
}));

// ─── PUT /api/feed/posts/visibilite ──────────────────────────────────────────
// Change l'audience de TOUTES mes publications d'un coup.
// Utile après la correction : les publications créées quand le formulaire
// proposait « Mes contacts » par défaut n'ont jamais été vues par personne.
// L'auteur décide lui-même de les ouvrir — rien n'est changé dans son dos.
r.put('/posts/visibilite', requireAuth, ah(async (req, res) => {
  const vis = canoniserVisibilite(req.body && req.body.visibilite);
  if (!vis)
    return res.status(400).json({ error: 'Visibilité invalide (public|communaute|contacts)' });

  const avant = await db.get(
    'SELECT COUNT(*) AS n FROM posts WHERE user_id = ?', [req.user.id]);
  await db.run('UPDATE posts SET visibilite = ? WHERE user_id = ?', [vis, req.user.id]);

  res.json({ visibilite: vis, publications: Number(avant && avant.n) || 0 });
}));

// ─── PATCH /api/feed/posts/:id/visibilite ────────────────────────────────────
// Change l'audience d'UNE de mes publications.
r.patch('/posts/:id/visibilite', requireAuth, ah(async (req, res) => {
  const vis = canoniserVisibilite(req.body && req.body.visibilite);
  if (!vis)
    return res.status(400).json({ error: 'Visibilité invalide (public|communaute|contacts)' });

  const post = await db.get('SELECT id, user_id FROM posts WHERE id = ?', [req.params.id]);
  if (!post) return res.status(404).json({ error: 'Publication introuvable' });
  if (String(post.user_id) !== String(req.user.id))
    return res.status(403).json({ error: 'Tu ne peux changer que tes publications' });

  await db.run('UPDATE posts SET visibilite = ? WHERE id = ?', [vis, post.id]);
  res.json({ id: post.id, visibilite: vis });
}));

// ─── POST /api/feed/stories ───────────────────────────────────────────────────
// Publier une story (expire automatiquement après 24 h).
r.post('/stories', requireAuth, ah(async (req, res) => {
  const { media_url, texte } = req.body;
  // Un statut peut être une photo/vidéo… ou simplement un texte (le modèle de
  // l'app prévoit `texte`), mais pas les deux à la fois vides.
  const textePropre = typeof texte === 'string' && texte.trim() ? texte.trim().slice(0, 300) : null;
  if (!media_url && !textePropre)
    return res.status(400).json({ error: 'media_url ou texte requis' });

  const id = uid('st');
  const ts = now();

  // La table stories n'a pas de colonne expires_at : la péremption à 24 h est
  // calculée à la lecture (WHERE created_at >= cutoff).
  await db.run(
    'INSERT INTO stories (id, user_id, media_url, texte, created_at) VALUES (?, ?, ?, ?, ?)',
    [id, req.user.id, media_url || null, textePropre, ts],
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

// ─── GET /api/feed/posts/:id ─────────────────────────────────────────────────
// Une publication seule : nécessaire pour ouvrir un lien partagé, et pour
// rafraîchir une carte sans recharger tout le fil.
r.get('/posts/:id', requireAuth, ah(async (req, res) => {
  const sel = selectPosts(req.user.id);
  const vis = predicatVisibilite(req.user.id, req.user.phone);
  const post = await db.get(`${sel.sql} WHERE p.id = ? AND ${vis.sql}`,
    [...sel.params, req.params.id, ...vis.params]);
  if (!post) return res.status(404).json({ error: 'Publication introuvable' });

  const [enrichi] = await enrichir([post], req.user.id);

  const cm = await db.get('SELECT COUNT(*) AS n FROM post_comments WHERE post_id = ?', [post.id]);
  res.json({ post: { ...enrichi, comments: Number(cm && cm.n) || 0 } });
}));

// ─── POST /api/feed/posts/:id/view ───────────────────────────────────────────
// Compteur de vues : une seule par lecteur et par publication, pour qu'un
// rafraîchissement ne gonfle pas le chiffre. La vue de l'auteur ne compte pas.
r.post('/posts/:id/view', requireAuth, ah(async (req, res) => {
  const id = String(req.params.id);
  const post = await db.get('SELECT id, user_id FROM posts WHERE id = ?', [id]);
  if (!post) return res.status(404).json({ error: 'Publication introuvable' });

  const dejaVu = await db.get(
    'SELECT 1 AS ok FROM post_views WHERE post_id = ? AND user_id = ?', [id, req.user.id]);
  const estAuteur = String(post.user_id) === String(req.user.id);

  if (!dejaVu && !estAuteur) {
    await db.tx(async (tx) => {
      await tx.run(
        `INSERT INTO post_views (post_id, user_id, created_at) VALUES (?, ?, ?)
         ON CONFLICT (post_id, user_id) DO NOTHING`, [id, req.user.id, now()]);
      await tx.run('UPDATE posts SET vues = COALESCE(vues, 0) + 1 WHERE id = ?', [id]);
    });
  }

  const total = await db.get('SELECT vues FROM posts WHERE id = ?', [id]);
  res.json({ vues: Number(total && total.vues) || 0, compte: !dejaVu && !estAuteur });
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

// ─── DELETE /api/feed/posts/:id ───────────────────────────────────────────────
// Seul l'auteur peut supprimer sa publication. Les j'aime, commentaires, vues
// et mots-clés associés partent avec (sinon les tables grossissent sans fin).
r.delete('/posts/:id', requireAuth, ah(async (req, res) => {
  const post = await db.get('SELECT id, user_id, media_url FROM posts WHERE id = ?', [req.params.id]);
  if (!post) return res.status(404).json({ error: 'Publication introuvable' });
  if (post.user_id !== req.user.id)
    return res.status(403).json({ error: 'Tu ne peux supprimer que tes publications' });

  await db.tx(async (tx) => {
    await tx.run('DELETE FROM post_likes    WHERE post_id = ?', [post.id]);
    await tx.run('DELETE FROM post_comments WHERE post_id = ?', [post.id]);
    await tx.run('DELETE FROM post_views    WHERE post_id = ?', [post.id]);
    await tx.run('DELETE FROM post_tags     WHERE post_id = ?', [post.id]);
    await tx.run('DELETE FROM posts         WHERE id      = ?', [post.id]);
  });

  // 🧹 Le fichier envoyé (photo/vidéo) ne doit pas rester orphelin sur le disque.
  await removeUploadedFile(post.media_url);

  res.json({ ok: true, deleted_id: post.id });
}));

// ─── DELETE /api/feed/stories/:id ─────────────────────────────────────────────
// Seul l'auteur peut supprimer son statut.
r.delete('/stories/:id', requireAuth, ah(async (req, res) => {
  const story = await db.get('SELECT id, user_id, media_url FROM stories WHERE id = ?', [req.params.id]);
  if (!story) return res.status(404).json({ error: 'Statut introuvable' });
  if (story.user_id !== req.user.id)
    return res.status(403).json({ error: 'Tu ne peux supprimer que tes statuts' });

  await db.tx(async (tx) => {
    await tx.run('DELETE FROM stories_seen WHERE story_id = ?', [story.id]);
    await tx.run('DELETE FROM stories      WHERE id       = ?', [story.id]);
  });

  await removeUploadedFile(story.media_url);

  res.json({ ok: true, deleted_id: story.id });
}));

module.exports = r;
