'use strict';

/**
 * HARMONISATION DU FIL AU DÉMARRAGE.
 *
 * Deux défauts historiques laissent des données incohérentes en base, et une
 * publication incohérente est une publication invisible — sans la moindre
 * erreur dans les journaux. Ce module remet tout d'aplomb, une fois, au
 * démarrage :
 *
 * 1. `visibilite` : les anciennes lignes peuvent contenir « communauté » (avec
 *    accent), une variante de casse, une forme Unicode décomposée, ou rien du
 *    tout. On ramène chaque valeur distincte à sa forme canonique
 *    (`public` | `communaute` | `contacts`).
 *    Une valeur inconnue ou absente devient `contacts` : en cas de doute, on
 *    protège l'auteur, on ne publie pas à sa place.
 *
 * 2. `duree` : seules `h24` et `permanent` ont un sens ; toute autre valeur
 *    devient `permanent` (aucune publication ne disparaît par accident).
 *
 * 3. Mots-clés : les publications créées avant l'arrivée de `post_tags` n'ont
 *    aucun mot-clé, donc n'apparaissent dans aucune tendance. On les extrait du
 *    texte existant, une seule fois.
 *
 * Ce travail est idempotent : le relancer ne change plus rien.
 */

const db = require('./../db');
const {
  canoniserVisibilite, canoniserDuree, extraireTags,
} = require('./feed_rules');

async function harmoniserVisibilites(log = console.log) {
  const lignes = await db.all('SELECT DISTINCT visibilite AS v FROM posts');
  let modifiees = 0;

  for (const ligne of lignes) {
    const brute = ligne.v;
    const canonique = canoniserVisibilite(brute) || 'contacts';
    const dejaBon = brute != null && String(brute) === canonique;
    if (dejaBon) continue;

    if (brute == null) {
      await db.run('UPDATE posts SET visibilite = ? WHERE visibilite IS NULL', [canonique]);
    } else {
      await db.run('UPDATE posts SET visibilite = ? WHERE visibilite = ?', [canonique, brute]);
    }
    const n = await db.get(
      'SELECT COUNT(*) AS n FROM posts WHERE visibilite = ?', [canonique]);
    modifiees += 1;
    log(`🧹 visibilité harmonisée : ${JSON.stringify(brute)} → ${canonique} (${n && n.n} publication(s))`);
  }
  return modifiees;
}

async function harmoniserDurees() {
  const lignes = await db.all('SELECT DISTINCT duree AS d FROM posts');
  let modifiees = 0;
  for (const ligne of lignes) {
    const brute = ligne.d;
    const canonique = canoniserDuree(brute);
    if (brute != null && String(brute) === canonique) continue;
    await db.run('UPDATE posts SET duree = ? WHERE duree = ?', [canonique, brute]);
    modifiees += 1;
  }
  return modifiees;
}

/**
 * Extrait les mots-clés des publications qui n'en ont aucun.
 * Borné : on ne bloque jamais le démarrage pour un rattrapage cosmétique.
 */
async function rattraperTags(limite = 2000) {
  const posts = await db.all(`
    SELECT p.id, p.texte, p.event_tags
      FROM posts p
     WHERE NOT EXISTS (SELECT 1 FROM post_tags pt WHERE pt.post_id = p.id)
       AND (p.texte LIKE '%#%' OR (p.event_tags IS NOT NULL AND p.event_tags <> '[]' AND p.event_tags <> ''))
     LIMIT ?`, [limite]);

  let ajoutes = 0;
  for (const p of posts) {
    let eventTags = null;
    try { eventTags = p.event_tags ? JSON.parse(p.event_tags) : null; } catch { /* texte libre */ }
    const tags = extraireTags(p.texte, eventTags);
    for (const tag of tags) {
      await db.run(
        `INSERT INTO post_tags (post_id, tag) VALUES (?, ?)
         ON CONFLICT (post_id, tag) DO NOTHING`, [p.id, tag]);
      ajoutes += 1;
    }
  }
  return { posts: posts.length, ajoutes };
}

/**
 * Rattrapage des miniatures vidéo.
 *
 * Les vidéos publiées avant l'arrivée de `thumb_url` n'ont aucun aperçu. On
 * capture leur première image maintenant, une fois pour toutes. Volontairement
 * borné (quelques dizaines par démarrage) : la capture vidéo coûte du processeur
 * et un hébergement modeste ne doit pas être saturé au réveil.
 */
async function rattraperMiniatures(limite = 25) {
  const videoThumb = require('./video_thumb');
  if (!videoThumb.disponible()) return { posts: 0, generees: 0 };

  const posts = await db.all(`
    SELECT id, media_url
      FROM posts
     WHERE (thumb_url IS NULL OR thumb_url = '')
       AND media_url IS NOT NULL
       AND (LOWER(media_url) LIKE '%.mp4' OR LOWER(media_url) LIKE '%.mov'
            OR LOWER(media_url) LIKE '%.m4v' OR LOWER(media_url) LIKE '%.webm'
            OR LOWER(media_url) LIKE '%.3gp')
     ORDER BY created_at DESC
     LIMIT ?`, [limite]);

  let generees = 0;
  for (const p of posts) {
    const miniature = await videoThumb.miniaturePourUrl(p.media_url);
    if (!miniature) continue;
    await db.run('UPDATE posts SET thumb_url = ? WHERE id = ?', [miniature, p.id]);
    generees += 1;
  }
  return { posts: posts.length, generees };
}

/**
 * Point d'entrée appelé par `server.js` après `db.init()`.
 * Ne relance JAMAIS une exception : un fil mal rangé ne doit pas empêcher le
 * serveur de démarrer.
 */
async function harmoniserFil() {
  try {
    const v = await harmoniserVisibilites();
    const d = await harmoniserDurees();
    const t = await rattraperTags();
    if (v || d || t.ajoutes) {
      console.log(`🧹 Fil harmonisé : ${v} visibilité(s), ${d} durée(s), ${t.ajoutes} mot(s)-clé(s).`);
    }
    return { visibilites: v, durees: d, tags: t };
  } catch (e) {
    console.error('🧹 Harmonisation du fil impossible :', e.message);
    return null;
  }
}

module.exports = {
  harmoniserFil,
  harmoniserVisibilites,
  harmoniserDurees,
  rattraperTags,
  rattraperMiniatures,
};
