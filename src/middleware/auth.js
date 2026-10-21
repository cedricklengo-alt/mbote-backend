const jwt = require('jsonwebtoken');
const db = require('../db');

const SECRET = process.env.JWT_SECRET || 'dev-secret';

function sign(user) {
  return jwt.sign({ uid: user.id, role: user.role }, SECRET, { expiresIn: '30d' });
}

function requireAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Token manquant' });
  try {
    const payload = jwt.verify(token, SECRET);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.uid);
    if (!user) return res.status(401).json({ error: 'Utilisateur inconnu' });
    if (user.status === 'blocked') return res.status(403).json({ error: 'Compte bloqué' });
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: 'Token invalide ou expiré' });
  }
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Accès admin requis' });
    next();
  });
}

module.exports = { sign, requireAuth, requireAdmin };
