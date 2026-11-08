'use strict';

/**
 * SUGGESTIONS ASSISTÉES (architecture prête pour l'IA).
 *
 * Le formulaire de publication propose des hashtags et des personnes à
 * mentionner avant l'envoi. Deux implémentations vivent derrière la même
 * interface :
 *
 *   1. HEURISTIQUE (active aujourd'hui) : mots significatifs du texte
 *      rapprochés des hashtags réellement utilisés sur la plateforme, plus la
 *      ville de l'auteur et son pays. Aucun appel réseau, réponse en quelques
 *      millisecondes, fonctionne hors ligne côté serveur.
 *
 *   2. MODÈLE (à brancher) : si `IA_SUGGESTIONS_URL` est défini, la même
 *      fonction appellera le service externe (`POST {url}` avec
 *      `{texte, ville, hashtags_connus, personnes_connues}`) et attendra
 *      `{hashtags: [...], mentions: [...]}`. La signature ne change pas, donc
 *      l'application n'a rien à modifier le jour du branchement.
 *
 * Rien ici ne décide à la place de l'auteur : ce sont des propositions, jamais
 * des ajouts automatiques. C'est la différence entre aider et publier à sa
 * place.
 */

const db = require('../db');
const texteSocial = require('./texte_social');
const { sansAccents } = require('./feed_rules');

/** Mots trop fréquents pour caractériser un contenu (français, lingala, swahili). */
const MOTS_VIDES = new Set([
  'le', 'la', 'les', 'un', 'une', 'des', 'du', 'de', 'da', 'et', 'ou', 'a', 'au',
  'aux', 'en', 'dans', 'sur', 'pour', 'par', 'avec', 'sans', 'ce', 'cet', 'cette',
  'ces', 'mon', 'ma', 'mes', 'ton', 'ta', 'tes', 'son', 'sa', 'ses', 'je', 'tu',
  'il', 'elle', 'on', 'nous', 'vous', 'ils', 'elles', 'est', 'sont', 'ete', 'être',
  'etre', 'avoir', 'fait', 'faire', 'plus', 'tres', 'tres', 'bien', 'tout', 'tous',
  'toute', 'pas', 'que', 'qui', 'quoi', 'dont', 'comme', 'mais', 'donc', 'car',
  'na', 'ya', 'ezali', 'mpe', 'kaka', 'yangó', 'yango', 'soki', 'malamu', 'to',
  'wa', 'kwa', 'ni', 'kama', 'hii', 'hiyo', 'za', 'kwenye', 'sana',
]);

/** Au-delà, le texte est trop long pour être utile : on n'analyse que le début. */
const TEXTE_MAX = 600;

/** Découpe un texte en mots exploitables (sans hashtags, sans mentions). */
function motsCles(texte) {
  if (typeof texte !== 'string') return [];
  const propre = texte
    .replace(/#[\p{L}\p{N}_]{2,30}/gu, ' ')
    .replace(/@[\p{L}\p{N}._-]{2,40}/gu, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .slice(0, TEXTE_MAX);

  const vus = new Set();
  for (const m of propre.matchAll(/[\p{L}][\p{L}\p{N}'-]{2,}/gu)) {
    const mot = sansAccents(m[0]);
    if (mot.length < 3 || MOTS_VIDES.has(mot) || vus.has(mot)) continue;
    vus.add(mot);
  }
  return [...vus];
}

/**
 * Hashtags proposés pour un texte.
 *
 * Croisement de deux signaux :
 *   - les mots du texte qui correspondent à un hashtag déjà utilisé sur la
 *     plateforme (c'est ce qui rend la proposition crédible) ;
 *   - la ville et le pays de l'auteur (les hashtags géographiques sont ceux qui
 *     engagent le plus localement).
 *
 * @param {object} p
 * @param {string} p.texte
 * @param {string} [p.ville]
 * @param {string} [p.pays]
 * @param {string[]} [p.dejaChoisis]  hashtags déjà présents dans le texte
 * @param {number} [p.limite]
 * @returns {Promise<{tag: string, publications: number, raison: string}[]>}
 */
async function suggererHashtags({ texte, ville, pays = 'rdc', dejaChoisis = [], limite = 5 }) {
  const mots = motsCles(texte);
  const exclus = new Set([...(dejaChoisis || []), ...texteSocial.extraireHashtags(texte).map((t) => t.cle)]);
  const propositions = new Map();

  const ajouter = (tag, publications, raison) => {
    const cle = texteSocial.cleHashtag(tag);
    if (!cle || exclus.has(cle) || propositions.has(cle)) return;
    propositions.set(cle, { tag: cle, publications, raison });
  };

  // 1. Mots du texte présents dans le catalogue réel des hashtags.
  if (mots.length) {
    const trous = mots.map(() => '?').join(',');
    const lignes = await db.all(`
      SELECT pt.tag AS tag, COUNT(*) AS n
        FROM post_tags pt JOIN posts p ON p.id = pt.post_id
       WHERE p.visibilite = 'public' AND pt.tag IN (${trous})
       GROUP BY pt.tag
       ORDER BY n DESC
       LIMIT ?`, [...mots, limite * 2]);

    for (const l of lignes) ajouter(l.tag, Number(l.n) || 0, 'mot_du_texte');

    // Les hashtags composés sont fréquents (« techafrique » pour « tech ») :
    // on complète par un préfixe, sans jamais inventer un hashtag inconnu.
    const prefixes = mots.slice(0, 4).map(() => 'tag LIKE ?').join(' OR ');
    const composes = await db.all(`
      SELECT pt.tag AS tag, COUNT(*) AS n
        FROM post_tags pt JOIN posts p ON p.id = pt.post_id
       WHERE p.visibilite = 'public' AND (${prefixes})
       GROUP BY pt.tag
       ORDER BY n DESC
       LIMIT ?`, [...mots.slice(0, 4).map((m) => `${m}%`), limite]);

    for (const l of composes) ajouter(l.tag, Number(l.n) || 0, 'mot_du_texte');
  }

  // 2. Géographie : la ville, puis le pays. Ce sont les plus engageants.
  if (ville) ajouter(String(ville), 0, 'ville');
  if (pays) {
    const code = sansAccents(pays);
    if (code === 'cd' || code === 'rdc' || code === 'congo') ajouter('rdc', 0, 'pays');
  }

  return [...propositions.values()].slice(0, limite);
}

/**
 * Personnes à mentionner : celles dont le nom ou l'identifiant apparaît dans le
 * texte, parmi les comptes réels. On ne propose jamais un contact au hasard.
 */
async function suggererMentions({ texte, limite = 5 }) {
  const mots = motsCles(texte);
  if (!mots.length) return [];

  const trous = mots.map(() => '?').join(',');
  const lignes = await db.all(`
    SELECT id, name, handle, avatar FROM users
     WHERE status = 'active' AND LOWER(name) IN (${trous})
     LIMIT ?`, [...mots, limite]);

  return lignes.map((u) => ({
    id: u.id, name: u.name || '', handle: u.handle || null,
    avatar: u.avatar || null, raison: 'nom_dans_le_texte',
  }));
}

/** Le service externe est-il configuré ? (voir l'en-tête du module) */
function modeleConfigure() {
  return !!process.env.IA_SUGGESTIONS_URL;
}

module.exports = {
  motsCles,
  suggererHashtags,
  suggererMentions,
  modeleConfigure,
};
