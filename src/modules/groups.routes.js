/**
 * Routes groupe — /api/groups
 * Fonctionnalités : créer, rejoindre, envoyer un message, lister les membres, etc.
 */
const router = require('express').Router();
const { requireAuth } = require('../middleware/auth');
const db = require('../db/sqlite');
const rtcWs = require('./rtc.ws');
const { v4: uuid } = require('uuid');

const ah = fn => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
const now = () => Date.now();

// ── Créer un groupe ─────────────────────────────────────────────────────────
router.post('/', requireAuth, ah(async (req, res) => {
  const { name, description = '', members = [] } = req.body;
  if (!name || typeof name !== 'string' || name.trim().length < 2) {
    return res.status(400).json({ error: 'Nom de groupe requis (min 2 caractères)' });
  }
  const groupId = uuid();
  const createdAt = now();
  await db.run(
    'INSERT INTO groups (id, name, description, created_by, created_at) VALUES (?,?,?,?,?)',
    [groupId, name.trim(), description, req.user.id, createdAt]
  );
  // Ajouter le créateur comme admin
  await db.run(
    'INSERT INTO group_members (group_id, user_id, role, joined_at) VALUES (?,?,?,?)',
    [groupId, req.user.id, 'admin', createdAt]
  );
  // Ajouter les autres membres (doivent exister)
  const phones = Array.isArray(members) ? members.slice(0, 256) : [];
  for (const phone of phones) {
    const u = await db.get('SELECT id FROM users WHERE phone = ?', [phone]);
    if (u && u.id !== req.user.id) {
      await db.run(
        'INSERT OR IGNORE INTO group_members (group_id, user_id, role, joined_at) VALUES (?,?,?,?)',
        [groupId, u.id, 'member', createdAt]
      );
    }
  }
  res.status(201).json({ id: groupId, name: name.trim(), description, createdAt });
}));

// ── Lister ses groupes ──────────────────────────────────────────────────────
router.get('/', requireAuth, ah(async (req, res) => {
  const groups = await db.all(`
    SELECT g.id, g.name, g.description, g.avatar_url, g.created_at,
           (SELECT COUNT(*) FROM group_members gm2 WHERE gm2.group_id = g.id) AS member_count
    FROM groups g
    JOIN group_members gm ON gm.group_id = g.id
    WHERE gm.user_id = ?
    ORDER BY g.created_at DESC
  `, [req.user.id]);
  res.json(groups);
}));

// ── Détail d'un groupe ──────────────────────────────────────────────────────
router.get('/:id', requireAuth, ah(async (req, res) => {
  const membership = await db.get(
    'SELECT role FROM group_members WHERE group_id = ? AND user_id = ?',
    [req.params.id, req.user.id]
  );
  if (!membership) return res.status(403).json({ error: 'Non membre de ce groupe' });
  const group = await db.get('SELECT * FROM groups WHERE id = ?', [req.params.id]);
  if (!group) return res.status(404).json({ error: 'Groupe introuvable' });
  const members = await db.all(`
    SELECT u.id, u.phone, u.name, u.avatar_url, gm.role, gm.joined_at
    FROM group_members gm
    JOIN users u ON u.id = gm.user_id
    WHERE gm.group_id = ?
    ORDER BY gm.role DESC, u.name ASC
  `, [req.params.id]);
  res.json({ ...group, members, myRole: membership.role });
}));

// ── Envoyer un message dans un groupe ───────────────────────────────────────
router.post('/:id/messages', requireAuth, ah(async (req, res) => {
  const membership = await db.get(
    'SELECT role FROM group_members WHERE group_id = ? AND user_id = ?',
    [req.params.id, req.user.id]
  );
  if (!membership) return res.status(403).json({ error: 'Non membre de ce groupe' });
  const { text = '', kind = 'text', client_id } = req.body;
  if (!text.trim() && kind === 'text') return res.status(400).json({ error: 'Message vide' });

  const msgId = uuid();
  const ts = now();
  await db.run(
    `INSERT INTO messages
     (id, sender_id, recipient_id, body, kind, group_id, created_at, client_id)
     VALUES (?,?,?,?,?,?,?,?)`,
    [msgId, req.user.id, req.user.id, text.trim(), kind, req.params.id, ts, client_id || null]
  );

  // Diffuser à tous les membres connectés
  const members = await db.all(
    'SELECT u.phone FROM group_members gm JOIN users u ON u.id = gm.user_id WHERE gm.group_id = ? AND gm.user_id != ?',
    [req.params.id, req.user.id]
  );
  const payload = {
    type: 'msg', kind, msg_id: msgId,
    group_id: req.params.id,
    from: req.user.phone, from_name: req.user.name,
    body: text, created_at: ts,
  };
  for (const m of members) rtcWs.sendTo(m.phone, payload);

  res.status(201).json({ id: msgId, created_at: ts });
}));

// ── Lister les messages d'un groupe ─────────────────────────────────────────
router.get('/:id/messages', requireAuth, ah(async (req, res) => {
  const membership = await db.get(
    'SELECT role FROM group_members WHERE group_id = ? AND user_id = ?',
    [req.params.id, req.user.id]
  );
  if (!membership) return res.status(403).json({ error: 'Non membre' });
  const before = req.query.before ? parseInt(req.query.before) : Date.now() + 1000;
  const limit = Math.min(parseInt(req.query.limit || '50'), 100);
  const messages = await db.all(`
    SELECT m.id, m.sender_id, u.name AS sender_name, u.phone AS sender_phone,
           m.body, m.kind, m.created_at, m.forwarded, m.reply_to_id
    FROM messages m
    JOIN users u ON u.id = m.sender_id
    WHERE m.group_id = ? AND m.created_at < ? AND m.deleted_at IS NULL
    ORDER BY m.created_at DESC
    LIMIT ?
  `, [req.params.id, before, limit]);
  res.json({ messages: messages.reverse(), hasMore: messages.length === limit });
}));

// ── Ajouter / supprimer un membre ───────────────────────────────────────────
router.post('/:id/members', requireAuth, ah(async (req, res) => {
  const me = await db.get(
    'SELECT role FROM group_members WHERE group_id = ? AND user_id = ?',
    [req.params.id, req.user.id]
  );
  if (!me || me.role !== 'admin') return res.status(403).json({ error: 'Réservé aux admins' });
  const { phone } = req.body;
  const u = await db.get('SELECT id FROM users WHERE phone = ?', [phone]);
  if (!u) return res.status(404).json({ error: 'Utilisateur introuvable' });
  await db.run(
    'INSERT OR IGNORE INTO group_members (group_id, user_id, role, joined_at) VALUES (?,?,?,?)',
    [req.params.id, u.id, 'member', now()]
  );
  res.json({ ok: true });
}));

router.delete('/:id/members/:userId', requireAuth, ah(async (req, res) => {
  const me = await db.get(
    'SELECT role FROM group_members WHERE group_id = ? AND user_id = ?',
    [req.params.id, req.user.id]
  );
  // Admin peut retirer n'importe qui, membre peut se retirer lui-même
  if (!me || (me.role !== 'admin' && req.params.userId !== req.user.id)) {
    return res.status(403).json({ error: 'Non autorisé' });
  }
  await db.run(
    'DELETE FROM group_members WHERE group_id = ? AND user_id = ?',
    [req.params.id, req.params.userId]
  );
  res.json({ ok: true });
}));

module.exports = router;
