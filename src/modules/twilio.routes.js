/**
 * ============================================================================
 *  ROUTES TWILIO — callbacks temps réel + supervision du compte fournisseur
 * ============================================================================
 *
 * PUBLIC (appelé par Twilio, jamais par l'app) :
 *   POST /api/twilio/voice           → TwiML d'un appel sortant (TwiML App)
 *   POST /api/twilio/voice-fallback  → TwiML d'échec
 *   POST /api/twilio/status          → statut d'appel (initiated→completed)
 *   POST /api/twilio/sms-status      → statut de message (queued→delivered)
 *
 * ADMIN (JWT + rôle `admin` vérifié CÔTÉ SERVEUR) :
 *   GET  /api/twilio/admin/status    → configuration, balance, URLs à déclarer
 *   GET  /api/twilio/admin/usage     → consommation consolidée (Usage Records)
 *   GET  /api/twilio/admin/numbers   → inventaire des numéros
 *   GET  /api/twilio/admin/overview  → tout en un, chaque partie isolée
 *
 * SÉCURITÉ :
 *   • signature X-Twilio-Signature vérifiée (fail-closed) ;
 *   • événements répétés ignorés (idempotence par statut final) ;
 *   • ordre inattendu géré (un « completed » avant un « ringing » ne casse rien) ;
 *   • aucun montant fourni par un client n'est utilisé pour créditer un compte ;
 *   • réponse rapide (< 1 s) : les traitements longs sont faits avant de répondre
 *     mais restent bornés (aucune boucle réseau).
 */
'use strict';

const express = require('express');
const db = require('../db');
const { now, normalizePhone, ah } = require('../util');
const { requireAdmin } = require('../middleware/auth');
const twilio = require('../services/twilio');
const smsService = require('../services/sms_service');
const { finalizeTwilioCall } = require('../services/twilio_billing');

const r = express.Router();

/* Les webhooks Twilio arrivent en `application/x-www-form-urlencoded`.
 * Le corps brut est capturé par server.js (req.rawBody) pour les signatures. */
const twilioBody = express.urlencoded({ extended: false, limit: '256kb' });

/** Statuts d'appel Twilio normalisés vers nos états internes. */
const CALL_STATUS_MAP = {
  queued: 'ringing',
  initiated: 'ringing',
  ringing: 'ringing',
  'in-progress': 'answered',
  completed: 'ended',
  busy: 'ended',
  failed: 'ended',
  'no-answer': 'ended',
  canceled: 'ended',
};

/* ───────────────────────────── VOICE (TwiML) ──────────────────────────── */

/**
 * TwiML App : l'app appelle ce point avec `To=+243…`.
 * Le numéro n'est accepté que s'il correspond à un appel autorisé et récent
 * (créé par POST /api/calls/start) : impossible d'utiliser notre compte
 * Twilio comme passerelle libre.
 */
r.post('/voice', twilioBody, ah(async (req, res) => {
  res.type('text/xml');
  if (!twilio.validateSignature(req)) {
    return res.status(403).send(twilio.voiceFallbackTwiml('Signature invalide. Appel refusé.').toString());
  }

  const to = normalizePhone(req.body.To || req.body.to);
  const identity = String(req.body.From || req.body.from || ''); // client:user_xxx
  const userId = identity.startsWith('client:user_') ? identity.slice('client:user_'.length) : null;

  if (!to || !userId) {
    return res.status(200).send(twilio.voiceFallbackTwiml('Appel non autorisé.').toString());
  }

  // Un appel doit avoir été autorisé par /calls/start il y a moins de 2 minutes.
  const authorized = await db.get(
    `SELECT * FROM calls
      WHERE user_id = ? AND callee = ? AND status != 'ended' AND started_at >= ?
      ORDER BY started_at DESC LIMIT 1`,
    [userId, to, now() - 120_000],
  );
  if (!authorized) {
    return res.status(200).send(twilio.voiceFallbackTwiml('Aucun appel autorisé pour ce numéro.').toString());
  }

  res.send(twilio.voiceTwiml({ to, callerId: twilio.config().fromNumber }));
}));

r.post('/voice-fallback', twilioBody, ah(async (req, res) => {
  res.type('text/xml');
  if (!twilio.validateSignature(req)) return res.status(403).send('<Response><Hangup/></Response>');
  res.send(twilio.voiceFallbackTwiml('Le service d’appel est momentanément indisponible.'));
}));

/* ─────────────────────────── STATUT D'APPEL ───────────────────────────── */

/**
 * Statut d'appel. Idempotent et tolérant à l'ordre d'arrivée.
 * Déclenche la facturation UNE SEULE FOIS, sur l'état terminal.
 */
r.post('/status', twilioBody, ah(async (req, res) => {
  if (!twilio.validateSignature(req)) {
    console.warn('⚠️  Webhook /api/twilio/status rejeté : signature invalide');
    return res.sendStatus(403);
  }

  const b = req.body || {};
  const sid = b.CallSid || b.call_sid || (b.ParentCallSid || null);
  const twilioStatus = String(b.CallStatus || b.call_status || '').toLowerCase();
  if (!sid || !twilioStatus) return res.json({ ok: true, ignored: 'paramètres manquants' });

  // Durée fournie par Twilio (entier, en secondes) — jamais par le client.
  const durationSec = Math.max(0, Math.floor(Number(b.CallDuration || b.call_duration || 0) || 0));
  const internal = CALL_STATUS_MAP[twilioStatus] || 'ringing';

  // Retrouver l'appel : par SID fournisseur (après un premier callback), sinon
  // par destination + appel en cours le plus récent (< 5 min).
  let call = await db.get('SELECT * FROM calls WHERE provider_sid = ?', [sid]);
  if (!call) {
    const to = normalizePhone(b.To || b.to);
    const from = normalizePhone(b.From || b.from);
    const candidate = await db.get(
      `SELECT * FROM calls
        WHERE provider_sid IS NULL AND status != 'ended'
          AND (callee = ? OR callee = ?)
          AND started_at >= ?
        ORDER BY started_at DESC LIMIT 1`,
      [to || '', from || '', now() - 300_000],
    );
    call = candidate || null;
    if (call) await db.run('UPDATE calls SET provider_sid = ? WHERE id = ?', [sid, call.id]);
  }

  if (!call) {
    // Un appel lancé hors application (console Twilio…) : on ne crée pas de
    // ligne client, on se contente de journaliser pour l'audit.
    console.log(`🔔 Statut Twilio ${sid} (${twilioStatus}) — appel hors application, ignoré côté facturation`);
    return res.json({ ok: true, ignored: 'appel inconnu' });
  }

  // Idempotence : un appel déjà terminé ne se re-facture jamais.
  if (call.status === 'ended') {
    return res.json({ ok: true, duplicate: true, status: 'ended' });
  }

  if (internal !== 'ended') {
    const patch = { status: internal };
    await db.run(
      `UPDATE calls SET status = ?, answered_at = COALESCE(answered_at, ?) WHERE id = ?`,
      [patch.status, internal === 'answered' ? now() : null, call.id],
    );
    return res.json({ ok: true, status: patch.status });
  }

  // ── État terminal : facturation (une seule fois, en transaction)
  const price = Number(call.price_per_min_cents) || 0;
  const priceCur = call.provider_sid ? (b.Price || null) : null;
  const priceUnit = b.PriceUnit || 'USD';
  const mappedStatus = ['completed'].includes(twilioStatus) ? 'completed' : twilioStatus;

  try {
    const result = await finalizeTwilioCall({
      callId: call.id,
      status: mappedStatus,
      durationSec,
      pricePerMinCents: price,
      userId: call.user_id,
      twilioPrice: priceCur,
      twilioPriceCurrency: priceUnit,
    });
    console.log(`📞 Appel ${call.id} → ${mappedStatus} (${durationSec}s) débit ${result.debit_cents}¢`);
    return res.json({ ok: true, status: 'ended', debit_cents: result.debit_cents });
  } catch (e) {
    // On répond 200 pour éviter une tempête de réessais ; l'appel reste
    // « à régulariser » et la console admin le signale.
    console.error('💥 Facturation d’appel impossible :', e.message);
    await db.run('UPDATE calls SET hangup_cause = ? WHERE id = ?', ['billing_error', call.id]).catch(() => {});
    return res.json({ ok: true, pending: true });
  }
}));

/* ─────────────────────────── STATUT DE MESSAGE ────────────────────────── */

r.post('/sms-status', twilioBody, ah(async (req, res) => {
  if (!twilio.validateSignature(req)) {
    console.warn('⚠️  Webhook /api/twilio/sms-status rejeté : signature invalide');
    return res.sendStatus(403);
  }
  const b = req.body || {};
  const sid = b.MessageSid || b.SmsSid || b.sid;
  const status = b.MessageStatus || b.SmsStatus || b.status;
  const errorCode = b.ErrorCode || b.error_code || null;

  const out = await smsService.applyStatus({ sid, status, errorCode });
  return res.json({ ok: true, ...out });
}));

/* ─────────────────────────────── ADMIN ────────────────────────────────── */

/** Configuration + balance : jamais une erreur présentée comme un solde nul. */
r.get('/admin/status', requireAdmin, ah(async (req, res) => {
  const bal = await twilio.balance();
  res.json({
    config: twilio.publicConfig(),
    balance: bal,
    fetched_at: now(),
  });
}));

/** Consommation consolidée (Usage Records) — ?days=7&category=calls */
r.get('/admin/usage', requireAdmin, ah(async (req, res) => {
  const days = Number(req.query.days) || 7;
  const category = String(req.query.category || 'calls');
  res.json(await twilio.usage({ days, category }));
}));

/** Inventaire des numéros Twilio (lecture seule : aucun achat). */
r.get('/admin/numbers', requireAdmin, ah(async (req, res) => {
  res.json(await twilio.numbers());
}));

/**
 * Vue d'ensemble pour le tableau de bord administrateur.
 * Chaque partie est isolée : si la balance échoue, l'usage reste affiché.
 */
r.get('/admin/overview', requireAdmin, ah(async (req, res) => {
  const days = Math.min(90, Math.max(1, Number(req.query.days) || 7));
  const [bal, callsUsage, smsUsage, nums] = await Promise.all([
    twilio.balance().catch((e) => ({ configured: twilio.configured(), ok: false, amount: null, currency: null, error: e.message, fetched_at: now() })),
    twilio.usage({ days, category: 'calls' }).catch((e) => ({ configured: twilio.configured(), ok: false, records: [], error: e.message })),
    twilio.usage({ days, category: 'sms' }).catch((e) => ({ configured: twilio.configured(), ok: false, records: [], error: e.message })),
    twilio.numbers().catch((e) => ({ configured: twilio.configured(), ok: false, numbers: [], error: e.message })),
  ]);

  // Données internes (toujours disponibles, même sans Twilio) : elles
  // permettent de comparer ce que l'on a facturé aux clients.
  const since = now() - days * 86400_000;
  const [billed, txPending] = await Promise.all([
    db.get(
      `SELECT COALESCE(SUM(cost_cents),0) c, COUNT(*) n, COALESCE(SUM(billed_sec),0) s
         FROM calls WHERE cost_cents > 0 AND started_at >= ?`,
      [since],
    ),
    db.get(
      `SELECT COUNT(*) n FROM transactions WHERE status = 'pending' AND created_at >= ?`,
      [since],
    ),
  ]);

  res.json({
    days,
    config: twilio.publicConfig(),
    balance: bal,
    usage: { calls: callsUsage, sms: smsUsage },
    numbers: nums,
    internal: {
      billed_calls: Number(billed.n || 0),
      billed_sec: Number(billed.s || 0),
      billed_cents: Number(billed.c || 0),
      pending_transactions: Number(txPending.n || 0),
    },
    fetched_at: now(),
  });
}));

module.exports = r;
