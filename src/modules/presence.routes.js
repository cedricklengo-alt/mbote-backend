/**
 * GET /api/presence?phones=+243...,+33...
 * Retourne le statut de présence (en ligne / dernier vu) pour une liste de numéros.
 * Seuls les contacts qui ont autorisé la présence sont exposés (privacy = default pour l'instant).
 */
const router = require('express').Router();
const { requireAuth } = require('../middleware/auth');
const rtcWs = require('./rtc.ws');

router.get('/', requireAuth, async (req, res) => {
  try {
    const raw = req.query.phones || '';
    const phones = raw.split(',').map(p => p.trim()).filter(Boolean).slice(0, 100);
    if (phones.length === 0) return res.json({});
    const result = await rtcWs.getPresence(phones);
    res.json(result);
  } catch (e) {
    console.error('presence GET :', e);
    res.status(500).json({ error: 'Erreur interne' });
  }
});

module.exports = router;
