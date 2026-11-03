/**
 * ============================================================================
 *  SERVICE TWILIO — un seul point d'entrée pour le compte fournisseur
 * ============================================================================
 *
 * Ce service isole TOUT ce qui touche au compte Twilio de l'entreprise :
 *   • configuration et détection de disponibilité ;
 *   • balance réelle du compte  (API Balance) ;
 *   • consommation consolidée   (API Usage Records) ;
 *   • inventaire des numéros    (API Incoming Phone Numbers) ;
 *   • envoi de SMS              (Programmable Messaging) ;
 *   • statut d'un appel / d'un message (Call & Message Resources) ;
 *   • vérification des signatures de webhook.
 *
 * RÈGLES DE CONCEPTION (importantes) :
 *   1. La balance Twilio est celle du COMPTE FOURNISSEUR. Elle n'est jamais
 *      confondue avec le portefeuille d'un utilisateur et ne le modifie pas.
 *   2. Un service non configuré n'est PAS un service à zéro : chaque fonction
 *      renvoie `{ configured:false, error }` — un solde nul et une erreur de
 *      récupération restent deux choses distinctes à l'écran.
 *   3. Aucun secret n'est journalisé ni renvoyé au client. Seuls des drapeaux
 *      (`configured`, `has_auth_token`…) sortent de ce module.
 *   4. Les prix ne sont jamais inventés : on relaie `price` / `priceUnit`
 *      fournis par Twilio, ou `null` si l'API ne les donne pas encore.
 *
 * Variables d'environnement :
 *   TWILIO_ACCOUNT_SID        SID du compte (AC…)
 *   TWILIO_AUTH_TOKEN         jeton d'authentification (obligatoire pour la
 *                             balance et pour vérifier les signatures)
 *   TWILIO_API_KEY / _SECRET  clé API à portée limitée (recommandée pour les
 *                             appels à l'API ; la balance exige le jeton)
 *   TWILIO_FROM_NUMBER        numéro expéditeur E.164 pour les SMS/appels
 *   TWILIO_TWIML_APP_SID      TwiML App utilisée par le SDK Voice de l'app
 *   PUBLIC_URL                URL publique du backend (callbacks)
 */
'use strict';

const SERVICE = 'twilio';

let Twilio = null;
try {
  Twilio = require('twilio'); // présent dans package.json (^5.3.7)
} catch {
  /* paquet absent : le service restera proprement « non configuré » */
}

/** Lit la configuration à chaque appel (aucune copie en cache d'un secret). */
function config() {
  return {
    accountSid: process.env.TWILIO_ACCOUNT_SID || '',
    authToken: process.env.TWILIO_AUTH_TOKEN || '',
    apiKey: process.env.TWILIO_API_KEY || '',
    apiSecret: process.env.TWILIO_API_SECRET || '',
    fromNumber: process.env.TWILIO_FROM_NUMBER || '',
    twimlAppSid: process.env.TWILIO_TWIML_APP_SID || '',
    publicUrl: (process.env.PUBLIC_URL || '').replace(/\/$/, ''),
  };
}

/** Le SDK est-il utilisable (identifiants présents) ? */
function configured() {
  const c = config();
  return Boolean(Twilio && c.accountSid && (c.authToken || (c.apiKey && c.apiSecret)));
}

/** La balance exige le jeton d'authentification (une clé API ne suffit pas). */
function balanceAvailable() {
  const c = config();
  return Boolean(Twilio && c.accountSid && c.authToken);
}

/** Les SMS sortants exigent un numéro expéditeur. */
function smsAvailable() {
  return configured() && Boolean(config().fromNumber);
}

function client() {
  const c = config();
  if (c.apiKey && c.apiSecret) {
    return Twilio(c.apiKey, c.apiSecret, { accountSid: c.accountSid });
  }
  return Twilio(c.accountSid, c.authToken);
}

/** Erreur métier homogène (jamais de secret dans le message). */
function notConfigured(quoi) {
  return Object.assign(
    new Error(`Twilio non configuré : ${quoi} indisponible. Renseignez TWILIO_ACCOUNT_SID et TWILIO_AUTH_TOKEN.`),
    { status: 409, code: 'TWILIO_NOT_CONFIGURED', expose: true },
  );
}

/** Vue publique de la configuration (aucun secret). */
function publicConfig() {
  const c = config();
  return {
    sdk_installed: Boolean(Twilio),
    has_account_sid: Boolean(c.accountSid),
    has_auth_token: Boolean(c.authToken),
    has_api_key: Boolean(c.apiKey && c.apiSecret),
    has_from_number: Boolean(c.fromNumber),
    has_twiml_app: Boolean(c.twimlAppSid),
    public_url: c.publicUrl || null,
    configured: configured(),
    balance_available: balanceAvailable(),
    sms_available: smsAvailable(),
    // Où Twilio Console doit pointer les callbacks :
    webhook_urls: {
      voice: c.publicUrl ? `${c.publicUrl}/api/twilio/voice` : null,
      call_status: c.publicUrl ? `${c.publicUrl}/api/twilio/status` : null,
      sms_status: c.publicUrl ? `${c.publicUrl}/api/twilio/sms-status` : null,
      voice_fallback: c.publicUrl ? `${c.publicUrl}/api/twilio/voice-fallback` : null,
    },
  };
}

/* ────────────────────────────── BALANCE ───────────────────────────────── */

/**
 * Balance réelle du compte fournisseur.
 * @returns {Promise<{configured:boolean, ok:boolean, amount:number|null,
 *                    currency:string|null, fetched_at:number, error?:string}>}
 */
async function balance() {
  const fetchedAt = Date.now();
  if (!balanceAvailable()) {
    return {
      configured: false,
      ok: false,
      amount: null,
      currency: null,
      fetched_at: fetchedAt,
      error: 'Balance indisponible : TWILIO_AUTH_TOKEN (ou le SDK) manque.',
      code: 'TWILIO_NOT_CONFIGURED',
    };
  }
  try {
    const b = await client().balance.fetch();
    return {
      configured: true,
      ok: true,
      amount: Number(b.balance),
      currency: b.currency || 'USD',
      account_sid: b.accountSid || null,
      fetched_at: fetchedAt,
    };
  } catch (e) {
    // Une erreur n'est JAMAIS traduite en solde nul.
    return {
      configured: true,
      ok: false,
      amount: null,
      currency: null,
      fetched_at: fetchedAt,
      error: (e && e.message) || 'Erreur Twilio',
      code: (e && e.code) || null,
      http_status: (e && e.status) || null,
    };
  }
}

/* ──────────────────────────── CONSOMMATION ────────────────────────────── */

/** Catégories d'usage Twilio utiles au pilotage (documentées par Twilio). */
const USAGE_CATEGORIES = ['calls', 'calls-inbound', 'calls-outbound', 'sms', 'sms-outbound'];

/**
 * Usage Records consolidés sur les N derniers jours.
 *
 * Twilio consolide ces données avec un décalage (souvent quelques heures) :
 * elles servent aux rapports, pas au débit temps réel.
 *
 * @param {{days?:number, category?:string}} opts
 */
async function usage({ days = 7, category = 'calls' } = {}) {
  const fetchedAt = Date.now();
  if (!configured()) {
    return {
      configured: false,
      ok: false,
      records: [],
      totals: { count: 0, usage: 0, price: null, currency: null },
      fetched_at: fetchedAt,
      error: 'Usage indisponible : Twilio non configuré.',
      code: 'TWILIO_NOT_CONFIGURED',
    };
  }
  const safeDays = Math.min(90, Math.max(1, Number(days) || 7));
  const startDate = new Date(fetchedAt - safeDays * 86400_000);
  const cat = USAGE_CATEGORIES.includes(category) ? category : 'calls';
  try {
    const list = await client().usage.records.list({ category: cat, startDate, limit: 100 });
    const records = list.map((r) => ({
      category: r.category,
      description: r.description || null,
      count: Number(r.count || 0),
      // `usage` est une chaîne côté SDK (« 12 » ou « 12.5 »)
      usage: r.usage == null ? null : Number(r.usage),
      usage_unit: r.usageUnit || null,
      price: r.price == null ? null : Number(r.price),
      price_unit: r.priceUnit || null,
      start_date: r.startDate ? new Date(r.startDate).getTime() : null,
      end_date: r.endDate ? new Date(r.endDate).getTime() : null,
    }));
    const totals = records.reduce(
      (acc, r) => {
        acc.count += r.count;
        acc.usage += r.usage || 0;
        if (r.price != null) {
          acc.price = (acc.price || 0) + r.price;
          acc.currency = acc.currency || r.price_unit;
        }
        return acc;
      },
      { count: 0, usage: 0, price: null, currency: null },
    );
    return { configured: true, ok: true, category: cat, days: safeDays, records, totals, fetched_at: fetchedAt };
  } catch (e) {
    return {
      configured: true,
      ok: false,
      category: cat,
      days: safeDays,
      records: [],
      totals: { count: 0, usage: 0, price: null, currency: null },
      fetched_at: fetchedAt,
      error: (e && e.message) || 'Erreur Twilio',
      code: (e && e.code) || null,
    };
  }
}

/* ─────────────────────────────── NUMÉROS ──────────────────────────────── */

/**
 * Inventaire des numéros Twilio du compte.
 * Aucun achat / suppression n'est déclenché ici : lecture seule.
 */
async function numbers() {
  const fetchedAt = Date.now();
  if (!configured()) {
    return {
      configured: false,
      ok: false,
      numbers: [],
      fetched_at: fetchedAt,
      error: 'Numéros indisponibles : Twilio non configuré.',
      code: 'TWILIO_NOT_CONFIGURED',
    };
  }
  try {
    const list = await client().incomingPhoneNumbers.list({ limit: 100 });
    return {
      configured: true,
      ok: true,
      fetched_at: fetchedAt,
      numbers: list.map((n) => ({
        sid: n.sid,
        phone_number: n.phoneNumber,
        friendly_name: n.friendlyName || null,
        // Twilio donne le pays sur certains numéros ; sinon null (pas d'invention)
        country: n.addressRequirements && n.addressRequirements.length ? null : null,
        capabilities: {
          voice: Boolean(n.capabilities && n.capabilities.voice),
          sms: Boolean(n.capabilities && n.capabilities.sms),
          mms: Boolean(n.capabilities && n.capabilities.mms),
        },
        status_callback: n.statusCallback || null,
        voice_url: n.voiceUrl || null,
        sms_url: n.smsUrl || null,
        date_created: n.dateCreated ? new Date(n.dateCreated).getTime() : null,
      })),
    };
  } catch (e) {
    return {
      configured: true,
      ok: false,
      numbers: [],
      fetched_at: fetchedAt,
      error: (e && e.message) || 'Erreur Twilio',
      code: (e && e.code) || null,
    };
  }
}

/* ──────────────────────────────── MESSAGES ────────────────────────────── */

/**
 * Envoie un SMS via Twilio Programmable Messaging.
 *
 * `statusCallback` permet de recevoir delivered / undelivered / failed sur
 * /api/twilio/sms-status : un message « accepté » n'est PAS un message livré.
 */
async function sendSms({ to, body, statusCallback } = {}) {
  if (!smsAvailable()) throw notConfigured('l’envoi de SMS');
  const c = config();
  const msg = await client().messages.create({
    to,
    from: c.fromNumber,
    body,
    statusCallback: statusCallback || (c.publicUrl ? `${c.publicUrl}/api/twilio/sms-status` : undefined),
  });
  return {
    sid: msg.sid,
    status: (msg.status || 'queued').toLowerCase(),
    num_segments: msg.numSegments ? Number(msg.numSegments) : null,
    price: msg.price == null ? null : Number(msg.price),
    price_unit: msg.priceUnit || null,
    date_created: msg.dateCreated ? new Date(msg.dateCreated).getTime() : Date.now(),
  };
}

/** Statut consolidé d'un message (source de vérité pour un rapprochement). */
async function fetchMessage(sid) {
  if (!configured()) throw notConfigured('la lecture d’un message');
  const m = await client().messages(sid).fetch();
  return {
    sid: m.sid,
    status: (m.status || '').toLowerCase(),
    error_code: m.errorCode ? Number(m.errorCode) : null,
    error_message: m.errorMessage || null,
    num_segments: m.numSegments ? Number(m.numSegments) : null,
    price: m.price == null ? null : Number(m.price),
    price_unit: m.priceUnit || null,
  };
}

/** Statut consolidé d'un appel. */
async function fetchCall(sid) {
  if (!configured()) throw notConfigured('la lecture d’un appel');
  const c = await client().calls(sid).fetch();
  return {
    sid: c.sid,
    status: (c.status || '').toLowerCase(),
    duration: c.duration ? Number(c.duration) : 0,
    start_time: c.startTime ? new Date(c.startTime).getTime() : null,
    end_time: c.endTime ? new Date(c.endTime).getTime() : null,
    price: c.price == null ? null : Number(c.price),
    price_unit: c.priceUnit || null,
    to: c.to || null,
    from: c.from || null,
  };
}

/* ────────────────────────────────── TWIML ─────────────────────────────── */

/**
 * TwiML de sortie pour un appel GSM : Twilio compose le numéro demandé.
 *
 * Le coût fournisseur n'est pas calculé ici — Twilio le consolidera dans les
 * Usage Records. Le débit client reste décidé par `services/twilio_billing.js`.
 */
function voiceTwiml({ to, callerId, statusCallback } = {}) {
  if (!Twilio) throw notConfigured('la génération TwiML');
  const { VoiceResponse } = Twilio.twiml;
  const vr = new VoiceResponse();
  if (!to || !/^\+\d{8,15}$/.test(String(to))) {
    vr.say({ language: 'fr-FR' }, 'Numéro invalide. Au revoir.');
    vr.hangup();
    return vr.toString();
  }
  const c = config();
  const dial = vr.dial({
    callerId: callerId || c.fromNumber || undefined,
    answerOnBridge: true,
    action: c.publicUrl ? `${c.publicUrl}/api/twilio/status` : undefined,
  });
  dial.number(
    {
      statusCallback: statusCallback || (c.publicUrl ? `${c.publicUrl}/api/twilio/status` : undefined),
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      statusCallbackMethod: 'POST',
    },
    String(to),
  );
  return vr.toString();
}

/** TwiML d'échec (numéro non autorisé, appel refusé côté serveur…). */
function voiceFallbackTwiml(message = 'Appel indisponible. Au revoir.') {
  if (!Twilio) throw notConfigured('la génération TwiML');
  const { VoiceResponse } = Twilio.twiml;
  const vr = new VoiceResponse();
  vr.say({ language: 'fr-FR' }, message);
  vr.hangup();
  return vr.toString();
}

/* ─────────────────────────── SIGNATURES WEBHOOK ───────────────────────── */

/**
 * Vérifie la signature `X-Twilio-Signature` d'un webhook.
 *
 * Sans TWILIO_AUTH_TOKEN, la vérification est IMPOSSIBLE : on refuse alors
 * (fail-closed) au lieu d'accepter n'importe quel appelant. En développement,
 * `TWILIO_ALLOW_UNSIGNED=true` permet de tester les webhooks localement —
 * le drapeau est journalisé une fois pour qu'il ne passe pas inaperçu.
 */
let _unsignedWarned = false;
function validateSignature(req) {
  const c = config();
  const signature = req.headers['x-twilio-signature'];
  if (!c.authToken) {
    if (String(process.env.TWILIO_ALLOW_UNSIGNED || 'false') === 'true') {
      if (!_unsignedWarned) {
        console.warn('⚠️  Twilio : webhooks acceptés SANS signature (TWILIO_ALLOW_UNSIGNED=true) — développement uniquement.');
        _unsignedWarned = true;
      }
      return true;
    }
    return false;
  }
  if (!signature) return false;
  try {
    // L'URL signée par Twilio est l'URL PUBLIQUE exacte du webhook.
    const url = c.publicUrl ? `${c.publicUrl}${req.originalUrl}` : `${req.protocol}://${req.get('host')}${req.originalUrl}`;
    return Twilio.validateRequest(c.authToken, signature, url, req.body || {});
  } catch {
    return false;
  }
}

module.exports = {
  SERVICE,
  config,
  configured,
  balanceAvailable,
  smsAvailable,
  publicConfig,
  balance,
  usage,
  numbers,
  sendSms,
  fetchMessage,
  fetchCall,
  voiceTwiml,
  voiceFallbackTwiml,
  validateSignature,
  USAGE_CATEGORIES,
};
