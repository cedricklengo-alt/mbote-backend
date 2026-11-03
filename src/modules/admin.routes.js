/**
 * Module ADMIN — back-office : stats, utilisateurs, tarifs, CDR, transactions.
 */
const express = require('express');
const db = require('../db');
const { uid, now, verifyPassword, normalizePhone, ah } = require('../util');
const { sign, requireAdmin } = require('../middleware/auth');

const r = express.Router();

/* ---- Login admin ---- */
r.post('/login', ah(async (req, res) => {
  const phone = normalizePhone(req.body.phone);
  const password = String(req.body.password || '').trim(); // tolère les espaces parasites
  const user = await db.get(`SELECT * FROM users WHERE phone = ? AND role = 'admin'`, [phone]);
  if (!user || !verifyPassword(password, user.password_hash))
    return res.status(401).json({ error: 'Identifiants incorrects' });
  res.json({ token: sign(user), name: user.name });
}));

/* ---- Tableau de bord ---- */
r.get('/stats', requireAdmin, ah(async (req, res) => {
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const d0 = dayStart.getTime();
  const D = db.fn.dateFromMs('started_at');

  const [u, ut, ct, mt, rt, tp, bt, last7] = await Promise.all([
    db.get(`SELECT COUNT(*) n FROM users WHERE role = 'user'`),
    db.get(`SELECT COUNT(*) n FROM users WHERE role = 'user' AND created_at >= ?`, [d0]),
    db.get('SELECT COUNT(*) n FROM calls WHERE started_at >= ?', [d0]),
    db.get('SELECT COALESCE(SUM(billed_sec),0) s FROM calls WHERE started_at >= ?', [d0]),
    db.get('SELECT COALESCE(SUM(cost_cents),0) c FROM calls WHERE started_at >= ?', [d0]),
    db.get(`SELECT COALESCE(SUM(amount_cents),0) c FROM transactions WHERE type='topup' AND created_at >= ?`, [d0]),
    db.get('SELECT COALESCE(SUM(balance_cents),0) c FROM wallets'),
    db.all(`SELECT ${D} d, COUNT(*) n, COALESCE(SUM(cost_cents),0) c
            FROM calls WHERE started_at >= ? GROUP BY d ORDER BY d`, [now() - 7 * 86400_000]),
  ]);

  res.json({
    users_total: Number(u.n),
    users_today: Number(ut.n),
    calls_today: Number(ct.n),
    minutes_today: Math.round(Number(mt.s) / 60),
    revenue_today_cents: Number(rt.c),
    topups_today_cents: Number(tp.c),
    balance_total_cents: Number(bt.c),
    last7days: last7.map((x) => ({ d: x.d, n: Number(x.n), c: Number(x.c) })),
  });
}));

/* ---- Utilisateurs ---- */
r.get('/users', requireAdmin, ah(async (req, res) => {
  res.json(await db.all(`
    SELECT u.id, u.phone, u.name, u.status, u.created_at, w.balance_cents,
      (SELECT COUNT(*) FROM calls c WHERE c.user_id = u.id) AS calls
    FROM users u JOIN wallets w ON w.user_id = u.id
    WHERE u.role = 'user' ORDER BY u.created_at DESC LIMIT 200`));
}));

r.post('/users/:id/credit', requireAdmin, ah(async (req, res) => {
  const amount = Math.round(Number(req.body.amount_cents));
  if (!Number.isFinite(amount) || amount === 0) return res.status(400).json({ error: 'Montant invalide' });
  const G = db.fn.greatest;
  await db.run(`UPDATE wallets SET balance_cents = ${G}(0, balance_cents + ?) WHERE user_id = ?`,
    [amount, req.params.id]);
  await db.run(
    'INSERT INTO transactions(id,user_id,type,amount_cents,method,reference,created_at) VALUES(?,?,?,?,?,?,?)',
    [uid('tx'), req.params.id, 'admin_credit', amount, 'system', 'Ajustement admin', now()]);
  res.json({ ok: true });
}));

r.post('/users/:id/status', requireAdmin, ah(async (req, res) => {
  // ⚠️ Avant : toute valeur inconnue était convertie en 'active' — une faute de
  // frappe dans la console DÉBLOQUAIT le compte sans le dire. On refuse net.
  const status = String(req.body.status || '');
  if (!['active', 'blocked'].includes(status))
    return res.status(400).json({ error: 'Statut invalide (active ou blocked)' });

  const user = await db.get(`SELECT id, status FROM users WHERE id = ? AND role = 'user'`, [req.params.id]);
  if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });

  await db.run(`UPDATE users SET status = ? WHERE id = ? AND role = 'user'`, [status, req.params.id]);
  res.json({ ok: true, status });
}));

/* ---- Forfaits de la boutique (onglet « Forfaits » de la console) ----
 * La console appelait /api/admin/packages alors que seules les routes
 * /api/shop/admin/packages existaient : l'onglet restait vide et ses boutons
 * « Activer / Supprimer » ne faisaient rien. */
r.get('/packages', requireAdmin, ah(async (req, res) => {
  res.json(await db.all('SELECT * FROM shop_packages ORDER BY sort_order ASC, id ASC'));
}));

r.post('/packages', requireAdmin, ah(async (req, res) => {
  const {
    name, description = '', price_cents, currency = 'USD',
    minutes = 0, sms_count = 0, days = 30,
    prefix = '', category = 'credit', conditions = '',
    renewable = false, sort_order = 0,
  } = req.body;

  if (!name || String(name).trim().length === 0)
    return res.status(400).json({ error: 'Le nom est requis' });
  const prix = Number(price_cents);
  if (!Number.isFinite(prix) || prix < 0)
    return res.status(400).json({ error: 'price_cents (≥ 0) est requis' });
  const mins = Math.round(Number(minutes) || 0);
  const jours = Math.round(Number(days) || 0);
  if (mins < 0 || jours < 1)
    return res.status(400).json({ error: 'minutes ≥ 0 et days ≥ 1 attendus' });

  const id = Date.now(); // identifiant entier (portable SQLite / PostgreSQL)
  await db.run(
    `INSERT INTO shop_packages
       (id, name, description, price_cents, currency, minutes, sms_count, days,
        prefix, category, conditions, renewable, sort_order, active, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    [id, String(name).slice(0, 120), String(description).slice(0, 300), Math.round(prix),
     String(currency).slice(0, 3), mins, Math.round(Number(sms_count) || 0), jours,
     String(prefix).replace(/\D/g, ''), String(category).slice(0, 40),
     String(conditions).slice(0, 300), renewable ? 1 : 0, Math.round(Number(sort_order) || 0), now()],
  );
  res.status(201).json({ ok: true, package: await db.get('SELECT * FROM shop_packages WHERE id = ?', [id]) });
}));

r.put('/packages/:id', requireAdmin, ah(async (req, res) => {
  const pack = await db.get('SELECT * FROM shop_packages WHERE id = ?', [req.params.id]);
  if (!pack) return res.status(404).json({ error: 'Forfait introuvable' });

  const sets = [];
  const vals = [];
  const num = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : null);

  if (req.body.active !== undefined) {
    sets.push('active = ?');
    vals.push(req.body.active ? 1 : 0);
  }
  for (const f of ['price_cents', 'minutes', 'days', 'sms_count', 'sort_order']) {
    if (req.body[f] !== undefined) {
      const n = num(req.body[f]);
      if (n === null || n < 0) return res.status(400).json({ error: `${f} invalide` });
      sets.push(`${f} = ?`);
      vals.push(n);
    }
  }
  for (const f of ['name', 'prefix', 'category', 'description']) {
    if (req.body[f] !== undefined) {
      sets.push(`${f} = ?`);
      vals.push(String(req.body[f]).slice(0, 200));
    }
  }
  if (!sets.length) return res.status(400).json({ error: 'Aucun champ à modifier' });

  await db.run(`UPDATE shop_packages SET ${sets.join(', ')} WHERE id = ?`, [...vals, pack.id]);
  res.json({ ok: true, package: await db.get('SELECT * FROM shop_packages WHERE id = ?', [pack.id]) });
}));

r.delete('/packages/:id', requireAdmin, ah(async (req, res) => {
  const pack = await db.get('SELECT id FROM shop_packages WHERE id = ?', [req.params.id]);
  if (!pack) return res.status(404).json({ error: 'Forfait introuvable' });
  // Les commandes et les forfaits déjà activés conservent leur propre
  // instantané (package_name, package_snapshot) : rien n'est perdu.
  await db.run('DELETE FROM shop_packages WHERE id = ?', [pack.id]);
  res.json({ ok: true });
}));

/* ---- Recharges de crédit GSM (onglet « Crédit GSM ») ---- */
r.get('/airtime', requireAdmin, ah(async (req, res) => {
  res.json(await db.all(`
    SELECT a.id, a.phone, a.operator, a.amount_cents, a.status, a.provider,
           a.reference, a.created_at, u.phone AS user_phone, u.name AS user_name
      FROM airtime_topups a
      LEFT JOIN users u ON u.id = a.user_id
     ORDER BY a.created_at DESC
     LIMIT 200`));
}));

/* ---- Tarifs (CRUD) ---- */
r.get('/rates', requireAdmin, ah(async (req, res) => {
  res.json(await db.all('SELECT * FROM rates ORDER BY destination'));
}));

r.post('/rates', requireAdmin, ah(async (req, res) => {
  const { prefix, destination, flag = '', price_per_min_cents } = req.body;
  if (!/^\d{1,7}$/.test(String(prefix)) || !destination || !(price_per_min_cents > 0))
    return res.status(400).json({ error: 'Champs invalides' });
  const row = await db.get(
    'INSERT INTO rates(prefix,destination,flag,price_per_min_cents) VALUES(?,?,?,?) RETURNING id',
    [String(prefix), destination, flag, Math.round(price_per_min_cents)]);
  res.json({ id: row.id });
}));

r.put('/rates/:id', requireAdmin, ah(async (req, res) => {
  const { price_per_min_cents, active } = req.body;
  if (price_per_min_cents !== undefined)
    await db.run('UPDATE rates SET price_per_min_cents = ? WHERE id = ?',
      [Math.round(price_per_min_cents), req.params.id]);
  if (active !== undefined)
    await db.run('UPDATE rates SET active = ? WHERE id = ?', [active ? 1 : 0, req.params.id]);
  res.json({ ok: true });
}));

r.delete('/rates/:id', requireAdmin, ah(async (req, res) => {
  await db.run('DELETE FROM rates WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
}));

/* ---- Promos / Happy Hours ---- */
r.get('/promos', requireAdmin, ah(async (req, res) => {
  res.json(await db.all('SELECT * FROM promos ORDER BY id DESC'));
}));

r.post('/promos', requireAdmin, ah(async (req, res) => {
  const { title, discount_pct, prefix = '', starts_at = 0, ends_at = 0 } = req.body;
  const pct = Math.round(Number(discount_pct));
  if (!title || !(pct >= 1 && pct <= 90))
    return res.status(400).json({ error: 'Titre requis, remise entre 1 et 90 %' });
  const row = await db.get(
    'INSERT INTO promos(title,discount_pct,prefix,starts_at,ends_at) VALUES(?,?,?,?,?) RETURNING id',
    [String(title).slice(0, 80), pct, String(prefix).replace(/\D/g, ''), Number(starts_at) || 0, Number(ends_at) || 0]);
  res.json({ id: row.id });
}));

r.put('/promos/:id', requireAdmin, ah(async (req, res) => {
  if (req.body.active !== undefined)
    await db.run('UPDATE promos SET active = ? WHERE id = ?', [req.body.active ? 1 : 0, req.params.id]);
  res.json({ ok: true });
}));

r.delete('/promos/:id', requireAdmin, ah(async (req, res) => {
  await db.run('DELETE FROM promos WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
}));

/* ---- CDR & transactions ---- */
r.get('/cdrs', requireAdmin, ah(async (req, res) => {
  res.json(await db.all(`
    SELECT c.*, u.phone AS user_phone FROM calls c JOIN users u ON u.id = c.user_id
    ORDER BY c.started_at DESC LIMIT 200`));
}));

r.get('/payments', requireAdmin, ah(async (req, res) => {
  res.json(await db.all(`
    SELECT p.*, u.phone AS user_phone FROM payments p JOIN users u ON u.id = p.user_id
    ORDER BY p.created_at DESC LIMIT 200`));
}));

r.get('/transactions', requireAdmin, ah(async (req, res) => {
  res.json(await db.all(`
    SELECT t.*, u.phone AS user_phone FROM transactions t JOIN users u ON u.id = t.user_id
    ORDER BY t.created_at DESC LIMIT 200`));
}));

module.exports = r;
