/**
 * Routes BOUTIQUE — /api/shop
 *
 * Endpoints publics (authentification requise) :
 *   GET  /api/shop/catalog              → liste des forfaits actifs
 *   POST /api/shop/orders               → créer une commande (prix figé)
 *   POST /api/shop/orders/:id/pay       → initier le paiement
 *   GET  /api/shop/orders/:id/status    → état de la commande + paiement
 *   GET  /api/shop/my-plans             → mes forfaits actifs
 *   GET  /api/shop/my-plans/all         → tous mes forfaits (historique)
 *   POST /api/shop/webhook              → callback FlexPay (public, HMAC vérifié)
 *
 * Admin (requireAdmin) :
 *   GET  /api/shop/admin/packages       → liste complète (inactifs inclus)
 *   POST /api/shop/admin/packages       → créer un forfait
 *   PUT  /api/shop/admin/packages/:id   → modifier un forfait
 *   GET  /api/shop/admin/orders         → toutes les commandes
 *   GET  /api/shop/admin/payments       → tous les paiements
 *
 * SÉCURITÉ :
 *   - Signature du webhook vérifiée via HMAC-SHA256 ou Bearer token
 *   - Montant confirmé comparé au centime près (± AMOUNT_TOLERANCE_CENTS)
 *   - Jamais de crédit sur simple retour d'URL
 *   - Rate limit : 5 commandes / 10 min / utilisateur
 */
const crypto  = require('crypto');
const express = require('express');
const db      = require('../db');
const { uid, now, ah } = require('../util');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { rateLimit } = require('../middleware/ratelimit');
const shop    = require('../services/shop');

const router  = express.Router();

// ── Webhook FlexPay — VÉRIFICATION DE SIGNATURE ──────────────────────────────

/**
 * Vérifie la signature du webhook FlexPay.
 * Supporte deux modes (selon la configuration du compte marchand) :
 *   1. Bearer token simple → Authorization: Bearer <FLEXPAY_WEBHOOK_SECRET>
 *   2. HMAC-SHA256          → X-FlexPay-Signature: <hmac_hex> (corps brut requis)
 *
 * Si FLEXPAY_WEBHOOK_SECRET n'est pas défini → accepte avec avertissement
 * (en développement uniquement — toujours définir en production).
 */
function verifyFlexPayWebhook(req) {
  const secret = process.env.FLEXPAY_WEBHOOK_SECRET;
  if (!secret) {
    console.warn('⚠️  FLEXPAY_WEBHOOK_SECRET non défini — webhook accepté sans vérification');
    return true;
  }

  // Mode Bearer
  const authHeader = req.headers['authorization'] || '';
  if (authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    try {
      return crypto.timingSafeEqual(
        Buffer.from(token, 'utf8'),
        Buffer.from(secret, 'utf8')
      );
    } catch { return false; }
  }

  // Mode HMAC-SHA256
  const sig = req.headers['x-flexpay-signature'];
  if (sig && req.rawBody) {
    const expected = crypto
      .createHmac('sha256', secret)
      .update(req.rawBody)
      .digest('hex');
    try {
      return crypto.timingSafeEqual(
        Buffer.from(sig,      'hex'),
        Buffer.from(expected, 'hex')
      );
    } catch { return false; }
  }

  // Aucun mécanisme trouvé : refuser
  return false;
}

// ── Rate limit commandes (anti-abus) ─────────────────────────────────────────
const orderRateLimit = rateLimit({
  windowMs: 10 * 60_000, // 10 minutes
  max: 5,                 // 5 commandes max par utilisateur
  key: (req) => 'shop-order:' + (req.user?.id || req.ip),
  message: 'Trop de commandes — réessayez dans quelques minutes.',
});

// Méthodes de paiement autorisées (doit correspondre au provider FlexPay configuré)
const ALLOWED_METHODS = ['mpesa', 'orange', 'airtel', 'card'];

// ── Catalogue (public + authentifié) ─────────────────────────────────────────

router.get('/catalog', requireAuth, ah(async (req, res) => {
  const catalog = await shop.listCatalog();
  res.json({ packages: catalog });
}));

// ── Commandes ─────────────────────────────────────────────────────────────────

router.post('/orders', requireAuth, orderRateLimit, ah(async (req, res) => {
  const { package_id } = req.body;
  if (!package_id) return res.status(400).json({ error: 'package_id requis' });

  const order = await shop.createOrder(req.user.id, package_id);
  res.status(201).json({ order });
}));

router.get('/orders/:id/status', requireAuth, ah(async (req, res) => {
  const order = await db.get(`SELECT * FROM shop_orders WHERE id=? AND user_id=?`,
    [req.params.id, req.user.id]);
  if (!order) return res.status(404).json({ error: 'Commande introuvable' });

  const pay = await db.get(
    `SELECT id, method, status, created_at, updated_at FROM shop_payments
     WHERE order_id=? ORDER BY created_at DESC LIMIT 1`,
    [order.id]
  );

  res.json({ order, payment: pay || null });
}));

// ── Paiement ──────────────────────────────────────────────────────────────────

router.post('/orders/:id/pay', requireAuth, ah(async (req, res) => {
  const { method, phone } = req.body;
  if (!method) return res.status(400).json({ error: 'method requis' });
  if (!ALLOWED_METHODS.includes(method)) {
    return res.status(400).json({
      error: `Moyen de paiement invalide. Valeurs acceptées : ${ALLOWED_METHODS.join(', ')}`,
    });
  }
  if (method !== 'card' && !phone) {
    return res.status(400).json({ error: 'phone requis pour Mobile Money' });
  }

  // Vérifier que la commande appartient à cet utilisateur
  const order = await db.get(`SELECT * FROM shop_orders WHERE id=? AND user_id=?`,
    [req.params.id, req.user.id]);
  if (!order) return res.status(404).json({ error: 'Commande introuvable' });

  const payment = await shop.createShopPayment(order.id, method, phone);
  res.status(201).json({ payment });
}));

// Polling du statut du paiement (l'app interroge pendant l'attente Mobile Money)
router.get('/orders/:id/pay/status', requireAuth, ah(async (req, res) => {
  const pay = await db.get(
    `SELECT sp.* FROM shop_payments sp
     INNER JOIN shop_orders so ON so.id = sp.order_id
     WHERE so.id=? AND so.user_id=?
     ORDER BY sp.created_at DESC LIMIT 1`,
    [req.params.id, req.user.id]
  );
  if (!pay) return res.status(404).json({ error: 'Paiement introuvable' });

  // Polling actif si en attente
  if (pay.status === 'pending') {
    const state = await shop.pollAndActivate(pay);
    return res.json({ status: state });
  }
  res.json({ status: pay.status });
}));

// ── Mes plans ─────────────────────────────────────────────────────────────────

router.get('/my-plans', requireAuth, ah(async (req, res) => {
  const plans = await shop.userActivePlans(req.user.id);
  res.json({ plans });
}));

router.get('/my-plans/all', requireAuth, ah(async (req, res) => {
  const plans = await shop.userAllPlans(req.user.id);
  res.json({ plans });
}));

// ── Webhook FlexPay (public — ne nécessite PAS d'authentification JWT) ───────

router.post('/webhook', ah(async (req, res) => {
  // Répondre 200 immédiatement (Twilio / FlexPay exigent une réponse rapide)
  // Le traitement se fait de manière asynchrone en cas de délai
  res.sendStatus(200);

  // Vérification de la signature
  if (!verifyFlexPayWebhook(req)) {
    console.warn('⚠️  Webhook boutique rejeté : signature invalide');
    return;
  }

  const body = req.body || {};
  console.log('📦 Webhook boutique reçu :', JSON.stringify(body));

  // Identifier le paiement par sa référence marchande
  const reference = body.reference || body.orderNumber || body.order_number;
  if (!reference) {
    console.warn('⚠️  Webhook boutique sans référence — ignoré');
    return;
  }

  const pay = await db.get(
    `SELECT * FROM shop_payments WHERE reference=? OR order_number=?`,
    [reference, reference]
  ).catch(() => null);

  if (!pay) {
    console.warn(`⚠️  Aucun paiement trouvé pour la référence ${reference}`);
    return;
  }

  if (pay.status !== 'pending') {
    console.log(`ℹ️  Paiement ${pay.id} déjà traité (${pay.status}) — webhook ignoré`);
    return;
  }

  // Toujours vérifier via l'API fournisseur, ne jamais croire le webhook seul
  const confirmedAmount = body.amount
    ? Math.round(parseFloat(body.amount) * 100)
    : null;

  await shop.pollAndActivate(pay).catch((e) =>
    console.error('💥 Erreur activation webhook boutique :', e.message)
  );
}));

// ── Administration ────────────────────────────────────────────────────────────

// Liste complète du catalogue (admin)
router.get('/admin/packages', requireAdmin, ah(async (req, res) => {
  const rows = await db.all(`SELECT * FROM shop_packages ORDER BY sort_order ASC, id ASC`);
  res.json({ packages: rows });
}));

// Créer un forfait
router.post('/admin/packages', requireAdmin, ah(async (req, res) => {
  const {
    name, description = '', price_cents, currency = 'USD',
    minutes = 0, sms_count = 0, days = 30,
    prefix = '', category = 'credit', conditions = '',
    renewable = false, sort_order = 0,
  } = req.body;

  if (!name || price_cents == null || price_cents < 0) {
    return res.status(400).json({ error: 'name et price_cents (≥ 0) sont requis' });
  }

  const id = now(); // timestamp comme id entier
  await db.run(
    `INSERT INTO shop_packages
       (id, name, description, price_cents, currency, minutes, sms_count, days,
        prefix, category, conditions, renewable, sort_order, active, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    [id, name, description, price_cents, currency, minutes, sms_count, days,
     prefix, category, conditions, renewable ? 1 : 0, sort_order, now()]
  );
  res.status(201).json({ id, message: 'Forfait créé' });
}));

// Modifier un forfait
router.put('/admin/packages/:id', requireAdmin, ah(async (req, res) => {
  const pkg = await db.get(`SELECT * FROM shop_packages WHERE id=?`, [req.params.id]);
  if (!pkg) return res.status(404).json({ error: 'Forfait introuvable' });

  const fields = ['name','description','price_cents','currency','minutes','sms_count',
                  'days','prefix','category','conditions','renewable','sort_order','active'];
  const updates = [];
  const vals    = [];
  for (const f of fields) {
    if (req.body[f] !== undefined) {
      updates.push(`${f}=?`);
      vals.push(f === 'renewable' || f === 'active' ? (req.body[f] ? 1 : 0) : req.body[f]);
    }
  }
  if (!updates.length) return res.status(400).json({ error: 'Aucun champ à modifier' });
  vals.push(now(), req.params.id);
  await db.run(`UPDATE shop_packages SET ${updates.join(',')}, updated_at=? WHERE id=?`, vals);
  res.json({ message: 'Forfait mis à jour' });
}));

// Commandes (admin)
router.get('/admin/orders', requireAdmin, ah(async (req, res) => {
  const { status, limit = 50, offset = 0 } = req.query;
  const where = status ? 'WHERE o.status=?' : '';
  const params = status ? [status, limit, offset] : [limit, offset];
  const orders = await db.all(
    `SELECT o.*, u.name as user_name, u.phone as user_phone
     FROM shop_orders o
     LEFT JOIN users u ON u.id = o.user_id
     ${where}
     ORDER BY o.created_at DESC
     LIMIT ? OFFSET ?`,
    params
  );
  res.json({ orders });
}));

// Paiements (admin)
router.get('/admin/payments', requireAdmin, ah(async (req, res) => {
  const { status, limit = 50, offset = 0 } = req.query;
  const where = status ? 'WHERE sp.status=?' : '';
  const params = status ? [status, limit, offset] : [limit, offset];
  const payments = await db.all(
    `SELECT sp.*, u.name as user_name
     FROM shop_payments sp
     LEFT JOIN users u ON u.id = sp.user_id
     ${where}
     ORDER BY sp.created_at DESC
     LIMIT ? OFFSET ?`,
    params
  );
  res.json({ payments });
}));

module.exports = router;
