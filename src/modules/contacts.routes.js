/** Module CONTACTS — favoris de l'utilisateur */
const express = require('express');
const db = require('../db');
const { uid, normalizePhone, ah } = require('../util');
const { requireAuth } = require('../middleware/auth');

const r = express.Router();

r.get('/', requireAuth, ah(async (req, res) => {
  res.json(await db.all('SELECT * FROM contacts WHERE user_id = ? ORDER BY name', [req.user.id]));
}));

r.post('/', requireAuth, ah(async (req, res) => {
  const phone = normalizePhone(req.body.phone);
  const name = String(req.body.name || '').trim().slice(0, 60);
  if (!phone || !name) return res.status(400).json({ error: 'Nom et numéro requis' });
  const id = uid('ct');
  await db.run('INSERT INTO contacts(id,user_id,name,phone) VALUES(?,?,?,?)',
    [id, req.user.id, name, phone]);
  res.json({ id, name, phone });
}));

r.delete('/:id', requireAuth, ah(async (req, res) => {
  await db.run('DELETE FROM contacts WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
  res.json({ ok: true });
}));

module.exports = r;
