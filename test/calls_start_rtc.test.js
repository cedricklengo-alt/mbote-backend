/**
 * Démarrage d'un appel MboteCall → MboteCall : la réponse doit permettre à
 * l'application de lancer la VRAIE voix.
 *
 * Constaté dans les journaux Render du 3 novembre 2026 : chaque appel donnait
 * un `POST /api/calls/start` suivi d'une quarantaine de
 * `GET /api/calls/<id>/status` — c'est le mode simulé de l'application. La
 * cause : `/calls/start` ne renvoyait JAMAIS le champ `rtc_online`, or l'app
 * ne lançait WebRTC que si `rtc_online === true`. Résultat : aucun appel
 * n'était réellement tenté, l'appelé ne sonnait jamais, et l'appel « ne
 * passait pas ».
 *
 * Lancement :  node test/calls_start_rtc.test.js
 */
const { spawn } = require('child_process');
const path = require('path');
const WebSocket = require('ws');

const PORT = 4793;
const B = `http://127.0.0.1:${PORT}/api`;
let pass = 0, fail = 0;

const ok = (label, cond, detail) => {
  if (cond) { console.log(`  ✓ ${label}`); pass++; }
  else { console.log(`  ✗ ${label}${detail !== undefined ? ' → ' + JSON.stringify(detail) : ''}`); fail++; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

function ouvrirWs(user) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${user.token}`);
  return new Promise((res, rej) => {
    ws.on('open', () => res(ws));
    ws.on('error', rej);
  });
}

(async () => {
  const srv = spawn('node', ['src/server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), JWT_SECRET: 'test-start-rtc', DEMO_MODE: 'true',
           DATABASE_URL: '', PUSH_DEBUG_FAKE: 'true', RTC_RING_TTL_MS: '5000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let srvOut = '';
  srv.stdout.on('data', (d) => { srvOut += d; });
  srv.stderr.on('data', (d) => { srvOut += d; });

  let up = false;
  for (let i = 0; i < 40; i++) {
    await sleep(300);
    try { const r = await fetch(`${B}/health`); if (r.ok) { up = true; break; } } catch { /* pas encore */ }
  }
  if (!up) { console.error('serveur non démarré\n' + srvOut); srv.kill(); process.exit(1); }

  let wsB = null, wsA = null;
  try {
    const suffix = Date.now() % 100000;
    const A = await login(`+2437200${suffix}`, 'Alice');
    const Bc = await login(`+2437201${suffix}`, 'Bob');

    console.log('1. Appel vers un compte EN LIGNE');
    wsB = await ouvrirWs(Bc);
    wsA = await ouvrirWs(A);
    await sleep(400); // laisse la présence s'installer

    const r1 = await call('POST', '/calls/start', { token: A.token, body: { to: Bc.phone } });
    ok('l’appel démarre', r1.status === 200, r1);
    ok('c’est bien un appel MboteCall → MboteCall (gratuit)',
      r1.data.free_reason === 'mbote' && r1.data.price_per_min_cents === 0, r1.data);
    ok('la réponse contient `rtc_online`', 'rtc_online' in (r1.data || {}), Object.keys(r1.data || {}));
    ok('`rtc_online` vaut true quand l’appelé est connecté', r1.data.rtc_online === true, r1.data.rtc_online);
    ok('l’application peut donc lancer la vraie voix (appelViaRtc)', r1.data.free_reason === 'mbote');

    await call('POST', `/calls/${r1.data.call_id}/hangup`, { token: A.token, body: {} });
    wsB.close();
    wsB = null;
    await sleep(400);

    console.log('\n2. Appel vers un compte HORS LIGNE');
    const r2 = await call('POST', '/calls/start', { token: A.token, body: { to: Bc.phone } });
    ok('l’appel démarre quand même', r2.status === 200, r2);
    ok('`rtc_online` vaut false', r2.data.rtc_online === false, r2.data.rtc_online);
    ok('le transport reste WebRTC (l’offre attend en salle d’attente + notification)',
      r2.data.free_reason === 'mbote' && r2.data.provider === 'rtc', r2.data);
    await call('POST', `/calls/${r2.data.call_id}/hangup`, { token: A.token, body: {} });

    console.log('\n3. Appel vidéo');
    wsB = await ouvrirWs(Bc);
    await sleep(400);
    const r3 = await call('POST', '/calls/start', { token: A.token, body: { to: Bc.phone, with_video: true } });
    ok('un appel vidéo démarre', r3.status === 200, r3);
    await call('POST', `/calls/${r3.data.call_id}/hangup`, { token: A.token, body: {} });
    const hist = await call('GET', '/calls/history', { token: A.token });
    const ligne = (hist.data?.calls || []).find((c) => c.id === r3.data.call_id);
    ok('le mode vidéo est enregistré dans l’historique',
      ligne && Number(ligne.with_video) === 1, ligne);
    ok('l’appel est classé « internet » (MboteCall → MboteCall)',
      ligne && Number(ligne.rtc_mode) === 1, ligne && ligne.rtc_mode);

    console.log('\n4. Aucune erreur serveur');
    const erreurs = srvOut.split('\n').filter((l) => l.startsWith('💥') && /→ 5\d\d/.test(l));
    ok('aucune erreur 5xx', erreurs.length === 0, erreurs.slice(0, 3));
  } catch (e) {
    console.error('erreur inattendue :', e);
    console.error('--- sortie serveur ---\n' + srvOut.slice(-1500));
    fail++;
  } finally {
    try { wsA && wsA.close(); wsB && wsB.close(); } catch {}
    srv.kill();
    await sleep(200);
    console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} réussis · ${fail} échoués`);
    process.exit(fail === 0 ? 0 : 1);
  }
})();
