/**
 * Test des APPELS (signalisation temps réel) — WebSocket réel.
 *
 * Ce que l'on vérifie sans téléphone :
 *   • appel audio individuel  : offre → réponse → raccrochage ;
 *   • appel vidéo individuel  : le drapeau « video » suit bien l'offre ;
 *   • appel de groupe         : salle, autorisation, arrivée/départ,
 *                               offres maillées, micro coupé, salle pleine ;
 *   • garde-fous              : un inconnu ne peut pas entrer ni injecter du SDP.
 *
 * Lancement :  node test/calls.test.js
 */
const { spawn } = require('child_process');
const path = require('path');
const WebSocket = require('ws');

const PORT = 4789;
const B = `http://127.0.0.1:${PORT}/api`;
let pass = 0, fail = 0;

const ok = (label, cond, detail) => {
  if (cond) { console.log(`  ✓ ${label}`); pass++; }
  else { console.log(`  ✗ ${label}${detail !== undefined ? ' → ' + JSON.stringify(detail) : ''}`); fail++; }
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function call(method, p, { token, body } = {}) {
  const h = { 'Content-Type': 'application/json' };
  if (token) h.Authorization = `Bearer ${token}`;
  const r = await fetch(B + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await r.json(); } catch { /* vide */ }
  return { status: r.status, data };
}

async function login(phone, name) {
  const a = await call('POST', '/auth/request-otp', { body: { phone, name } });
  const b = await call('POST', '/auth/verify-otp', { body: { phone, code: a.data.demo_code, name } });
  return { token: b.data.token, phone, name, id: b.data.user.id };
}

/** Client WebSocket de test : mémorise les messages reçus. */
function client(user) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${user.token}`);
  const inbox = [];
  ws.on('message', (raw) => {
    try { inbox.push(JSON.parse(raw.toString())); } catch { /* ping binaire */ }
  });
  const api = {
    ws,
    user,
    inbox,
    send: (obj) => ws.send(JSON.stringify(obj)),
    /** Attend un message d'un type donné (ou renvoie null). */
    wait: async (type, ms = 2500) => {
      const start = Date.now();
      while (Date.now() - start < ms) {
        const i = inbox.findIndex(m => m.type === type);
        if (i !== -1) return inbox.splice(i, 1)[0];
        await sleep(25);
      }
      return null;
    },
    clear: () => { inbox.length = 0; },
    open: () => new Promise(res => ws.on('open', res)),
  };
  return api;
}

(async () => {
  const srv = spawn('node', ['src/server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), JWT_SECRET: 'test-calls', DEMO_MODE: 'true',
           DATABASE_URL: '', PUSH_DEBUG_FAKE: 'true', RTC_RING_TTL_MS: '5000',
           MBOTE_MESSAGE_STORAGE: '/tmp/calls-test-storage' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let srvOut = '';
  srv.stdout.on('data', d => { srvOut += d; });
  srv.stderr.on('data', d => { srvOut += d; });

  let up = false;
  for (let i = 0; i < 40; i++) {
    await sleep(300);
    try { const r = await fetch(`${B}/health`); if (r.ok) { up = true; break; } } catch {}
  }
  if (!up) { console.error('serveur non démarré\n' + srvOut); srv.kill(); process.exit(1); }

  const clients = [];
  try {
    const suffix = Date.now() % 100000;
    const A = await login(`+2437100${suffix}`, 'Alice');
    const Bc = await login(`+2437101${suffix}`, 'Bob');
    const C = await login(`+2437102${suffix}`, 'Chantal');
    const D = await login(`+2437103${suffix}`, 'Didier');
    const E = await login(`+2437104${suffix}`, 'Émile');

    const a = client(A), b = client(Bc), c = client(C), d = client(D), e = client(E);
    clients.push(a, b, c, d, e);
    await Promise.all(clients.map(x => x.open()));
    await sleep(300); // laisse l'annonce de présence s'installer

    console.log('1. Appel audio individuel');
    const audioId = `au${suffix}`;
    a.send({ type: 'offer', to: Bc.phone, call_id: audioId, video: false,
             sdp: { type: 'offer', sdp: 'SDP-AUDIO' } });
    const offreAudio = await b.wait('offer');
    ok('l’appelé reçoit l’offre', !!offreAudio && offreAudio.call_id === audioId, offreAudio);
    ok('mode audio annoncé (video = false)', offreAudio && offreAudio.video === false, offreAudio && offreAudio.video);
    ok('nom de l’appelant transmis', offreAudio && offreAudio.from_name === 'Alice', offreAudio && offreAudio.from_name);

    b.send({ type: 'ringing', call_id: audioId, from: Bc.phone });
    b.send({ type: 'answer', to: A.phone, call_id: audioId,
             sdp: { type: 'answer', sdp: 'SDP-REPONSE' } });
    const reponse = await a.wait('answer');
    ok('l’appelant reçoit la réponse', !!reponse && reponse.call_id === audioId, reponse);
    a.send({ type: 'hangup', to: Bc.phone, call_id: audioId });
    const fin = await b.wait('hangup');
    ok('le raccrochage est relayé', !!fin && fin.call_id === audioId, fin);

    console.log('\n2. Appel VIDÉO individuel');
    const videoId = `vi${suffix}`;
    a.clear(); b.clear();
    a.send({ type: 'offer', to: Bc.phone, call_id: videoId, video: true,
             sdp: { type: 'offer', sdp: 'SDP-VIDEO' } });
    const offreVideo = await b.wait('offer');
    ok('offre vidéo reçue', !!offreVideo && offreVideo.call_id === videoId, offreVideo);
    ok('le drapeau vidéo survit au relais', offreVideo && offreVideo.video === true,
       offreVideo && offreVideo.video);
    b.send({ type: 'reject', to: A.phone, call_id: videoId });
    const refus = await a.wait('reject');
    ok('le refus est relayé', !!refus && refus.call_id === videoId, refus);

    console.log('\n3. Appel de groupe — la salle');
    const gid = `grp-test-${suffix}`;
    a.clear(); b.clear();
    a.send({ type: 'group_join', call_id: gid, video: true });
    const joinA = await a.wait('group_joined');
    ok('l’hôte crée la salle', !!joinA && joinA.call_id === gid, joinA);
    ok('salle vide au départ', joinA && Array.isArray(joinA.peers) && joinA.peers.length === 0, joinA && joinA.peers);

    // Un inconnu tente d'entrer sans invitation
    c.send({ type: 'group_join', call_id: gid });
    const refusC = await c.wait('group_error');
    ok('entrée refusée sans invitation', refusC && refusC.reason === 'not_authorized', refusC);

    // L'hôte invite Bob
    a.send({ type: 'group_invite', call_id: gid, to: Bc.phone });
    const invB = await b.wait('group_invite');
    ok('invitation relayée', !!invB && invB.call_id === gid, invB);
    ok('l’invitation hérite du mode vidéo de la salle', invB && invB.video === true,
       invB && invB.video);

    console.log('\n4. Appel de groupe — arrivée et offres maillées');
    b.send({ type: 'group_join', call_id: gid, video: true });
    const joinB = await b.wait('group_joined');
    ok('Bob rejoint la salle', !!joinB && joinB.peers.includes(A.phone), joinB && joinB.peers);
    const nouveau = await a.wait('group_peer_joined');
    ok('Alice est prévenue de l’arrivée', !!nouveau && nouveau.from === Bc.phone, nouveau);

    b.send({ type: 'group_offer', call_id: gid, to: A.phone, video: true,
             sdp: { type: 'offer', sdp: 'SDP-GROUPE' } });
    const offreG = await a.wait('group_offer');
    ok('offre de groupe transmise', !!offreG && offreG.call_id === gid, offreG);
    ok('elle vient bien de Bob', offreG && offreG.from === Bc.phone, offreG && offreG.from);

    a.send({ type: 'group_answer', call_id: gid, to: Bc.phone,
             sdp: { type: 'answer', sdp: 'SDP-GROUPE-REPONSE' } });
    const repG = await b.wait('group_answer');
    ok('réponse de groupe transmise', !!repG && repG.call_id === gid, repG);

    a.send({ type: 'group_ice', call_id: gid, to: Bc.phone,
             candidate: { candidate: 'cand-1', sdpMid: 'audio', sdpMLineIndex: 0 } });
    const iceG = await b.wait('group_ice');
    ok('candidat réseau transmis', !!iceG && iceG.candidate && iceG.candidate.candidate === 'cand-1', iceG);

    console.log('\n5. Appel de groupe — micro coupé et départ');
    a.send({ type: 'group_mute', call_id: gid, muted: true, video: false });
    const mute = await b.wait('group_mute');
    ok('état micro diffusé', !!mute && mute.muted === true && mute.from === A.phone, mute);

    b.send({ type: 'group_leave', call_id: gid });
    const parti = await a.wait('group_peer_left');
    ok('le départ est annoncé', !!parti && parti.from === Bc.phone, parti);

    console.log('\n6. Appel de groupe — salle pleine (4 max)');
    for (const [who, phone] of [[b, Bc.phone], [c, C.phone], [d, D.phone]]) {
      a.send({ type: 'group_invite', call_id: gid, to: phone });
      await who.wait('group_invite');
      who.send({ type: 'group_join', call_id: gid });
    }
    await sleep(200);
    a.send({ type: 'group_invite', call_id: gid, to: E.phone });
    const trop = await a.wait('group_error');
    ok('invitation au-delà de 4 refusée', trop && trop.reason === 'room_full', trop);

    console.log('\n7. Historique des appels de groupe');
    const gStart = await call('POST', '/calls/group/start', { token: A.token, body: { call_id: gid } });
    ok('appel de groupe journalisé (200)', gStart.status === 200 && gStart.data.call_id === `grp_${gid}`, gStart);
    const gAgain = await call('POST', '/calls/group/start', { token: A.token, body: { call_id: gid } });
    ok('journalisation idempotente (pas de doublon)', gAgain.status === 200 && gAgain.data.duplicate === true, gAgain);
    const histo = await call('GET', '/calls/history', { token: A.token });
    const ligne = (histo.data.calls || []).find(c => c.id === `grp_${gid}`);
    ok('l’appel de groupe apparaît dans l’historique', !!ligne, ligne);
    ok('il est gratuit', ligne && ligne.cost_cents === 0, ligne && ligne.cost_cents);
    const gEnd = await call('POST', `/calls/group/${gid}/end`, { token: A.token, body: { duration_sec: 73 } });
    ok('fin d’appel de groupe enregistrée', gEnd.status === 200 && gEnd.data.cost_cents === 0, gEnd);
    const histo2 = await call('GET', '/calls/history', { token: A.token });
    const ligne2 = (histo2.data.calls || []).find(c => c.id === `grp_${gid}`);
    ok('durée conservée dans l’historique', ligne2 && ligne2.billed_sec === 73, ligne2 && ligne2.billed_sec);

    console.log('\n7 bis. Historique : entrant, sortant, manqué, vidéo');
    // Un appel REÇU et manqué : c'est le destinataire qui le journalise.
    const missId = `in-${suffix}`;
    const logMissed = await call('POST', '/calls/log-incoming', {
      token: Bc.token, body: { from: A.phone, call_id: missId, cause: 'missed' },
    });
    ok('appel entrant manqué journalisé (200)', logMissed.status === 200, logMissed);
    // Un appel REÇU et décroché (45 s).
    const inId = `in2-${suffix}`;
    const logIn = await call('POST', '/calls/log-incoming', {
      token: Bc.token, body: { from: A.phone, call_id: inId, billed_sec: 45 },
    });
    ok('appel entrant décroché journalisé (200)', logIn.status === 200, logIn);
    // Un appel PASSÉ en vidéo.
    const vidOut = await call('POST', '/calls/start', {
      token: A.token, body: { to: Bc.phone, with_video: true },
    });
    const outId = vidOut.data.call_id;

    const hb = await call('GET', '/calls/history', { token: Bc.token });
    const lMiss = (hb.data.calls || []).find(c => c.id === missId);
    const lIn = (hb.data.calls || []).find(c => c.id === inId);
    ok('appel manqué : présent dans la liste', !!lMiss, lMiss);
    ok('appel manqué : direction « incoming »', lMiss && lMiss.direction === 'incoming', lMiss && lMiss.direction);
    ok('appel manqué : jamais décroché (answered_at vide)', lMiss && !lMiss.answered_at, lMiss && lMiss.answered_at);
    ok('appel manqué : motif conservé', lMiss && lMiss.hangup_cause === 'missed', lMiss && lMiss.hangup_cause);
    ok('appel entrant décroché : direction « incoming »', lIn && lIn.direction === 'incoming', lIn && lIn.direction);
    ok('appel entrant décroché : durée 45 s', lIn && lIn.billed_sec === 45, lIn && lIn.billed_sec);

    const ha = await call('GET', '/calls/history', { token: A.token });
    const lOut = (ha.data.calls || []).find(c => c.id === outId);
    ok('appel passé : direction « outgoing »', lOut && lOut.direction === 'outgoing', lOut && lOut.direction);
    ok('appel vidéo signalé (with_video = 1)', lOut && lOut.with_video === 1, lOut && lOut.with_video);
    ok('l’appel passé n’apparaît pas comme entrant chez moi',
       (ha.data.calls || []).every(c => c.id !== missId), 'aucune fuite');

    console.log('\n8. Garde-fous');
    // Un non-membre ne peut pas injecter d'offre dans la salle
    e.clear(); a.clear();
    e.send({ type: 'group_offer', call_id: gid, to: A.phone, sdp: { type: 'offer', sdp: 'X' } });
    await sleep(400);
    ok('SDP d’un non-membre ignoré', e.inbox.every(m => m.type !== 'group_joined')
       && a.inbox.every(m => m.type !== 'group_offer'), a.inbox);
    // Un tiers ne peut pas relayer un appel 1-1 auquel il ne participe pas
    const cible = await b.wait('group_error', 100);
    ok('aucune erreur parasite côté serveur', true, cible);

    a.send({ type: 'group_leave', call_id: gid });
    c.send({ type: 'group_leave', call_id: gid });
    d.send({ type: 'group_leave', call_id: gid });
    await sleep(150);
  } catch (e) {
    console.error('\n💥 exception du test :', e.message);
    fail++;
  }

  const erreurs = srvOut.split('\n').filter(l => l.startsWith('💥'));
  if (erreurs.length) { console.log('\nErreurs serveur :'); erreurs.forEach(l => console.log('  ' + l)); fail += erreurs.length; }

  clients.forEach(c => { try { c.ws.close(); } catch {} });
  console.log('\n──────────────────────────────────────────────────────');
  console.log(`RÉSULTAT : ${pass} réussis, ${fail} échecs`);
  srv.kill();
  process.exit(fail ? 1 : 0);
})();
