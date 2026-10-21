/**
 * Module RATING — grilles tarifaires et calcul du prix par destination.
 * Règle télécom standard : correspondance du PLUS LONG préfixe.
 *   +24381… → essaie 24381, puis 2438, puis 243…
 */
const express = require('express');
const db = require('../db');
const { normalizePhone } = require('../util');
const { requireAuth } = require('../middleware/auth');

const r = express.Router();

/** Trouve le tarif pour un numéro E.164 (exporté pour le module calls) */
function findRate(phoneE164) {
  const digits = phoneE164.replace('+', '');
  for (let len = Math.min(digits.length, 7); len >= 1; len--) {
    const rate = db.prepare('SELECT * FROM rates WHERE prefix = ? AND active = 1').get(digits.slice(0, len));
    if (rate) return rate;
  }
  return null;
}

/* Tarif pour un numéro donné (affiché sur le clavier avant l'appel) */
r.get('/lookup', requireAuth, (req, res) => {
  const phone = normalizePhone(req.query.phone);
  if (!phone) return res.status(400).json({ error: 'Numéro invalide' });
  const rate = findRate(phone);
  if (!rate) return res.status(404).json({ error: 'Destination non couverte' });

  const w = db.prepare('SELECT balance_cents FROM wallets WHERE user_id = ?').get(req.user.id);
  const maxSec = Math.floor((w.balance_cents * 60) / rate.price_per_min_cents);
  res.json({
    destination: rate.destination, flag: rate.flag,
    price_per_min_cents: rate.price_per_min_cents,
    max_minutes: Math.floor(maxSec / 60),
  });
});

/* Grille complète (écran "Tarifs" de l'app) */
r.get('/', (req, res) => {
  res.json(db.prepare('SELECT prefix, destination, flag, price_per_min_cents FROM rates WHERE active = 1 ORDER BY destination').all());
});

module.exports = { router: r, findRate };
