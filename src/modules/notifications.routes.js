'use strict';

/**
 * BOÎTE DE RÉCEPTION.
 *
 * Les mentions produisent deux choses : une poussée (téléphone fermé) et une
 * ligne en base. Cette ligne est ce qui reste — sans elle, une notification
 * manquée est une notification perdue, et l'utilisateur ne sait jamais qu'on
 * l'a mentionné.
 *
 * Tout est paginé par curseur (`created_at`, `id`) : la table grandit vite, un
 * OFFSET croissant finirait par coûter plus cher que la lecture elle-même.
 */

const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { now } = require('../util');
const notifs = require('../services/notifs');

const r = express.Router();

/**
 * GET /api/notifications?before=<ts>&limite=30 — les plus récentes d'abord.
 *
 * Chaque ligne porte :
 *   - son `message` prêt à afficher (« Patrick, Junior et 16 autres personnes
 *     ont aimé votre publication ») ;
 *   - `nb_acteurs` et `acteurs` (trois noms + leurs avatars) pour composer le
 *     bandeau d'aperçus sans requête supplémentaire ;
 *   - `post_id` / `comment_id` pour ouvrir la publication ET se positionner sur
 *     le commentaire concerné.
 */
r.get('/', requireAuth, (req, res, next) => {
  const limite = Math.min(Number(req.query.limite) || 30, 100);
  const avant = req.query.before ? Number(req.query.before) : now() + 1;
  const seulementNonLues = req.query.non_lues === '1' || req.query.non_lues === 'true';

  Promise.resolve()
    .then(() => db.all(`
      SELECT n.*, u.name AS sender_name, u.handle AS sender_handle, u.avatar AS sender_avatar
        FROM notifications n
        LEFT JOIN users u ON u.id = n.sender_id
       WHERE n.user_id = ? AND n.created_at < ?${seulementNonLues ? ' AND n.lu = 0' : ''}
       ORDER BY n.created_at DESC, n.id DESC
       LIMIT ?`, [req.user.id, avant, limite + 1]))
    .then(async (lignes) => {
      const plus = lignes.length > limite;
      const gardees = plus ? lignes.slice(0, limite) : lignes;

      // Les auteurs des notifications groupées, en une seule requête : jusqu'à
      // 3 noms par ligne, les plus récents d'abord.
      const groupes = gardees.filter((n) => Number(n.nb_acteurs) > 1).map((n) => n.id);
      const acteursParNotif = new Map();
      if (groupes.length) {
        const trous = groupes.map(() => '?').join(',');
        const lignesA = await db.all(`
          SELECT na.notification_id, na.user_id, u.name, u.handle, u.avatar
            FROM notification_acteurs na
            LEFT JOIN users u ON u.id = na.user_id
           WHERE na.notification_id IN (${trous})
           ORDER BY na.created_at DESC`, groupes);
        for (const a of lignesA) {
          const liste = acteursParNotif.get(a.notification_id) || [];
          liste.push({
            id: a.user_id,
            name: a.name || '',
            handle: a.handle || null,
            avatar: a.avatar || null,
          });
          acteursParNotif.set(a.notification_id, liste);
        }
      }

      const items = gardees.map((n) => {
        const nb = Math.max(1, Number(n.nb_acteurs) || 1);
        const tous = acteursParNotif.get(n.id) || [];
        const expediteur = n.sender_id
          ? {
            id: n.sender_id,
            name: n.sender_name || '',
            handle: n.sender_handle || null,
            avatar: n.sender_avatar || null,
          }
          : null;
        const acteurs = tous.length ? tous : (expediteur ? [expediteur] : []);
        const noms = acteurs.slice(0, 2).map((a) => a.name).filter(Boolean);
        if (!noms.length && expediteur && expediteur.name) noms.push(expediteur.name);

        return {
          id: n.id,
          type: n.type,
          post_id: n.post_id,
          comment_id: n.comment_id,
          source_type: n.source_type,
          source_id: n.source_id,
          texte: n.texte || '',
          lu: Number(n.lu) || 0,
          created_at: Number(n.created_at) || 0,
          nb_acteurs: nb,
          acteurs,
          expediteur,
          message: notifs.messageDe({
            type: n.type, nbActeurs: nb, noms, apercu: n.texte || '',
          }),
        };
      });

      const non_lues = await db.get(
        'SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND lu = 0', [req.user.id]);

      res.json({
        notifications: items,
        non_lues: Number(non_lues && non_lues.n) || 0,
        next: plus && items.length ? { before: items[items.length - 1].created_at } : null,
      });
    })
    .catch(next);
});

/** GET /api/notifications/count — juste le badge, pour l'en-tête de l'app. */
r.get('/count', requireAuth, async (req, res, next) => {
  try {
    const n = await db.get(
      'SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND lu = 0', [req.user.id]);
    res.json({ non_lues: Number(n && n.n) || 0 });
  } catch (e) { next(e); }
});

/** POST /api/notifications/lues — tout marquer comme lu. */
r.post('/lues', requireAuth, async (req, res, next) => {
  try {
    await db.run('UPDATE notifications SET lu = 1 WHERE user_id = ? AND lu = 0', [req.user.id]);
    res.json({ ok: true, non_lues: 0 });
  } catch (e) { next(e); }
});

/** POST /api/notifications/:id/lue — marquer une seule notification. */
r.post('/:id/lue', requireAuth, async (req, res, next) => {
  try {
    const n = await db.get(
      'SELECT id FROM notifications WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!n) return res.status(404).json({ error: 'Notification introuvable' });

    await db.run('UPDATE notifications SET lu = 1 WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.id]);
    res.json({ ok: true, id: req.params.id });
  } catch (e) { next(e); }
});

module.exports = r;
