/**
 * Module SMS — envoi vers le réseau GSM (Twilio) avec facturation contrôlée.
 *
 *   GET  /api/sms/quote?to=+243…   → prix, couverture par un forfait, faisabilité
 *   POST /api/sms/send             → { to, text, client_id? } → message + statut
 *   GET  /api/sms                  → historique (50 derniers par défaut)
 *   GET  /api/sms/:id              → détail d'un message de l'utilisateur
 *
 * Aucun montant n'est accepté depuis le client : le prix vient de la grille
 * (`rates.sms_price_cents`) ou du forfait. Le débit est fait côté serveur.
 */
'use strict';

const express = require('express');
const { ah } = require('../util');
const { requireAuth } = require('../middleware/auth');
const { rateLimit } = require('../middleware/ratelimit');
const sms = require('../services/sms_service');

const r = express.Router();

/** Anti-abus : 60 SMS / 10 min par compte (protège le compte fournisseur). */
const sendLimit = rateLimit({
  windowMs: 10 * 60_000,
  max: 60,
  key: (req) => 'sms:' + (req.user ? req.user.id : req.ip),
  message: 'Trop de SMS envoyés — réessayez dans quelques minutes.',
});

r.get('/quote', requireAuth, ah(async (req, res) => {
  res.json(await sms.quote(req.user.id, req.query.to));
}));

r.post('/send', requireAuth, sendLimit, ah(async (req, res) => {
  const { to, text, client_id } = req.body || {};
  const out = await sms.send({
    userId: req.user.id,
    to,
    text,
    clientId: client_id,
  });
  res.status(out.duplicate ? 200 : 201).json({
    message: out.message,
    duplicate: out.duplicate,
  });
}));

r.get('/', requireAuth, ah(async (req, res) => {
  res.json({ messages: await sms.list(req.user.id, req.query.limit) });
}));

r.get('/:id', requireAuth, ah(async (req, res) => {
  res.json({ message: await sms.get(req.user.id, req.params.id) });
}));

module.exports = r;
