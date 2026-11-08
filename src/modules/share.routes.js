'use strict';

/**
 * PARTAGE D'UNE PUBLICATION EN DEHORS DE L'APPLICATION.
 *
 * Un lien partagé vers WhatsApp, Facebook ou un SMS n'a de valeur que s'il
 * s'affiche : les applications de messagerie téléchargent la page, lisent les
 * balises `og:` et dessinent un aperçu (titre, texte, image). Sans page
 * publique, un lien partagé n'est qu'une URL nue — personne ne clique.
 *
 * Ce module fournit donc :
 *   GET /p/:id                 page web publique de la publication, avec aperçu
 *                              Open Graph (image = miniature de la vidéo, sinon
 *                              la photo, sinon l'avatar, sinon la vignette de
 *                              marque), bouton d'ouverture dans l'application et
 *                              repli vers la fiche de téléchargement ;
 *   GET /api/feed/posts/:id/public
 *                              la même publication en JSON, sans jeton. Sert à
 *                              l'application et aux aperçus.
 *
 * Règle de visibilité, sans exception : la page publique ne montre QUE les
 * publications `public`. Une publication réservée aux contacts ou à la
 * communauté n'est jamais exposée à un visiteur non connecté — sinon un lien
 * partagé deviendrait une fuite.
 */

const express = require('express');
const db = require('../db');

const r = express.Router();

/** Échappe le HTML : le contenu des utilisateurs n'est jamais interprété. */
function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Base publique du site (ex. https://mbote-backend-1.onrender.com). */
function base(req) {
  return (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
}

const LIBELLE_TYPE = {
  photo: 'Photo', clip: 'Vidéo', texte: 'Publication', event: 'Événement',
};

/**
 * Charge une publication visible par n'importe qui (visibilité `public`).
 * @returns {Promise<object|null>}
 */
async function postPublic(id) {
  const post = await db.get(`
    SELECT p.*, u.name AS author_name, u.avatar AS author_avatar
      FROM posts p
      JOIN users u ON u.id = p.user_id
     WHERE p.id = ?`, [String(id)]);
  if (!post) return null;
  // `communauté` reste réservé aux membres : hors de l'application, seule la
  // visibilité `public` ouvre la porte.
  if (post.visibilite !== 'public') return null;
  return post;
}

/**
 * Rend une adresse absolue. Les robots d'aperçu ne résolvent jamais un chemin
 * relatif : `og:image="/uploads/x.jpg"` ne s'affiche pas.
 */
function absolu(url, racine) {
  if (!url) return null;
  const s = String(url).trim();
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith('/')) return `${racine}${s}`;
  return null;
}

/** Lien de partage d'une publication. */
function lienPartage(req, id) {
  return `${base(req)}/p/${id}`;
}

/** Texte prêt à coller dans une conversation. */
function textePartage(post, lien) {
  const morceaux = [];
  if (post.author_name) morceaux.push(`${post.author_name} sur MboteCall`);
  const contenu = post.texte || post.event_title || '';
  if (contenu) morceaux.push(String(contenu).slice(0, 300));
  morceaux.push(lien);
  return morceaux.join('\n');
}

// ─── GET /p/:id ──────────────────────────────────────────────────────────────
// Page publique. Elle doit rester lisible même sans JavaScript : les robots des
// applications de messagerie n'en exécutent pas.
r.get('/p/:id', async (req, res, next) => {
  try {
    const post = await postPublic(req.params.id);
    const racine = base(req);

    if (!post) {
      return res.status(404).type('html').send(pageIndisponible(racine));
    }

    const lien = lienPartage(req, post.id);
    const description = (post.texte || post.event_title || 'Publication sur MboteCall')
      .toString().replace(/\s+/g, ' ').slice(0, 200);

    // Image d'aperçu : miniature de la vidéo, sinon la photo, sinon l'avatar de
    // l'auteur, sinon la vignette de marque. Un lien partagé doit TOUJOURS
    // montrer une image : sans elle, l'aperçu WhatsApp se réduit à une ligne de
    // texte grise et personne ne clique.
    const image = absolu(post.thumb_url, racine)
      || absolu(post.media_url, racine)
      || absolu(post.author_avatar, racine)
      || `${racine}/assets/og.png`;

    res.type('html').send(pagePublication({
      lien,
      titre: post.author_name ? `${post.author_name} — ${LIBELLE_TYPE[post.type] || 'Publication'}` : 'MboteCall',
      description,
      image,
      mediaUrl: post.media_url,
      estVideo: post.type === 'clip',
      miniature: post.thumb_url,
      auteur: post.author_name,
      avatar: absolu(post.author_avatar, racine),
      texte: post.texte,
      type: post.type,
      evenement: post.type === 'event'
        ? { titre: post.event_title, date: post.event_date, lieu: post.event_lieu }
        : null,
      racine,
    }));
  } catch (e) { next(e); }
});

// ── Rendu HTML ───────────────────────────────────────────────────────────────

const STYLE = `
  *{box-sizing:border-box}
  body{margin:0;background:#0e1116;color:#e8edf4;
       font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
       line-height:1.55;display:flex;justify-content:center;padding:24px 16px}
  .carte{max-width:520px;width:100%;background:#161b23;border:1px solid #242c38;
         border-radius:16px;overflow:hidden}
  .entete{display:flex;align-items:center;gap:10px;padding:16px 18px}
  .avatar{width:40px;height:40px;border-radius:12px;background:#1c222c;overflow:hidden;
          display:flex;align-items:center;justify-content:center;color:#98a4b5;
          font-weight:700;flex:0 0 auto}
  .avatar img{width:100%;height:100%;object-fit:cover}
  .nom{font-weight:700}
  .sous{color:#98a4b5;font-size:13px}
  .media{display:block;width:100%;max-height:420px;object-fit:cover;background:#0b0f14}
  .corps{padding:16px 18px}
  .texte{margin:0 0 14px;white-space:pre-wrap;word-break:break-word}
  .evt{border-left:3px solid #f2b04a;padding-left:12px;margin:0 0 14px}
  .evt h2{margin:0 0 4px;font-size:17px}
  .lien{font-size:12px;color:#98a4b5;word-break:break-all;margin:0 0 16px}
  .bouton{display:block;text-align:center;text-decoration:none;background:#f2b04a;color:#0e1116;
          font-weight:800;padding:14px;border-radius:12px;margin-bottom:10px}
  .secondaire{display:block;text-align:center;text-decoration:none;color:#6aa6ff;
              padding:12px;border:1px solid #242c38;border-radius:12px;font-weight:600}
  .pied{padding:0 18px 20px;font-size:12px;color:#98a4b5;text-align:center}
  code{background:#0b0f14;padding:1px 5px;border-radius:4px}
`;

function pagePublication(v) {
  const image = v.image && /^https?:\/\//i.test(v.image) ? v.image : null;
  // `og:image` doit être une URL absolue : les robots ne résolvent pas les
  // chemins relatifs.
  const imageAbsolue = image ? image : null;

  const media = v.estVideo
    ? (v.miniature
        ? `<img class="media" src="${esc(v.miniature)}" alt="Aperçu de la vidéo">`
        : `<div class="corps sous">Vidéo — ouvre l’application pour la lire.</div>`)
    : (v.mediaUrl ? `<img class="media" src="${esc(v.mediaUrl)}" alt="">` : '');

  const evenement = v.evenement && (v.evenement.titre || v.evenement.lieu)
    ? `<div class="evt"><h2>${esc(v.evenement.titre || 'Événement')}</h2>
         <div class="sous">${esc(v.evenement.lieu || '')}</div></div>`
    : '';

  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(v.titre)}</title>
<meta name="description" content="${esc(v.description)}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="MboteCall">
<meta property="og:title" content="${esc(v.titre)}">
<meta property="og:description" content="${esc(v.description)}">
<meta property="og:url" content="${esc(v.lien)}">
${imageAbsolue ? `<meta property="og:image" content="${esc(imageAbsolue)}">
<meta name="twitter:image" content="${esc(imageAbsolue)}">` : ''}
<meta name="twitter:card" content="${imageAbsolue ? 'summary_large_image' : 'summary'}">
<meta name="twitter:title" content="${esc(v.titre)}">
<meta name="twitter:description" content="${esc(v.description)}">
<link rel="image_src" href="${esc(imageAbsolue || v.racine + '/assets/og.png')}">
<style>${STYLE}</style>
</head>
<body>
<div class="carte">
  <div class="entete">
    <div class="avatar">${v.avatar && /^https?:\/\//i.test(v.avatar)
      ? `<img src="${esc(v.avatar)}" alt="">`
      : esc((v.auteur || 'M').slice(0, 1).toUpperCase())}</div>
    <div>
      <div class="nom">${esc(v.auteur || 'Compte Mbote')}</div>
      <div class="sous">MboteCall</div>
    </div>
  </div>
  ${media}
  <div class="corps">
    ${evenement}
    ${v.texte ? `<p class="texte">${esc(v.texte)}</p>` : ''}
    <p class="lien">${esc(v.lien)}</p>
    <a class="bouton" href="mbote://post/${esc(v.lien.split('/').pop())}">Ouvrir dans MboteCall</a>
    <a class="secondaire" href="${esc(v.racine)}/">Application non installée ? Découvrir MboteCall</a>
  </div>
  <div class="pied">Aperçu d’une publication publique. L’application affiche le fil complet.</div>
</div>
</body>
</html>`;
}

function pageIndisponible(racine) {
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Publication indisponible — MboteCall</title>
<meta name="robots" content="noindex">
<style>${STYLE}</style>
</head>
<body>
<div class="carte">
  <div class="corps">
    <h2>Cette publication n’est pas publique</h2>
    <p class="sous">Elle a peut-être été supprimée, ou son auteur l’a réservée à ses
    contacts. Le fil reste accessible dans l’application, avec les droits de ton
    compte.</p>
    <a class="bouton" href="${esc(racine)}/">Ouvrir MboteCall</a>
  </div>
</div>
</body>
</html>`;
}

module.exports = { r, lienPartage, textePartage, postPublic, base, esc };
