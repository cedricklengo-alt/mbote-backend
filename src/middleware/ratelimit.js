/**
 * 🛡️ Limiteur de débit (anti-abus) — en mémoire, zéro dépendance.
 *
 * Protège les routes sensibles contre les attaques par force brute et
 * l'inondation de requêtes :
 *   - demandes de code OTP répétées (SMS bombing / devinette de compte)
 *   - essais de codes OTP en rafale (force brute)
 *   - inondation générale de l'API
 *
 * Usage : rateLimit({ windowMs, max, key: (req) => '...', message })
 * Renvoie 429 + message clair quand la limite est dépassée.
 */

const buckets = new Map(); // clé → { n, reset }

function rateLimit({ windowMs, max, key, message }) {
  return (req, res, next) => {
    let k;
    try {
      k = (key ? key(req) : req.ip || 'ip?') + `|${windowMs}|${max}`;
    } catch (_) {
      k = `${req.ip}|${windowMs}|${max}`;
    }
    const t = Date.now();
    let b = buckets.get(k);
    if (!b || t > b.reset) {
      b = { n: 0, reset: t + windowMs };
      buckets.set(k, b);
    }
    b.n++;
    if (b.n > max) {
      return res.status(429).json({
        error: message || 'Trop de tentatives — patiente quelques minutes puis réessaie',
        code: 'RATE_LIMIT',
      });
    }
    next();
  };
}

// 🧹 Nettoyage des compteurs expirés (toutes les minutes)
setInterval(() => {
  const t = Date.now();
  for (const [k, b] of buckets) if (t > b.reset) buckets.delete(k);
}, 60_000).unref();

module.exports = { rateLimit };
