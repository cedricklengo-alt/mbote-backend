const jwt = require('jsonwebtoken');
const db  = require('../db');

// ── B1 SÉCURITÉ : JWT_SECRET OBLIGATOIRE EN PRODUCTION ───────────────────
// Si JWT_SECRET n'est pas défini et que DEMO_MODE est désactivé, le serveur
// refuse de démarrer. Un secret par défaut connu permettrait de forger des
// JWT pour n'importe quel compte.
const DEMO = () => String(process.env.DEMO_MODE || 'true') === 'true';

function _getSecret() {
  const s = process.env.JWT_SECRET;
  if (!s || s.length < 32) {
    if (!DEMO()) {
      console.error('💥 FATAL: JWT_SECRET doit être défini et faire ≥ 32 caractères en production.');
      process.exit(1);
    }
    console.warn('⚠️  JWT_SECRET non défini — utilisation du secret de développement (DÉMO uniquement).');
    return 'mbote-dev-secret-do-not-use-in-prod-v1';
  }
  return s;
}

const SECRET     = _getSecret();
// 🔄 ROTATION : l'ancienne clé reste acceptée en lecture 30 jours.
const SECRET_OLD = process.env.JWT_SECRET_OLD || '';

function sign(user) {
  return jwt.sign({ uid: user.id, role: user.role }, SECRET, { expiresIn: '30d' });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, SECRET);
  } catch {
    if (!SECRET_OLD) return null;
    try { return jwt.verify(token, SECRET_OLD); } catch { return null; }
  }
}

function requireAuth(req, res, next) {
  (async () => {
    const h     = req.headers.authorization || '';
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
