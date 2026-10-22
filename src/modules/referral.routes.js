/** Module PARRAINAGE — « Invitez vos proches, gagnez 1 $ chacun ». */
const express = require('express');
const { ah } = require('../util');
const { requireAuth } = require('../middleware/auth');
const referral = require('../services/referral');

const r = express.Router();

/* Mon code + mes statistiques de parrainage */
r.get('/', requireAuth, ah(async (req, res) => {
  res.json(await referral.stats(req.user.id));
}));

module.exports = r;
