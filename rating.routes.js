/**
 * Module RATING — grilles tarifaires, règle du PLUS LONG préfixe.
 */
const express = require('express');
const db = require('../db');
const { normalizePhone, ah } = require('../util');
const { requireAuth } = require('../middleware/auth');
const { bestPromoFor, discounted, activePromos } = require('../services/promos');

const r = express.Router();

/** Trouve le tarif pour un numéro E.164 (exporté pour le module calls) */
async function findRate(phoneE164) {
  const digits = phoneE164.replace('+', '');
  for (let len = Math.min(digits.length, 7); len >= 1; len--) {
    const rate = await db.get('SELECT * FROM rates WHERE prefix = ? AND active = 1',
      [digits.slice(0, len)]);
    if (rate) return rate;
  }
  return null;
}

/* Tarif pour un numéro donné (affiché sur le clavier avant l'appel) */
r.get('/lookup', requireAuth, ah(async (req, res) => {
  const phone = normalizePhone(req.query.phone);
  if (!phone) return res.status(400).json({ error: 'Numéro invalide' });

  // 💚 Appelé déjà sur MboteCall → GRATUIT
  const toUser = await db.get(
    `SELECT id FROM users WHERE phone = ? AND role = 'user' AND status = 'active'`, [phone]);
  if (toUser && toUser.id !== req.user.id) {
    return res.json({
      destination: 'MboteCall', flag: '💚',
      price_per_min_cents: 0, free_reason: 'mbote', max_minutes: 240,
    });
  }

  const rate = await findRate(phone);
  if (!rate) return res.status(404).json({ error: 'Destination non couverte' });

  // 📦 Forfait actif → GRATUIT (minutes du forfait)
  const packages = require('../services/packages');
  const pack = await packages.findActive(req.user.id, phone);
  if (pack) {
    return res.json({
      destination: rate.destination, flag: rate.flag,
      price_per_min_cents: 0, free_reason: 'package', package_name: pack.name,
      max_minutes: pack.unlimited ? 240 : Math.floor(pack.remaining_sec / 60),
    });
  }

  // 🎉 Happy hour éventuelle sur cette destination
  const promo = await bestPromoFor(phone);
  const price = discounted(rate.price_per_min_cents, promo);

  const w = await db.get('SELECT balance_cents FROM wallets WHERE user_id = ?', [req.user.id]);
  const maxSec = Math.floor((w.balance_cents * 60) / price);
  res.json({
    destination: rate.destination, flag: rate.flag,
    price_per_min_cents: price,
    normal_price_cents: rate.price_per_min_cents,
    promo: promo ? { title: promo.title, discount_pct: promo.discount_pct } : null,
    max_minutes: Math.floor(maxSec / 60),
  });
}));

/* Promos actives (bannière de l'app — public) */
r.get('/promos', ah(async (req, res) => {
  res.json((await activePromos()).map((p) => ({
    title: p.title, discount_pct: p.discount_pct, prefix: p.prefix, ends_at: p.ends_at,
  })));
}));

/* Grille complète (écran "Tarifs" de l'app) */
r.get('/', ah(async (req, res) => {
  res.json(await db.all(
    'SELECT prefix, destination, flag, price_per_min_cents FROM rates WHERE active = 1 ORDER BY destination'));
}));

module.exports = { router: r, findRate };
