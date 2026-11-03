'use strict';

/**
 * TEXTE SOCIAL — hashtags (#) et mentions (@).
 *
 * Un seul endroit décide de ce qu'est un hashtag valide et de ce qu'est une
 * mention. L'application affiche, le serveur enregistre : si les deux ne
 * partagent pas exactement la même règle, on obtient des hashtags cliquables
 * qui ne mènent nulle part, ou des mentions notifiées à contretemps.
 *
 * Règles retenues, alignées sur les plateformes de référence :
 *
 *   #Hashtag   2 à 30 caractères, lettres (accents compris), chiffres, `_`.
 *              Un `#` collé à un mot (« 100# ») n'est PAS un hashtag.
 *   @mention   2 à 40 caractères, lettres, chiffres, `.`, `_`, `-`.
 *              Une adresse électronique (`a@b.com`) n'est PAS une mention :
 *              le caractère qui précède doit être un séparateur.
 *
 * Normalisation : le texte affiché garde la casse et les accents tapés
 * (« #MboteCall », « @Cédrick ») ; la clé de recherche, elle, est sans accent
 * et en minuscules, comme pour les mots-clés du fil.
 */

const { sansAccents } = require('./feed_rules');

const HASHTAGS_MAX = 10;     // par publication / commentaire / statut
const MENTIONS_MAX = 10;     // idem
const HANDLE_MAX = 24;

// Un `#` ou un `@` précédé d'une lettre, d'un chiffre ou d'un point appartient
// au mot (adresse électronique, code, couleur hexadécimale) : on l'ignore.
const RE_HASHTAG = /(?<![\p{L}\p{N}_.])#([\p{L}\p{N}_]{2,30})/gu;
const RE_MENTION = /(?<![\p{L}\p{N}_.])@([\p{L}\p{N}._-]{2,40})/gu;

/**
 * Clé de comparaison d'un hashtag : « #MboteCall », « mbotecall » et
 * « MBOTECALL » désignent le MÊME hashtag.
 * @returns {string|null}
 */
function cleHashtag(v) {
  const s = sansAccents(v)
    .replace(/^#+/, '')
    .replace(/[^a-z0-9_]/g, '')
    .slice(0, 30);
  return s.length >= 2 ? s : null;
}

/**
 * Forme d'affichage d'un hashtag tel qu'il a été tapé (casse et accents
 * conservés). Les espaces et la ponctuation de bord sont retirés.
 */
function affichageHashtag(v) {
  return String(v == null ? '' : v)
    .replace(/^#+/, '')
    .trim()
    .slice(0, 30);
}

/**
 * Hashtags d'un texte, dans l'ordre d'apparition, sans doublon.
 * La comparaison se fait sur la clé : « #RDC » et « #rdc » ne comptent qu'une
 * fois, mais c'est la PREMIÈRE écriture qui est conservée pour l'affichage.
 *
 * @param {string} texte
 * @param {{max?: number}} [options]
 * @returns {{cle: string, nom: string}[]}
 */
function extraireHashtags(texte, { max = HASHTAGS_MAX } = {}) {
  const sortie = [];
  const vus = new Set();
  if (typeof texte !== 'string' || !texte) return sortie;

  for (const m of texte.matchAll(RE_HASHTAG)) {
    const nom = affichageHashtag(m[1]);
    const cle = cleHashtag(nom);
    if (!cle || vus.has(cle)) continue;
    vus.add(cle);
    sortie.push({ cle, nom });
    if (sortie.length >= max) break;
  }
  return sortie;
}

/**
 * Mentions d'un texte, normalisées en identifiants publics (sans `@`,
 * minuscules, sans accent). `nom` conserve l'écriture tapée, pour l'affichage
 * et pour les messages d'erreur (« @Cedrick n'existe pas »).
 *
 * @param {string} texte
 * @param {{max?: number}} [options]
 * @returns {{handle: string, nom: string}[]}
 */
function extraireMentions(texte, { max = MENTIONS_MAX } = {}) {
  const sortie = [];
  const vus = new Set();
  if (typeof texte !== 'string' || !texte) return sortie;

  for (const m of texte.matchAll(RE_MENTION)) {
    const nom = String(m[1]).replace(/[._-]+$/, '');
    if (nom.length < 2) continue;
    const handle = normaliserHandle(nom);
    if (!handle || vus.has(handle)) continue;
    vus.add(handle);
    sortie.push({ handle, nom });
    if (sortie.length >= max) break;
  }
  return sortie;
}

/**
 * Identifiant public : minuscules, sans accent, sans espace ni ponctuation
 * (hors `.`, `_`, `-`). C'est la clé unique de `users.handle`.
 */
function normaliserHandle(v) {
  const s = sansAccents(v)
    .replace(/^@+/, '')
    .replace(/[^a-z0-9._-]/g, '')
    .replace(/^[._-]+/, '')
    .slice(0, HANDLE_MAX);
  return s.length >= 2 ? s : null;
}

/**
 * Identifiant public proposé à partir du nom affiché : « Cédrick Lengo » →
 * `cedricklengo`. `pris` permet d'éviter les collisions (on ajoute alors un
 * numéro), ce qui garantit l'unicité de `users.handle`.
 *
 * @param {string} nom
 * @param {(handle: string) => boolean} pris
 */
function handleDepuisNom(nom, pris = () => false) {
  const base = sansAccents(nom)
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, HANDLE_MAX - 3) || 'mbote';
  let candidat = base;
  let n = 2;
  while (n < 1000 && pris(candidat)) {
    const suffixe = String(n);
    candidat = base.slice(0, HANDLE_MAX - suffixe.length) + suffixe;
    n++;
  }
  return candidat;
}

/**
 * Découpe un texte en segments affichables : texte simple, hashtag, mention,
 * lien. Sert aux aperçus côté serveur (page publique) et de référence aux
 * tests : l'application a la même logique, écrite en Dart.
 *
 * @returns {{type: 'texte'|'hashtag'|'mention'|'lien', valeur: string, cle?: string}[]}
 */
function decouper(texte) {
  const s = typeof texte === 'string' ? texte : '';
  const jetons = [];
  const motif = new RegExp(`${RE_HASHTAG.source}|${RE_MENTION.source}|https?:\\/\\/[^\\s]+`, 'gu');
  let dernier = 0;

  for (const m of s.matchAll(motif)) {
    const debut = m.index || 0;
    if (debut > dernier) jetons.push({ type: 'texte', valeur: s.slice(dernier, debut) });
    const brut = m[0];
    if (brut.startsWith('#')) {
      const cle = cleHashtag(brut);
      if (cle) jetons.push({ type: 'hashtag', valeur: brut, cle });
      else jetons.push({ type: 'texte', valeur: brut });
    } else if (brut.startsWith('@')) {
      const handle = normaliserHandle(brut);
      if (handle) jetons.push({ type: 'mention', valeur: brut, cle: handle });
      else jetons.push({ type: 'texte', valeur: brut });
    } else {
      jetons.push({ type: 'lien', valeur: brut });
    }
    dernier = debut + brut.length;
  }
  if (dernier < s.length) jetons.push({ type: 'texte', valeur: s.slice(dernier) });
  return jetons;
}

module.exports = {
  HASHTAGS_MAX,
  MENTIONS_MAX,
  HANDLE_MAX,
  cleHashtag,
  affichageHashtag,
  extraireHashtags,
  extraireMentions,
  normaliserHandle,
  handleDepuisNom,
  decouper,
};
