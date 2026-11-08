'use strict';

/**
 * LIMITES SOCIALES — garde-fous des hashtags et des mentions.
 *
 * Un réseau social sans limites devient un mur de publicité : cinquante
 * hashtags par publication, la même personne mentionnée vingt fois par heure,
 * et la boîte de réception de l'intéressé devient inutilisable. Ces règles sont
 * volontairement simples, mesurables et silencieuses : l'auteur n'est pas
 * bloqué, ce qui dépasse la limite est simplement ignoré, et le nombre de
 * mentions réellement envoyées est renvoyé à l'application.
 *
 * Deux niveaux :
 *   1. par contenu  → nombre maximum de mentions retenues (texte_social.js) ;
 *   2. par période  → nombre maximum de notifications de mention envoyées à
 *      une même personne, sur une fenêtre glissante (ce module).
 *
 * Le compteur vit en mémoire : il protège contre l'emballement d'un compte ou
 * d'un robot pendant la vie du processus. Les données durables (mentions et
 * notifications) sont en base, donc un redémarrage ne fait perdre aucune
 * information utile — seulement le compteur de la fenêtre en cours.
 */

/** Fenêtre et plafond des notifications de mention par destinataire. */
const MENTIONS_NOTIF_MAX = 10;                     // par destinataire…
const MENTIONS_NOTIF_FENETRE = 60 * 60 * 1000;     // …et par heure

/** Publications maximales par auteur et par minute (anti-flood). */
const POSTS_MAX_MINUTE = 12;
const POSTS_FENETRE = 60 * 1000;

const compteurs = new Map();

/**
 * Autorise ou refuse une action dans une fenêtre glissante.
 *
 * @param {string} cle      identifiant de la fenêtre (ex. `mention:u1`)
 * @param {number} max      nombre d'actions autorisées sur la fenêtre
 * @param {number} fenetre  durée de la fenêtre en millisecondes
 * @param {number} [maintenant]
 * @returns {boolean} true si l'action est autorisée
 */
function autoriser(cle, max, fenetre, maintenant = Date.now()) {
  const c = compteurs.get(cle);
  if (!c || maintenant - c.debut >= fenetre) {
    compteurs.set(cle, { debut: maintenant, compte: 1 });
    return true;
  }
  if (c.compte >= max) return false;
  c.compte += 1;
  return true;
}

/** Combien d'actions restent dans la fenêtre courante. */
function restant(cle, max, fenetre, maintenant = Date.now()) {
  const c = compteurs.get(cle);
  if (!c || maintenant - c.debut >= fenetre) return max;
  return Math.max(0, max - c.compte);
}

/** Une notification de mention peut-elle encore partir vers cette personne ? */
function notifMentionAutorisee(userId, maintenant = Date.now()) {
  return autoriser(`mention:${userId}`, MENTIONS_NOTIF_MAX, MENTIONS_NOTIF_FENETRE, maintenant);
}

/** Publication autorisée ? Protège aussi la création en rafale. */
function publicationAutorisee(userId, maintenant = Date.now()) {
  return autoriser(`post:${userId}`, POSTS_MAX_MINUTE, POSTS_FENETRE, maintenant);
}

/** Remise à zéro (tests). */
function reinitialiser() {
  compteurs.clear();
}

module.exports = {
  MENTIONS_NOTIF_MAX,
  MENTIONS_NOTIF_FENETRE,
  POSTS_MAX_MINUTE,
  POSTS_FENETRE,
  autoriser,
  restant,
  notifMentionAutorisee,
  publicationAutorisee,
  reinitialiser,
};
