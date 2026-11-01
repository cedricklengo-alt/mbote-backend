/**
 * Module CALLS — autorisation, appel, décompte temps réel, CDR.
 */
const express = require('express');
const db = require('../db');
const { uid, now, normalizePhone, costFor, ah } = require('../util');
const { requireAuth } = require('../middleware/auth');
const { findRate } = require('./rating.routes');
const { getProvider } = require('../providers');
const { bestPromoFor, discounted } = require('../services/promos');
const referral = require('../services/referral');
const rtcWs = require('./rtc.ws');

const r = express.Router();

/* ---------- Helpers ---------- */
// Synchronise l'état provider → BDD (transition sonnerie → décroché)
async function syncState(call) {
  if (call.rtc_mode) return call;
  if (call.status === 'ended' || call.answered_at) return call;
  if (getProvider().getCallState(call) === 'answered') {
    const at = getProvider().answerTime ? getProvider().answerTime(call) : now();
    await db.run(`UPDATE calls SET status='answered', answered_at=? WHERE id=?`, [at, call.id]);
    return db.get('SELECT * FROM calls WHERE id = ?', [call.id]);
  }
  return call;
}

function liveNumbers(call) {
  const t = now();
  const answeredAt = call.answered_at;
  const elapsed = answeredAt ? Math.floor(((call.ended_at || t) - answeredAt) / 1000) : 0;
  const cost = costFor(elapsed, call.price_per_min_cents);
  return { elapsed, cost };
}

async function finalize(call, cause) {
  const { elapsed, cost } = liveNumbers(call);
  const G = db.fn.greatest;
  await db.tx(async (t) => {
    await t.run(
      `UPDATE calls SET status='ended', ended_at=?, billed_sec=?, cost_cents=?, hangup_cause=? WHERE id=?`,
      [now(), elapsed, cost, cause, call.id]);
    if (cost > 0) {
      await t.run(`UPDATE wallets SET balance_cents = ${G}(0, balance_cents - ?) WHERE user_id = ?`,
        [cost, call.user_id]);
      await t.run(
        'INSERT INTO transactions(id,user_id,type,amount_cents,method,reference,created_at) VALUES(?,?,?,?,?,?,?)',
        [uid('tx'), call.user_id, 'call_debit', -cost, 'system', `Appel ${call.callee} (${elapsed}s)`, now()]);
      // 🤝 Premier appel facturé d'un filleul → 1 $ pour lui + 1 $ pour le parrain
      await referral.maybeRewardInsideTx(t, call.user_id);
    }
  });
  try { getProvider().hangup(call); } catch { /* best effort */ }
  return db.get('SELECT * FROM calls WHERE id = ?', [call.id]);
}

/* ---------- 1) Démarrer un appel ---------- */
r.post('/start', requireAuth, ah(async (req, res) => {
  const to = normalizePhone(req.body.to);
  if (!to) return res.status(400).json({ error: 'Numéro invalide (format +243…)' });
  if (to === req.user.phone) return res.status(400).json({ error: 'Tu ne peux pas t’appeler toi-même' });

  await db.run("UPDATE calls SET status='ended',ended_at=?,hangup_cause='timeout' WHERE rtc_mode=1 AND status='ringing' AND started_at<=?", [now(), now() - 75000]);
  await db.run("UPDATE calls SET status='ended',ended_at=?,hangup_cause='timeout' WHERE rtc_mode=2 AND status='answered' AND started_at<=?", [now(), now() - 12 * 60 * 60 * 1000]);

  const active = await db.get(`SELECT id FROM calls WHERE (user_id=? OR callee_user_id=?) AND status != 'ended'`, [req.user.id, req.user.id]);
  if (active) return res.status(409).json({ error: 'Un appel est déjà en cours' });

  // Les comptes Mbote s'appellent gratuitement en WebRTC. Il n'y a ni tarif
  // GSM ni provider téléphonique dans ce parcours.
  const mbotePeer = await db.get(
    "SELECT id, phone, name, avatar, status FROM users WHERE phone = ?",
    [to],
  );
  if (mbotePeer) {
    if (mbotePeer.status === 'blocked')
      return res.status(403).json({ error: 'Ce compte ne peut pas recevoir d’appel' });
    const id = uid('ca');
    const ts = now();
    await db.run(
      `INSERT INTO calls(id,user_id,callee,direction,destination,price_per_min_cents,max_sec,status,started_at,callee_user_id,rtc_mode,with_video)
       VALUES(?,?,?,'outgoing','MboteCall',0,3600,'ringing',?,?,1,?)`,
      [id, req.user.id, to, ts, mbotePeer.id, req.body.with_video === true ? 1 : 0],
    );
    return res.json({
      call_id: id,
      destination: 'MboteCall',
      price_per_min_cents: 0,
      max_sec: 3600,
      provider: 'rtc',
      free_reason: 'mbote',
      callee_name: mbotePeer.name || to,
      callee_avatar: mbotePeer.avatar || null,
    });
  }

  // AUTORISATION temps réel : tarif + solde AVANT de connecter (règle d'or)
  const rate = await findRate(to);
  if (!rate) return res.status(404).json({ error: 'Destination non couverte' });

  // 🎉 Happy hour : le prix remisé est figé dans le CDR au moment de l'appel
  const promo = await bestPromoFor(to);
  const price = discounted(rate.price_per_min_cents, promo);

  const w = await db.get('SELECT balance_cents FROM wallets WHERE user_id = ?', [req.user.id]);
  if (w.balance_cents < Math.ceil(price / 2))
    return res.status(402).json({ error: 'Crédit insuffisant — rechargez votre compte', code: 'NO_CREDIT' });

  const maxSec = Math.floor((w.balance_cents * 60) / price);
  const id = uid('ca');
  await db.run(
    `INSERT INTO calls(id,user_id,callee,destination,price_per_min_cents,max_sec,status,started_at)
     VALUES(?,?,?,?,?,?,'ringing',?)`,
    [id, req.user.id, to, rate.destination, price, maxSec, now()]);

  getProvider().placeCall({ callId: id, to });

  res.json({
    call_id: id,
    destination: rate.destination, flag: rate.flag,
    price_per_min_cents: price,
    promo: promo ? { title: promo.title, discount_pct: promo.discount_pct } : null,
    max_sec: maxSec,
    provider: getProvider().name,
  });
}));

/* Journalisation idempotente des appels de groupe WebRTC, toujours gratuits. */
r.post('/group/start', requireAuth, ah(async (req, res) => {
  const groupId = String(req.body.call_id || '').trim();
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(groupId))
    return res.status(400).json({ error: 'Identifiant d’appel de groupe invalide' });
  const id = `grp_${groupId}`;
  const existing = await db.get('SELECT id,user_id,rtc_mode FROM calls WHERE id=?', [id]);
  if (existing && (existing.user_id !== req.user.id || existing.rtc_mode !== 2))
    return res.status(409).json({ error: 'Identifiant d’appel déjà utilisé' });
  if (!existing) {
    const active = await db.get(
      "SELECT id FROM calls WHERE (user_id=? OR callee_user_id=?) AND status!='ended' LIMIT 1",
      [req.user.id, req.user.id],
    );
    if (active) return res.status(409).json({ error: 'Un appel est déjà en cours' });
    const ts = now();
    await db.run(`INSERT INTO calls
      (id,user_id,callee,direction,destination,price_per_min_cents,max_sec,status,started_at,answered_at,rtc_mode)
      VALUES(?,?,?,'outgoing','MboteCall',0,43200,'answered',?,?,2)`,
    [id, req.user.id, 'Mbote Famille', ts, ts]);
  }
  res.json({ ok: true, call_id: id, duplicate: !!existing });
}));

r.post('/group/:callId/end', requireAuth, ah(async (req, res) => {
  const id = `grp_${String(req.params.callId || '').trim()}`;
  const call = await db.get('SELECT id,status FROM calls WHERE id=? AND user_id=? AND rtc_mode=2', [id, req.user.id]);
  if (!call) return res.status(404).json({ error: 'Appel de groupe introuvable' });
  if (call.status !== 'ended') {
    const duration = Math.max(0, Math.min(12 * 60 * 60, Number(req.body.duration_sec) || 0));
    await db.run(`UPDATE calls SET status='ended',ended_at=?,billed_sec=?,cost_cents=0,hangup_cause='user_hangup'
      WHERE id=? AND user_id=? AND status!='ended'`, [now(), duration, id, req.user.id]);
  }
  res.json({ ok: true, cost_cents: 0 });
}));

/* ---------- 2) Statut en direct ---------- */
r.get('/:id/status', requireAuth, ah(async (req, res) => {
  let call = await db.get('SELECT * FROM calls WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
  if (!call) return res.status(404).json({ error: 'Appel introuvable' });

  if (call.status !== 'ended') {
    call = await syncState(call);
    // ⚡ Coupure automatique si le crédit est épuisé
    const { elapsed } = liveNumbers(call);
    if (call.answered_at && elapsed >= call.max_sec) {
      call = await finalize(call, 'no_credit');
    }
  }

  const { elapsed, cost } = liveNumbers(call);
  const w = await db.get('SELECT balance_cents FROM wallets WHERE user_id = ?', [req.user.id]);
  res.json({
    status: call.status,
    elapsed_sec: elapsed,
    cost_cents: cost,
    remaining_sec: Math.max(0, call.max_sec - elapsed),
    balance_after_cents: call.status === 'ended' ? w.balance_cents : w.balance_cents - cost,
    hangup_cause: call.hangup_cause,
  });
}));

/* ---------- 3) Raccrocher ---------- */
r.post('/:id/hangup', requireAuth, ah(async (req, res) => {
  let call = await db.get('SELECT * FROM calls WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
  if (!call) return res.status(404).json({ error: 'Appel introuvable' });
  if (call.rtc_mode) {
    if (call.status !== 'ended') {
      const elapsed = call.answered_at ? Math.max(0, Math.floor((now() - call.answered_at) / 1000)) : 0;
      await db.run(
        "UPDATE calls SET status='ended', ended_at=?, billed_sec=?, cost_cents=0, hangup_cause='user_hangup' WHERE id=? AND status!='ended'",
        [now(), elapsed, call.id],
      );
      rtcWs.endCall(call.id, 'cancel');
    }
    call = await db.get('SELECT * FROM calls WHERE id = ?', [call.id]);
    return res.json({ ok: true, billed_sec: call.billed_sec || 0, cost_cents: 0 });
  }
  if (call.status !== 'ended') call = await finalize(await syncState(call), 'user_hangup');
  res.json({ ok: true, billed_sec: call.billed_sec, cost_cents: call.cost_cents });
}));

/* Journalisation idempotente des appels RTC entrants, refusés et manqués. */
r.post('/log-incoming', requireAuth, ah(async (req, res) => {
  const from = normalizePhone(req.body.from);
  if (!from) return res.status(400).json({ error: 'Numéro appelant invalide' });
  const callId = String(req.body.call_id || '').trim().slice(0, 120);
  const cause = ['missed', 'declined'].includes(req.body.cause) ? req.body.cause : null;
  const billedSec = Math.max(0, Math.min(24 * 60 * 60, Number(req.body.billed_sec) || 0));

  if (callId) {
    const existing = await db.get(
      'SELECT * FROM calls WHERE id = ? AND rtc_mode = 1 AND (callee_user_id = ? OR user_id = ?)',
      [callId, req.user.id, req.user.id],
    );
    if (existing) {
      if (existing.status !== 'ended') {
        const answeredAt = existing.answered_at || (billedSec > 0 ? existing.started_at : null);
        await db.run(
          "UPDATE calls SET status='ended', ended_at=?, answered_at=?, billed_sec=?, cost_cents=0, hangup_cause=? WHERE id=?",
          [now(), answeredAt, billedSec, cause || 'remote_hangup', callId],
        );
      }
      return res.json({ ok: true, duplicate: existing.status === 'ended' });
    }

    // Les appels de groupe n'ont pas de ligne dans `calls`. Enregistrer leur
    // événement sans créer une seconde ligne à chaque renvoi client.
    const duplicate = await db.get('SELECT id FROM calls WHERE id = ?', [callId]);
    if (!duplicate) {
      await db.run(
        `INSERT INTO calls(id,user_id,callee,direction,destination,price_per_min_cents,max_sec,status,started_at,ended_at,billed_sec,cost_cents,hangup_cause,rtc_mode)
         VALUES(?,?,?,'incoming','MboteCall',0,3600,'ended',?,?,?,?,?,1)`,
        [callId, req.user.id, from, now(), now(), billedSec, 0, cause || 'missed'],
      );
    }
  }
  res.json({ ok: true });
}));

/* ---------- 4) Historique ---------- */
r.get('/history', requireAuth, ah(async (req, res) => {
  const rows = await db.all(
    `SELECT c.id,
            CASE WHEN c.user_id = ? THEN c.callee ELSE COALESCE(u.phone, c.callee) END AS callee,
            CASE WHEN c.user_id = ? THEN 'outgoing' ELSE 'incoming' END AS direction,
            c.destination, c.status, c.started_at, c.billed_sec, c.cost_cents, c.hangup_cause
     FROM calls c LEFT JOIN users u ON u.id = c.user_id
     WHERE c.user_id = ? OR c.callee_user_id = ?
     ORDER BY c.started_at DESC LIMIT 100`, [req.user.id, req.user.id, req.user.id, req.user.id]);
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime();
  const month = await db.get(
    `SELECT COALESCE(SUM(billed_sec),0) s, COALESCE(SUM(cost_cents),0) c
     FROM calls WHERE user_id = ? AND started_at >= ?`, [req.user.id, monthStart]);
  res.json({ calls: rows, month_sec: Number(month.s), month_cost_cents: Number(month.c) });
}));

/* ---------- 5) Jeton SDK voix (Twilio) pour l'app ---------- */
r.get('/voice-token', requireAuth, (req, res) => {
  res.json(getProvider().clientToken('user_' + req.user.id));
});

module.exports = r;
