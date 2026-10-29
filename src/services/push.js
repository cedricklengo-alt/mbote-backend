/**
 * 🔔 Notifications push Firebase (FCM)
 *
 * Rôle : réveiller le téléphone de l'appelé quand son app MboteCall est
 * FERMÉE — comme WhatsApp. Le serveur envoie une notification « X t'appelle »,
 * l'utilisateur touche la notification, l'app s'ouvre, et l'appel mis en
 * attente (voir rtc.ws.js) lui est livré.
 *
 * Configuration (Render → Environment) :
 *   FIREBASE_SERVICE_ACCOUNT = contenu JSON complet de la clé privée
 *   téléchargée dans Firebase (Paramètres → Comptes de service).
 *
 * Sans cette variable, le push est simplement désactivé : les appels
 * fonctionnent comme avant (app ouverte uniquement).
 */

let messaging = null; // client Firebase prêt à envoyer
let fake = false;     // 🧪 mode simulation pour les tests locaux

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

/**
 * 📲 « X t'appelle sur MboteCall » — notification haute priorité.
 * TTL 45 s : si le téléphone est injoignable plus longtemps, la notification
 * est abandonnée (l'appel aura expiré de toute façon).
 */
async function sendCallPush(token, fromName, fromPhone) {
  if (fake) {
    console.log(`🧪 [SIMULATION] push appel de ${fromPhone} → jeton ${String(token).slice(0, 12)}…`);
    return true;
  }
  if (!messaging || !token) return false;
  try {
    await messaging.send({
      token,
      android: {
        priority: 'high',
        ttl: 45000,
        notification: { priority: 'max', sound: 'default', tag: 'mbote-call' },
      },
      notification: {
        title: '📞 Appel MboteCall',
        body: `${fromName || fromPhone} t'appelle — touche pour répondre`,
      },
      data: {
        kind: 'incoming_call',
        // ⚠️ « from » est un mot RÉSERVÉ par FCM (rejet silencieux !) → from_phone
        from_phone: String(fromPhone),
        from_name: String(fromName || ''),
      },
    });
    return true;
  } catch (e) {
    console.error('⚠️ Envoi push KO :', e.message);
    return false;
  }
}

/**
 * 📵 v2.9.1 — Appel manqué : REMPLACE la notification « t'appelle »
 * (même tag "mbote-call") pour ne jamais laisser une fausse sonnerie
 * dans la barre. Toucher la notification ouvre la conversation avec
 * la personne (kind=message → navigation déjà en place dans l'app).
 */
async function sendMissedCallPush(token, fromName, fromPhone) {
  if (fake) {
    console.log(`🧪 [SIMULATION] push appel manqué de ${fromPhone}`);
    return true;
  }
  if (!messaging || !token) return false;
  try {
    await messaging.send({
      token,
      android: {
        priority: 'high',
        ttl: 3600000,
        notification: { priority: 'high', tag: 'mbote-call' },
      },
      notification: {
        title: '📵 Appel manqué',
        body: `${fromName || fromPhone} a essayé de te joindre`,
      },
      data: {
        kind: 'message', // toucher → ouvre le fil avec la personne
        from_phone: String(fromPhone),
        from_name: String(fromName || ''),
      },
    });
    return true;
  } catch (e) {
    console.error('⚠️ Envoi push appel manqué KO :', e.message);
    return false;
  }
}

/**
 * ℹ️ Notification d'information (ex. alerte sécurité « PIN réinitialisé »)
 */
async function sendInfoPush(token, title, body, data) {
  if (fake) {
    console.log(`🧪 [SIMULATION] push info « ${title} »`);
    return true;
  }
  if (!messaging || !token) return false;
  try {
    // FCM exige des valeurs texte dans data — et INTERDIT certaines clés
    // réservées (« from », « notification », « message_type », gcm*/google*) :
    // les présentes seraient rejetées silencieusement → on les écarte.
    const safeData = {};
    for (const [k, v] of Object.entries(data || {})) {
      if (k === 'from' || k === 'notification' || k === 'message_type' ||
          k.startsWith('google') || k.startsWith('gcm')) continue;
      safeData[k] = String(v);
    }
    await messaging.send({
      token,
      android: {
        priority: 'high',
        // 🔔 regroupe les notifs d'un même expéditeur (pas de spam)
        notification: safeData.from_phone ? { tag: `msg-${safeData.from_phone}` } : {},
      },
      notification: { title, body },
      data: safeData,
    });
    return true;
  } catch (e) {
    console.error('⚠️ Envoi push info KO :', e.message);
    return false;
  }
}

module.exports = { init, enabled, sendCallPush, sendMissedCallPush, sendInfoPush };
