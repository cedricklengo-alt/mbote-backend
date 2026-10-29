/**
 * 🔔 Notifications push Firebase (FCM) — v3.0
 *
 * Trois familles de notifications, chacune avec le bon canal Android :
 *
 *  1. 📞 APPEL ENTRANT (réveil de l'app, même fermée)
 *     - message « data-only » priorité HAUTE : l'app se réveille en arrière-plan
 *       et affiche elle-même l'écran d'appel plein écran avec sonnerie ;
 *     - si l'app n'a pas confirmé (« ack ») sous quelques secondes, le serveur
 *       envoie en renfort une notification VISIBLE (sendCallFallbackPush) : le
 *       téléphone sonne/vibre quoi qu'il arrive, sans que l'app ait à tourner.
 *     - annulation (sendCallCancelPush) : l'appelant raccroche → l'écran
 *       d'appel disparaît chez l'appelé.
 *
 *  2. 💬 MESSAGES : notification visible, canal « messages » (importance haute),
 *     petite icône monochrome et couleur de marque.
 *
 *  3. 📵 APPEL MANQUÉ : remplace la notification d'appel (même tag).
 *
 * Nettoyage automatique : un jeton que FCM déclare périmé est effacé de la
 * base (plus jamais de « push envoyé » dans le vide).
 *
 * Configuration (Render → Environment) :
 *   FIREBASE_SERVICE_ACCOUNT = contenu JSON complet de la clé privée Firebase.
 * Sans elle, le push est désactivé (l'app fonctionne ouverte uniquement).
 */

let messaging = null; // client Firebase prêt à envoyer
let fake = false;     // 🧪 simulation pour les tests locaux
const sentLog = [];   // 🧪 journal des envois simulés (tests automatisés)

// 🎨 Identifiants partagés avec l'app (AndroidManifest + MboteApplication.kt)
const CH_CALLS = 'mbote_calls';
const CH_MESSAGES = 'mbote_messages';
const SMALL_ICON = 'ic_stat_mbote';
const BRAND_COLOR = '#F5A623';

let onInvalidToken = null; // (token) => Promise — posé par server.js

function init() {
  if (String(process.env.PUSH_DEBUG_FAKE || '') === 'true') {
    fake = true;
    console.log('🧪 Push en mode SIMULATION (PUSH_DEBUG_FAKE=true) — aucun envoi réel');
    return;
  }
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) {
    console.log('🔕 Notifications push désactivées (FIREBASE_SERVICE_ACCOUNT absente)');
    return;
  }
  try {
    const admin = require('firebase-admin');
    const app = admin.initializeApp({
      credential: admin.credential.cert(JSON.parse(raw)),
    });
    messaging = admin.messaging(app);
    console.log('🔔 Notifications push Firebase prêtes (appels app fermée)');
  } catch (e) {
    console.error('⚠️ Clé Firebase refusée — push désactivé :', e.message);
    messaging = null;
  }
}

/** Le push est-il utilisable ? */
const enabled = () => fake || !!messaging;

/** Enregistre la fonction qui efface un jeton périmé de la base */
function setInvalidTokenHandler(fn) { onInvalidToken = fn; }

/** 🧪 Journal des envois simulés (lecture seule, tests) */
function getSentLog() { return sentLog.slice(); }
function clearSentLog() { sentLog.length = 0; }

const DEAD_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
]);

/** Les valeurs « data » FCM doivent être du texte ; certaines clés sont réservées */
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

/**
 * Envoi centralisé : journal en mode simulation, nettoyage des jetons morts,
 * jamais d'exception vers l'appelant. → true si FCM a accepté le message.
 */
async function deliver(kind, token, message) {
  if (fake) {
    sentLog.push({ at: Date.now(), kind, token: String(token), message });
    if (sentLog.length > 300) sentLog.shift();
    console.log(`🧪 [SIMULATION] push ${kind} → jeton ${String(token).slice(0, 12)}…`);
    // 🧪 Un jeton « dead-… » simule un jeton périmé côté FCM (test du nettoyage)
    if (String(token).startsWith('dead-')) {
      if (onInvalidToken) { try { await onInvalidToken(token); } catch (_) {} }
      return false;
    }
    return true;
  }
  if (!messaging || !token) return false;
  try {
    await messaging.send({ token, ...message });
    return true;
  } catch (e) {
    console.error(`⚠️ Envoi push ${kind} KO :`, e.code || '', e.message);
    if (DEAD_CODES.has(e.code) && onInvalidToken) {
      try {
        await onInvalidToken(token);
        console.log('🧹 Jeton FCM périmé effacé de la base');
      } catch (_) {}
    }
    return false;
  }
}

/**
 * 📞 Réveil d'appel — message DATA-ONLY, priorité haute.
 * (Un message « notification » ne réveille PAS le code de l'app : le système
 * l'affiche seul. Data-only = l'app décide et affiche l'écran d'appel.)
 * TTL 45 s : au-delà, l'appel a expiré de toute façon.
 */
function sendCallPush(token, { callId, fromName, fromPhone }) {
  return deliver('call', token, {
    android: { priority: 'high', ttl: 45000 },
    data: cleanData({
      kind: 'incoming_call',
      call_id: callId,
      // ⚠️ « from » est RÉSERVÉ par FCM (rejet silencieux) → from_phone
      from_phone: fromPhone,
      from_name: fromName || '',
    }),
  });
}

/**
 * 📞 Renfort VISIBLE : envoyée seulement si l'app n'a pas confirmé le réveil.
 * Le canal « appels » (importance max, sonnerie) est créé par l'app.
 */
function sendCallFallbackPush(token, { callId, fromName, fromPhone }) {
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
    data: cleanData({
      kind: 'incoming_call',
      call_id: callId,
      from_phone: fromPhone,
      from_name: fromName || '',
    }),
  });
}

/**
 * 🚫 L'appelant a raccroché / l'appel a expiré : fait disparaître l'écran
 * d'appel chez l'appelé (message data-only, traité par l'app en arrière-plan).
 */
function sendCallCancelPush(token, { callId, fromPhone, reason }) {
  return deliver('call_cancel', token, {
    android: { priority: 'high', ttl: 30000 },
    data: cleanData({
      kind: 'call_cancel',
      call_id: callId,
      from_phone: fromPhone,
      // 'cancel' = l'appelant a renoncé (appel manqué) · 'answered' = décroché
      // sur un autre écran (pas un appel manqué)
      reason: reason || 'cancel',
    }),
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
    data: cleanData({
      kind: 'message', // toucher → ouvre le fil avec la personne
      from_phone: fromPhone,
      from_name: fromName || '',
    }),
  });
}

/**
 * 💬 Notification d'information (messages, notes vocales, alertes sécurité).
 */
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

module.exports = {
  init, enabled, setInvalidTokenHandler, getSentLog, clearSentLog,
  sendCallPush, sendCallFallbackPush, sendCallCancelPush,
  sendMissedCallPush, sendInfoPush,
  CH_CALLS, CH_MESSAGES,
};
