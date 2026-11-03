/**
 * Configurations ICE (STUN/TURN) fournies aux applications.
 *
 * Pourquoi ce fichier existe : la production ne fournissait QUE des serveurs
 * STUN. Or le STUN ne suffit pas sur les réseaux mobiles congolais, où les
 * opérateurs placent les téléphones derrière un NAT symétrique (CGNAT) : les
 * deux appareils ne trouvent jamais de chemin direct, l'appel reste bloqué en
 * « Ça sonne… » puis se termine tout seul. C'est le symptôme « les appels ne
 * passent pas ».
 *
 * Un relais TURN, lui, fait transiter les paquets par un serveur : l'appel
 * aboutit même en CGNAT. Il coûte de la bande passante passante, d'où des
 * identifiants à part, jamais écrits dans l'application (rotation possible sans
 * recompiler).
 *
 * Configuration attendue (Render → Environment), au choix :
 *
 *   A) Identifiants fixes (Metered, Cloudflare Realtime, Twilio…)
 *        TURN_URLS       = turn:relay.example.com:80,turn:relay.example.com:443
 *        TURN_USERNAME   = …
 *        TURN_CREDENTIAL = …
 *
 *   B) Identifiants éphémères calculés (coturn en mode « REST »)
 *        TURN_URLS          = turn:mon-serveur:3478
 *        TURN_SHARED_SECRET = la clé partagée coturn
 *
 * Sans ces variables : STUN seulement, et le serveur le dit au démarrage.
 */

/** Serveurs STUN publics, toujours utiles (découverte d'adresse). */
const STUN_SERVERS = [
  'stun:stun.l.google.com:19302',
  'stun:stun1.l.google.com:19302',
];

/** Lit TURN_URLS et renvoie la liste nettoyée. */
function turnUrls(env = process.env) {
  return String(env.TURN_URLS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    // Un relais s'écrit forcément turn: ou turns:
    .filter((u) => /^turns?:/i.test(u));
}

/** Le relais TURN est-il configuré ? */
function turnConfigured(env = process.env) {
  const urls = turnUrls(env);
  if (!urls.length) return false;
  return Boolean((env.TURN_USERNAME && env.TURN_CREDENTIAL) || env.TURN_SHARED_SECRET);
}

/**
 * Construit la liste `iceServers` envoyée à l'application.
 * @param {string} userId identifiant du compte (sert aux identifiants éphémères)
 * @param {object} [env] environnement (injectable pour les tests)
 * @param {Function} [hmac] fonction (secret, texte) → base64 (injectable)
 */
function buildIceServers(userId, env = process.env, hmac = null) {
  const iceServers = STUN_SERVERS.map((urls) => ({ urls }));
  const urls = turnUrls(env);
  if (!urls.length) return iceServers;

  if (env.TURN_USERNAME && env.TURN_CREDENTIAL) {
    // A) identifiants fixes
    iceServers.push({
      urls: urls.length === 1 ? urls[0] : urls,
      username: String(env.TURN_USERNAME),
      credential: String(env.TURN_CREDENTIAL),
    });
    return iceServers;
  }

  if (env.TURN_SHARED_SECRET) {
    // B) coturn « REST » : le nom d'utilisateur porte une date d'expiration,
    //    le mot de passe est un HMAC-SHA1 de ce nom.
    const username = `${Math.floor(Date.now() / 1000) + 3600}:${userId || ''}`;
    const sign = hmac || ((secret, text) =>
      require('crypto').createHmac('sha1', secret).update(text).digest('base64'));
    iceServers.push({
      urls: urls.length === 1 ? urls[0] : urls,
      username,
      credential: sign(env.TURN_SHARED_SECRET, username),
    });
  }
  return iceServers;
}

/** Message de démarrage : dit franchement si les appels peuvent aboutir. */
function startupNotice(env = process.env) {
  if (turnConfigured(env)) {
    return `🔁 Relais TURN configuré (${turnUrls(env).length} adresse(s))`;
  }
  return '⚠️  Aucun relais TURN configuré : les appels MboteCall → MboteCall ' +
    'échoueront sur les réseaux mobiles derrière un NAT symétrique (CGNAT). ' +
    'Renseigne TURN_URLS + TURN_USERNAME + TURN_CREDENTIAL (voir services/ice.js).';
}

module.exports = { STUN_SERVERS, turnUrls, turnConfigured, buildIceServers, startupNotice };
