/**
 * ============================================================
 *  MboteCall — Serveur principal (monolithe modulaire)
 *  Modules : auth · wallet · rating · calls · contacts · admin
 * ============================================================
 */
require('dotenv').config();
const express = require('express');
const path = require('path');
const db = require('./db');

const app = express();
app.use(express.json({ limit: '500kb' })); // 500 kb : photos de profil compressées

/* 🛡️ Sécurité — en-têtes de protection navigateur + limite globale anti-inondation */
const { rateLimit } = require('./middleware/ratelimit');
app.disable('x-powered-by'); // ne pas révéler la technologie du serveur
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  });
  next();
});
app.use(rateLimit({ windowMs: 60_000, max: 300 })); // 300 req/min par adresse

// Journal des requêtes (diagnostic)
app.use((req, res, next) => {
  console.log(`➡️  ${req.method} ${req.url}`);
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
app.use('/api/auth', require('./modules/auth.routes'));
app.use('/api/wallet', require('./modules/wallet.routes'));
app.use('/api/rates', require('./modules/rating.routes').router);
app.use('/api/calls', require('./modules/calls.routes'));
app.use('/api/contacts', require('./modules/contacts.routes'));
app.use('/api/referral', require('./modules/referral.routes'));
app.use('/api/packages', require('./modules/packages.routes'));
app.use('/api/airtime', require('./modules/airtime.routes'));
app.use('/api/i18n', require('./modules/i18n.routes')); // 🗣️ langues téléchargeables (public)
app.use('/api/lokota', require('./modules/lokota.routes')); // 🗣️ notes vocales traduites (LOKOTA 1)
app.use('/api/messages', require('./modules/messages.routes')); // 💬 v2.0 messagerie traduite
app.use('/api/rtc', require('./modules/rtc.routes')); // 📡 config ICE (TURN côté serveur — Phase A)
app.use('/api/payments', require('./modules/payments.routes')); // webhook agrégateur (public)
app.use('/api/admin', require('./modules/admin.routes'));

/* ---- Console admin (web) ---- */
app.use('/admin', express.static(path.join(__dirname, '..', 'public', 'admin')));
app.get('/', (req, res) => res.redirect('/admin'));

/* ---- Santé ---- */
app.get('/api/health', (req, res) => res.json({
  ok: true, service: 'mbote-backend', db: db.name,
  demo_mode: String(process.env.DEMO_MODE || 'true') === 'true',
}));

/* ---- Gestion d'erreurs ---- */
app.use((err, req, res, next) => {
  console.error('💥', err);
  res.status(500).json({ error: 'Erreur interne' });
});

const PORT = process.env.PORT || 4000;
db.init().then(() => {
  const http = require('http');
  const server = http.createServer(app);
  require('./services/push').init(); // 🔔 notifications d'appel (Firebase)
  require('./modules/rtc.ws').init(server); // 🎙️ appels voix temps réel
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
