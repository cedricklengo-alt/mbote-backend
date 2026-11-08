/**
 * ============================================================
 *  MBOTE! — Serveur principal (monolithe modulaire)
 *  Modules : auth · wallet · rating · calls · contacts · admin · feed
 *           présence · dial-later · invite
 * ============================================================
 */
require('dotenv').config();
const http    = require('http');
const express = require('express');
const path = require('path');
const db = require('./db');
const rtcWs = require('./modules/rtc.ws');

const app = express();

// 🌐 Derrière le répartiteur de charge de l'hébergeur : sans cela, req.ip vaut
// l'IP du répartiteur pour TOUT LE MONDE → un seul quota partagé par tous les
// utilisateurs (et une limitation de débit inopérante).
app.set('trust proxy', 1);

// Corps JSON — 4 Mo : les notes vocales et les pièces jointes voyagent en
// JSON/base64 et dépassent largement la limite par défaut d'Express (100 ko),
// qui renvoyait 413 sur toute note de plus de ~75 ko.
// `verify` conserve le corps BRUT, indispensable à la vérification HMAC-SHA256
// du webhook de paiement (sans lui, la signature ne peut jamais correspondre).
app.use(express.json({
  limit: '4mb',
  verify: (req, _res, buf) => {
    if (req.url && (req.url.includes('/webhook') || req.url.includes('/payments') ||
                    req.url.includes('/api/twilio'))) {
      req.rawBody = buf;
    }
  },
}));

/* 🛡️ En-têtes de sécurité (OWASP MSTG-NETWORK) */
const { rateLimit } = require('./middleware/ratelimit');
const crypto = require('crypto');
app.disable('x-powered-by'); // ne pas révéler la technologie du serveur

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options':    'nosniff',
    'X-Frame-Options':           'DENY',
    'Referrer-Policy':           'no-referrer',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    // API JSON : aucun contenu externe n'est nécessaire (la console admin
    // n'utilise que ses propres ressources).
    'Content-Security-Policy':
      "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
    'X-XSS-Protection':          '1; mode=block',
    'Permissions-Policy':
      'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
  });
  next();
});

// Limite globale anti-inondation : 1200 requêtes/min par compte (ou par IP).
// Volontairement haute : les clients légitimes peuvent synchroniser plusieurs
// écrans en parallèle, mais un script ne peut plus saturer le serveur.
app.use(rateLimit({
  windowMs: 60_000, max: 1200,
  key: (req) => {
    const h = req.headers.authorization;
    return h ? 'tok:' + crypto.createHash('sha1').update(h).digest('hex').slice(0, 16)
             : 'ip:' + req.ip;
  },
}));

// Journal des requêtes (diagnostic) — req.path et non req.url : la query string
// contient des numéros de téléphone, qui n'ont rien à faire dans les journaux.
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
app.use('/api/referral',   require('./modules/referral.routes'));
app.use('/api/payments',   require('./modules/payments.routes')); // webhook agrégateur (public)
app.use('/api/admin',      require('./modules/admin.routes'));
// 🔗 Partage : page publique /p/:id, avec les balises d'aperçu que lisent
// WhatsApp, Facebook et Telegram. Les routes de données publiques
// (`/api/feed/posts/:id/public` et `/share`) vivent dans le module du fil.
app.use(require('./modules/share.routes').r);
app.use('/api/feed',       require('./modules/feed.routes'));
app.use('/api/rank',      require('./modules/feed_ranked.routes')); // v4.1 ranking (additif)
app.use('/api/presence',   require('./modules/presence.routes'));
// 🔎 Recherche universelle (`#hashtag`, `@personne`, texte) et boîte de
// réception des notifications. Deux routeurs distincts : la recherche lit,
// les notifications écrivent.
app.use('/api/search',        require('./modules/search.routes'));
app.use('/api/notifications', require('./modules/notifications.routes'));
app.use('/api/dial-later', require('./modules/dial_later.routes'));

/* ---- Modules présents mais jamais montés (corrigé) ----
 * Ces routeurs existaient dans src/modules/ sans être branchés ici : l'app
 * cliente appelait /api/messages, /api/lokota, /api/shop, /api/packages,
 * /api/airtime, /api/i18n et /api/rtc, qui répondaient donc 404.
 * Conséquences observées : messagerie inopérante, boutique et forfaits
 * inaccessibles, et surtout /api/rtc/ice injoignable — l'app retombait sur
 * son repli STUN, donc aucun relais TURN et des appels qui échouent sur
 * réseau mobile strict. */
app.use('/api/rtc',       require('./modules/rtc.routes'));      // ICE/TURN + ack/decline
const { router: messagesRouter, lokota: konversations } = require('./modules/messages.routes');
app.use('/api/messages',  messagesRouter);    // messagerie texte et vocale
app.use('/api/konversations', konversations); // fils de conversation (depuis messages.routes)
app.use('/api/lokota',    require('./modules/lokota.routes'));   // notes vocales traduites Lokota
app.use('/api/groups',    require('./modules/groups.routes'));   // groupes de discussion
app.use('/api/shop',      require('./modules/shop.routes'));     // boutique et commandes
app.use('/api/packages',  require('./modules/packages.routes')); // forfaits
app.use('/api/airtime',   require('./modules/airtime.routes'));  // crédit téléphonique
app.use('/api/i18n',      require('./modules/i18n.routes'));     // libellés traduits
app.use('/api/sms',       require('./modules/sms.routes'));      // SMS vers GSM (facturés)
app.use('/api/twilio',    require('./modules/twilio.routes'));   // webhooks + supervision fournisseur

// Lien d'invitation magique (Feature B).
//   POST /api/invite                   → créer un lien (authentifié)
//   GET  /api/invite/validate/:token   → valider après installation
//   GET  /invite/:token                → page publique de redirection
// Auparavant monté uniquement sous /invite : les routes documentées
// /api/invite… répondaient 404.
const inviteRoutes = require('./modules/invite.routes');
app.use('/api/invite', inviteRoutes);
app.use('/invite',     inviteRoutes);


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

/**
 * Envoi d'un fichier (photo, vidéo, pièce jointe).
 *
 * 🖼️ Pour une VIDÉO, la miniature est capturée ici, tout de suite, sans que
 * l'application ait à s'en occuper : le fil peut alors afficher un aperçu
 * immédiat au lieu de faire télécharger la vidéo entière à chaque passage. La
 * capture est faite par ffmpeg (voir services/video_thumb.js) ; si aucun
 * décodeur n'est disponible, l'envoi réussit quand même et `thumb_url` vaut
 * null — l'application retombe sur un simple bouton de lecture.
 */
app.post('/api/upload', requireAuth, _upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Aucun fichier valide reçu' });
  const host = process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
  const nom = req.file.filename;

  let thumb = null;
  const estVid = require('./services/video_thumb').estVideo(nom);

  // ── Compression vidéo automatique (économie données RDC) ───────────
  if (estVid) {
    const compress = require('./services/video_compress');
    await compress.compresser(req.file.path);
  }
  // ───────────────────────────────────────────────────────────────────

  if (estVid) {
    const relatif = await require('./services/video_thumb').miniatureDepuisUpload(nom);
    if (relatif) thumb = `${host}${relatif}`;
  }

  res.json({
    url: `${host}/uploads/${nom}`,
    // Toujours présent, éventuellement null : l'application n'a pas à deviner.
    thumb_url: thumb,
    type: require('./services/video_thumb').estVideo(nom) ? 'video' : 'image',
  });
});
app.use('/uploads', require('express').static(uploadsDir));

/* ---- Console admin (web) ---- */
app.use('/admin', express.static(path.join(__dirname, '..', 'public', 'admin')));
// Vignette de marque : image d'aperçu par défaut des liens partagés.
app.use('/assets', express.static(path.join(__dirname, '..', 'public', 'assets')));
app.get('/', (req, res) => res.redirect('/admin'));

/* ---- Santé ---- */
app.get('/api/health', (req, res) => res.json({
  ok: true, service: 'mbote-backend', db: db.name,
  push: require('./services/push').enabled(),
  demo_mode: String(process.env.DEMO_MODE || 'true') === 'true',
  // Commit réellement déployé : Render expose RENDER_GIT_COMMIT. Sans ce champ,
  // impossible de savoir si la production tourne bien le dernier code poussé.
  commit: (process.env.RENDER_GIT_COMMIT || '').slice(0, 7) || null,
  // Projet Firebase utilisé pour les notifications : doit être le MÊME que
  // celui de l'application (android/app/google-services.json → project_id).
  // Sinon FCM répond 404 NOT_FOUND à chaque envoi et l'appelé ne sonne pas.
  fcm_project: require('./services/push').projectId(),
}));

/* ---- Gestion d'erreurs ---- */
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  // Les erreurs 4xx sont des messages MÉTIER destinés à l'utilisateur
  // (« Forfait introuvable », « Commande expirée »…) : on les transmet.
  // Les 5xx restent masquées pour ne jamais exposer une trace interne.
  const msg    = (err.expose || status < 500) ? err.message : 'Erreur interne';
  // Le code métier (SMS_NOT_CONFIGURED, NO_CREDIT…) permet à l'app d'afficher
  // un message utile au lieu d'un texte générique.
  const code   = err.code && typeof err.code === 'string' ? err.code : undefined;
  console.error(`💥 ${req.method} ${req.path} → ${status}`, err.stack || err.message || err);
  res.status(status).json(code ? { error: msg, code } : { error: msg });
});

// 🛟 Une promesse oubliée ne doit JAMAIS faire tomber le serveur
process.on('unhandledRejection', (e) => console.error('💥 Promesse non gérée :', (e && e.message) || e));
process.on('uncaughtException',  (e) => console.error('💥 Exception non gérée :', (e && e.stack) || e));

const PORT = process.env.PORT || 4000;
const server = http.createServer(app);

db.init().then(() => {
  // 🔔 Push : initialisation + purge automatique des jetons FCM périmés.
  // Sans le gestionnaire de jetons invalides, un appareil désinstallé
  // recevait des envois en échec pour toujours.
  const push = require('./services/push');
  // 🧹 Jeton refusé par FCM (404 NOT_FOUND / UNREGISTERED) : on l'efface des
  // DEUX sources. Seule l'ancienne colonne était nettoyée jusqu'ici, alors que
  // l'application enregistre ses jetons dans `device_tokens` : le jeton mort y
  // restait et chaque envoi échouait de nouveau — d'où la répétition de
  // « ⚠️ Envoi push call KO : 404 NOT_FOUND » dans les journaux Render.
  push.setInvalidTokenHandler(async (tk) => {
    await db.run('UPDATE users SET fcm_token = NULL WHERE fcm_token = ?', [tk]);
    await db.run('DELETE FROM device_tokens WHERE token = ?', [tk]);
  });
  push.init();

  // 🧹 Purge périodique des contenus livrés (confidentialité, rétention).
  try { require('./services/retention').start(); } catch (e) { console.error('retention :', e.message); }

  // 🛒 Catalogue boutique : on ne dépend plus du script de démarrage pour le
  // remplir. Sans ça, la production servait une boutique VIDE
  // (`{"packages": []}`) alors que le service tournait normalement.
  // Idempotent : rien n'est fait si le catalogue contient déjà un produit.
  require('./services/shop').ensureCatalog()
    .then((n) => { if (n > 0) console.log(`✅ Catalogue boutique initialisé (${n} forfaits)`); })
    .catch((e) => console.error('catalogue :', e.message));

  // 🧹 FIL DE PUBLICATIONS : harmonisation des données héritées.
  // Une visibilité écrite « communauté » (accentuée) ou dans une autre forme
  // Unicode ne correspondait à aucune comparaison SQL → publication invisible
  // pour tout le monde, sauf son auteur. On ramène ces valeurs à leur forme
  // canonique, et on récupère les mots-clés des publications antérieures.
  // Idempotent, non bloquant : un fil à ranger ne retarde pas le démarrage.
  // Identifiants publics (@pseudo) : un compte sans identifiant ne peut pas
  // être mentionné. L'attribution est idempotente et sans effet si tout le
  // monde en a déjà un.
  // (Promise : le bloc de démarrage est synchrone, on n'attend pas ici.)
  require('./services/social').attribuerHandles()
    .catch((e) => console.error('Identifiants publics :', e.message));
  require('./services/feed_migration').harmoniserFil()
    .then((r) => { if (!r) console.log('🧹 Fil : harmonisation partielle, on continue.'); })
    .catch((e) => console.error('fil :', e.message));

  // 🖼️ Miniatures des vidéos déjà publiées : capture différée, bornée, et
  // seulement si un décodeur existe. Une miniature manquante n'est jamais une
  // raison de retarder l'ouverture du service.
  setTimeout(() => {
    require('./services/feed_migration').rattraperMiniatures()
      .then((r) => {
        if (r && r.generees) console.log(`🖼️  Miniatures rattrapées : ${r.generees}/${r.posts} vidéo(s).`);
      })
      .catch((e) => console.error('miniatures :', e.message));
  }, 8000);

  rtcWs.init(server);           // ← WebSocket RTC (appels + présence + groupes)
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ MBOTE! backend démarré sur le port ${PORT}`);
    console.log(`   Base de données : ${db.name}`);
    console.log(`   Console admin   : http://localhost:${PORT}/admin`);
    console.log(`   Mode démo       : ${String(process.env.DEMO_MODE || 'true')}`);
    // Sans relais TURN, un appel entre deux téléphones sur réseau mobile ne
    // peut pas aboutir : autant le dire clairement dans les journaux.
    console.log(`   ${require('./services/ice').startupNotice()}`);
    console.log(`   ${require('./services/video_thumb').startupNotice()}`);
  });
}).catch((e) => {
  console.error('💥 Impossible d\'initialiser la base de données :', e);
  process.exit(1);
});
