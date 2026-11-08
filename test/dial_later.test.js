/**
 * Test du contrat « appeler plus tard » utilisé par l'onglet Appels
 * hors ligne (file de synchro locale → POST /api/dial-later).
 *
 * Lancement :  node test/dial_later.test.js
 */
const { spawn } = require('child_process');
const path = require('path');

const PORT = 4793;
const B = `http://127.0.0.1:${PORT}/api`;
let pass = 0, fail = 0;
const ok = (l, c, d) => { if (c) { console.log(`  ✓ ${l}`); pass++; } else { console.log(`  ✗ ${l}${d !== undefined ? ' → ' + JSON.stringify(d) : ''}`); fail++; } };
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
  const b = await call('POST', '/auth/verify-otp', { body: { phone, code: a.data.demo_code, name } });
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
  for (let i = 0; i < 40; i++) { await sleep(300); try { const r = await fetch(B + '/health'); if (r.ok) { up = true; break; } } catch {} }
  if (!up) { console.error('serveur indisponible'); srv.kill(); process.exit(1); }
  try {
    const t = await login('+243900000011', 'Test');
    ok('auth', !!t);
    const future = Date.now() + 3600_000;
    const r1 = await call('POST', '/dial-later', { token: t, body: {
      target_phone: '+243900000002', target_name: 'Bob', scheduled_at: future, tz_offset: 60 } });
    ok('programmation acceptée (id renvoyé)', r1.status < 400 && !!r1.data.id, r1.data);
    const r2 = await call('POST', '/dial-later', { token: t, body: {
      target_phone: '+243900000002', scheduled_at: Date.now() - 1000 } });
    ok('date passée → 400', r2.status === 400, r2.status);
    const r3 = await call('POST', '/dial-later', { token: t, body: { scheduled_at: future } });
    ok('sans target_phone → 400', r3.status === 400, r3.status);
    const list = await call('GET', '/dial-later', { token: t });
    ok('liste consultable', list.status === 200 && Array.isArray(list.data.items || list.data), list.data);
    const items = list.data.items || list.data;
    ok('le rappel programmé y figure', items.some(i => i.target_phone === '+243900000002'), items);
    const noauth = await call('POST', '/dial-later', { body: { target_phone: '+243900000002', scheduled_at: future } });
    ok('sans jeton → 401', noauth.status === 401, noauth.status);
    console.log(`\n${pass} ✓ / ${fail} ✗`);
  } finally { srv.kill(); }
  process.exit(fail ? 1 : 0);
})();
