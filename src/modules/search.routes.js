'use strict';

/**
 * RECHERCHE UNIVERSELLE.
 *
 * Une seule barre, une seule requête, des résultats groupés : c'est ce que font
 * X, Instagram et TikTok. La règle de lecture est celle de toute la recherche :
 *
 *   - `#mbote` cherche un HASHTAG (préfixe), pas du texte ;
 *   - `@ced` cherche une PERSONNE (identifiant public ou nom) ;
 *   - tout le reste cherche partout : publications, personnes, hashtags,
 *     statuts et événements.
 *
 * Chaque groupe renvoie au plus `limite` éléments : au-delà, l'utilisateur
 * affine sa requête. Cela évite de payer mille lectures pour un « a ».
 *
 * La visibilité n'est jamais contournée : la recherche de publications réutilise
 * exactement le prédicat du fil (public, communauté, mes contacts) et la
 * découverte reste réservée au public.
 */

const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { now } = require('../util');
const {
  predicatVisibilite, predicatDecouverte, predicatNonExpire, lienPublic,
} = require('../services/feed_rules');
const texteSocial = require('../services/texte_social');

const r = express.Router();

/** Échappe les caractères spéciaux de LIKE : `%`, `_` et l'antislash. */
function like(v) {
  return String(v).replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * GET /api/search?q=…&limite=5
 *
 * `type` peut être forcé (`personnes`, `hashtags`, `publications`, `statuts`,
 * `evenements`) : l'application s'en sert pour les onglets de résultats.
 */
r.get('/', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.id;
    const brut = String(req.query.q || '').trim().slice(0, 80);
    const limite = Math.min(Number(req.query.limite) || 6, 20);
    const typeForce = ['personnes', 'hashtags', 'publications', 'statuts', 'evenements']
      .includes(String(req.query.type)) ? String(req.query.type) : null;

    if (brut.length < 1) {
      return res.json({
        q: '', portee: null,
        personnes: [], hashtags: [], publications: [], statuts: [], evenements: [],
      });
    }

    // ── Lecture de la requête : #hashtag, @personne, ou texte libre ──────────
    const estHashtag = brut.startsWith('#');
    const estMention = brut.startsWith('@');
    const motCle = texteSocial.cleHashtag(brut) || '';
    const handle = texteSocial.normaliserHandle(brut) || '';
    const texte = brut.replace(/^[#@]/, '').trim();

    const resultat = {
      q: brut,
      portee: estHashtag ? 'hashtags' : (estMention ? 'personnes' : 'tout'),
      personnes: [], hashtags: [], publications: [], statuts: [], evenements: [],
    };

    const veutPersonnes = !estHashtag && (typeForce === null || typeForce === 'personnes');
    const veutHashtags = !estMention && (typeForce === null || typeForce === 'hashtags');

    // ── Personnes : identifiant public, nom, puis contacts en premier ────────
    if (veutPersonnes) {
      resultat.personnes = (await db.all(`
        SELECT u.id, u.name, u.handle, u.avatar, u.country,
               CASE WHEN c.phone IS NOT NULL THEN 1 ELSE 0 END AS contact,
               CASE WHEN f.followee_id IS NOT NULL THEN 1 ELSE 0 END AS suivi
          FROM users u
          LEFT JOIN contacts c ON c.user_id = ? AND c.phone = u.phone
          LEFT JOIN follows f ON f.follower_id = ? AND f.followee_id = u.id
         WHERE u.status = 'active' AND u.id <> ?
           AND (LOWER(COALESCE(u.handle, '')) LIKE ? OR LOWER(u.name) LIKE ?)
         ORDER BY contact DESC, suivi DESC, u.name
         LIMIT ?`,
      [userId, userId, userId, `${like(handle || texte)}%`, `%${like(texte.toLowerCase())}%`, limite]))
        .map((u) => ({
          id: u.id, name: u.name || '', handle: u.handle || null,
          avatar: u.avatar || null, country: u.country || null,
          contact: Number(u.contact) || 0, suivi: Number(u.suivi) || 0,
        }));
    }

    // ── Hashtags : préfixe, volume, tendance ────────────────────────────────
    if (veutHashtags) {
      resultat.hashtags = (await db.all(`
        SELECT pt.tag AS tag, COUNT(*) AS publications
          FROM post_tags pt JOIN posts p ON p.id = pt.post_id
         WHERE p.visibilite = 'public' AND pt.tag LIKE ?
         GROUP BY pt.tag
         ORDER BY publications DESC
         LIMIT ?`, [`${like(motCle || texte.toLowerCase())}%`, limite]))
        .map((t) => ({ tag: t.tag, publications: Number(t.publications) || 0 }));
    }

    // ── Publications : mêmes règles de visibilité que le fil ────────────────
    if (typeForce === null || typeForce === 'publications') {
      const vis = predicatVisibilite(userId, req.user.phone);
      const exp = predicatNonExpire(now());
      const motif = `%${like(texte.toLowerCase())}%`;
      const filtreTag = motCle
        ? `OR p.id IN (SELECT pt.post_id FROM post_tags pt WHERE pt.tag LIKE ?)`
        : '';

      const lignes = await db.all(`
        SELECT p.id, p.user_id, p.type, p.texte, p.media_url, p.thumb_url,
               p.event_title, p.event_lieu, p.created_at, p.likes, p.comments,
               u.name AS author_name, u.avatar AS author_avatar
          FROM posts p JOIN users u ON u.id = p.user_id
         WHERE ${vis.sql} AND ${exp.sql}
           AND (
             LOWER(COALESCE(p.texte, '')) LIKE ?
             OR LOWER(COALESCE(p.event_title, '')) LIKE ?
             OR LOWER(COALESCE(u.name, '')) LIKE ?
             ${filtreTag}
           )
         ORDER BY p.created_at DESC
         LIMIT ?`,
      [...vis.params, ...exp.params, motif, motif, motif,
        ...(motCle ? [`${like(motCle)}%`] : []), limite]);

      resultat.publications = lignes.map((p) => ({
        id: p.id, type: p.type, texte: p.texte, media_url: p.media_url,
        thumb_url: p.thumb_url, event_title: p.event_title,
        created_at: p.created_at, likes: Number(p.likes) || 0,
        comments: Number(p.comments) || 0, share_url: lienPublic(p.id),
        auteur: { id: p.user_id, name: p.author_name, avatar: p.author_avatar },
      }));

      resultat.evenements = lignes
        .filter((p) => p.type === 'event')
        .map((p) => ({
          id: p.id, titre: p.event_title, lieu: p.event_lieu,
          created_at: p.created_at, auteur: p.author_name,
        }));
    }

    // ── Statuts : ceux du public, encore valides (24 h) ─────────────────────
    if (typeForce === null || typeForce === 'statuts') {
      const lignes = await db.all(`
        SELECT s.id, s.texte, s.media_url, s.created_at, u.name AS author_name,
               u.id AS author_id, u.avatar AS author_avatar
          FROM stories s JOIN users u ON u.id = s.user_id
         WHERE s.created_at >= ?
           AND LOWER(COALESCE(s.texte, '')) LIKE ?
         ORDER BY s.created_at DESC
         LIMIT ?`,
      [now() - 24 * 60 * 60 * 1000, `%${like(texte.toLowerCase())}%`, limite]);

      resultat.statuts = lignes.map((s) => ({
        id: s.id, texte: s.texte, media_url: s.media_url,
        created_at: s.created_at,
        auteur: { id: s.author_id, name: s.author_name, avatar: s.author_avatar },
      }));
    }

    // La découverte n'est pas contournée : on ne renvoie jamais une publication
    // non publique par la recherche de hashtag, même si son texte correspond.
    resultat.total = resultat.personnes.length + resultat.hashtags.length +
      resultat.publications.length + resultat.statuts.length;

    res.json(resultat);
  } catch (e) { next(e); }
});

/**
 * GET /api/search/suggestions?q=… — amorce de la barre de recherche :
 * les cinq éléments les plus probables, sans regroupement. Sert à afficher des
 * résultats dès la première lettre sans payer le coût d'une recherche complète.
 */
r.get('/suggestions', requireAuth, async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim().slice(0, 40);
    if (!q) return res.json({ q, elements: [] });

    const propre = texteSocial.cleHashtag(q) || texteSocial.normaliserHandle(q) || '';
    const elements = [];

    const personnes = await db.all(`
      SELECT id, name, handle, avatar FROM users
       WHERE status = 'active' AND id <> ?
         AND (LOWER(COALESCE(handle, '')) LIKE ? OR LOWER(name) LIKE ?)
       ORDER BY name LIMIT 3`, [req.user.id, `${like(propre)}%`, `%${like(q.toLowerCase())}%`]);
    for (const p of personnes) {
      elements.push({ type: 'personne', id: p.id, libelle: `@${p.handle || p.name}`,
        sous_titre: p.name, avatar: p.avatar || null });
    }

    const tags = await db.all(`
      SELECT pt.tag, COUNT(*) AS n FROM post_tags pt JOIN posts p ON p.id = pt.post_id
       WHERE p.visibilite = 'public' AND pt.tag LIKE ?
       GROUP BY pt.tag ORDER BY n DESC LIMIT 3`, [`${like(propre)}%`]);
    for (const t of tags) {
      elements.push({ type: 'hashtag', id: t.tag, libelle: `#${t.tag}`,
        sous_titre: `${Number(t.n)} publications` });
    }

    res.json({ q, elements });
  } catch (e) { next(e); }
});

module.exports = r;
