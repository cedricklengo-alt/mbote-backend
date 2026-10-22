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
  const status = req.body.status === 'blocked' ? 'blocked' : 'active';
  await db.run(`UPDATE users SET status = ? WHERE id = ? AND role = 'user'`, [status, req.params.id]);
  res.json({ ok: true, status });
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

/* ---- Forfaits (CRUD) ---- */
r.get('/packages', requireAdmin, ah(async (req, res) => {
  res.json(await db.all('SELECT * FROM packages ORDER BY price_cents'));
}));

r.post('/packages', requireAdmin, ah(async (req, res) => {
  const { name, price_cents, prefix = '', minutes = 0, days = 30 } = req.body;
  if (!name || !(price_cents > 0) || !(days > 0))
    return res.status(400).json({ error: 'Nom, prix et durée requis' });
  const row = await db.get(
    'INSERT INTO packages(name,price_cents,prefix,minutes,days) VALUES(?,?,?,?,?) RETURNING id',
    [String(name).slice(0, 80), Math.round(price_cents), String(prefix).replace(/\D/g, ''),
     Math.max(0, Math.round(minutes)), Math.round(days)]);
  res.json({ id: row.id });
}));

r.put('/packages/:id', requireAdmin, ah(async (req, res) => {
  if (req.body.active !== undefined)
    await db.run('UPDATE packages SET active = ? WHERE id = ?', [req.body.active ? 1 : 0, req.params.id]);
  res.json({ ok: true });
}));

r.delete('/packages/:id', requireAdmin, ah(async (req, res) => {
  await db.run('DELETE FROM packages WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
}));

/* ---- Recharges airtime ---- */
r.get('/airtime', requireAdmin, ah(async (req, res) => {
  res.json(await db.all(`
    SELECT a.*, u.phone AS user_phone FROM airtime_topups a JOIN users u ON u.id = a.user_id
    ORDER BY a.created_at DESC LIMIT 200`));
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
