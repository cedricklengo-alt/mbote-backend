/**
 * ============================================================
 *  MboteCall — Serveur principal (monolithe modulaire)
 *  Modules : auth · wallet · rating · calls · contacts · admin
 *
 *  SÉCURITÉ (v3.4 — correctifs OWASP MASVS) :
 *   B5 : rawBody capturé pour vérification HMAC des webhooks
 *   B6 : en-têtes de sécurité complets (CSP, X-XSS-Protection, Permissions-Policy)
 *   B7 : journaux expurgés — req.path uniquement (no query string avec numéros de téléphone)
 * ============================================================
 */
require('dotenv').config();
const express = require('express');
const path    = require('path');
const crypto  = require('crypto');
const db      = require('./db');

const app = express();

// 🌐 Derrière le répartiteur de charge Render : sans ceci, req.ip = l'IP du
// répartiteur pour TOUT LE MONDE → un seul quota partagé par tous les utilisateurs.
app.set('trust proxy', 1);

// ── B5 : capturer rawBody pour la vérification HMAC des webhooks ─────────────
// Le middleware JSON standard ne conserve pas le corps brut ; le webhook FlexPay
// utilise HMAC-SHA256 sur le corps brut. Sans ceci, la signature ne peut jamais
// correspondre et on revient au mode Bearer-token uniquement.
app.use(
  express.json({
    limit: '1mb',          // photos / notes vocales compressées
    verify: (req, _res, buf) => {
      // rawBody est injecté uniquement pour les routes webhook
      if (req.url && (req.url.includes('/webhook') || req.url.includes('/payments'))) {
        req.rawBody = buf;
      }
    },
  })
);

/* 🛡️ B6 : En-têtes de sécurité complets (MSTG-NETWORK-3) ──────────────────
 * Les en-têtes manquants dans la version précédente :
 *   - Content-Security-Policy  → bloque l'injection de scripts dans la console admin HTML
 *   - X-XSS-Protection         → protection XSS héritée pour IE/Edge anciens
 *   - Permissions-Policy       → désactive les API sensibles inutiles pour une API JSON
 */
const { rateLimit } = require('./middleware/ratelimit');
app.disable('x-powered-by'); // ne pas révéler la technologie du serveur

app.use((req, res, next) => {
  res.set({
    // ── Déjà présents v3.3 ──────────────────────────────────────────────────
    'X-Content-Type-Options':    'nosniff',
    'X-Frame-Options':           'DENY',
    'Referrer-Policy':           'no-referrer',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',

    // ── Ajouts B6 ────────────────────────────────────────────────────────────
    // CSP : API pure JSON — aucun script externe autorisé, sauf la console admin
    // qui ne charge que ses propres assets (inline styles/scripts autorisés via 'self')
    'Content-Security-Policy':
      "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",

    // Compatibilité XSS pour navigateurs anciens
    'X-XSS-Protection':          '1; mode=block',

    // Désactive les API sensibles inutiles pour cette app (micr, géoloc, caméra…)
    'Permissions-Policy':
      'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
  });
  next();
});

// Limite globale anti-inondation : 300 req/min par utilisateur (token) ou par IP
app.use(rateLimit({
  windowMs: 60_000, max: 300,
  key: (req) => {
    const h = req.headers.authorization;
    return h ? 'tok:' + crypto.createHash('sha1').update(h).digest('hex').slice(0, 16)
             : 'ip:' + req.ip;
  },
}));

// ── B7 : Journal assaini — path uniquement, jamais req.url ───────────────────
// req.url contient la query string complète, p. ex. ?phone=+243812345678.
// Un journal d'accès ou une remontée Sentry ne doit pas exposer des numéros
// de téléphone (données personnelles) en clair.
app.use((req, res, next) => {
  console.log(`➡️  ${req.method} ${req.path}`);
  next();
});

// CORS simple (l'app Flutter appelle depuis un autre host)
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

/* ---- Modules métier ---- */
app.use('/api/auth',     require('./modules/auth.routes'));
app.use('/api/wallet',   require('./modules/wallet.routes'));
app.use('/api/rates',    require('./modules/rating.routes').router);
app.use('/api/calls',    require('./modules/calls.routes'));
app.use('/api/contacts', require('./modules/contacts.routes'));
app.use('/api/referral', require('./modules/referral.routes'));
app.use('/api/packages', require('./modules/packages.routes'));
app.use('/api/airtime',  require('./modules/airtime.routes'));
app.use('/api/i18n',     require('./modules/i18n.routes'));
app.use('/api/lokota',   require('./modules/lokota.routes'));
app.use('/api/messages', require('./modules/messages.routes'));
app.use('/api/rtc',      require('./modules/rtc.routes'));
app.use('/api/payments', require('./modules/payments.routes'));
app.use('/api/shop',     require('./modules/shop.routes'));
app.use('/api/admin',    require('./modules/admin.routes'));
app.use('/api/feed',     require('./modules/feed.routes'));  // v3.2

/* ---- Console admin (web) ---- */
app.use('/admin', express.static(path.join(__dirname, '..', 'public', 'admin')));
app.get('/', (req, res) => res.redirect('/admin'));

/* ---- Santé ---- */
app.get('/api/health', (req, res) => res.json({
  ok: true, service: 'mbote-backend', db: db.name,
  push: require('./services/push').enabled(),
  demo_mode: String(process.env.DEMO_MODE || 'true') === 'true',
}));

/* ---- Gestion d'erreurs ---- */
app.use((err, req, res, _next) => {
  // Ne jamais exposer le stack trace en production
  console.error('💥', err && err.stack || err);
  res.status(500).json({ error: 'Erreur interne' });
});

// 🛟 Une promesse oubliée ne doit JAMAIS faire tomber le serveur
process.on('unhandledRejection', (e) => console.error('💥 Promesse non gérée :', e && e.message || e));
process.on('uncaughtException',  (e) => console.error('💥 Exception non gérée :', e && e.stack  || e));

const PORT = process.env.PORT || 4000;
db.init().then(() => {
  const http   = require('http');
  const server = http.createServer(app);
  const push   = require('./services/push');
  push.setInvalidTokenHandler((tk) =>
    db.run('UPDATE users SET fcm_token = NULL WHERE fcm_token = ?', [tk]));
  push.init();
  require('./modules/rtc.ws').init(server);
  require('./services/retention').start();
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ MboteCall backend démarré sur le port ${PORT}`);
    console.log(`   Base de données : ${db.name}`);
    console.log(`   Console admin   : http://localhost:${PORT}/admin`);
    console.log(`   Mode démo       : ${String(process.env.DEMO_MODE || 'true')}`);
  });
}).catch((e) => {
  console.error('💥 Impossible d\'initialiser la base de données :', e);
  process.exit(1);
});
