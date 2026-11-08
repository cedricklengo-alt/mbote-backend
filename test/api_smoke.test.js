/**
 * Test de bout en bout des parcours applicatifs, sur serveur réel + SQLite.
 * Couvre : authentification, messagerie texte, fil d'actualité et likes,
 * rappels d'appel, boutique, forfaits, jeton push, présence, libellés.
 *
 * Lancement :  node test/api_smoke.test.js
 */
const { spawn } = require('child_process');
const path = require('path');

const PORT = 4777;
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
  const r = await fetch(B + p, {
    method, headers: h, body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await r.json(); } catch { /* corps vide */ }
  return { status: r.status, data };
}

/** Authentifie un numéro via le code OTP de démonstration */
async function login(phone, name) {
  const a = await call('POST', '/auth/request-otp', { body: { phone, name } });
  const code = a.data && a.data.demo_code;
  if (!code) throw new Error(`pas de demo_code pour ${phone}: ${JSON.stringify(a.data)}`);
  const b = await call('POST', '/auth/verify-otp', { body: { phone, code, name } });
  const token = b.data && (b.data.token || b.data.jwt);
  if (!token) throw new Error(`pas de jeton pour ${phone}: ${JSON.stringify(b.data)}`);
  return token;
}

(async () => {
  const srv = spawn('node', ['src/server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), JWT_SECRET: 'test-local-secret',
           DEMO_MODE: 'true', PUSH_DEBUG_FAKE: 'true', DATABASE_URL: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let srvOut = '';
  srv.stdout.on('data', d => { srvOut += d; });
  srv.stderr.on('data', d => { srvOut += d; });

  // Attendre que le serveur réponde
  let up = false;
  for (let i = 0; i < 40; i++) {
    await sleep(300);
    try { const r = await fetch(B + '/health'); if (r.ok) { up = true; break; } } catch {}
  }
  if (!up) {
    console.error('Le serveur n\'a pas démarré :\n' + srvOut);
    srv.kill(); process.exit(2);
  }

  try {
    const A = '+243810000111', NA = 'Alice';
    const C = '+243810000222', NC = 'Chantal';

    console.log('1. Authentification');
    const tA = await login(A, NA);
    const tC = await login(C, NC);
    ok('deux utilisateurs authentifiés', !!tA && !!tC);
    const me = await call('GET', '/auth/me', { token: tA });
    ok('/auth/me renvoie le profil', me.status === 200 && me.data && me.data.user && me.data.user.phone === A,
       { status: me.status, data: me.data });

    console.log('\n2. Jeton push (§9)');
    const fcm = await call('POST', '/auth/fcm-token', { token: tA, body: { token: 'jeton-test-abc123' } });
    ok('enregistrement du jeton FCM accepté', fcm.status === 200, fcm.status);

    console.log('\n2b. Profil (§6)');
    const pu = await call('PUT', '/auth/me', { token: tA, body: { name: 'Alice Modifiée' } });
    ok('modification du nom acceptée', pu.status === 200, pu.status);
    const me2 = await call('GET', '/auth/me', { token: tA });
    ok('le nom modifié est persistant',
       me2.data && me2.data.user && me2.data.user.name === 'Alice Modifiée',
       me2.data && me2.data.user);
    const badAv = await call('PUT', '/auth/me', { token: tA, body: { avatar: 'pas-une-image' } });
    ok('avatar invalide refusé (400)', badAv.status === 400, badAv.status);

    console.log('\n3. Messagerie texte (§5)');
    const snd = await call('POST', '/messages/send', { token: tA, body: { to: C, text: 'Mbote Chantal !' } });
    ok('envoi accepté', snd.status === 200 || snd.status === 201, { s: snd.status, d: snd.data });
    const thr = await call('GET', '/messages/threads', { token: tC });
    ok('le destinataire voit un fil', thr.status === 200 && Array.isArray(thr.data) && thr.data.length >= 1,
       { s: thr.status, n: Array.isArray(thr.data) ? thr.data.length : thr.data });
    const conv = await call('GET', `/messages/with/${encodeURIComponent(A)}`, { token: tC });
    const msgs = Array.isArray(conv.data) ? conv.data
      : (conv.data && (conv.data.items || conv.data.messages)) || [];
    ok('la conversation contient le message', msgs.some(m => String(m.body || m.text || '').includes('Mbote Chantal')),
       { s: conv.status, n: msgs.length });
    const rd = await call('POST', `/messages/with/${encodeURIComponent(A)}/read`, { token: tC });
    ok('marquage comme lu accepté', rd.status === 200, rd.status);

    console.log('\n4. Fil d\'actualité, publications et likes (§7)');
    const post = await call('POST', '/feed/posts', { token: tA,
      body: { type: 'texte', texte: 'Première publication de test', visibilite: 'public' } });
    ok('publication créée', post.status === 200 || post.status === 201, { s: post.status, d: post.data });
    const pid = post.data && (post.data.id || (post.data.post && post.data.post.id));
    const feed = await call('GET', '/feed', { token: tC });
    ok('le fil se charge', feed.status === 200, feed.status);
    if (pid) {
      const like1 = await call('POST', `/feed/posts/${pid}/like`, { token: tC });
      ok('like ajouté', like1.status === 200, { s: like1.status, d: like1.data });
      const like2 = await call('POST', `/feed/posts/${pid}/like`, { token: tC });
      ok('second appel : pas de doublon (bascule ou refus)', like2.status === 200 || like2.status === 409,
         { s: like2.status, d: like2.data });
      const cmt = await call('POST', `/feed/posts/${pid}/comments`, { token: tC, body: { texte: 'Bravo' } });
      ok('commentaire ajouté', cmt.status === 200 || cmt.status === 201, cmt.status);
    } else {
      ok('identifiant de publication récupéré', false, post.data);
    }

    console.log('\n5. Rappel d\'appel programmé (§8)');
    const future = Date.now() + 3600_000;
    const dl = await call('POST', '/dial-later', { token: tA,
      body: { target_phone: C, target_name: NC, scheduled_at: future, tz_offset: 60 } });
    ok('rappel créé', dl.status === 200 || dl.status === 201, { s: dl.status, d: dl.data });
    const dlPast = await call('POST', '/dial-later', { token: tA,
      body: { target_phone: C, scheduled_at: Date.now() - 1000 } });
    ok('date passée refusée (400)', dlPast.status === 400, dlPast.status);
    const dlList = await call('GET', '/dial-later', { token: tA });
    ok('liste des rappels', dlList.status === 200, dlList.status);
    const dlId = dl.data && (dl.data.id || (dl.data.reminder && dl.data.reminder.id));
    if (dlId) {
      const del = await call('DELETE', `/dial-later/${dlId}`, { token: tA });
      ok('annulation du rappel', del.status === 200 || del.status === 204, del.status);
    }

    console.log('\n6. Boutique et forfaits');
    const cat = await call('GET', '/shop/catalog', { token: tA });
    ok('catalogue boutique répond', cat.status === 200, cat.status);
    const plans = await call('GET', '/shop/my-plans', { token: tA });
    ok('mes forfaits répond', plans.status === 200, plans.status);
    const pk = await call('GET', '/packages', { token: tA });
    ok('forfaits répond', pk.status === 200, pk.status);
    const pkm = await call('GET', '/packages/mine', { token: tA });
    ok('mes forfaits (packages) répond', pkm.status === 200, pkm.status);

    console.log('\n7. Présence et libellés');
    const pres = await call('GET', '/presence', { token: tA });
    ok('présence répond', pres.status === 200, pres.status);
    const i18n = await call('GET', '/i18n');
    ok('libellés répondent', i18n.status === 200, i18n.status);

    console.log('\n8. Configuration ICE / TURN (§3)');
    const ice = await call('GET', '/rtc/ice', { token: tA });
    ok('/rtc/ice accessible (était 404 avant montage)', ice.status === 200, ice.status);
    const list = ice.data && ice.data.iceServers;
    ok('la réponse contient des serveurs ICE', Array.isArray(list) && list.length > 0,
       Array.isArray(list) ? list.length : ice.data);
    console.log(`      → TURN actif : ${ice.data && ice.data.turn === true ? 'OUI' : 'NON (STUN seul — variables Metered/TURN non définies)'}`);

    console.log('\n9. Autorisation');
    const noTok = await call('GET', '/messages/threads');
    ok('sans jeton → 401', noTok.status === 401, noTok.status);
    const badTok = await call('GET', '/messages/threads', { token: 'jeton-bidon' });
    ok('jeton invalide → 401', badTok.status === 401, badTok.status);

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
