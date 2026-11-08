/**
 * Test de l'endpoint de synchro local-first : GET /api/messages/since
 * + idempotence de l'envoi (client_id) + curseur /calls/history?since=
 *
 * Lancement :  node test/sync_since.test.js
 */
const { spawn } = require('child_process');
const path = require('path');

const PORT = 4791;
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
  try { data = await r.json(); } catch {}
  return { status: r.status, data };
}

async function login(phone, name) {
  const a = await call('POST', '/auth/request-otp', { body: { phone, name } });
  const code = a.data && a.data.demo_code;
  const b = await call('POST', '/auth/verify-otp', { body: { phone, code, name } });
  return b.data && (b.data.token || b.data.jwt);
}

(async () => {
  const srv = spawn('node', ['src/server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), JWT_SECRET: 'test-local-secret',
           DEMO_MODE: 'true', PUSH_DEBUG_FAKE: 'true', DATABASE_URL: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let up = false;
  for (let i = 0; i < 40; i++) {
    await sleep(300);
    try { const r = await fetch(B + '/health'); if (r.ok) { up = true; break; } } catch {}
  }
  if (!up) { console.error('serveur indisponible'); srv.kill(); process.exit(1); }

  try {
    const alice = await login('+243900000001', 'Alice');
    const bob = await login('+243900000002', 'Bob');
    ok('auth Alice/Bob', !!alice && !!bob);

    // 1. Alice envoie 3 messages à Bob avec client_id (idempotence).
    const ids = [];
    for (let i = 1; i <= 3; i++) {
      const r = await call('POST', '/messages/send', {
        token: alice,
        body: { to: '+243900000002', text: `msg ${i}`, client_id: `cli-${i}` },
      });
      ok(`envoi msg ${i}`, r.status < 400, r.data);
      ids.push(`cli-${i}`);
    }
    // 2. Renvoi du même client_id → pas de doublon.
    const dup = await call('POST', '/messages/send', {
      token: alice, body: { to: '+243900000002', text: 'msg 1', client_id: 'cli-1' },
    });
    ok('renvoi idempotent accepté', dup.status < 400, dup.data);

    // 3. Bob récupère depuis curseur 0 → 3 messages (pas 4 malgré le renvoi).
    const since0 = await call('GET', '/messages/since?since=0&limit=100', { token: bob });
    ok('/since depuis 0 → 200', since0.status === 200, since0.data);
    const items = since0.data.items || [];
    ok('3 messages reçus (pas de doublon)', items.length === 3, items.length);
    ok('champs synchro présents (peer_phone, client_id)',
       items.every(m => m.peer_phone && m.client_id), items[0]);

    // 4. Curseur avancé : since = dernier created_at → plus rien (ou peu).
    const lastTs = Math.max(...items.map(m => m.created_at));
    const sinceNext = await call('GET', `/messages/since?since=${lastTs}&limit=100`, { token: bob });
    ok('curseur avancé → aucun nouveau', (sinceNext.data.items || []).length === 0,
       sinceNext.data.items);

    // 5. Nouveau message après le curseur → récupéré.
    await call('POST', '/messages/send', {
      token: alice, body: { to: '+243900000002', text: 'après curseur', client_id: 'cli-4' },
    });
    const sinceAfter = await call('GET', `/messages/since?since=${lastTs}&limit=100`, { token: bob });
    ok('message après curseur récupéré', (sinceAfter.data.items || []).length === 1,
       sinceAfter.data.items);

    // 6. Curseur invalide → 400.
    const bad = await call('GET', '/messages/since?since=-5', { token: bob });
    ok('curseur invalide → 400', bad.status === 400, bad.status);

    // 7. Non authentifié → 401.
    const noauth = await call('GET', '/messages/since?since=0');
    ok('sans jeton → 401', noauth.status === 401, noauth.status);

    // 8. /calls/history?since= filtre bien.
    const h0 = await call('GET', '/calls/history?since=0&limit=50', { token: alice });
    ok('/calls/history?since=0 → 200', h0.status === 200, h0.status);
    const future = Date.now() + 60000;
    const hFuture = await call('GET', `/calls/history?since=${future}&limit=50`, { token: alice });
    const callsList = hFuture.data.calls || hFuture.data.items || [];
    ok('curseur futur → liste vide', callsList.length === 0, callsList.length);

    console.log(`\n${pass} ✓ / ${fail} ✗`);
  } finally {
    srv.kill();
  }
  process.exit(fail ? 1 : 0);
})();
