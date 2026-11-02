/**
 * Test de la signalisation d'appel de groupe « Mbote Famille » (mesh P2P).
 *
 * Serveur réel + SQLite + vrais WebSockets. Vérifie le protocole tel que le
 * client Flutter le consomme (clés peers / from / from_name) ainsi que les
 * garde-fous : autorisation de salle, limite de participants, appartenance
 * obligatoire pour relayer du SDP, départ qui n'interrompt pas les autres.
 *
 * Lancement :  node test/group_signaling.test.js
 */
const { spawn } = require('child_process');
const path = require('path');
const WebSocket = require('ws');

const PORT = 4822;
const API = `http://127.0.0.1:${PORT}/api`;
let pass = 0, fail = 0;

const ok = (label, cond, detail) => {
  if (cond) { console.log(`  ✓ ${label}`); pass++; }
  else { console.log(`  ✗ ${label}${detail !== undefined ? ' → ' + JSON.stringify(detail) : ''}`); fail++; }
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function http(method, p, { token, body } = {}) {
  const h = { 'Content-Type': 'application/json' };
  if (token) h.Authorization = `Bearer ${token}`;
  const r = await fetch(API + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  let d = null; try { d = await r.json(); } catch {}
  return { status: r.status, data: d };
}

/** Crée/authentifie un compte via le code OTP de démonstration */
async function account(phone, name) {
  const a = await http('POST', '/auth/request-otp', { body: { phone, name } });
  const code = a.data && a.data.demo_code;
  if (!code) throw new Error(`pas de demo_code pour ${phone}`);
  const b = await http('POST', '/auth/verify-otp', { body: { phone, code, name } });
  const token = b.data && b.data.token;
  if (!token) throw new Error(`pas de jeton pour ${phone}`);
  return { phone, name, token };
}

/** Client WebSocket avec file de messages et attente par type */
function connect(acc) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${encodeURIComponent(acc.token)}`);
    const inbox = [], waiters = [];
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      inbox.push(m);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].type === m.type) { waiters[i].resolve(m); waiters.splice(i, 1); }
      }
    });
    const c = {
      ws, inbox, phone: acc.phone, name: acc.name,
      send: (o) => ws.send(JSON.stringify(o)),
      wait: (type, ms = 1500) => new Promise((res) => {
        const found = inbox.find(m => m.type === type);
        if (found) return res(found);
        const w = { type, resolve: res };
        waiters.push(w);
        setTimeout(() => {
          const i = waiters.indexOf(w);
          if (i >= 0) { waiters.splice(i, 1); res(null); }
        }, ms);
      }),
      clear: () => { inbox.length = 0; },
      close: () => ws.close(),
    };
    ws.on('open', () => resolve(c));
    ws.on('error', reject);
  });
}

(async () => {
  const srv = spawn('node', ['src/server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), JWT_SECRET: 'test-local-secret',
           DEMO_MODE: 'true', PUSH_DEBUG_FAKE: 'true', DATABASE_URL: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  srv.stdout.on('data', d => { out += d; });
  srv.stderr.on('data', d => { out += d; });

  let up = false;
  for (let i = 0; i < 40; i++) {
    await sleep(300);
    try { const r = await fetch(API + '/health'); if (r.ok) { up = true; break; } } catch {}
  }
  if (!up) { console.error('serveur non démarré :\n' + out); srv.kill(); process.exit(2); }

  try {
    const ROOM = 'famille-test-' + Date.now().toString(36);

    const aA = await account('+243820000001', 'Alice');
    const aB = await account('+243820000002', 'Bob');
    const aC = await account('+243820000003', 'Chantal');
    const aD = await account('+243820000004', 'Didier');
    const aE = await account('+243820000005', 'Eve');

    const A = await connect(aA), B = await connect(aB), C = await connect(aC),
          D = await connect(aD), E = await connect(aE);

    console.log('1. Création de salle');
    A.send({ type: 'group_join', call_id: ROOM, from_name: A.name });
    let m = await A.wait('group_joined');
    ok('l\'hôte reçoit group_joined', !!m);
    ok('clé « peers » (celle que lit le client)', m && Array.isArray(m.peers), m && Object.keys(m));
    ok('salle vide au départ', m && m.peers.length === 0, m && m.peers);

    console.log('\n2. Autorisation de salle');
    B.clear();
    B.send({ type: 'group_join', call_id: ROOM, from_name: B.name });
    m = await B.wait('group_error');
    ok('non-invité refusé (not_authorized)', m && m.reason === 'not_authorized', m && m.reason);
    ok('et il n\'entre pas', !(await B.wait('group_joined', 300)));

    console.log('\n3. Invitation');
    B.clear();
    A.send({ type: 'group_invite', call_id: ROOM, to: B.phone, with_video: true });
    m = await B.wait('group_invite');
    ok('l\'invité reçoit group_invite', !!m);
    ok('porte from + from_name', m && m.from === A.phone && m.from_name === 'Alice',
       m && { from: m.from, name: m.from_name });
    E.clear();
    E.send({ type: 'group_invite', call_id: ROOM, to: C.phone });
    m = await E.wait('group_error');
    ok('un non-membre ne peut pas inviter', m && m.reason === 'not_authorized', m && m.reason);

    console.log('\n4. Arrivée de l\'invité');
    A.clear(); B.clear();
    B.send({ type: 'group_join', call_id: ROOM, from_name: B.name });
    const bj = await B.wait('group_joined');
    ok('l\'invité entre', !!bj);
    ok('il reçoit la liste des numéros présents',
       bj && bj.peers.length === 1 && bj.peers[0] === A.phone, bj && bj.peers);
    const aj = await A.wait('group_peer_joined');
    ok('l\'hôte est notifié (clés from / from_name)',
       aj && aj.from === B.phone && aj.from_name === 'Bob', aj && { f: aj && aj.from, n: aj && aj.from_name });

    console.log('\n5. Offre / réponse / ICE');
    A.clear();
    B.send({ type: 'group_offer', call_id: ROOM, to: A.phone,
             sdp: { sdp: 'v=0-offre-bob', type: 'offer' } });
    m = await A.wait('group_offer');
    ok('offre relayée avec from', m && m.from === B.phone, m && m.from);
    ok('SDP intact', m && m.sdp && m.sdp.sdp === 'v=0-offre-bob');
    B.clear();
    A.send({ type: 'group_answer', call_id: ROOM, to: B.phone,
             sdp: { sdp: 'v=0-reponse', type: 'answer' } });
    m = await B.wait('group_answer');
    ok('réponse relayée', m && m.from === A.phone);
    B.clear();
    A.send({ type: 'group_ice', call_id: ROOM, to: B.phone,
             candidate: { candidate: 'candidate:1 1 udp', sdpMid: '0', sdpMLineIndex: 0 } });
    m = await B.wait('group_ice');
    ok('candidat ICE relayé', m && m.candidate && m.candidate.sdpMid === '0');

    console.log('\n6. Étanchéité de la salle');
    B.clear();
    E.send({ type: 'group_offer', call_id: ROOM, to: B.phone, sdp: { sdp: 'x', type: 'offer' } });
    ok('SDP d\'un non-membre rejeté', !(await B.wait('group_offer', 400)));

    console.log('\n7. group_mute (badges distants)');
    B.clear();
    A.send({ type: 'group_mute', call_id: ROOM, audio: true, video: false });
    m = await B.wait('group_mute');
    ok('mute diffusé aux autres', !!m);
    ok('porte from + audio + video', m && m.from === A.phone && m.audio === true && m.video === false,
       m && { f: m.from, a: m.audio, v: m.video });
    ok('l\'émetteur ne se le reçoit pas', !(await A.wait('group_mute', 300)));
    B.clear();            // vider la file de B : elle contient le mute d'Alice
    E.send({ type: 'group_mute', call_id: ROOM, audio: true });
    ok('mute d\'un non-membre ignoré', !(await B.wait('group_mute', 400)));

    console.log('\n8. Limite de participants');
    A.send({ type: 'group_invite', call_id: ROOM, to: C.phone });
    await C.wait('group_invite');
    C.send({ type: 'group_join', call_id: ROOM, from_name: C.name });
    await C.wait('group_joined');
    A.send({ type: 'group_invite', call_id: ROOM, to: D.phone });
    await D.wait('group_invite');
    D.send({ type: 'group_join', call_id: ROOM, from_name: D.name });
    const dj = await D.wait('group_joined');
    ok('4ᵉ participant accepté', !!dj);
    ok('il voit les 3 autres', dj && dj.peers.length === 3, dj && dj.peers.length);
    A.clear();
    A.send({ type: 'group_invite', call_id: ROOM, to: E.phone });
    m = await A.wait('group_error');
    ok('5ᵉ invitation → room_full', m && m.reason === 'room_full', m && m.reason);

    console.log('\n9. Départ d\'un participant');
    A.clear(); C.clear(); D.clear();
    B.send({ type: 'group_leave', call_id: ROOM });
    const al = await A.wait('group_peer_left');
    ok('les autres sont notifiés (clé from)', al && al.from === B.phone, al && al);
    ok('les trois restants reçoivent la notification', !!(await C.wait('group_peer_left')) && !!(await D.wait('group_peer_left')));
    C.clear();
    A.send({ type: 'group_ice', call_id: ROOM, to: C.phone,
             candidate: { candidate: 'candidate:2 1 udp', sdpMid: '0', sdpMLineIndex: 0 } });
    ok('l\'appel continue pour les restants', !!(await C.wait('group_ice')));
    A.clear();
    A.send({ type: 'group_invite', call_id: ROOM, to: E.phone });
    ok('la place libérée est réutilisable', !!(await E.wait('group_invite')));

    console.log('\n10. Coupure brutale (socket fermé sans group_leave)');
    A.clear(); D.clear();
    C.ws.terminate();
    const ag = await A.wait('group_peer_left', 2000);
    ok('déconnexion → group_peer_left', !!ag);
    ok('c\'est bien le participant parti', ag && ag.from === C.phone, ag && ag.from);

    console.log('\n11. Salle inconnue');
    E.clear();
    E.send({ type: 'group_leave', call_id: 'salle-inexistante' });
    E.send({ type: 'group_offer', call_id: 'salle-inexistante', to: A.phone, sdp: { sdp: 'x', type: 'offer' } });
    await sleep(300);
    ok('aucun effet, pas de plantage', A.ws.readyState === WebSocket.OPEN);

    for (const c of [A, B, C, D, E]) c.close();
  } catch (e) {
    console.error('\nERREUR DU BANC D\'ESSAI :', e.message);
    fail++;
  }

  console.log(`\n${'─'.repeat(54)}`);
  console.log(`RÉSULTAT : ${pass} réussis, ${fail} échecs`);
  srv.kill();
  await sleep(300);
  process.exit(fail === 0 ? 0 : 1);
})();
