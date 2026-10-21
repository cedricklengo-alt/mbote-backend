/**
 * Module ADMIN — back-office : stats, utilisateurs, tarifs, CDR, transactions.
 * Connexion par téléphone + mot de passe (rôle admin uniquement).
 */
const express = require('express');
const db = require('../db');
const { uid, now, verifyPassword, normalizePhone } = require('../util');
const { sign, requireAdmin } = require('../middleware/auth');

const r = express.Router();

/* ---- Login admin ---- */
r.post('/login', (req, res) => {
  const phone = normalizePhone(req.body.phone);
  const user = db.prepare(`SELECT * FROM users WHERE phone = ? AND role = 'admin'`).get(phone);
  if (!user || !verifyPassword(String(req.body.password || ''), user.password_hash))
    return res.status(401).json({ error: 'Identifiants incorrects' });
  res.json({ token: sign(user), name: user.name });
});

/* ---- Tableau de bord ---- */
r.get('/stats', requireAdmin, (req, res) => {
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const q = (sql, ...p) => db.prepare(sql).get(...p);
  res.json({
    users_total: q('SELECT COUNT(*) n FROM users WHERE role = "user"').n,
    users_today: q('SELECT COUNT(*) n FROM users WHERE role = "user" AND created_at >= ?', dayStart.getTime()).n,
    calls_today: q('SELECT COUNT(*) n FROM calls WHERE started_at >= ?', dayStart.getTime()).n,
    minutes_today: Math.round(q('SELECT COALESCE(SUM(billed_sec),0) s FROM calls WHERE started_at >= ?', dayStart.getTime()).s / 60),
    revenue_today_cents: q('SELECT COALESCE(SUM(cost_cents),0) c FROM calls WHERE started_at >= ?', dayStart.getTime()).c,
    topups_today_cents: q(`SELECT COALESCE(SUM(amount_cents),0) c FROM transactions WHERE type='topup' AND created_at >= ?`, dayStart.getTime()).c,
    balance_total_cents: q('SELECT COALESCE(SUM(balance_cents),0) c FROM wallets').c,
    // 7 derniers jours pour le mini-graphique
    last7days: db.prepare(`
      SELECT date(started_at/1000,'unixepoch') d, COUNT(*) n, COALESCE(SUM(cost_cents),0) c
      FROM calls WHERE started_at >= ? GROUP BY d ORDER BY d`).all(now() - 7 * 86400_000),
  });
});

/* ---- Utilisateurs ---- */
r.get('/users', requireAdmin, (req, res) => {
  res.json(db.prepare(`
    SELECT u.id, u.phone, u.name, u.status, u.created_at, w.balance_cents,
      (SELECT COUNT(*) FROM calls c WHERE c.user_id = u.id) AS calls
    FROM users u JOIN wallets w ON w.user_id = u.id
    WHERE u.role = 'user' ORDER BY u.created_at DESC LIMIT 200`).all());
});

r.post('/users/:id/credit', requireAdmin, (req, res) => {
  const amount = Math.round(Number(req.body.amount_cents));
  if (!Number.isFinite(amount) || amount === 0) return res.status(400).json({ error: 'Montant invalide' });
  db.prepare('UPDATE wallets SET balance_cents = MAX(0, balance_cents + ?) WHERE user_id = ?').run(amount, req.params.id);
  db.prepare('INSERT INTO transactions(id,user_id,type,amount_cents,method,reference,created_at) VALUES(?,?,?,?,?,?,?)')
    .run(uid('tx'), req.params.id, 'admin_credit', amount, 'system', 'Ajustement admin', now());
  res.json({ ok: true });
});

r.post('/users/:id/status', requireAdmin, (req, res) => {
  const status = req.body.status === 'blocked' ? 'blocked' : 'active';
  db.prepare(`UPDATE users SET status = ? WHERE id = ? AND role = 'user'`).run(status, req.params.id);
  res.json({ ok: true, status });
});

/* ---- Tarifs (CRUD) ---- */
r.get('/rates', requireAdmin, (req, res) => {
  res.json(db.prepare('SELECT * FROM rates ORDER BY destination').all());
});
r.post('/rates', requireAdmin, (req, res) => {
  const { prefix, destination, flag = '', price_per_min_cents } = req.body;
  if (!/^\d{1,7}$/.test(String(prefix)) || !destination || !(price_per_min_cents > 0))
    return res.status(400).json({ error: 'Champs invalides' });
  const info = db.prepare('INSERT INTO rates(prefix,destination,flag,price_per_min_cents) VALUES(?,?,?,?)')
    .run(String(prefix), destination, flag, Math.round(price_per_min_cents));
  res.json({ id: info.lastInsertRowid });
});
r.put('/rates/:id', requireAdmin, (req, res) => {
  const { price_per_min_cents, active } = req.body;
  if (price_per_min_cents !== undefined)
    db.prepare('UPDATE rates SET price_per_min_cents = ? WHERE id = ?').run(Math.round(price_per_min_cents), req.params.id);
  if (active !== undefined)
    db.prepare('UPDATE rates SET active = ? WHERE id = ?').run(active ? 1 : 0, req.params.id);
  res.json({ ok: true });
});
r.delete('/rates/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM rates WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

/* ---- CDR & transactions ---- */
r.get('/cdrs', requireAdmin, (req, res) => {
  res.json(db.prepare(`
    SELECT c.*, u.phone AS user_phone FROM calls c JOIN users u ON u.id = c.user_id
    ORDER BY c.started_at DESC LIMIT 200`).all());
});
r.get('/transactions', requireAdmin, (req, res) => {
  res.json(db.prepare(`
    SELECT t.*, u.phone AS user_phone FROM transactions t JOIN users u ON u.id = t.user_id
    ORDER BY t.created_at DESC LIMIT 200`).all());
});

module.exports = r;
