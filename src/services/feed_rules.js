'use strict';

/**
 * RÈGLES DU FIL MBOTE — visibilité, hashtags, découverte.
 *
 * Pourquoi ce module existe : la visibilité d'une publication était comparée
 * à des chaînes accentuées écrites à la main dans la requête SQL
 * (`'communauté'`). Une seule différence d'encodage (forme composée NFC contre
 * forme décomposée NFD), de casse ou de libellé envoyé par l'application
 * suffisait à rendre une publication INVISIBLE pour tout le monde… sauf pour
 * son auteur, qui la voyait parce que la requête du fil comporte toujours la
 * clause « OR p.user_id = moi ». C'est exactement le symptôme constaté.
 *
 * Décision : les valeurs sont désormais CANONIQUES et SANS ACCENT en base
 * (`public`, `communaute`, `contacts`), et tout ce qui arrive de l'extérieur
 * est ramené à ces trois valeurs par `canoniserVisibilite()`. La lecture
 * tolère en plus l'ancienne écriture accentuée, pour les lignes créées avant
 * la migration.
 */

const VISIBILITES = ['public', 'communaute', 'contacts'];
const DUREES = ['h24', 'permanent'];

/** Retire les accents (NFC ou NFD) et passe en minuscules. */
function sansAccents(v) {
  return String(v == null ? '' : v)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Ramène n'importe quelle écriture à `public` | `communaute` | `contacts`.
 * Renvoie `null` si la valeur n'est pas reconnue (l'appelant décide : refus à
 * la création, repli à la migration).
 */
function canoniserVisibilite(v) {
  const s = sansAccents(v);
  if (!s) return null;
  if (['public', 'publique', 'tout le monde', 'toutlemonde', 'world', 'everyone'].includes(s)) return 'public';
  if (['communaute', 'community', 'communaute mbote', 'mbote'].includes(s)) return 'communaute';
  if (['contacts', 'contact', 'mes contacts', 'amis', 'friends', 'prive', 'privee', 'private'].includes(s)) return 'contacts';
  return null;
}

/** Durée de vie : `h24` expire après 24 h, `permanent` reste. */
function canoniserDuree(v) {
  const s = sansAccents(v);
  return s === 'h24' ? 'h24' : 'permanent';
}

// ─── Hashtags ────────────────────────────────────────────────────────────────

const TAG_MAX = 30;      // longueur maximale d'un mot-clé
const TAGS_PAR_POST = 10; // au-delà, on ignore (anti-pollution)

/** Normalise un mot-clé : sans #, sans accent, sans espace, en minuscules. */
function normaliserTag(v) {
  const s = sansAccents(v)
    .replace(/^#+/, '')
    .replace(/[^a-z0-9_]/g, '')
    .slice(0, TAG_MAX);
  return s.length >= 2 ? s : null;
}

/**
 * Extrait les mots-clés d'une publication : les `#mots` du texte, plus les
 * `event_tags` fournis par l'application. Doublons supprimés, ordre conservé.
 */
function extraireTags(texte, eventTags) {
  const sortie = [];
  const ajouter = (v) => {
    const t = normaliserTag(v);
    if (t && !sortie.includes(t) && sortie.length < TAGS_PAR_POST) sortie.push(t);
  };
  if (typeof texte === 'string') {
    for (const m of texte.matchAll(/#([\p{L}\p{N}_]{2,30})/gu)) ajouter(m[1]);
  }
  if (Array.isArray(eventTags)) for (const t of eventTags) ajouter(t);
  return sortie;
}

// ─── Visibilité côté SQL ─────────────────────────────────────────────────────

/**
 * Construit le prédicat de visibilité du fil, alias `p` = table posts.
 *
 * Règles :
 *   - mes propres publications : toujours visibles ;
 *   - `public` et `communaute` : visibles par tout le monde connecté ;
 *   - `contacts` : visible si l'auteur est dans MES contacts, OU si je suis
 *     dans SES contacts. Cette seconde moitié manquait : « mes contacts »
 *     n'atteignait donc que les gens dont le répertoire me contenait déjà,
 *     ce qui donne en pratique une audience nulle.
 *
 * @param {string} userId
 * @param {string} phone  numéro normalisé de l'utilisateur courant
 * @returns {{sql: string, params: any[]}}
 */
function predicatVisibilite(userId, phone) {
  const sql = `(
    p.user_id = ?
    OR p.visibilite IN ('public', 'communaute', 'communauté')
    OR (
      p.visibilite = 'contacts'
      AND (
        p.user_id IN (
          SELECT uc.id FROM contacts c JOIN users uc ON uc.phone = c.phone
           WHERE c.user_id = ?
        )
        OR EXISTS (
          SELECT 1 FROM contacts c2
           WHERE c2.user_id = p.user_id AND c2.phone = ?
        )
      )
    )
  )`;
  return { sql, params: [userId, userId, phone || ''] };
}

/** Prédicat « contenu public » : ce que n'importe qui peut découvrir. */
function predicatPublic() {
  return { sql: `p.visibilite IN ('public', 'communaute', 'communauté')`, params: [] };
}

/**
 * Prédicat d'expiration : une publication éphémère (`h24`) sort du fil au bout
 * de 24 h. Avant, le champ `duree` était enregistré mais jamais lu — les
 * publications « 24 h » restaient donc à vie.
 */
function predicatNonExpire(maintenant) {
  return {
    sql: `(p.duree IS NULL OR p.duree <> 'h24' OR p.created_at >= ?)`,
    params: [maintenant - 24 * 60 * 60 * 1000],
  };
}

// ─── Découverte : score d'intérêt ────────────────────────────────────────────

/**
 * Score « Pour toi / Tendances », calculé en JS parce que les deux moteurs
 * (SQLite et PostgreSQL) n'ont pas les mêmes fonctions mathématiques.
 *
 *   intérêt = (j'aime × 3 + commentaires × 4 + vues × 0,5) / (âge + 2)^1,4
 *
 * Le dénominateur fait vieillir les publications : une publication ancienne
 * très aimée laisse la place à une publication récente qui marche. Le +2 évite
 * une division explosive sur les publications de la seconde.
 */
function scoreInteret(post, maintenant) {
  const ageHeures = Math.max(0, (maintenant - Number(post.created_at || 0)) / 3600000);
  const engagement =
    Number(post.likes || 0) * 3 +
    Number(post.comments || 0) * 4 +
    Number(post.vues || 0) * 0.5;
  // Une publication à laquelle j'ai déjà participé remonte légèrement.
  const bonus = Number(post.liked || 0) ? 1.5 : 0;
  return (engagement + bonus) / Math.pow(ageHeures + 2, 1.4);
}

/** Trie par intérêt décroissant, sans modifier le tableau d'origine. */
function trierParInteret(posts, maintenant) {
  return [...posts]
    .map((p) => ({ post: p, score: scoreInteret(p, maintenant) }))
    .sort((a, b) => b.score - a.score || Number(b.post.created_at) - Number(a.post.created_at))
    .map((x) => x.post);
}

module.exports = {
  VISIBILITES,
  DUREES,
  sansAccents,
  canoniserVisibilite,
  canoniserDuree,
  normaliserTag,
  extraireTags,
  predicatVisibilite,
  predicatPublic,
  predicatNonExpire,
  scoreInteret,
  trierParInteret,
  TAGS_PAR_POST,
};
