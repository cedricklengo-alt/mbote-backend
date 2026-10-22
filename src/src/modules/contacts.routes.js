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

/** 📒 Vérification en lot : lesquels de ces numéros ont un compte MBOTE! ?
 *  Body : { phones: ["+243 81 234 56 78", "081 234 5678", …] } (max 500)
 *  Match par les 9 derniers chiffres → tolère les formats locaux (081…)
 *  et internationaux (+24381…).
 *  Réponse : { mbote: { "<numéro envoyé>": "+2438123456 78 normalisé", … } } */
r.post('/check', requireAuth, ah(async (req, res) => {
  const phones = Array.isArray(req.body.phones) ? req.body.phones.slice(0, 500) : [];
  // suffixe 9 chiffres → liste des numéros bruts envoyés
  const bySuffix = new Map();
  for (const raw of phones) {
    const digits = String(raw).replace(/\D/g, '');
    if (digits.length < 9) continue;
    const suf = digits.slice(-9);
    if (!bySuffix.has(suf)) bySuffix.set(suf, []);
    bySuffix.get(suf).push(String(raw));
  }
  const mbote = {};
  const sufs = [...bySuffix.keys()];
  if (sufs.length) {
    const rightExpr = db.name === 'postgres' ? 'RIGHT(phone, 9)' : 'substr(phone, -9)';
    // par lots de 100 pour rester léger
    for (let i = 0; i < sufs.length; i += 100) {
      const batch = sufs.slice(i, i + 100);
      const rows = await db.all(
        `SELECT phone, ${rightExpr} AS suf FROM users
         WHERE role = 'user' AND status = 'active' AND ${rightExpr} IN (${batch.map(() => '?').join(',')})`,
        batch);
      for (const row of rows) {
        // on ne se signale pas soi-même
        if (row.phone === req.user.phone) continue;
        for (const raw of bySuffix.get(row.suf) || []) mbote[raw] = row.phone;
      }
    }
  }
  res.json({ mbote });
}));

module.exports = r;
