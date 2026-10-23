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
        from: String(fromPhone),
        from_name: String(fromName || ''),
      },
    });
    return true;
  } catch (e) {
    console.error('⚠️ Envoi push KO :', e.message);
    return false;
  }
}

module.exports = { init, enabled, sendCallPush };
