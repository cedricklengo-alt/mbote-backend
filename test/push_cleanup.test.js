/**
 * Nettoyage des jetons de notification refusés par FCM.
 *
 * Constaté dans les journaux Render du 3 novembre 2026 :
 *   ⚠️ Envoi push call KO : 404 NOT_FOUND
 *   🧹 Jeton FCM périmé effacé de la base
 * …qui revenait à CHAQUE envoi, indéfiniment. La cause : seul l'ancien champ
 * `users.fcm_token` était vidé, alors que l'application enregistre ses jetons
 * dans la table `device_tokens`. Le jeton mort y restait, il était rechoisi en
 * priorité (le plus récent), et l'envoi échouait de nouveau.
 *
 * Ici on utilise le mode simulation de FCM : un jeton qui commence par
 * « dead- » est refusé comme un jeton périmé.
 *
 * Lancement :  node test/push_cleanup.test.js
 */
const { spawn } = require('child_process');
const path = require('path');
const db = require('../src/db');

const PORT = 4796;
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

(async () => {
  await db.init(); // même base SQLite que le serveur lancé ci-dessous

  const srv = spawn('node', ['src/server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), JWT_SECRET: 'test-push', DEMO_MODE: 'true',
           DATABASE_URL: '', PUSH_DEBUG_FAKE: 'true' },
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

  try {
    const suffix = Date.now() % 100000;
    const A = await login(`+2437300${suffix}`, 'Alice');
    const Bc = await login(`+2437301${suffix}`, 'Bénédicte');

    const mort = `dead-${suffix}`;
    const vivant = `vivant-${suffix}`;
    await call('POST', '/auth/fcm-token', { token: Bc.token, body: { token: mort } });
    await call('POST', '/auth/fcm-token', { token: Bc.token, body: { token: vivant } });

    const liste = async () =>
      (await db.all('SELECT token FROM device_tokens WHERE user_id = ?', [Bc.id])).map((r) => r.token);
    ok('les deux jetons sont enregistrés', (await liste()).length === 2, await liste());

    console.log('\n1. Un message déclenche une notification');
    const envoi = await call('POST', '/messages/send', {
      token: A.token,
      body: { to: Bc.phone, text: 'Coucou, tu reçois ça ?', client_id: `push-${suffix}` },
    });
    ok('le message part', envoi.status === 201 || envoi.status === 200, envoi.status);

    await sleep(1200);

    console.log('\n2. Le jeton refusé est effacé, l’autre reste');
    const apres = await liste();
    ok('le jeton mort a disparu de device_tokens', !apres.includes(mort), apres);
    ok('le jeton valide est conservé', apres.includes(vivant), apres);

    console.log('\n3. Le nettoyage est réellement dû au refus de FCM');
    ok('la simulation a bien signalé le jeton', /SIMULATION|périmé|KO/.test(srvOut), srvOut.slice(-200));

    console.log('\n4. Aucune erreur serveur');
    const erreurs = srvOut.split('\n').filter((l) => l.startsWith('💥') && /→ 5\d\d/.test(l));
    ok('aucune erreur 5xx', erreurs.length === 0, erreurs.slice(0, 2));

    // Nettoyage des données de test
    await db.run('DELETE FROM device_tokens WHERE user_id = ?', [Bc.id]);
  } catch (e) {
    console.error('erreur inattendue :', e);
    console.error('--- sortie serveur ---\n' + srvOut.slice(-1500));
    fail++;
  } finally {
    srv.kill();
    await sleep(200);
    console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} réussis · ${fail} échoués`);
    process.exit(fail === 0 ? 0 : 1);
  }
})();
