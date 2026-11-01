/**
 * ============================================================
 *  MBOTE! — Serveur principal (monolithe modulaire)
 *  Modules : auth · wallet · rating · calls · contacts · admin · feed · rtc
 * ============================================================
 */
require('dotenv').config();
const http    = require('http');
const express = require('express');
const path    = require('path');
const db      = require('./db');
const rtcWs   = require('./modules/rtc.ws');

const app = express();
app.use(express.json({
  limit: '12mb',
  verify: (req, _res, buffer) => { req.rawBody = Buffer.from(buffer); },
}));

// Journal des requêtes (diagnostic)
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
app.use('/api/payments', require('./modules/payments.routes')); // webhook agrégateur (public)
app.use('/api/admin',    require('./modules/admin.routes'));
app.use('/api/feed',     require('./modules/feed.routes'));
app.use('/api/rtc',      require('./modules/rtc.routes'));      // ICE servers + config WebRTC
app.use('/api/packages', require('./modules/packages.routes'));
app.use('/api/airtime',  require('./modules/airtime.routes'));
app.use('/api/i18n',     require('./modules/i18n.routes'));
app.use('/api/shop',     require('./modules/shop.routes'));
const messageRoutes = require('./modules/messages.routes');
app.use('/api/messages', messageRoutes.router);
app.use('/api/lokota',   messageRoutes.lokota);

/* ---- Upload média (photos / clips) ---- */
const { requireAuth } = require('./middleware/auth');
const multer           = require('multer');
const fs               = require('fs');
const uploadsDir       = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const _multerStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = require('path').extname(file.originalname).toLowerCase() || '.bin';
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  },
});
const _upload = multer({
  storage: _multerStorage,
  limits: { fileSize: 20 * 1024 * 1024 },          // 20 MB
  fileFilter: (req, file, cb) => {
    const ok = /^(image\/(jpeg|png|gif|webp)|video\/(mp4|quicktime|x-msvideo))$/.test(file.mimetype);
    cb(null, ok);
  },
});

app.post('/api/upload', requireAuth, _upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Aucun fichier valide reçu' });
  const host = process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
  res.json({ url: `${host}/uploads/${req.file.filename}` });
});
app.use('/uploads', require('express').static(uploadsDir));

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
  const status = Number(err.status);
  if (!status || status >= 500) console.error('💥', err);
  res.status(status >= 400 && status < 500 ? status : 500).json({
    error: status >= 400 && status < 500 ? err.message : 'Erreur interne',
  });
});

/* ---- Démarrage ---- */
const PORT = process.env.PORT || 4000;
const server = http.createServer(app);

db.init().then(() => {
  // Attacher le serveur WebSocket après l'init DB
  rtcWs.init(server);

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ MBOTE! backend démarré sur le port ${PORT}`);
    console.log(`   Base de données : ${db.name}`);
    console.log(`   Console admin   : http://localhost:${PORT}/admin`);
    console.log(`   WebSocket RTC   : ws://localhost:${PORT}/ws`);
    console.log(`   Mode démo       : ${String(process.env.DEMO_MODE || 'true')}`);
  });
}).catch((e) => {
  console.error('💥 Impossible d\'initialiser la base de données :', e);
  process.exit(1);
});
