'use strict';

/**
 * DÉTECTION D'ARNAQUES — Heuristiques légères (sans ML, sans API payante).
 *
 * Stratégie : score cumulatif. Chaque signal ajoute des points.
 * Si le score >= SEUIL, le message est signalé.
 *
 * Niveaux de risque retournés :
 *   'none'    → message sûr
 *   'low'     → signal faible (avertissement discret côté client)
 *   'medium'  → arnaque probable (bannière jaune dans la bulle)
 *   'high'    → arnaque très probable (bannière rouge, blocage suggéré)
 *
 * Les mots-clés sont calibrés pour le contexte francophone RDC :
 *   français, lingala, swahili, et argot courant dans les arnaques locales.
 *
 * IMPORTANT : ces heuristiques ne sont PAS infaillibles. Elles signalent ;
 * la décision appartient toujours à l'utilisateur.
 */

// ── Mots-clés par catégorie (chacun ajoute des points au score) ────────────

/** Urgence financière / transfert d'argent. Score +3 par match. */
const ARGENT = [
  'envoie argent', 'envoyer argent', 'envoyer de l\'argent',
  'western union', 'moneygram', 'orange money', 'mpesa', 'airtel money',
  'transfert', 'virement', 'recharge', 'crédit téléphone',
  'tuma pesa', 'nitumie pesa', // swahili : "envoie-moi de l'argent"
  'tinda mbongo', 'pesez',      // lingala
  'compte bancaire', 'numéro de compte', 'rib',
];

/** Gains / cadeaux miraculeux. Score +3. */
const GAINS = [
  'vous avez gagné', 'tu as gagné', 'félicitations', 'prix',
  'cadeau gratuit', 'loterie', 'tirage au sort',
  'gagnant', 'sélectionné', 'élu', 'chanceux',
  'million', 'milliard', '100 000', '500 000',
  'ungeshinda', // swahili : "tu as gagné"
];

/** Urgence / pression psychologique. Score +2. */
const URGENCE = [
  'immédiatement', 'maintenant', 'urgent', 'dès maintenant',
  'avant ce soir', 'dans les 24', 'dans les 48', 'expire',
  'ne dis pas', 'ne parle pas', 'secret', 'confidentiellement',
  'surtout pas à', 'ne pas montrer',
  'haraka', // swahili : "vite"
];

/** URLs suspectes / hameçonnage. Score +4. */
const URL_SUSPECTE = [
  /https?:\/\/bit\.ly/i,
  /https?:\/\/tinyurl/i,
  /https?:\/\/t\.co\//i,
  /https?:\/\/[a-z0-9-]+\.(xyz|top|club|online|site|tk|ml|ga|cf|gq)\//i,
  /clique.{0,10}ici/i,
  /cliquez.{0,10}lien/i,
  /verification.{0,20}compte/i,
  /confirmer.{0,20}identit/i,
];

/** Demandes de données personnelles. Score +4. */
const DONNEES = [
  'numéro de carte', 'carte bancaire', 'code pin', 'code secret',
  'mot de passe', 'password', 'login', 'identifiant',
  'numéro de sécurité', 'cvc', 'cvv',
  'copie de pièce', 'carte d\'identité', 'passeport',
];

/** Profil émotionnel / romance arnaque. Score +2. */
const ROMANCE = [
  'je t\'aime dès le premier', 'coup de foudre', 'âme sœur',
  'je suis seul', 'je suis seule', 'militaire américain', 'ingénieur pétrolier',
  'medecin en mission', 'je t\'enverrai', 'rejoins-moi',
];

// ── Fonction principale ────────────────────────────────────────────────────

/**
 * Analyse un message et retourne un niveau de risque.
 *
 * @param {string} body   Corps du message
 * @param {{isNewContact?: boolean, accountAgeMs?: number}} ctx
 *   isNewContact   : expéditeur non présent dans les contacts
 *   accountAgeMs   : âge du compte en millisecondes (0 = inconnu)
 * @returns {{ level: 'none'|'low'|'medium'|'high', score: number, signals: string[] }}
 */
function analyser(body, ctx = {}) {
  if (!body || typeof body !== 'string') return { level: 'none', score: 0, signals: [] };

  const texte = body.toLowerCase();
  let score = 0;
  const signals = [];

  // ── Facteurs contextuels ──────────────────────────────────────────────
  if (ctx.isNewContact) {
    score += 2;
    signals.push('contact_inconnu');
  }
  if (ctx.accountAgeMs > 0 && ctx.accountAgeMs < 7 * 24 * 3600 * 1000) {
    // Compte créé il y a moins de 7 jours.
    score += 3;
    signals.push('compte_recent');
  }

  // ── Mots-clés ─────────────────────────────────────────────────────────
  for (const kw of ARGENT) {
    if (texte.includes(kw)) { score += 3; signals.push(`argent:${kw}`); }
  }
  for (const kw of GAINS) {
    if (texte.includes(kw)) { score += 3; signals.push(`gains:${kw}`); }
  }
  for (const kw of URGENCE) {
    if (texte.includes(kw)) { score += 2; signals.push(`urgence:${kw}`); }
  }
  for (const kw of DONNEES) {
    if (texte.includes(kw)) { score += 4; signals.push(`donnees:${kw}`); }
  }
  for (const kw of ROMANCE) {
    if (texte.includes(kw)) { score += 2; signals.push(`romance:${kw}`); }
  }
  for (const re of URL_SUSPECTE) {
    if (re.test(body)) { score += 4; signals.push(`url_suspecte`); break; }
  }

  // ── Montants élevés en chiffres (> 1 000 $) ───────────────────────────
  const montants = body.match(/\b\d[\d\s.]{3,}\b/g) || [];
  if (montants.length > 0) { score += 2; signals.push('montant_eleve'); }

  // ── Score → niveau ────────────────────────────────────────────────────
  let level = 'none';
  if (score >= 12) level = 'high';
  else if (score >= 7) level = 'medium';
  else if (score >= 4) level = 'low';

  return { level, score, signals: [...new Set(signals)] };
}

module.exports = { analyser };
