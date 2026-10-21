/** Module CONTACTS — favoris de l'utilisateur */
const express = require('express');
const db = require('../db');
const { uid, normalizePhone } = require('../util');
const { requireAuth } = require('../middleware/auth');

const r = express.Router();

r.get('/', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM contacts WHERE user_id = ? ORDER BY name').all(req.user.id));
});

r.post('/', requireAuth, (req, res) => {
  const phone = normalizePhone(req.body.phone);
  const name = String(req.body.name || '').trim().slice(0, 60);
  if (!phone || !name) return res.status(400).json({ error: 'Nom et numéro requis' });
  const id = uid('ct');
  db.prepare('INSERT INTO contacts(id,user_id,name,phone) VALUES(?,?,?,?)').run(id, req.user.id, name, phone);
  res.json({ id, name, phone });
});

r.delete('/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM contacts WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

module.exports = r;
