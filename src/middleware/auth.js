const jwt = require('jsonwebtoken');
const db = require('../db');

// 🔒 En production, AUCUN fallback : un secret faible ou connu = tous les
// jetons sont forgables. En dev, si JWT_SECRET manque, on génère un secret
// éphémère aléatoire (les sessions sont alors invalidées à chaque
// redémarrage, ce qui est acceptable en local et visible dans les logs).
if (!process.env.JWT_SECRET) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('JWT_SECRET manquant : le serveur refuse de démarrer en production. Définissez JWT_SECRET dans les variables d’environnement (Render → Environment). Voir .env.example.');
  }
  process.env.JWT_SECRET = require('crypto').randomBytes(32).toString('hex');
  console.warn('⚠️  JWT_SECRET absent : secret éphémère généré pour cette session (dev uniquement).');
}
const SECRET = process.env.JWT_SECRET;
// 🔄 ROTATION SANS DOULEUR (Phase A) : pendant la transition, l'ancienne
// clé reste acceptée en lecture via JWT_SECRET_OLD. Les nouveaux jetons
// sont TOUJOURS signés avec JWT_SECRET. Après 30 jours (durée de vie max
// d'un jeton), retirer JWT_SECRET_OLD : la rotation est terminée.
const SECRET_OLD = process.env.JWT_SECRET_OLD || '';

function sign(user) {
  return jwt.sign({ uid: user.id, role: user.role }, SECRET, { expiresIn: '30d' });
}

/**
 * Vérifie un jeton et renvoie sa charge utile, ou null.
 * Utilisé par requireAuth MAIS AUSSI par le WebSocket (rtc.ws) qui
 * authentifie la connexion /ws?token=…
 */
function verifyToken(token) {
  if (!token) return null;
  try {
    return jwt.verify(token, SECRET);
  } catch {
    if (!SECRET_OLD) return null;
    try {
      return jwt.verify(token, SECRET_OLD); // jeton d'avant la rotation
    } catch {
      return null;
    }
  }
}

function requireAuth(req, res, next) {
  (async () => {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Token manquant', code: 'AUTH' });
    const payload = verifyToken(token);
    if (!payload) return res.status(401).json({ error: 'Token invalide ou expiré', code: 'AUTH' });
    const user = await db.get('SELECT * FROM users WHERE id = ?', [payload.uid]);
    if (!user) return res.status(401).json({ error: 'Utilisateur inconnu', code: 'AUTH' });
    if (user.status === 'blocked') return res.status(403).json({ error: 'Compte bloqué' });
    req.user = user;
    next();
  })().catch(next);
}

/**
 * Authentification FACULTATIVE.
 *
 * Utilisée par les liens de partage : un visiteur non connecté doit pouvoir
 * voir une publication PUBLIQUE (aperçu WhatsApp, page web), mais un membre
 * connecté doit retrouver ses droits habituels (publications de ses contacts…).
 * Sans jeton valide, on continue simplement sans `req.user`.
 */
function optionalAuth(req, res, next) {
  (async () => {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : null;
    if (!token) return next();
    const payload = verifyToken(token);
    if (!payload) return next();
    const user = await db.get('SELECT * FROM users WHERE id = ?', [payload.uid]);
    if (!user || user.status === 'blocked') return next();
    req.user = user;
    next();
  })().catch(next);
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Accès admin requis' });
    next();
  });
}

module.exports = { sign, verifyToken, requireAuth, optionalAuth, requireAdmin };
