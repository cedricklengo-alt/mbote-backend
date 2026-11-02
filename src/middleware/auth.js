const jwt = require('jsonwebtoken');
const db = require('../db');

const SECRET = process.env.JWT_SECRET || 'dev-secret';
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

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Accès admin requis' });
    next();
  });
}

module.exports = { sign, verifyToken, requireAuth, requireAdmin };
