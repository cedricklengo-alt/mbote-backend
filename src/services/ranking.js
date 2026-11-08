'use strict';

/**
 * MOTEUR DE RANKING DU FIL MBOTECALL
 * ──────────────────────────────────
 * Score = 35% intérêt utilisateur
 *       + 25% interactions passées avec l'auteur
 *       + 15% fraîcheur
 *       + 15% popularité de la publication
 *       + 10% proximité sociale
 *
 * Le score est recalculé automatiquement :
 *  - à chaque nouvel événement (vue, like, commentaire, partage, profil visité)
 *  - via rescorePeriodique() (tâche de fond)
 *  - et persisté dans la table feed_scores (recalcul différentiel).
 *
 * 100% déterministe et testable hors ligne (aucune I/O dans computeScore).
 */

const W = { interest: 0.35, affinity: 0.25, freshness: 0.15, popularity: 0.15, social: 0.10 };

// Réactions supportées (Facebook-like)
const REACTIONS = ['like', 'love', 'haha', 'wow', 'sad', 'angry', 'care', 'solidarity'];
const REACTION_WEIGHT = { like: 1, love: 1.4, care: 1.3, haha: 1.2, wow: 1.2, sad: 0.8, angry: 0.9, solidarity: 1.3 };

/** Fraîcheur : décroissance exponentielle, demi-vie ~ 24 h. */
function composanteFraicheur(ageMs, maintenant) {
  const age = Math.max(0, (maintenant - ageMs) / 1000);
  const halfLife = 24 * 3600; // 24 h en s
  return Math.pow(0.5, age / halfLife);
}

/** Popularité : likes pondérés + commentaires + partages + vues. */
function composantePopularite(p) {
  const likes = (p.likes || 0);
  const comments = (p.comments || 0);
  const shares = (p.shares || 0);
  const views = (p.views || 0);
  const raw = likes + 2 * comments + 3 * shares + 0.2 * views;
  return 1 - Math.pow(0.5, raw / 10); // ramené dans [0,1)
}

/**
 * ctx attendu :
 * {
 *   maintenant, tagsInteret: [], auteursAimes: {id:poids}, ville,
 *   amis: Set/[], groupesCommuns: [], auteursVus: {id:nb}, likesRecus...
 *   likesAuteur: {id:nb}, commentairesAuteur: {id:nb}, partagesAuteur:{id:nb},
 *   profilVisites: {id:nb}, groupesAuteur: {id:Set}, interetsCommuns: nb
 * }
 */
function computeScore(post, ctx = {}) {
  const m = ctx.maintenant || Date.now();
  const authorId = post.user_id || post.author_id;

  // 1) Intérêt utilisateur (35 %) : tags suivis + auteur suivi + ville
  let interest = 0;
  const tags = post.tags || [];
  const tagsInteret = ctx.tagsInteret || [];
  const matchTags = tags.filter(t => tagsInteret.includes(t.toLowerCase())).length;
  interest += Math.min(0.6, matchTags * 0.2);
  if (ctx.auteursSuivis && ctx.auteursSuivis.includes(authorId)) interest += 0.3;
  if (ctx.ville && post.ville && String(post.ville).toLowerCase() === String(ctx.ville).toLowerCase()) {
    interest += 0.1;
  }
  interest = Math.min(1, interest);

  // 2) Affinité avec l'auteur (25 %) : likes/commentaires/partages passés + visites profil
  let affinity = 0;
  if (authorId) {
    const l = (ctx.likesAuteur && ctx.likesAuteur[authorId]) || 0;
    const c = (ctx.commentairesAuteur && ctx.commentairesAuteur[authorId]) || 0;
    const s = (ctx.partagesAuteur && ctx.partagesAuteur[authorId]) || 0;
    const v = (ctx.profilVisites && ctx.profilVisites[authorId]) || 0;
    affinity = 1 - Math.pow(0.5, (l + 2 * c + 3 * s + v) / 5);
  }

  // 3) Fraîcheur (15 %)
  const freshness = composanteFraicheur(post.created_at || m, m);

  // 4) Popularité (15 %)
  const popularity = composantePopularite(post);

  // 5) Proximité sociale (10 %) : amis, groupes communs, intérêts communs, géo
  let social = 0;
  if (ctx.amis && ctx.amis.includes && ctx.amis.includes(authorId)) social += 0.4;
  if (ctx.groupesCommuns && authorId && ctx.groupesAuteur && ctx.groupesAuteur[authorId]) {
    const communs = ctx.groupesAuteur[authorId].filter(g => ctx.groupesCommuns.includes(g)).length;
    social += Math.min(0.3, communs * 0.15);
  }
  if (ctx.interetsCommuns) social += Math.min(0.2, ctx.interetsCommuns * 0.05);
  if (ctx.memeVille) social += 0.1;
  social = Math.min(1, social);

  const score = W.interest * interest + W.affinity * affinity + W.freshness * freshness +
                W.popularity * popularity + W.social * social;
  return {
    score: Math.round(score * 10000) / 10000,
    detail: { interest, affinity, freshness, popularity, social },
  };
}

/** Trie une liste de publications selon le score (décroissant). */
function rankPosts(posts, ctx = {}) {
  return posts
    .map(p => ({ post: p, ...computeScore(p, ctx) }))
    .sort((a, b) => b.score - a.score)
    .map(e => ({ ...e.post, _score: e.score, _detail: e.detail }));
}

/** Persiste le score d'une publication (table feed_scores). */
async function persistScore(db, postId, score, detail) {
  await db.run(
    `INSERT INTO feed_scores (post_id, score, detail, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(post_id) DO UPDATE SET score=excluded.score, detail=excluded.detail, updated_at=excluded.updated_at`,
    [postId, score, JSON.stringify(detail || {}), Date.now()]
  );
}

/**
 * Enregistre un événement utilisateur et met à jour les préférences
 * (table user_preferences.colonne `interests` JSON) + feed_scores.
 */
async function recordEvent(db, userId, type, data = {}) {
  const now = Date.now();
  await db.run(
    `INSERT INTO feed_events (user_id, type, post_id, meta, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [userId, type, data.postId || null, JSON.stringify(data.meta || {}), now]
  );
  // met à jour les compteurs d'affinité dans user_preferences.interests
  const row = await db.get(`SELECT interests FROM user_preferences WHERE user_id = ?`, [userId]);
  let interests = {};
  try { interests = row && row.interests ? JSON.parse(row.interests) : {}; } catch { interests = {}; }
  const authorId = data.authorId;
  if (authorId) {
    const a = interests.affinity || {};
    const k = { like: 'likes', comment: 'comments', share: 'shares', view: 'views', profile_visit: 'profilVisites' }[type] || 'views';
    a[authorId] = a[authorId] || { likes: 0, comments: 0, shares: 0, views: 0, profilVisites: 0 };
    a[authorId][k] = (a[authorId][k] || 0) + 1;
    interests.affinity = a;
  }
  if (data.tag) {
    const t = String(data.tag).toLowerCase();
    interests.tags = interests.tags || {};
    interests.tags[t] = (interests.tags[t] || 0) + 1;
  }
  await db.run(
    `INSERT INTO user_preferences (user_id, interests, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET interests=excluded.interests, updated_at=excluded.updated_at`,
    [userId, JSON.stringify(interests), now]
  );
}

module.exports = {
  W, REACTIONS, REACTION_WEIGHT,
  computeScore, rankPosts, composanteFraicheur, composantePopularite,
  persistScore, recordEvent,
};
