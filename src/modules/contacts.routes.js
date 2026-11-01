/** Module CONTACTS — favoris de l'utilisateur */
const express = require('express');
const db = require('../db');
const { uid, normalizePhone, ah } = require('../util');
const { requireAuth } = require('../middleware/auth');
const { isOnline } = require('./rtc.ws');

const r = express.Router();

r.get('/', requireAuth, ah(async (req, res) => {
  res.json(await db.all('SELECT * FROM contacts WHERE user_id = ? ORDER BY name', [req.user.id]));
}));

r.post('/check', requireAuth, ah(async (req, res) => {
  const input = Array.isArray(req.body.phones) ? req.body.phones.slice(0, 300) : [];
  const normalized = [...new Set(input.map(normalizePhone).filter(Boolean))];
  if (!normalized.length) return res.json({ mbote: {} });
  const peers = await db.all(
    `SELECT phone FROM users WHERE status='active' AND phone IN (${normalized.map(() => '?').join(',')})`,
    normalized,
  );
  const available = new Set(peers.map((p) => p.phone));
  const mbote = {};
  for (const raw of input) {
    const phone = normalizePhone(raw);
    if (phone && available.has(phone)) mbote[String(raw)] = phone;
  }
  res.json({ mbote });
}));

r.post('/', requireAuth, ah(async (req, res) => {
  const phone = normalizePhone(req.body.phone);
  const name = String(req.body.name || '').trim().slice(0, 60);
  if (!phone || !name) return res.status(400).json({ error: 'Nom et numéro requis' });
  const existing = await db.get('SELECT id FROM contacts WHERE user_id=? AND phone=?', [req.user.id, phone]);
  if (existing) {
    await db.run('UPDATE contacts SET name=? WHERE id=?', [name, existing.id]);
    return res.json({ id: existing.id, name, phone });
  }
  const id = uid('ct');
  await db.run('INSERT INTO contacts(id,user_id,name,phone) VALUES(?,?,?,?)',
    [id, req.user.id, name, phone]);
  res.json({ id, name, phone });
}));

r.delete('/:id', requireAuth, ah(async (req, res) => {
  await db.run('DELETE FROM contacts WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
  res.json({ ok: true });
}));

r.get('/profile/:phone', requireAuth, ah(async (req, res) => {
  const phone = normalizePhone(req.params.phone);
  if (!phone) return res.status(400).json({ error: 'Numéro invalide' });
  const peer = await db.get('SELECT id,phone,name,avatar,created_at,presence_visible,last_seen_at FROM users WHERE phone=? AND status=\'active\'', [phone]);
  if (!peer) return res.status(404).json({ error: 'Compte MboteCall introuvable' });
  const visible = peer.presence_visible !== 0;
  const reminder = await db.get('SELECT notified_at FROM presence_reminders WHERE owner_id=? AND target_id=?', [req.user.id, peer.id]);
  res.json({
    id: peer.id, phone: peer.phone, name: peer.name, avatar: peer.avatar || null,
    member_since: peer.created_at,
    created_at: peer.created_at,
    presence_visible: visible,
    online: visible && isOnline(peer.phone),
    last_seen_at: visible ? peer.last_seen_at : null,
    reminder_active: !!(reminder && !reminder.notified_at),
  });
}));

r.post('/:phone/reminder', requireAuth, ah(async (req, res) => {
  const phone = normalizePhone(req.params.phone);
  if (!phone || phone === req.user.phone) return res.status(400).json({ error: 'Contact invalide' });
  const peer = await db.get('SELECT id,phone,name,presence_visible FROM users WHERE phone=? AND status=\'active\'', [phone]);
  if (!peer) return res.status(404).json({ error: 'Compte MboteCall introuvable' });
  if (peer.presence_visible === 0) return res.status(403).json({ error: 'Ce contact masque sa présence' });
  if (isOnline(phone)) {
    await db.run('DELETE FROM presence_reminders WHERE owner_id=? AND target_id=?', [req.user.id, peer.id]);
    return res.json({ ok: true, already_online: true, active: false });
  }
  await db.run(`
    INSERT INTO presence_reminders(owner_id,target_id,created_at,notified_at) VALUES(?,?,?,NULL)
    ON CONFLICT(owner_id,target_id) DO UPDATE SET created_at=excluded.created_at,notified_at=NULL
  `, [req.user.id, peer.id, Date.now()]);
  res.json({ ok: true, already_online: false, active: true });
}));

r.delete('/:phone/reminder', requireAuth, ah(async (req, res) => {
  const phone = normalizePhone(req.params.phone);
  if (!phone) return res.status(400).json({ error: 'Contact invalide' });
  const peer = await db.get('SELECT id FROM users WHERE phone=?', [phone]);
  if (peer) await db.run('DELETE FROM presence_reminders WHERE owner_id=? AND target_id=?', [req.user.id, peer.id]);
  res.json({ ok: true, active: false });
}));

module.exports = r;
