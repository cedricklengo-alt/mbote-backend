/**
 * Module CALLS — le cœur : autorisation, appel, décompte temps réel, CDR.
 *
 * Cycle de vie :
 *   POST /start        → vérifie solde + tarif, réserve, lance l'appel (provider)
 *   GET  /:id/status   → état + coût en direct (l'app interroge chaque seconde)
 *                        coupe automatiquement si le crédit est épuisé
 *   POST /:id/hangup   → fin d'appel, débit définitif, CDR
 *   GET  /history      → historique de l'utilisateur
 */
const express = require('express');
const db = require('../db');
const { uid, now, normalizePhone, costFor } = require('../util');
const { requireAuth } = require('../middleware/auth');
const { findRate } = require('./rating.routes');
const { getProvider } = require('../providers');

const r = express.Router();

/* ---------- Helpers ---------- */
// Synchronise l'état provider → BDD (transition sonnerie → décroché)
function syncState(call) {
  if (call.status === 'ended' || call.answered_at) return call;
  if (getProvider().getCallState(call) === 'answered') {
    const at = getProvider().answerTime ? getProvider().answerTime(call) : now();
    db.prepare(`UPDATE calls SET status='answered', answered_at=? WHERE id=?`).run(at, call.id);
    return db.prepare('SELECT * FROM calls WHERE id = ?').get(call.id);
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

function finalize(call, cause) {
  const { elapsed, cost } = liveNumbers(call);
  const tx = db.transaction(() => {
    db.prepare(`UPDATE calls SET status='ended', ended_at=?, billed_sec=?, cost_cents=?, hangup_cause=? WHERE id=?`)
      .run(now(), elapsed, cost, cause, call.id);
    if (cost > 0) {
      db.prepare('UPDATE wallets SET balance_cents = MAX(0, balance_cents - ?) WHERE user_id = ?').run(cost, call.user_id);
      db.prepare('INSERT INTO transactions(id,user_id,type,amount_cents,method,reference,created_at) VALUES(?,?,?,?,?,?,?)')
        .run(uid('tx'), call.user_id, 'call_debit', -cost, 'system', `Appel ${call.callee} (${elapsed}s)`, now());
    }
  });
  tx();
  try { getProvider().hangup(call); } catch { /* best effort */ }
  return db.prepare('SELECT * FROM calls WHERE id = ?').get(call.id);
}

/* ---------- 1) Démarrer un appel ---------- */
r.post('/start', requireAuth, (req, res) => {
  const to = normalizePhone(req.body.to);
  if (!to) return res.status(400).json({ error: 'Numéro invalide (format +243…)' });

  // Un seul appel actif par utilisateur (anti-abus basique)
  const active = db.prepare(`SELECT id FROM calls WHERE user_id=? AND status != 'ended'`).get(req.user.id);
  if (active) return res.status(409).json({ error: 'Un appel est déjà en cours' });

  // AUTORISATION temps réel : tarif + solde AVANT de connecter (règle d'or)
  const rate = findRate(to);
  if (!rate) return res.status(404).json({ error: 'Destination non couverte' });

  const w = db.prepare('SELECT balance_cents FROM wallets WHERE user_id = ?').get(req.user.id);
  if (w.balance_cents < Math.ceil(rate.price_per_min_cents / 2))
    return res.status(402).json({ error: 'Crédit insuffisant — rechargez votre compte', code: 'NO_CREDIT' });

  const maxSec = Math.floor((w.balance_cents * 60) / rate.price_per_min_cents);
  const id = uid('ca');
  db.prepare(`INSERT INTO calls(id,user_id,callee,destination,price_per_min_cents,max_sec,status,started_at)
              VALUES(?,?,?,?,?,?, 'ringing', ?)`)
    .run(id, req.user.id, to, rate.destination, rate.price_per_min_cents, maxSec, now());

  getProvider().placeCall({ callId: id, to });

  res.json({
    call_id: id,
    destination: rate.destination, flag: rate.flag,
    price_per_min_cents: rate.price_per_min_cents,
    max_sec: maxSec,
    provider: getProvider().name,
  });
});

/* ---------- 2) Statut en direct (poll chaque seconde par l'app) ---------- */
r.get('/:id/status', requireAuth, (req, res) => {
  let call = db.prepare('SELECT * FROM calls WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!call) return res.status(404).json({ error: 'Appel introuvable' });

  if (call.status !== 'ended') {
    call = syncState(call);
    // ⚡ Coupure automatique si le crédit est épuisé
    const { elapsed } = liveNumbers(call);
    if (call.answered_at && elapsed >= call.max_sec) {
      call = finalize(call, 'no_credit');
    }
  }

  const { elapsed, cost } = liveNumbers(call);
  const w = db.prepare('SELECT balance_cents FROM wallets WHERE user_id = ?').get(req.user.id);
  res.json({
    status: call.status,
    elapsed_sec: elapsed,
    cost_cents: cost,
    remaining_sec: Math.max(0, call.max_sec - elapsed),
    balance_after_cents: call.status === 'ended' ? w.balance_cents : w.balance_cents - cost,
    hangup_cause: call.hangup_cause,
  });
});

/* ---------- 3) Raccrocher ---------- */
r.post('/:id/hangup', requireAuth, (req, res) => {
  let call = db.prepare('SELECT * FROM calls WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!call) return res.status(404).json({ error: 'Appel introuvable' });
  if (call.status !== 'ended') call = finalize(syncState(call), 'user_hangup');
  res.json({ ok: true, billed_sec: call.billed_sec, cost_cents: call.cost_cents });
});

/* ---------- 4) Historique ---------- */
r.get('/history', requireAuth, (req, res) => {
  const rows = db.prepare(`SELECT id, callee, destination, status, started_at, billed_sec, cost_cents, hangup_cause
                           FROM calls WHERE user_id = ? ORDER BY started_at DESC LIMIT 100`).all(req.user.id);
  const month = db.prepare(`SELECT COALESCE(SUM(billed_sec),0) s, COALESCE(SUM(cost_cents),0) c
                            FROM calls WHERE user_id = ? AND started_at >= ?`)
    .get(req.user.id, new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime());
  res.json({ calls: rows, month_sec: month.s, month_cost_cents: month.c });
});

/* ---------- 5) Jeton SDK voix (Twilio) pour l'app ---------- */
r.get('/voice-token', requireAuth, (req, res) => {
  res.json(getProvider().clientToken('user_' + req.user.id));
});

module.exports = r;
