/**
 * ============================================================
 *  MBOTE! — Serveur principal (monolithe modulaire)
 *  Modules : auth · wallet · rating · calls · contacts · admin
 * ============================================================
 */
require('dotenv').config();
const express = require('express');
const path = require('path');
const db = require('./db');

const app = express();
app.use(express.json());

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
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ MBOTE! backend démarré sur le port ${PORT}`);
    console.log(`   Base de données : ${db.name}`);
    console.log(`   Console admin   : http://localhost:${PORT}/admin`);
    console.log(`   Mode démo       : ${String(process.env.DEMO_MODE || 'true')}`);
  });
}).catch((e) => {
  console.error('💥 Impossible d\'initialiser la base de données :', e);
  process.exit(1);
});
