/* 🧪 Test e2e v2.9.1 — garde anti-socket-fantôme + appel manqué.
 * Scénario 1 : B connecté mais MUET (app tuée sans fermer le socket).
 *   A envoie une offre → au bout de 4,5 s le serveur doit :
 *   ① fermer le socket fantôme de B  ② mettre l'appel en salle d'attente
 *   ③ répondre « push-sent » à A.
 *   Puis B se reconnecte (= notification touchée) → il doit recevoir
 *   l'offre + les ICE rejoués.
 * Scénario 2 : A raccroche pendant que l'appel est en salle d'attente
 *   → log « appel manqué » (push simulé).
 */
const WebSocket = require('ws');
const http = require('http');

const BASE = 'http://localhost:3000/api';
function req(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(BASE + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
      },
    }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(new Error(b)); } });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function login(phone) {
  const o = await req('POST', '/auth/request-otp', { phone });
  const v = await req('POST', '/auth/verify-otp', { phone, code: o.demo_code });
  if (!v.token) throw new Error('login KO ' + JSON.stringify(v));
  return v.token;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const A = '+243811112222', B = '+243855556666';
  const tA = await login(A), tB = await login(B);
  await req('POST', '/auth/fcm-token', { token: 'jeton-fcm-test-B' }, tB);
  console.log('✅ logins + jeton FCM de B enregistrés');

  // --- Scénario 1 : socket fantôme ---
  const wsB = new WebSocket('ws://localhost:3000/ws?token=' + tB); // MUET
  const wsA = new WebSocket('ws://localhost:3000/ws?token=' + tA);
  const seenA = [];
  wsA.on('message', (d) => seenA.push(JSON.parse(d)));
  let ghostClosed = false;
  wsB.on('close', () => { ghostClosed = true; });
  await sleep(800);

  wsA.send(JSON.stringify({ type: 'offer', to: B, call_id: 'c1', sdp: { type: 'offer', sdp: 'x' } }));
  wsA.send(JSON.stringify({ type: 'ice', to: B, call_id: 'c1', candidate: { candidate: 'cand-1' } }));
  console.log('📤 A → offre + ICE (B est un fantôme : il ne répond rien)');
  await sleep(6000);

  const pushSent = seenA.some((m) => m.type === 'push-sent');
  console.log(pushSent ? '✅ ① A a reçu « push-sent » (bascule notification)' : '❌ ① pas de push-sent : ' + JSON.stringify(seenA));
  console.log(ghostClosed ? '✅ ② socket fantôme de B fermé par le serveur' : '❌ ② socket fantôme toujours ouvert');

  // B « touche la notification » → reconnexion → offre livrée + ICE rejoués
  const wsB2 = new WebSocket('ws://localhost:3000/ws?token=' + tB);
  const seenB = [];
  wsB2.on('message', (d) => seenB.push(JSON.parse(d)));
  await sleep(1500);
  const gotOffer = seenB.find((m) => m.type === 'offer' && m.call_id === 'c1');
  const gotIce = seenB.find((m) => m.type === 'ice');
  console.log(gotOffer ? '✅ ③ offre livrée à B après reconnexion' : '❌ ③ offre non livrée : ' + JSON.stringify(seenB));
  console.log(gotIce ? '✅ ④ ICE rejoués à B' : '❌ ④ ICE non rejoués');

  // B sonne → A doit le voir
  wsB2.send(JSON.stringify({ type: 'ringing', to: A, call_id: 'c1' }));
  await sleep(600);
  console.log(seenA.some((m) => m.type === 'ringing') ? '✅ ⑤ A reçoit « ringing »' : '❌ ⑤ ringing perdu');

  // --- Scénario 2 : appel manqué (A raccroche, B redevenu fantôme/hors ligne) ---
  wsB2.close();
  await sleep(500);
  wsA.send(JSON.stringify({ type: 'offer', to: B, call_id: 'c2', sdp: { type: 'offer', sdp: 'y' } }));
  await sleep(1200); // B hors ligne → directement en salle d'attente
  wsA.send(JSON.stringify({ type: 'hangup', to: B, call_id: 'c2' }));
  await sleep(1200);
  console.log('ℹ️ ⑥ vérifier dans les logs serveur : « 🧪 [SIMULATION] push appel manqué »');

  wsA.close();
  process.exit(0);
})().catch((e) => { console.error('💥', e.message); process.exit(1); });
