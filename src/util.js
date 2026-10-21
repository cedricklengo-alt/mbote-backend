const crypto = require('crypto');

const uid = (p) => p + '_' + crypto.randomBytes(8).toString('hex');
const now = () => Date.now();

// Hash de mot de passe sans dépendance externe (scrypt natif de Node)
function hashPassword(pwd) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pwd, salt, 32).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(pwd, stored) {
  if (!stored) return false;
  const [salt, hash] = stored.split(':');
  const h = crypto.scryptSync(pwd, salt, 32).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(h), Buffer.from(hash));
}

// Normalise un numéro au format E.164 : "+243 81-234" -> "+24381234"
function normalizePhone(p) {
  if (!p) return null;
  const clean = String(p).replace(/[\s.\-()]/g, '');
  return /^\+\d{8,15}$/.test(clean) ? clean : null;
}

// Coût d'un appel : arrondi au centime supérieur (facturation à la seconde)
const costFor = (sec, pricePerMinCents) => Math.ceil((sec * pricePerMinCents) / 60);

module.exports = { uid, now, hashPassword, verifyPassword, normalizePhone, costFor };
