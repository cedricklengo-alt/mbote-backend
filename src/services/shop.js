/**
 * Service BOUTIQUE — gestion des forfaits catalogue, commandes, paiements FlexPay,
 * activation des droits utilisateur et consommation au fil des appels/SMS.
 *
 * GARANTIES :
 *   - Idempotence : un callback répété n'active jamais deux fois le même forfait
 *   - Atomicité   : activation dans db.tx() — tout ou rien
 *   - Sécurité    : le montant confirmé est comparé au centime près (± AMOUNT_TOLERANCE_CENTS)
 *   - Isolation   : ne confond jamais un portefeuille monétaire et un quota de forfait
 */
const db = require('../db');
const { uid, now } = require('../util');
const { getPayProvider } = require('../providers/payments');

// ── Constantes ────────────────────────────────────────────────────────────────
/** Tolérance d'arrondi en centimes (ex : FlexPay arrondit parfois à 2 décimales). */
const AMOUNT_TOLERANCE_CENTS = 1;

// ── Catalogue public ──────────────────────────────────────────────────────────

/**
 * Retourne la version publique d'un forfait (filtre les champs internes).
 * @param {object} p - ligne brute de la table shop_packages
 */
function publicPackage(p) {
  return {
    id:           p.id,
    name:         p.name,
    description:  p.description || '',
    price_cents:  p.price_cents,
    currency:     p.currency || 'USD',
    minutes:      p.minutes,
    sms_count:    p.sms_count || 0,
    days:         p.days,
    prefix:       p.prefix || '',
    category:     p.category || 'credit',
    conditions:   p.conditions || '',
    renewable:    p.renewable === 1,
    active:       p.active === 1,
    sort_order:   p.sort_order || 0,
  };
}

/** Liste les forfaits actifs du catalogue. */
/**
 * Crée les deux forfaits par défaut SI le catalogue est vide.
 *
 * Pourquoi ici et pas seulement dans le script de démarrage : la production
 * (Render) sert l'API avec un catalogue VIDE — `GET /api/shop/catalog`
 * répondait `{"packages": []}` et la boutique n'affichait aucun produit. Le
 * remplissage dépendait du script `src/seed.js`, dont l'exécution au démarrage
 * n'est pas garantie selon la commande configurée côté hébergeur.
 *
 * Idempotent : aucun effet si le catalogue contient déjà quelque chose, donc
 * jamais de doublon et jamais de produit imposé à un vrai catalogue.
 * @returns {Promise<number>} nombre de forfaits créés (0 si rien à faire)
 */
async function ensureCatalog() {
  const n = await db.get('SELECT COUNT(*) n FROM shop_packages');
  if (Number(n && n.n) > 0) return 0;
  const created = now();
  const forfaits = [
    ['Pack RDC 100 minutes', 'Appels vers la RDC · valable 30 jours', 700, 100, 30, 1],
    ['Pass RDC Illimité 30 jours', 'Appels vers la RDC · valable 30 jours', 1500, 0, 30, 2],
  ];
  for (const [name, description, price, minutes, days, sortOrder] of forfaits) {
    await db.run(
      `INSERT INTO shop_packages
       (name,description,price_cents,currency,minutes,days,prefix,category,sort_order,created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?)`,
      [name, description, price, 'USD', minutes, days, '243', 'minutes', sortOrder, created]
    );
  }
  return forfaits.length;
}

async function listCatalog() {
  const rows = await db.all(
    `SELECT * FROM shop_packages WHERE active = 1 ORDER BY sort_order ASC, price_cents ASC`
  );
  return rows.map(publicPackage);
}

/** Retourne un forfait actif par son id. */
async function getPackage(id) {
  return db.get(`SELECT * FROM shop_packages WHERE id = ? AND active = 1`, [id]);
}

// ── Commandes ─────────────────────────────────────────────────────────────────

/**
 * Crée une commande verrouillée (prix figé à l'instant T).
 * Ne déclenche PAS encore le paiement.
 */
async function createOrder(userId, packageId) {
  const pkg = await getPackage(packageId);
  if (!pkg) throw Object.assign(new Error('Forfait introuvable ou inactif'), { status: 404 });

  const orderId = uid('ord');
  const expiresAt = now() + 30 * 60 * 1000; // commande valide 30 min

  await db.run(
    `INSERT INTO shop_orders
       (id, user_id, package_id, package_name, package_snapshot,
        amount_cents, currency, status, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    [
      orderId,
      userId,
      pkg.id,
      pkg.name,
      JSON.stringify(publicPackage(pkg)),
      pkg.price_cents,
      pkg.currency || 'USD',
      now(),
      expiresAt,
    ]
  );
  return db.get(`SELECT * FROM shop_orders WHERE id = ?`, [orderId]);
}

// ── Paiements ─────────────────────────────────────────────────────────────────

/**
 * Crée un enregistrement de paiement boutique et déclenche le USSD Push / carte.
 * @param {string} orderId
 * @param {string} method   - 'mpesa' | 'orange' | 'airtel' | 'card'
 * @param {string} [phone]  - numéro Mobile Money (requis sauf carte)
 */
async function createShopPayment(orderId, method, phone) {
  const order = await db.get(`SELECT * FROM shop_orders WHERE id = ?`, [orderId]);
  if (!order) throw Object.assign(new Error('Commande introuvable'), { status: 404 });
  if (order.status !== 'pending') {
    throw Object.assign(new Error(`Commande déjà ${order.status}`), { status: 409 });
  }
  if (Date.now() > order.expires_at) {
    await db.run(`UPDATE shop_orders SET status='expired' WHERE id=?`, [orderId]);
    throw Object.assign(new Error('Commande expirée'), { status: 410 });
  }

  const pending = await db.get(
    `SELECT * FROM shop_payments WHERE order_id=? AND status='pending' ORDER BY created_at DESC LIMIT 1`,
    [orderId],
  );
  if (pending) return pending;

  const provider = getPayProvider();
  const payId    = uid('spay');
  const reference = 'SHOP-' + payId.slice(5).toUpperCase();

  await db.run(
    `INSERT INTO shop_payments
       (id, order_id, user_id, provider, method, phone, amount_cents, currency,
        reference, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    [payId, orderId, order.user_id, provider.name, method, phone || null,
     order.amount_cents, order.currency, reference, now()]
  );

  // Déclenche le paiement chez le fournisseur
  const payRow = await db.get(`SELECT * FROM shop_payments WHERE id = ?`, [payId]);
  try {
    // On réutilise l'interface identique à payments.js
    const adapted = {
      id:           payRow.id,
      reference:    payRow.reference,
      amount_cents: payRow.amount_cents,
      currency:     payRow.currency,
      method:       payRow.method,
      phone:        payRow.phone,
      order_number: null,
      created_at:   payRow.created_at,
    };
    const { order_number, redirect_url } = await provider.initiate(adapted);
    await db.run(`UPDATE shop_payments SET order_number=?, redirect_url=? WHERE id=?`,
      [order_number, redirect_url || null, payId]);
  } catch (e) {
    await db.run(`UPDATE shop_payments SET status='failed', updated_at=? WHERE id=?`, [now(), payId]);
    throw e;
  }

  return db.get(`SELECT * FROM shop_payments WHERE id = ?`, [payId]);
}

// ── Activation ────────────────────────────────────────────────────────────────

/**
 * Active un forfait après confirmation fiable du paiement.
 * Idempotent : si le plan est déjà activé pour cette commande, ne fait rien.
 *
 * @param {string}        paymentId       - id dans shop_payments
 * @param {string|number} [confirmedAmount] - montant en cents confirmé par le fournisseur
 */
async function activateOrder(paymentId, confirmedAmount) {
  return db.tx(async (t) => {
    // 1. Récupérer le paiement et la commande associée
    const pay = await t.get(
      `UPDATE shop_payments SET status='success', updated_at=?
       WHERE id=? AND status='pending'
       RETURNING *`,
      [now(), paymentId]
    );
    if (!pay) {
      // Déjà traité (idempotence) — on retourne l'état actuel
      const existing = await t.get(`SELECT * FROM shop_payments WHERE id=?`, [paymentId]);
      return { already_processed: true, status: existing?.status };
    }

    // 2. Vérification du montant (anti sous-paiement)
    if (confirmedAmount != null) {
      const confirmedCents = Math.round(Number(confirmedAmount));
      if (!Number.isFinite(confirmedCents)) {
        throw new Error(`Montant confirmé invalide : ${confirmedAmount}`);
      }
      if (confirmedCents < pay.amount_cents - AMOUNT_TOLERANCE_CENTS) {
        throw new Error(
          `Sous-paiement détecté : reçu ${confirmedCents}¢, attendu ${pay.amount_cents}¢`
        );
      }
    }

    // 3. Mettre à jour la commande
    const order = await t.get(`SELECT * FROM shop_orders WHERE id=?`, [pay.order_id]);
    if (!order) throw new Error('Commande introuvable lors de l\'activation');

    await t.run(
      `UPDATE shop_orders SET status='paid', payment_id=?, paid_at=? WHERE id=?`,
      [pay.id, now(), order.id]
    );

    // 4. Récupérer le snapshot du forfait
    let pkg;
    try { pkg = JSON.parse(order.package_snapshot); } catch { pkg = {}; }

    // 5. Calculer les droits
    const activatedAt  = now();
    const expiresAt    = activatedAt + (pkg.days || 30) * 24 * 3600 * 1000;
    const remainingSec = pkg.minutes > 0 ? pkg.minutes * 60 : 0; // 0 = illimité
    const unlimited    = pkg.minutes === 0 ? 1 : 0;
    const planId       = uid('upl');

    // 6. Créer le plan pour l'acheteur ou le bénéficiaire vérifié.
    let planUserId = pay.user_id;
    let isGift = 0;
    if (order.recipient_phone) {
      const recipient = await t.get('SELECT id,status FROM users WHERE phone=?', [order.recipient_phone]);
      if (recipient && recipient.status !== 'blocked') {
        planUserId = recipient.id;
        isGift = 1;
      } else {
        // Le bénéficiaire peut créer son compte plus tard; il devra vérifier ce numéro par OTP.
        await t.run(
          `INSERT INTO pending_gifts(order_id,recipient_phone,recipient_name,created_at)
           VALUES(?,?,?,?) ON CONFLICT(order_id) DO NOTHING`,
          [order.id, order.recipient_phone, order.recipient_name || null, activatedAt],
        );
      }
    }
    if (!order.recipient_phone || isGift) {
      // Idempotence SANS dépendre d'une contrainte UNIQUE : `ON CONFLICT
      // (order_id)` échouait (aucune contrainte UNIQUE sur cette colonne) et
      // empêchait TOUTE activation de forfait. `WHERE NOT EXISTS` fonctionne
      // à l'identique sur SQLite et PostgreSQL.
      await t.run(
        `INSERT INTO user_plans
           (id, user_id, order_id, package_id, package_name, prefix,
            minutes_total, remaining_sec, sms_total, remaining_sms,
            unlimited, recipient_phone, is_gift, activated_at, expires_at, status)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active'
         WHERE NOT EXISTS (SELECT 1 FROM user_plans WHERE order_id = ?)`,
        [
          planId, planUserId, order.id, order.package_id, order.package_name,
          pkg.prefix || '', pkg.minutes || 0, remainingSec,
          pkg.sms_count || 0, pkg.sms_count || 0, unlimited,
          isGift ? order.recipient_phone : null, isGift, activatedAt, expiresAt,
          order.id,
        ]
      );
    }
    await t.run('UPDATE shop_orders SET activated_at=? WHERE id=?', [activatedAt, order.id]);

    // 7. Transaction financière pour la traçabilité
    await t.run(
      `INSERT INTO transactions
         (id, user_id, type, amount_cents, method, reference, created_at)
       VALUES (?, ?, 'package_purchase', ?, ?, ?, ?)`,
      [uid('tx'), pay.user_id, pay.amount_cents, pay.method, pay.reference, now()]
    );

    return { activated: true, plan_id: planId, expires_at: expiresAt };
  });
}

// ── Polling et webhook ────────────────────────────────────────────────────────

/**
 * Vérifie le statut d'un paiement boutique auprès du fournisseur et active
 * le forfait si confirmé.
 */
async function pollAndActivate(shopPayment) {
  if (shopPayment.status !== 'pending') return shopPayment.status;

  const provider = getPayProvider();
  // Adapter pour l'interface checkStatus du provider.
  // ⚠️ TOUS les champs utilisés par les providers doivent être transmis :
  // le provider démo s'appuie sur `phone` (numéro se terminant par 0001 =
  // paiement refusé) et sur `created_at` (délai de confirmation). Sans eux,
  // chaque interrogation de statut levait une TypeError → 500, et le forfait
  // n'était JAMAIS activé.
  const adapted = {
    id:           shopPayment.id,
    reference:    shopPayment.reference,
    amount_cents: shopPayment.amount_cents,
    currency:     shopPayment.currency || 'USD',
    method:       shopPayment.method,
    phone:        shopPayment.phone,
    order_number: shopPayment.order_number,
    created_at:   shopPayment.created_at,
  };

  const state = await provider.checkStatus(adapted);

  if (state === 'success') {
    await activateOrder(shopPayment.id).catch((e) =>
      console.error('⚠️ Activation différée (sera reprise) :', e.message)
    );
  } else if (state === 'failed') {
    await db.run(
      `UPDATE shop_payments SET status='failed', updated_at=? WHERE id=? AND status='pending'`,
      [now(), shopPayment.id]
    );
    await db.run(
      `UPDATE shop_orders SET status='failed' WHERE id=? AND status='pending'`,
      [(await db.get(`SELECT order_id FROM shop_payments WHERE id=?`, [shopPayment.id]))?.order_id]
    );
  }

  return state;
}

// ── Plans utilisateur ─────────────────────────────────────────────────────────

/** Forfaits actifs d'un utilisateur, triés par expiration la plus proche. */
async function userActivePlans(userId) {
  return db.all(
    `SELECT * FROM user_plans
     WHERE user_id = ? AND status = 'active' AND expires_at > ?
     ORDER BY expires_at ASC`,
    [userId, now()]
  );
}

/** Tous les forfaits d'un utilisateur (actifs + expirés + épuisés). */
async function userAllPlans(userId) {
  return db.all(
    `SELECT * FROM user_plans WHERE user_id = ? ORDER BY activated_at DESC`,
    [userId]
  );
}

/** Délivre après connexion les cadeaux déjà payés pour le numéro vérifié. */
async function claimGiftPlans(userId, phone) {
  return db.tx(async (t) => {
    const gifts = await t.all(`
      SELECT g.order_id,g.recipient_phone,o.package_id,o.package_name,o.package_snapshot
      FROM pending_gifts g JOIN shop_orders o ON o.id=g.order_id
      WHERE g.recipient_phone=? AND g.claimed_at IS NULL AND o.status='paid'
      ORDER BY g.created_at ASC
    `, [phone]);
    const claimed = [];
    for (const gift of gifts) {
      let pkg;
      try { pkg = JSON.parse(gift.package_snapshot); } catch { pkg = {}; }
      const activatedAt = now();
      const days = Math.max(1, Math.min(365, Number(pkg.days) || 30));
      const minutes = Math.max(0, Math.min(100000, Number(pkg.minutes) || 0));
      await t.run(`
        INSERT INTO user_plans
          (id,user_id,order_id,package_id,package_name,prefix,minutes_total,remaining_sec,
           sms_total,remaining_sms,unlimited,recipient_phone,is_gift,activated_at,expires_at,status)
        SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'active'
        WHERE NOT EXISTS (SELECT 1 FROM user_plans WHERE order_id = ?)
      `, [
        uid('upl'), userId, gift.order_id, gift.package_id, gift.package_name,
        pkg.prefix || '', minutes, minutes * 60, Number(pkg.sms_count) || 0,
        Number(pkg.sms_count) || 0, minutes === 0 ? 1 : 0, phone, 1,
        activatedAt, activatedAt + days * 24 * 60 * 60 * 1000, gift.order_id,
      ]);
      await t.run('UPDATE pending_gifts SET user_id=?,claimed_at=? WHERE order_id=? AND claimed_at IS NULL',
        [userId, activatedAt, gift.order_id]);
      await t.run('UPDATE shop_orders SET activated_at=? WHERE id=?', [activatedAt, gift.order_id]);
      claimed.push(gift.order_id);
    }
    return claimed;
  });
}

/**
 * Consomme des secondes depuis le forfait le plus adapté (expiration la plus proche).
 * Retourne { consumed, plan_id } ou null si aucun forfait éligible.
 *
 * @param {string} userId
 * @param {string} prefix    - préfixe du numéro appelé (pour vérifier l'éligibilité)
 * @param {number} seconds   - secondes à facturer
 */
async function consumeSeconds(userId, prefix, seconds) {
  const plans = await userActivePlans(userId);
  // Filtre : le forfait doit couvrir la destination (prefix vide = toutes destinations)
  const eligible = plans.filter((p) => !p.prefix || prefix.startsWith(p.prefix));
  if (!eligible.length) return null;

  const plan = eligible[0]; // priorité : expiration la plus proche

  if (plan.unlimited) {
    // Forfait illimité : on note la consommation sans déduire
    await db.run(
      `UPDATE user_plans SET consumed_sec = consumed_sec + ? WHERE id=?`,
      [seconds, plan.id]
    );
    return { consumed: seconds, plan_id: plan.id };
  }

  const toConsume = Math.min(seconds, plan.remaining_sec);
  if (toConsume <= 0) return null;

  const newRemaining = plan.remaining_sec - toConsume;
  const newStatus = newRemaining <= 0 ? 'exhausted' : 'active';

  await db.run(
    `UPDATE user_plans
     SET remaining_sec = ?, consumed_sec = consumed_sec + ?, status = ?
     WHERE id=?`,
    [newRemaining, toConsume, newStatus, plan.id]
  );
  return { consumed: toConsume, plan_id: plan.id };
}

/**
 * Consomme des SMS depuis le forfait le plus adapté.
 * Retourne { consumed, plan_id } ou null.
 */
async function consumeSms(userId, prefix, count) {
  const plans = await userActivePlans(userId);
  const eligible = plans.filter(
    (p) => (p.sms_total > 0 || p.unlimited) && (!p.prefix || prefix.startsWith(p.prefix))
  );
  if (!eligible.length) return null;

  const plan = eligible[0];
  if (plan.unlimited) {
    await db.run(
      `UPDATE user_plans SET consumed_sms = consumed_sms + ? WHERE id=?`,
      [count, plan.id]
    );
    return { consumed: count, plan_id: plan.id };
  }

  const toConsume = Math.min(count, plan.remaining_sms);
  if (toConsume <= 0) return null;

  const newRemaining = plan.remaining_sms - toConsume;
  const newStatus = newRemaining <= 0 && plan.remaining_sec <= 0 ? 'exhausted' : 'active';

  await db.run(
    `UPDATE user_plans
     SET remaining_sms = ?, consumed_sms = consumed_sms + ?, status = ?
     WHERE id=?`,
    [newRemaining, toConsume, newStatus, plan.id]
  );
  return { consumed: toConsume, plan_id: plan.id };
}


/**
 * Crée une commande cadeau pour un tiers (recipient_phone).
 * Le bénéficiaire est identifié par son numéro +243.
 * L'expéditeur (userId) paie via Mobile Money ou Visa.
 */
async function createGiftOrder(userId, packageId, recipientPhone, recipientName) {
  const pkg = await getPackage(packageId);
  if (!pkg) throw Object.assign(new Error('Forfait introuvable'), { status: 404 });

  const orderId   = uid('ord');
  const createdAt = now();
  const expiresAt = createdAt + 30 * 60 * 1000; // 30 min

  await db.run(
    `INSERT INTO shop_orders
       (id, user_id, package_id, package_name, package_snapshot,
        amount_cents, currency, status, recipient_phone, recipient_name,
        created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
    [
      orderId, userId, pkg.id, pkg.name, JSON.stringify(publicPackage(pkg)),
      pkg.price_cents, pkg.currency || 'USD',
      recipientPhone, recipientName || null,
      createdAt, expiresAt,
    ]
  );
  // Même forme que createOrder (ligne snake_case) : un seul contrat pour l'API.
  return db.get(`SELECT * FROM shop_orders WHERE id = ?`, [orderId]);
}

module.exports = {
  publicPackage,
  ensureCatalog,
  listCatalog,
  getPackage,
  createOrder,
  createGiftOrder,
  createShopPayment,
  activateOrder,
  pollAndActivate,
  userActivePlans,
  userAllPlans,
  claimGiftPlans,
  consumeSeconds,
  consumeSms,
};
