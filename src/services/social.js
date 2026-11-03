'use strict';

/**
 * SOCIAL — résolution des mentions et notifications.
 *
 * Le texte d'une publication ne suffit pas : « @Cedrick » doit désigner UNE
 * personne précise, au moment où la publication est écrite. On résout donc les
 * mentions à l'enregistrement (une ligne par personne réellement mentionnée),
 * et non à la lecture, pour trois raisons :
 *   - notifier tout de suite la bonne personne, une seule fois ;
 *   - ne pas relire le texte de chaque publication à chaque affichage du fil ;
 *   - garder la trace même si l'auteur modifie son texte plus tard.
 *
 * Les notifications sont écrites en base (boîte de réception de l'application)
 * ET poussées par FCM, avec deux garde-fous : pas de notification à soi-même,
 * et plafond horaire par destinataire (services/limites).
 */

const db = require('../db');
const { uid, now } = require('../util');
const limites = require('./limites');
const push = require('./push');
const {
  extraireHashtags, extraireMentions, normaliserHandle, handleDepuisNom,
} = require('./texte_social');

const TYPES_AVEC_NOM = new Set(['publication', 'commentaire', 'statut']);

const LIBELLE_SOURCE = {
  post: 'une publication',
  comment: 'un commentaire',
  story: 'un statut',
};

/**
 * Retrouve les personnes derrière une liste d'identifiants publics.
 * Un utilisateur sans `handle` (compte créé avant cette version) est retrouvé
 * par son nom, à défaut de mieux ; la migration au démarrage lui attribue de
 * toute façon un identifiant.
 *
 * @param {string[]} handles
 * @returns {Promise<Map<string, {id: string, name: string, handle: string, avatar: string|null}>>}
 */
async function resoudreHandles(handles) {
  const sortie = new Map();
  const liste = [...new Set(handles.map((h) => normaliserHandle(h)).filter(Boolean))];
  if (!liste.length) return sortie;

  const trous = liste.map(() => '?').join(',');
  const lignes = await db.all(
    `SELECT id, name, handle, avatar FROM users
      WHERE LOWER(handle) IN (${trous})`, liste);

  for (const l of lignes) {
    if (l.handle) sortie.set(String(l.handle).toLowerCase(), l);
  }
  return sortie;
}

/**
 * Identifiant public d'un utilisateur, créé à la volée si le compte est ancien.
 * @returns {Promise<string|null>}
 */
async function handleDe(userId) {
  const u = await db.get('SELECT id, name, handle FROM users WHERE id = ?', [userId]);
  if (!u) return null;
  if (u.handle) return u.handle;

  // Attribution à la première utilisation : on vérifie l'unicité en base.
  const base = handleDepuisNom(u.name || '');
  let candidat = base;
  for (let n = 2; n < 200; n++) {
    const pris = await db.get('SELECT id FROM users WHERE LOWER(handle) = ?', [candidat]);
    if (!pris) break;
    candidat = `${base.slice(0, 20)}${n}`;
  }
  await db.run('UPDATE users SET handle = ? WHERE id = ? AND handle IS NULL', [candidat, userId]);
  return candidat;
}

/** Attribue un identifiant public à tous les comptes qui n'en ont pas. */
async function attribuerHandles(log = console.log) {
  const sans = await db.all(
    'SELECT id, name FROM users WHERE handle IS NULL OR TRIM(handle) = \'\'');
  let attribues = 0;

  for (const u of sans) {
    const base = handleDepuisNom(u.name || '');
    let candidat = base;
    for (let n = 2; n < 500; n++) {
      const pris = await db.get('SELECT id FROM users WHERE LOWER(handle) = ?', [candidat]);
      if (!pris) break;
      candidat = `${base.slice(0, 20)}${n}`;
    }
    await db.run('UPDATE users SET handle = ? WHERE id = ?', [candidat, u.id]);
    attribues++;
  }
  if (attribues) log(`Identifiants publics attribués : ${attribues}`);
  return attribues;
}

/**
 * Enregistre les mentions d'un contenu et prévient les personnes concernées.
 *
 * @param {object} p
 * @param {'post'|'comment'|'story'} p.sourceType
 * @param {string} p.sourceId
 * @param {string} p.auteurId       auteur du contenu (jamais notifié)
 * @param {string} p.auteurNom
 * @param {string} p.texte
 * @param {string} [p.postId]       publication parente (commentaire)
 * @param {string} [p.texteApercu]  extrait affiché dans la notification
 * @returns {Promise<{mentions: object[], notifies: number, ignores: number}>}
 */
async function enregistrerMentions({
  sourceType, sourceId, auteurId, auteurNom, texte, postId, texteApercu,
}) {
  const demandees = extraireMentions(texte);
  if (!demandees.length) return { mentions: [], notifies: 0, ignores: 0 };

  const connus = await resoudreHandles(demandees.map((m) => m.handle));
  const retenues = [];
  let notifies = 0;
  let ignores = 0;

  for (const m of demandees) {
    const cible = connus.get(m.handle);
    // Mention d'un identifiant inconnu : elle reste affichée comme texte, mais
    // elle n'est ni enregistrée ni notifiée (aucune fuite d'existence).
    if (!cible) { ignores++; continue; }
    if (String(cible.id) === String(auteurId)) { ignores++; continue; }

    await db.run(
      `INSERT INTO mentions (source_type, source_id, user_id, handle, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (source_type, source_id, user_id) DO NOTHING`,
      [sourceType, sourceId, cible.id, cible.handle || m.handle, now()]);

    retenues.push({
      id: cible.id,
      handle: cible.handle || m.handle,
      name: cible.name || '',
      avatar: cible.avatar || null,
    });

    await notifierMention({
      cible, auteurId, auteurNom, sourceType, sourceId, postId, texte: texteApercu,
    }) && notifies++;
  }

  return { mentions: retenues, notifies, ignores };
}

/**
 * Notification de mention : une ligne en base, plus une poussée si l'appareil
 * est joignable. Le plafond horaire évite qu'une personne mentionnée vingt fois
 * reçoive vingt notifications.
 *
 * @returns {Promise<boolean>} true si une notification a été créée
 */
async function notifierMention({
  cible, auteurId, auteurNom, sourceType, sourceId, postId, texte,
}) {
  if (String(cible.id) === String(auteurId)) return false;
  if (!limites.notifMentionAutorisee(cible.id)) return false;

  const id = uid('no');
  const extrait = (texte || '').toString().replace(/\s+/g, ' ').trim().slice(0, 140);
  const corps = `${auteurNom || 'Quelqu’un'} t’a mentionné dans ${LIBELLE_SOURCE[sourceType] || 'un contenu'}`;

  try {
    await db.run(
      `INSERT INTO notifications
         (id, user_id, sender_id, type, post_id, comment_id, source_type, source_id,
          texte, lu, created_at)
       VALUES (?, ?, ?, 'mention', ?, ?, ?, ?, ?, 0, ?)
       ON CONFLICT (user_id, type, source_type, source_id) DO NOTHING`,
      [id, cible.id, auteurId, postId || sourceId,
        sourceType === 'comment' ? sourceId : null,
        sourceType, sourceId, extrait, now()]);
  } catch {
    return false; // doublon : la notification existe déjà
  }

  // La poussée ne doit jamais faire échouer l'enregistrement du contenu.
  try {
    await push.sendUser(cible.id, {
      title: 'Nouvelle mention',
      body: corps,
      channel: 'messages',
      collapseKey: `mention-${postId || sourceId}`,
      data: {
        type: 'mention',
        post_id: String(postId || sourceId),
        source_type: sourceType,
        source_id: String(sourceId),
        from: String(auteurId || ''),
      },
    });
  } catch { /* sans réseau, la notification reste dans l'application */ }

  return true;
}

/**
 * Hashtags d'un contenu + enregistrement dans `post_tags` (clé du catalogue des
 * tendances). Idempotent : republier ne duplique rien.
 *
 * @returns {Promise<{cle: string, nom: string}[]>}
 */
async function enregistrerHashtags(sourceId, texte, tagsSupplementaires = []) {
  const trouves = extraireHashtags(texte);
  const vus = new Set(trouves.map((t) => t.cle));

  for (const brut of Array.isArray(tagsSupplementaires) ? tagsSupplementaires : []) {
    const cle = normaliserHandle(brut); // même normalisation : sans accent, minuscules
    if (cle && !vus.has(cle) && trouves.length < 10) {
      vus.add(cle);
      trouves.push({ cle, nom: String(brut).replace(/^#+/, '').slice(0, 30) });
    }
  }

  for (const t of trouves) {
    await db.run(
      `INSERT INTO post_tags (post_id, tag) VALUES (?, ?)
       ON CONFLICT (post_id, tag) DO NOTHING`, [sourceId, t.cle]);
  }
  return trouves;
}

module.exports = {
  LIBELLE_SOURCE,
  TYPES_AVEC_NOM,
  resoudreHandles,
  handleDe,
  attribuerHandles,
  enregistrerMentions,
  enregistrerHashtags,
  notifierMention,
};
