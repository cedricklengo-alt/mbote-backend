/**
 * 🔔 Notifications push Firebase (FCM) — v3.1
 *
 * Transport : FCM HTTP v1 (aucune dépendance native, un simple POST HTTPS).
 * Deux familles d'appelants coexistent dans le code, les deux sont servies :
 *
 *   1. API « jeton » (rtc.ws, lokota, dial_later) :
 *        sendCallPush · sendCallFallbackPush · sendCallCancelPush
 *        sendMissedCallPush · sendInfoPush · sendData
 *
 *   2. API « utilisateur » (messages.routes, services) :
 *        sendUser(userId, { data, title, body, channel, collapseKey })
 *        → résout tous les appareils de l'utilisateur (device_tokens).
 *
 * Configuration (Render → Environment), l'un OU l'autre :
 *   FIREBASE_SERVICE_ACCOUNT = contenu JSON complet de la clé privée Firebase
 *   FCM_PROJECT_ID + FCM_CLIENT_EMAIL + FCM_PRIVATE_KEY = les mêmes champs
 *     éclatés en trois variables.
 * Sans ces variables, le push est désactivé (l'app fonctionne ouverte
 * uniquement) et enabled() renvoie false.
 *
 * 🧪 PUSH_DEBUG_FAKE=true → mode simulation : rien n'est envoyé, les envois
 * sont journalisés (getSentLog) pour les tests automatisés.
 */

'use strict';

const https = require('https');
const jwt = require('jsonwebtoken');
const db = require('../db');

// 🎨 Identifiants partagés avec l'app (AndroidManifest + MboteApplication.kt)
const CH_CALLS = 'mbote_calls';
const CH_MESSAGES = 'mbote_messages';
const SMALL_ICON = 'ic_stat_mbote';
const BRAND_COLOR = '#F5A623';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

let fake = false;              // 🧪 simulation (tests)
let initialised = false;
const sentLog = [];            // 🧪 journal des envois simulés
let onInvalidToken = null;     // (token) => Promise — posé par le serveur
let cachedAccessToken = null;
let cachedUntil = 0;

/* ─────────────────────────── Configuration ─────────────────────────── */

/** Clé de service Firebase, quelle que soit la façon dont elle est fournie. */
function credentials() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (raw && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      const projectId = parsed.project_id || parsed.projectId;
      const clientEmail = parsed.client_email || parsed.clientEmail;
      const privateKey = (parsed.private_key || parsed.privateKey || '').replace(/\\n/g, '\n');
      if (projectId && clientEmail && privateKey) return { projectId, clientEmail, privateKey };
    } catch {
      console.error('⚠️ FIREBASE_SERVICE_ACCOUNT illisible (JSON attendu) — push ignoré');
    }
  }
  const projectId = process.env.FCM_PROJECT_ID;
  const clientEmail = process.env.FCM_CLIENT_EMAIL;
  const privateKey = process.env.FCM_PRIVATE_KEY && process.env.FCM_PRIVATE_KEY.replace(/\\n/g, '\n');
  return projectId && clientEmail && privateKey ? { projectId, clientEmail, privateKey } : null;
}

/** Initialisation explicite (facultative : tout est paresseux). Idempotente. */
function init() {
  if (initialised) return supportsPushNow();
  initialised = true;
  if (String(process.env.PUSH_DEBUG_FAKE || '') === 'true') {
    fake = true;
    console.log('🧪 Push en mode SIMULATION (PUSH_DEBUG_FAKE=true) — aucun envoi réel');
    return true;
  }
  if (!credentials()) {
    console.log('🔕 Notifications push désactivées (FIREBASE_SERVICE_ACCOUNT absente)');
    return false;
  }
  console.log('🔔 Notifications push Firebase prêtes (appels app fermée)');
  return true;
}

const supportsPushNow = () => fake || !!credentials();

/** Le push est-il utilisable ? */
function enabled() {
  if (!initialised) init();
  return supportsPushNow();
}

/** Enregistre la fonction qui efface un jeton périmé de la base */
function setInvalidTokenHandler(fn) { onInvalidToken = fn; }

/** 🧪 Journal des envois simulés (lecture seule, tests) */
function getSentLog() { return sentLog.slice(); }
function clearSentLog() { sentLog.length = 0; }

/* ─────────────────────────── Transport ─────────────────────────── */

function postJson(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = https.request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': data.length, ...headers },
      timeout: 10000,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        let parsed = {};
        try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
        resolve({ status: res.statusCode || 0, body: parsed });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(data);
  });
}

async function accessToken(creds) {
  if (cachedAccessToken && Date.now() < cachedUntil - 60000) return cachedAccessToken;
  const issuedAt = Math.floor(Date.now() / 1000);
  const assertion = jwt.sign({
    iss: creds.clientEmail,
    scope: FCM_SCOPE,
    aud: TOKEN_URL,
    iat: issuedAt,
    exp: issuedAt + 3600,
  }, creds.privateKey, { algorithm: 'RS256' });
  const form = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion,
  }).toString();
  const response = await new Promise((resolve, reject) => {
    const data = Buffer.from(form);
    const req = https.request(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': data.length },
      timeout: 10000,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        let parsed = {};
        try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
        resolve({ status: res.statusCode || 0, body: parsed });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(data);
  });
  if (response.status < 200 || response.status >= 300 || !response.body.access_token) {
    throw new Error('FCM OAuth token unavailable');
  }
  cachedAccessToken = response.body.access_token;
  cachedUntil = Date.now() + Number(response.body.expires_in || 3600) * 1000;
  return cachedAccessToken;
}

/* ─────────────────── Normalisation des charges utiles ───────────────────
 * Les appelants historiques décrivent le message avec les noms de champs
 * de firebase-admin (channelId, defaultSound, priority: 'max'…). On les
 * traduit ici vers le format HTTP v1, pour ne pas toucher aux appelants.
 */

const RE_DEAD = /UNREGISTERED|NOT_REGISTERED|INVALID_ARGUMENT.*token/i;

/** Les valeurs « data » doivent être du texte ; certaines clés sont réservées */
function cleanData(data) {
  const out = {};
  for (const [k, v] of Object.entries(data || {})) {
    if (v === undefined || v === null) continue;
    if (k === 'from' || k === 'notification' || k === 'message_type' ||
        k.startsWith('google') || k.startsWith('gcm')) continue;
    out[k] = String(v);
  }
  return out;
}

const PRIORITY_MAP = {
  max: 'PRIORITY_MAX', high: 'PRIORITY_HIGH', normal: 'PRIORITY_DEFAULT',
  low: 'PRIORITY_LOW', min: 'PRIORITY_MIN',
};

function ttlToDuration(ttl) {
  if (ttl == null) return undefined;
  if (typeof ttl === 'string') return ttl;           // déjà « 45s »
  if (!Number.isFinite(ttl)) return undefined;
  return `${Math.max(1, Math.round(ttl / 1000))}s`;  // millisecondes
}

/** Traduit { android, notification, data } (firebase-admin) → message HTTP v1 */
function toV1Payload({ data, notification, android } = {}) {
  const message = {};
  const clean = cleanData(data);
  if (Object.keys(clean).length) message.data = clean;
  if (notification && (notification.title || notification.body)) {
    message.notification = { title: notification.title, body: notification.body };
  }
  if (android) {
    const n = android.notification || {};
    const androidNotification = {};
    if (n.title || notification?.title) androidNotification.title = n.title || notification?.title;
    if (n.body || notification?.body) androidNotification.body = n.body || notification?.body;
    if (n.channelId || n.channel_id) androidNotification.channel_id = n.channelId || n.channel_id;
    if (n.icon) androidNotification.icon = n.icon;
    if (n.color) androidNotification.color = n.color;
    if (n.tag) androidNotification.tag = n.tag;
    if (n.clickAction) androidNotification.click_action = n.clickAction;
    if (n.visibility) androidNotification.visibility = String(n.visibility).toUpperCase();
    if (n.priority && PRIORITY_MAP[n.priority]) androidNotification.notification_priority = PRIORITY_MAP[n.priority];
    if (n.defaultSound || n.sound) androidNotification.sound = n.sound || 'default';
    if (n.defaultVibrateTimings) androidNotification.default_vibrate_timings = true;
    message.android = {
      ...(android.priority ? { priority: String(android.priority).toUpperCase() } : {}),
      ...(ttlToDuration(android.ttl) ? { ttl: ttlToDuration(android.ttl) } : {}),
      ...(android.collapseKey ? { collapse_key: android.collapseKey } : {}),
      ...(Object.keys(androidNotification).length ? { notification: androidNotification } : {}),
    };
  }
  return message;
}

const DEAD_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'UNREGISTERED',
]);

/**
 * Envoi bas niveau vers UN jeton : journal en mode simulation, nettoyage des
 * jetons morts, jamais d'exception vers l'appelant.
 * → true si FCM a accepté le message.
 */
async function deliver(kind, token, payload) {
  if (fake) {
    sentLog.push({ at: Date.now(), kind, token: String(token), message: payload });
    if (sentLog.length > 300) sentLog.shift();
    console.log(`🧪 [SIMULATION] push ${kind} → jeton ${String(token).slice(0, 12)}…`);
    // 🧪 Un jeton « dead-… » simule un jeton périmé côté FCM (test du nettoyage)
    if (String(token).startsWith('dead-')) {
      if (onInvalidToken) { try { await onInvalidToken(token); } catch {} }
      return false;
    }
    return true;
  }
  if (!token) return false;
  const creds = credentials();
  if (!creds) return false;
  try {
    const bearer = await accessToken(creds);
    const response = await postJson(
      `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(creds.projectId)}/messages:send`,
      { message: { token, ...toV1Payload(payload) } },
      { authorization: `Bearer ${bearer}` },
    );
    if (response.status >= 200 && response.status < 300) return true;
    const blob = JSON.stringify(response.body || {});
    const code = response.body?.error?.status || response.body?.error?.details?.[0]?.errorCode || '';
    console.error(`⚠️ Envoi push ${kind} KO : ${response.status} ${code}`);
    if ((RE_DEAD.test(blob) || DEAD_CODES.has(code)) && onInvalidToken) {
      try {
        await onInvalidToken(token);
        console.log('🧹 Jeton FCM périmé effacé de la base');
      } catch {}
    }
    return false;
  } catch (e) {
    console.error(`⚠️ Envoi push ${kind} KO :`, e.message);
    return false;
  }
}

/* ───────────────────── API « jeton » (historique) ───────────────────── */

/**
 * 📞 Réveil d'appel — DATA-ONLY, priorité haute.
 * (Un message « notification » ne réveille PAS le code de l'app : le système
 * l'affiche seul. Data-only = l'app décide et affiche l'écran d'appel.)
 * TTL 45 s : au-delà, l'appel a expiré de toute façon.
 */
function sendCallPush(token, { callId, fromName, fromPhone } = {}) {
  return deliver('call', token, {
    android: { priority: 'high', ttl: 45000 },
    data: {
      kind: 'incoming_call',
      call_id: callId,
      // ⚠️ « from » est RÉSERVÉ par FCM (rejet silencieux) → from_phone
      from_phone: fromPhone,
      from_name: fromName || '',
    },
  });
}

/**
 * 📞 Renfort VISIBLE : envoyée seulement si l'app n'a pas confirmé le réveil.
 * Le canal « appels » (importance max, sonnerie) est créé par l'app.
 */
function sendCallFallbackPush(token, { callId, fromName, fromPhone } = {}) {
  return deliver('call_fallback', token, {
    android: {
      priority: 'high',
      ttl: 40000,
      notification: {
        channelId: CH_CALLS,
        icon: SMALL_ICON,
        color: BRAND_COLOR,
        priority: 'max',
        defaultSound: true,
        defaultVibrateTimings: true,
        visibility: 'public',
        tag: 'mbote-call',
      },
    },
    notification: {
      title: 'Appel MboteCall',
      body: `${fromName || fromPhone} t'appelle — touche pour répondre`,
    },
    data: {
      kind: 'incoming_call',
      call_id: callId,
      from_phone: fromPhone,
      from_name: fromName || '',
    },
  });
}

/**
 * 🚫 L'appelant a raccroché / l'appel a expiré : fait disparaître l'écran
 * d'appel chez l'appelé (data-only, traité par l'app en arrière-plan).
 */
function sendCallCancelPush(token, { callId, fromPhone, reason } = {}) {
  return deliver('call_cancel', token, {
    android: { priority: 'high', ttl: 30000 },
    data: {
      kind: 'call_cancel',
      call_id: callId,
      from_phone: fromPhone,
      // 'cancel' = l'appelant a renoncé (appel manqué) · 'answered' = décroché
      // sur un autre écran (pas un appel manqué)
      reason: reason || 'cancel',
    },
  });
}

/**
 * 📵 Appel manqué : REMPLACE la notification « t'appelle » (même tag) pour ne
 * jamais laisser une fausse sonnerie dans la barre. Toucher → ouvre le fil.
 */
function sendMissedCallPush(token, fromName, fromPhone) {
  return deliver('missed', token, {
    android: {
      priority: 'high',
      ttl: 3600000,
      notification: {
        channelId: CH_MESSAGES,
        icon: SMALL_ICON,
        color: BRAND_COLOR,
        priority: 'high',
        tag: 'mbote-call',
      },
    },
    notification: {
      title: 'Appel manqué',
      body: `${fromName || fromPhone} a essayé de te joindre`,
    },
    data: {
      kind: 'message', // toucher → ouvre le fil avec la personne
      from_phone: fromPhone,
      from_name: fromName || '',
    },
  });
}

/** 💬 Notification d'information (messages, notes vocales, alertes sécurité). */
function sendInfoPush(token, title, body, data) {
  const safe = cleanData(data);
  return deliver('info', token, {
    android: {
      priority: 'high',
      notification: {
        channelId: CH_MESSAGES,
        icon: SMALL_ICON,
        color: BRAND_COLOR,
        priority: 'high',
        defaultSound: true,
        visibility: 'private',
        // 🔔 regroupe les notifs d'un même expéditeur (pas de spam)
        ...(safe.from_phone ? { tag: `msg-${safe.from_phone}` } : {}),
      },
    },
    notification: { title, body },
    data: safe,
  });
}

/** 📨 Push « data-only » générique (réveil, présence, rappels programmés). */
function sendData(token, data, opts = {}) {
  return deliver('data', token, {
    android: { priority: opts.priority || 'high', ttl: opts.ttl },
    data,
  });
}

/* ──────────────────── API « utilisateur » (moderne) ──────────────────── */

/**
 * Jetons FCM de tous les appareils d'un utilisateur.
 * Source de vérité : la table `device_tokens` (alimentée par
 * POST /api/auth/fcm-token). Repli sur l'ancienne colonne users.fcm_token.
 */
async function tokensForUser(userId) {
  if (!userId) return [];
  const rows = await db.all('SELECT token FROM device_tokens WHERE user_id = ?', [userId]).catch(() => []);
  if (rows && rows.length) return rows.map((r) => r.token).filter(Boolean);
  const legacy = await db.get('SELECT fcm_token FROM users WHERE id = ?', [userId]).catch(() => null);
  return legacy && legacy.fcm_token ? [legacy.fcm_token] : [];
}

/**
 * Un seul jeton pour joindre un utilisateur (le dernier appareil enregistré).
 * Utilisé par les chemins d'appel, qui raisonnent « un téléphone qui sonne ».
 */
async function primaryToken(userId) {
  if (!userId) return null;
  const row = await db.get('SELECT token FROM device_tokens WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1', [userId]).catch(() => null);
  if (row && row.token) return row.token;
  const legacy = await db.get('SELECT fcm_token FROM users WHERE id = ?', [userId]).catch(() => null);
  return legacy && legacy.fcm_token ? legacy.fcm_token : null;
}

/** Envoie un push à tous les appareils d'un utilisateur. */
async function sendUser(userId, { data, title, body, channel = 'messages', collapseKey } = {}) {
  if (!userId) return false;
  if (!enabled()) return false;
  try {
    const prefs = await db.get('SELECT notifications_enabled FROM users WHERE id = ?', [userId]).catch(() => null);
    if (prefs && prefs.notifications_enabled === 0) return false;
    const tokens = await tokensForUser(userId);
    if (!tokens.length) return false;
    const payload = {
      data,
      ...(title && body ? { notification: { title, body } } : {}),
      android: {
        priority: channel === 'calls' ? 'high' : 'normal',
        ttl: channel === 'calls' ? 60000 : 86400000,
        ...(collapseKey ? { collapseKey } : {}),
        notification: {
          channelId: channel === 'calls' ? CH_CALLS : CH_MESSAGES,
          ...(channel === 'calls' ? { defaultSound: true } : {}),
        },
      },
    };
    const results = await Promise.all(tokens.map((token) => deliver('user', token, payload)));
    return results.some(Boolean);
  } catch {
    return false;
  }
}

module.exports = {
  // cycle de vie
  init, enabled, setInvalidTokenHandler, getSentLog, clearSentLog,
  // API « jeton »
  sendCallPush, sendCallFallbackPush, sendCallCancelPush,
  sendMissedCallPush, sendInfoPush, sendData,
  // API « utilisateur »
  sendUser, tokensForUser, primaryToken,
  // constantes partagées avec l'app
  CH_CALLS, CH_MESSAGES,
};
