/**
 * Feature C — Appel programmé ("Dial Later")
 *
 * POST   /api/dial-later          — créer un rappel
 * GET    /api/dial-later          — liste des rappels de l'utilisateur
 * DELETE /api/dial-later/:id      — annuler un rappel
 *
 * Un scheduler in-process vérifie toutes les minutes les rappels à envoyer.
 */
const router = require('express').Router();
const { requireAuth } = require('../middleware/auth');
const db = require('../db');
const push = require('../services/push');         // sendData(token, data)
const { v4: uuidv4 } = require('uuid');

/* ─────────────── CRUD ─────────────── */

router.post('/', requireAuth, async (req, res) => {
  try {
    const user = req.user;
    const { target_phone, target_name, scheduled_at, tz_offset } = req.body;
    if (!target_phone || !scheduled_at) {
      return res.status(400).json({ error: 'target_phone et scheduled_at requis' });
    }
    const ts = Number(scheduled_at);
    if (isNaN(ts) || ts <= Date.now()) {
      return res.status(400).json({ error: 'scheduled_at doit être dans le futur' });
    }
    const id = uuidv4();
    await db.run(
      `INSERT INTO dial_later (id, user_id, target_phone, target_name, scheduled_at, tz_offset, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, user.id, target_phone, target_name || '', ts, tz_offset || 0, Date.now()]
    );
    res.json({ id });
  } catch (e) {
    console.error('dial_later POST :', e);
    res.status(500).json({ error: 'Erreur interne' });
  }
});

router.get('/', requireAuth, async (req, res) => {
  try {
    const rows = await db.all(
      `SELECT * FROM dial_later
       WHERE user_id = ? AND cancelled = 0 AND scheduled_at > ?
       ORDER BY scheduled_at ASC`,
      [req.user.id, Date.now()]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: 'Erreur interne' });
  }
});

router.delete('/:id', requireAuth, async (req, res) => {
  try {
    await db.run(
      `UPDATE dial_later SET cancelled = 1 WHERE id = ? AND user_id = ?`,
      [req.params.id, req.user.id]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Erreur interne' });
  }
});

/* ─────────────── Scheduler ─────────────── */

const REMIND_BEFORE_MS = 5 * 60 * 1000;   // rappel 5 minutes avant

async function runScheduler() {
  try {
    const now = Date.now();
    const horizon = now + REMIND_BEFORE_MS + 60_000; // fenêtre +1 min de tolérance
    const due = await db.all(
      `SELECT dl.*, u.fcm_token, u.phone AS user_phone
       FROM dial_later dl
       JOIN users u ON u.id = dl.user_id
       WHERE dl.cancelled = 0
         AND dl.reminded  = 0
         AND dl.scheduled_at BETWEEN ? AND ?`,
      [now + REMIND_BEFORE_MS - 60_000, horizon]
    );

    for (const row of due) {
      // Notifier l'initiateur
      const token = row.fcm_token || await push.primaryToken(row.user_id);
      if (token) {
        await push.sendData(token, {
          kind:         'dial_later_reminder',
          dial_id:      row.id,
          target_phone: row.target_phone,
          target_name:  row.target_name,
          scheduled_at: String(row.scheduled_at),
        }).catch(() => {});
      }
      // Marquer comme envoyé
      await db.run(`UPDATE dial_later SET reminded = 1 WHERE id = ?`, [row.id]);
    }
  } catch (e) {
    console.error('dial_later scheduler :', e);
  }
}

// Démarrer le scheduler dès que le module est chargé
setInterval(runScheduler, 60_000);
runScheduler(); // premier passage immédiat

module.exports = router;
