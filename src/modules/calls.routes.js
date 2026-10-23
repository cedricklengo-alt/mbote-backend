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
const packages = require('../services/packages');

const r = express.Router();

/* ---------- Helpers ---------- */
// Synchronise l'état provider → BDD (transition sonnerie → décroché)
async function syncState(call) {
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
    // 📦 Décompte des minutes du forfait utilisé
    if (call.user_package_id && elapsed > 0)
      await packages.consumeInsideTx(t, call.user_package_id, elapsed);
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

  const active = await db.get(`SELECT id FROM calls WHERE user_id=? AND status != 'ended'`, [req.user.id]);
  if (active) return res.status(409).json({ error: 'Un appel est déjà en cours' });

  const FREE_CAP_SEC = 4 * 3600; // 4 h max par appel gratuit
  let price, maxSec, destination, flag, promo = null, packId = null, freeReason = null;
  let calleeName = null, calleeAvatar = null;

  // 💚 1. Appel MboteCall : GRATUIT si l'appelé a l'app
  const toUser = await db.get(
    `SELECT id, name, avatar FROM users WHERE phone = ? AND role = 'user' AND status = 'active'`, [to]);
  if (toUser && toUser.id !== req.user.id) {
    price = 0; destination = 'MboteCall'; flag = '💚';
    maxSec = FREE_CAP_SEC; freeReason = 'mbote';
    calleeName = toUser.name || null;
    calleeAvatar = toUser.avatar || null; // 📷 la photo de l'appelé s'affiche pendant l'appel
  } else {
    const rate = await findRate(to);
    if (!rate) return res.status(404).json({ error: 'Destination non couverte' });
    destination = rate.destination; flag = rate.flag;

    // 📦 2. Forfait actif couvrant la destination
    const pack = await packages.findActive(req.user.id, to);
    if (pack) {
      price = 0; packId = pack.id; freeReason = 'package';
      maxSec = pack.unlimited ? FREE_CAP_SEC : Math.min(FREE_CAP_SEC, pack.remaining_sec);
    } else {
      // 🎉 3. Tarif à la minute (remisé si Happy Hour)
      promo = await bestPromoFor(to);
      price = discounted(rate.price_per_min_cents, promo);
      const w = await db.get('SELECT balance_cents FROM wallets WHERE user_id = ?', [req.user.id]);
      if (w.balance_cents < Math.ceil(price / 2))
        return res.status(402).json({ error: 'Crédit insuffisant — recharge ton compte', code: 'NO_CREDIT' });
      maxSec = Math.floor((w.balance_cents * 60) / price);
    }
  }

  const id = uid('ca');
  await db.run(
    `INSERT INTO calls(id,user_id,callee,destination,price_per_min_cents,max_sec,status,started_at,user_package_id)
     VALUES(?,?,?,?,?,?,'ringing',?,?)`,
    [id, req.user.id, to, destination, price, maxSec, now(), packId]);

  getProvider().placeCall({ callId: id, to });

  res.json({
    call_id: id,
    destination, flag,
    price_per_min_cents: price,
    // 🎙️ L'appelé est-il joignable en voix réelle (app ouverte) ?
    rtc_online: freeReason === 'mbote' && require('./rtc.ws').isOnline(to),
    free_reason: freeReason, // 'mbote' | 'package' | null
    callee_name: calleeName,
    callee_avatar: calleeAvatar,
    promo: promo ? { title: promo.title, discount_pct: promo.discount_pct } : null,
    max_sec: maxSec,
    provider: getProvider().name,
  });
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
  if (call.status !== 'ended') call = await finalize(await syncState(call), 'user_hangup');
  res.json({ ok: true, billed_sec: call.billed_sec, cost_cents: call.cost_cents });
}));

/* ---------- 4) Historique ---------- */
r.get('/history', requireAuth, ah(async (req, res) => {
  const rows = await db.all(
    `SELECT id, callee, destination, status, started_at, billed_sec, cost_cents, hangup_cause, direction
     FROM calls WHERE user_id = ? ORDER BY started_at DESC LIMIT 100`, [req.user.id]);
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime();
  const month = await db.get(
    `SELECT COALESCE(SUM(billed_sec),0) s, COALESCE(SUM(cost_cents),0) c
     FROM calls WHERE user_id = ? AND started_at >= ?`, [req.user.id, monthStart]);
  res.json({ calls: rows, month_sec: Number(month.s), month_cost_cents: Number(month.c) });
}));

/* ---------- 4bis) 📥 Journal d'un appel MboteCall REÇU (vraie voix) ----------
   Appelé par l'app du destinataire à la fin d'un appel entrant :
   répondu (billed_sec > 0) ou manqué/refusé (billed_sec = 0). */
r.post('/log-incoming', requireAuth, ah(async (req, res) => {
  const from = normalizePhone(req.body.from);
  if (!from) return res.status(400).json({ error: 'Numéro invalide' });
  const billed = Math.max(0, Math.min(86400, parseInt(req.body.billed_sec, 10) || 0));
  await db.run(
    `INSERT INTO calls(id,user_id,callee,destination,price_per_min_cents,max_sec,status,started_at,ended_at,billed_sec,cost_cents,hangup_cause,direction)
     VALUES(?,?,?,?,0,0,'ended',?,?,?,0,?,'in')`,
    [uid('ca'), req.user.id, from, 'MboteCall',
     now() - billed * 1000, now(), billed,
     billed > 0 ? 'remote_hangup' : 'missed']);
  res.json({ ok: true });
}));

/* ---------- 5) Jeton SDK voix (Twilio) pour l'app ---------- */
r.get('/voice-token', requireAuth, (req, res) => {
  res.json(getProvider().clientToken('user_' + req.user.id));
});

module.exports = r;
