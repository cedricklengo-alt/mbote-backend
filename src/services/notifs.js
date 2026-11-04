'use strict';

/**
 * NOTIFICATIONS SOCIALES — j'aime, commentaires, réponses, partages, mentions.
 *
 * Trois principes, tirés des plateformes de référence (Facebook, Instagram, X,
 * LinkedIn, TikTok) :
 *
 * 1. **On ne se notifie pas soi-même.** Un like sur sa propre publication, un
 *    commentaire sur son propre commentaire : rien. C'est la première source de
 *    bruit sur les réseaux mal réglés.
 *
 * 2. **Les gestes répétés se regroupent.** Dix personnes qui aiment la même
 *    publication ne font pas dix lignes : une seule, avec « Patrick, Junior et
 *    8 autres personnes ont aimé votre publication ». Les commentaires, les
 *    réponses et les mentions restent individuels : chacun porte un texte, donc
 *    chacun a sa valeur.
 *
 * 3. **Un like retiré ne laisse pas de trace.** L'auteur du j'aime est retiré
 *    du groupe ; si plus personne n'aime, la notification disparaît. C'est ce
 *    qui évite « X a aimé » alors que X n'aime plus — le défaut le plus visible
 *    quand on ne suit pas les retraits.
 *
 * La poussée (FCM) part à la CRÉATION de la notification seulement. Un groupe
 * qui grossit ne produit pas une nouvelle poussée à chaque j'aime : ce serait
 * exactement le spam que l'on veut éviter. L'application, ouverte, rafraîchit
 * son compteur par interrogation périodique (pas de Firestore dans cette
 * architecture : PostgreSQL est la source de vérité).
 */

const db = require('../db');
const { uid, now } = require('../util');
const limites = require('./limites');
const push = require('./push');

/** Types reconnus. `mention` est produit par services/social.js. */
const TYPES = {
  LIKE: 'post_like',
  COMMENT: 'comment',
  REPLY: 'comment_reply',
  MENTION: 'mention',
  SHARE: 'share',
  FOLLOW: 'follow',
  PRESENCE: 'presence', // « X est de retour en ligne » (rappel de présence)
};

/** Types regroupés : un seul enregistrement, plusieurs auteurs. */
const GROUPES = new Set([TYPES.LIKE, TYPES.SHARE]);

/** Plafond de notifications par destinataire et par heure (tous types). */
const NOTIFS_MAX_HEURE = 40;

/** Texte lisible d'une notification, calculé côté serveur (jamais côté client :
 *  deux clients afficheraient deux phrases différentes). */
function messageDe({ type, nbActeurs, noms, apercu }) {
  const premier = noms[0] || 'Quelqu’un';
  const second = noms[1];
  const autres = Math.max(0, nbActeurs - (noms.length >= 2 ? 2 : 1));
  const qui = nbActeurs <= 1
    ? premier
    : (second
      ? `${premier}, ${second}${autres > 0 ? ` et ${autres} autre${autres > 1 ? 's' : ''} personne${autres > 1 ? 's' : ''}` : ''}`
      : `${premier} et ${autres} autre${autres > 1 ? 's' : ''} personne${autres > 1 ? 's' : ''}`);

  switch (type) {
    case TYPES.LIKE:
      return nbActeurs <= 1
        ? `${premier} a aimé votre publication`
        : `${qui} ont aimé votre publication`;
    case TYPES.SHARE:
      return nbActeurs <= 1
        ? `${premier} a partagé votre publication`
        : `${qui} ont partagé votre publication`;
    case TYPES.COMMENT:
      return `${premier} a commenté votre publication`;
    case TYPES.REPLY:
      return `${premier} a répondu à votre commentaire`;
    case TYPES.MENTION:
      return `${premier} vous a mentionné`;
    case TYPES.FOLLOW:
      return `${premier} vous suit maintenant`;
    case TYPES.PRESENCE:
      return `${premier} est de retour en ligne`;
    default:
      return apercu ? `${premier} : ${apercu}` : `${premier} a interagi avec votre contenu`;
  }
}

/**
 * Crée ou met à jour une notification.
 *
 * @param {object} p
 * @param {string} p.receiverId  destinataire (auteur du contenu)
 * @param {string} p.senderId    auteur du geste
 * @param {string} [p.senderNom]
 * @param {string} p.type        voir TYPES
 * @param {string} [p.postId]
 * @param {string} [p.commentId]
 * @param {string} [p.sourceType] post | comment | story
 * @param {string} [p.sourceId]
 * @param {string} [p.texte]      aperçu du contenu (tronqué à 140)
 * @returns {Promise<{creee: boolean, regroupee: boolean, poussee: boolean}>}
 */
async function notifier({
  receiverId, senderId, senderNom, type,
  postId, commentId, sourceType = 'post', sourceId, texte,
}) {
  const rien = { creee: false, regroupee: false, poussee: false };
  if (!receiverId || !senderId) return rien;
  if (String(receiverId) === String(senderId)) return rien; // jamais soi-même
  if (!Object.values(TYPES).includes(type)) return rien;

  const source = String(sourceId || postId || commentId || '');
  if (!source) return rien;

  // Plafond global : même quelqu'un de très sollicité garde une boîte lisible.
  if (!limites.autoriser(`notif:${receiverId}`, NOTIFS_MAX_HEURE, 60 * 60 * 1000)) {
    return rien;
  }

  const apercu = (texte || '').toString().replace(/\s+/g, ' ').trim().slice(0, 140);
  const ts = now();
  const existante = await db.get(
    `SELECT id, nb_acteurs FROM notifications
      WHERE user_id = ? AND type = ? AND source_type = ? AND source_id = ?`,
    [receiverId, type, sourceType, source]);

  // ── Cas groupé : la ligne existe, on ajoute l'auteur ─────────────────────
  if (existante && GROUPES.has(type)) {
    const deja = await db.get(
      'SELECT 1 AS oui FROM notification_acteurs WHERE notification_id = ? AND user_id = ?',
      [existante.id, senderId]);
    if (deja) return { creee: false, regroupee: true, poussee: false };

    await db.run(
      `INSERT INTO notification_acteurs (notification_id, user_id, created_at)
       VALUES (?, ?, ?) ON CONFLICT (notification_id, user_id) DO NOTHING`,
      [existante.id, senderId, ts]);
    const compte = await db.get(
      'SELECT COUNT(*) AS n FROM notification_acteurs WHERE notification_id = ?',
      [existante.id]);

    await db.run(
      `UPDATE notifications
          SET sender_id = ?, nb_acteurs = ?, created_at = ?, lu = 0,
              texte = CASE WHEN ? <> '' THEN ? ELSE texte END
        WHERE id = ?`,
      [senderId, Number(compte && compte.n) || 1, ts, apercu, apercu, existante.id]);

    // Pas de nouvelle poussée : le groupe a déjà prévenu une fois.
    return { creee: false, regroupee: true, poussee: false };
  }

  // ── Doublon d'une notification individuelle : on ne crée rien ────────────
  if (existante) return { creee: false, regroupee: false, poussee: false };

  const id = uid('no');
  try {
    await db.run(
      `INSERT INTO notifications
         (id, user_id, sender_id, type, post_id, comment_id, source_type, source_id,
          texte, lu, created_at, nb_acteurs)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 1)`,
      [id, receiverId, senderId, type, postId || sourceId,
        commentId || null, sourceType, source, apercu, ts]);

    if (GROUPES.has(type)) {
      await db.run(
        `INSERT INTO notification_acteurs (notification_id, user_id, created_at)
         VALUES (?, ?, ?) ON CONFLICT (notification_id, user_id) DO NOTHING`,
        [id, senderId, ts]);
    }
  } catch {
    return rien; // contrainte d'unicité : la notification existe déjà
  }

  // ── Poussée : une seule, à la création ──────────────────────────────────
  let poussee = false;
  try {
    const noms = [senderNom || 'Quelqu’un'];
    poussee = await push.sendUser(receiverId, {
      title: titrePoussee(type),
      body: messageDe({ type, nbActeurs: 1, noms, apercu }),
      channel: 'messages',
      collapseKey: `notif-${type}-${postId || source}`,
      data: {
        type,
        post_id: String(postId || source),
        comment_id: commentId ? String(commentId) : '',
        source_type: sourceType,
        source_id: source,
        from: String(senderId),
      },
    });
  } catch { /* sans réseau, la notification reste dans l'application */ }

  return { creee: true, regroupee: false, poussee };
}

/** Titre de la notification système, court et lisible. */
function titrePoussee(type) {
  switch (type) {
    case TYPES.LIKE: return 'Nouveau j’aime';
    case TYPES.COMMENT: return 'Nouveau commentaire';
    case TYPES.REPLY: return 'Réponse à votre commentaire';
    case TYPES.MENTION: return 'Nouvelle mention';
    case TYPES.SHARE: return 'Votre publication a été partagée';
    case TYPES.FOLLOW: return 'Nouvel abonné';
    case TYPES.PRESENCE: return 'Contact en ligne';
    default: return 'MboteCall';
  }
}

/**
 * Retire un auteur d'une notification groupée (j'aime retiré).
 * Si plus personne n'est concerné, la notification disparaît : l'auteur ne
 * verra jamais « X a aimé » alors que X n'aime plus.
 *
 * @param {{receiverId: string, senderId: string, type: string, sourceId: string,
 *          sourceType?: string}} p
 */
async function retirer({ receiverId, senderId, type, sourceId, sourceType = 'post' }) {
  if (!receiverId || !senderId) return false;

  const existante = await db.get(
    `SELECT id FROM notifications
      WHERE user_id = ? AND type = ? AND source_type = ? AND source_id = ?`,
    [receiverId, type, sourceType, String(sourceId)]);
  if (!existante) return false;

  await db.run(
    'DELETE FROM notification_acteurs WHERE notification_id = ? AND user_id = ?',
    [existante.id, senderId]);

  const reste = await db.get(
    'SELECT COUNT(*) AS n FROM notification_acteurs WHERE notification_id = ?',
    [existante.id]);

  if (!reste || !Number(reste.n)) {
    await db.run('DELETE FROM notifications WHERE id = ?', [existante.id]);
    return true;
  }

  // Le dernier auteur affiché doit exister : on prend le plus récent restant.
  const dernier = await db.get(
    `SELECT user_id FROM notification_acteurs
      WHERE notification_id = ? ORDER BY created_at DESC LIMIT 1`, [existante.id]);
  await db.run(
    'UPDATE notifications SET nb_acteurs = ?, sender_id = ? WHERE id = ?',
    [Number(reste.n), dernier ? dernier.user_id : null, existante.id]);
  return true;
}

/**
 * Notifie les personnes concernées par un commentaire :
 *   - l'auteur de la publication (type `comment`) ;
 *   - l'auteur du commentaire parent, s'il s'agit d'une réponse
 *     (type `comment_reply`).
 * Les doublons (même personne, même type) sont écartés par les appelants.
 */
async function notifierCommentaire({
  postId, commentId, parentId, auteurPostId, auteurParentId,
  senderId, senderNom, texte,
}) {
  const resultats = [];

  if (parentId && auteurParentId && String(auteurParentId) !== String(senderId)) {
    resultats.push(await notifier({
      receiverId: auteurParentId, senderId, senderNom,
      type: TYPES.REPLY, postId, commentId, sourceType: 'comment', sourceId: commentId,
      texte,
    }));
  }
  if (auteurPostId && String(auteurPostId) !== String(senderId)
      && String(auteurPostId) !== String(auteurParentId || '')) {
    resultats.push(await notifier({
      receiverId: auteurPostId, senderId, senderNom,
      type: TYPES.COMMENT, postId, commentId, sourceType: 'comment', sourceId: commentId,
      texte,
    }));
  }
  return resultats;
}

module.exports = {
  TYPES,
  GROUPES,
  NOTIFS_MAX_HEURE,
  messageDe,
  notifier,
  retirer,
  notifierCommentaire,
  titrePoussee,
};
