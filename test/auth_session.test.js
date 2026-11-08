/**
 * Test v4.0 — sessions persistantes, refresh token, déconnexion, audit.
 * Lancement : node test/auth_session.test.js
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

async function call(method, p, { token, body } = {}) {
  const h = { 'Content-Type': 'application/json' };
  if (token) h.Authorization = `Bearer ${token}`;
  const r = await fetch(B + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await r.json(); } catch {}
  return { status: r.status, data };
}

async function main() {
  const srv = spawn('node', [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DEMO_MODE: 'true', DATABASE_URL: '' },
    stdio: 'pipe',
  });
  await new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error('timeout démarrage serveur')), 15000);
    srv.stdout.on('data', (d) => { if (String(d).includes('démarré')) { clearTimeout(to); res(); } });
    srv.stderr.on('data', (d) => process.stderr.write(d));
  });

  try {
    // 1) Inscription OTP → jetons + session
    const phone = '+243991000001';
    const a = await call('POST', '/auth/request-otp', { body: { phone } });
    ok('request-otp 200 + demo_code', a.status === 200 && /^\d{6}$/.test(a.data.demo_code || ''), a.data);
    const v = await call('POST', '/auth/verify-otp', {
      body: { phone, code: a.data.demo_code, name: 'Test Session',
              dial_code: '+243', country: 'CD', app_version: '4.0.0', language: 'fr',
              device: { device_id: 'dev-1', platform: 'android', model: 'SM X706B', app_version: '4.0.0' } },
    });
    ok('verify-otp 200 avec token + refresh_token + session_id',
      v.status === 200 && !!v.data.token && !!v.data.refresh_token && !!v.data.session_id, v.data);
    const token = v.data.token;

    // 2) Session valide au démarrage (splash → accueil)
    const s = await call('GET', '/auth/session', { token });
    ok('GET /auth/session 200 valid:true', s.status === 200 && s.data.valid === true, s.data);
    ok('session enregistrée côté serveur', !!s.data.session && s.data.session.id === v.data.session_id, s.data.session);

    // 3) Rotation du refresh token
    const r1 = await call('POST', '/auth/refresh', { body: { refresh_token: v.data.refresh_token } });
    ok('refresh 200 → nouveaux jetons', r1.status === 200 && !!r1.data.token && !!r1.data.refresh_token, r1.data);
    ok('nouveau refresh différent de l\'ancien', r1.data.refresh_token !== v.data.refresh_token);

    // 4) L'ancien refresh token est révoqué (rejeu impossible)
    const r2 = await call('POST', '/auth/refresh', { body: { refresh_token: v.data.refresh_token } });
    ok('rejeu de l\'ancien refresh → 401', r2.status === 401, r2.data);

    // 5) Mauvais refresh → 401
    const r3 = await call('POST', '/auth/refresh', { body: { refresh_token: 'bidon' } });
    ok('refresh invalide → 401', r3.status === 401, r3.data);

    // 6) Le nouveau token fonctionne
    const s2 = await call('GET', '/auth/session', { token: r1.data.token });
    ok('nouveau token accepté', s2.status === 200 && s2.data.valid === true, s2.data);

    // 7) Déconnexion → session révoquée → ancien token toujours JWT valide mais logout enregistré
    const lo = await call('POST', '/auth/logout', { token: r1.data.token, body: { refresh_token: r1.data.refresh_token } });
    ok('logout 200', lo.status === 200 && lo.data.ok === true, lo.data);
    const r4 = await call('POST', '/auth/refresh', { body: { refresh_token: r1.data.refresh_token } });
    ok('refresh après logout → 401 (session révoquée)', r4.status === 401, r4.data);

    // 8) Mauvais OTP → 401 (protection essais)
    await call('POST', '/auth/request-otp', { body: { phone: '+243991000002' } });
    const bad = await call('POST', '/auth/verify-otp', { body: { phone: '+243991000002', code: '000000' } });
    ok('mauvais code OTP → 401', bad.status === 401, bad.data);

    // 9) Champs profil enrichis persistés (vérifié via /auth/session)
    const s3 = await call('GET', '/auth/session', { token });
    ok('pays persisté (CD)', s3.data.user && s3.data.user.country === 'CD', s3.data.user);

    console.log(`\n${pass} réussi(s), ${fail} échec(s)`);
  } finally {
    srv.kill('SIGTERM');
  }
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
