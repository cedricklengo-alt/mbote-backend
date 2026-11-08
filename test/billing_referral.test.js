/**
 * Tests FACTURATION RÉELLE et PARRAINAGE — les deux endroits où une erreur se
 * traduit directement par de l'argent perdu ou volé.
 *
 *   1. Un appel vers un GSM est facturé à la seconde, jamais en dessous de zéro.
 *   2. Le premier appel facturé d'un filleul verse 1 $ au filleul ET 1 $ au
 *      parrain, une seule fois.
 *   3. Un compte bloqué par l'admin ne peut plus appeler ni se reconnecter.
 *   4. Un appel MboteCall → MboteCall reste gratuit.
 *
 * Lancement :  node test/billing_referral.test.js
 */
const { spawn } = require('child_process');
const path = require('path');

const PORT = 4796;
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

async function login(phone, name, referralCode) {
  const a = await call('POST', '/auth/request-otp', { body: { phone, name } });
  const b = await call('POST', '/auth/verify-otp',
    { body: { phone, code: a.data.demo_code, name, referral_code: referralCode } });
  return { token: b.data?.token, phone, name, id: b.data?.user?.id, verify: b };
}

const bal = async (u) => (await call('GET', '/wallet', { token: u.token })).data.balance_cents;

/** Appelle un numéro GSM, attend le décroché simulé (4 s), puis raccroche. */
async function appelFacture(u, to, secondes = 6) {
  const start = await call('POST', '/calls/start', { token: u.token, body: { to } });
  if (start.status !== 200) return { start };
  const id = start.data.call_id;
  // Le provider démo décroche à 4 s : on attend, puis on laisse filer 2 s.
  await sleep(4600);
  const mid = await call('GET', `/calls/${id}/status`, { token: u.token });
  await sleep(secondes * 200);
  const end = await call('POST', `/calls/${id}/hangup`, { token: u.token });
  return { start, mid, end, id };
}

(async () => {
  const srv = spawn('node', ['src/server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env, PORT: String(PORT), JWT_SECRET: 'test-billing', DEMO_MODE: 'true',
      DATABASE_URL: '', PUBLIC_URL: `http://127.0.0.1:${PORT}`,
      FIREBASE_SERVICE_ACCOUNT: '', MBOTE_MESSAGE_STORAGE: '/tmp/billing-test-storage',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let srvOut = '';
  srv.stdout.on('data', d => { srvOut += d; });
  srv.stderr.on('data', d => { srvOut += d; });

  let up = false;
  for (let i = 0; i < 40; i++) {
    await sleep(300);
    try { const r = await fetch(`${B}/health`); if (r.ok) { up = true; break; } } catch { /* … */ }
  }
  if (!up) { console.error('serveur non démarré\n' + srvOut); srv.kill(); process.exit(1); }

  try {
    const s = String(Date.now() % 100000).padStart(5, '0'); // 5 chiffres garantis
    const parrain = await login(`+2438500${s}`, 'Parrain');
    const code = (await call('GET', '/referral', { token: parrain.token })).data.code;

    // ─────────────── 1. Parrainage : code au moment de l'inscription ──────────
    console.log('1. Parrainage — inscription avec code');
    const filleul = await login(`+2438501${s}`, 'Filleul', code);
    ok('inscription acceptée', filleul.verify.status === 200, filleul.verify.status);
    ok('le filleul a bien 0,50 $ de bienvenue', (await bal(filleul)) === 50, await bal(filleul));
    const statsAvant = (await call('GET', '/referral', { token: parrain.token })).data;
    ok('le parrain voit 1 filleul', statsAvant.filleuls === 1, statsAvant);
    ok('aucun gain avant le premier appel', statsAvant.earned_cents === 0, statsAvant.earned_cents);

    const avecCodeInconnu = await login(`+2438502${s}`, 'Sans parrain', 'MBOTE-ZZZZZZ');
    ok('un code inconnu n’empêche pas l’inscription', avecCodeInconnu.verify.status === 200);

    // ─────────────── 2. Tarif affiché avant l'appel ───────────────
    console.log('\n2. Tarif');
    const gsm = `+24399${String(s).padStart(6, '0').slice(-6)}`;   // GSM non inscrit (9 chiffres)
    const tarif = await call('GET', `/rates/lookup?phone=${encodeURIComponent(gsm)}`,
      { token: filleul.token });
    ok('tarif consultable', tarif.status === 200 && tarif.data.price_per_min_cents > 0, tarif.data);

    // ─────────────── 3. Appel facturé → déclenche le bonus ───────────────
    console.log('\n3. Premier appel facturé du filleul');
    const avantF = await bal(filleul);
    const avantP = await bal(parrain);
    const a = await appelFacture(filleul, gsm);
    ok('appel démarré', a.start.status === 200, a.start.data);
    ok('appel décroché (statut « answered »)', a.mid?.data?.status === 'answered', a.mid?.data?.status);
    ok('appel terminé', a.end.status === 200, a.end.data);
    ok('durée facturée > 0', (a.end.data?.billed_sec || 0) > 0, a.end.data?.billed_sec);
    ok('coût > 0', (a.end.data?.cost_cents || 0) > 0, a.end.data?.cost_cents);

    const apresF = await bal(filleul);
    ok('le solde du filleul = 50 + 100 (bonus) − coût',
       apresF === avantF + 100 - a.end.data.cost_cents, { avantF, apresF, cout: a.end.data.cost_cents });
    ok('le parrain reçoit 1 $', (await bal(parrain)) === avantP + 100, await bal(parrain));

    const statsApres = (await call('GET', '/referral', { token: parrain.token })).data;
    ok('gain du parrain visible', statsApres.earned_cents === 100, statsApres.earned_cents);
    const txF = await call('GET', '/wallet/stats', { token: filleul.token });
    ok('bonus filleul dans l’historique',
       (txF.data.transactions || []).some(t => t.type === 'referral_bonus' && t.amount_cents === 100),
       txF.data.transactions?.map(t => t.type));
    const txP = await call('GET', '/wallet/stats', { token: parrain.token });
    ok('bonus parrain dans l’historique',
       (txP.data.transactions || []).some(t => t.type === 'referral_bonus' && t.amount_cents === 100),
       txP.data.transactions?.map(t => t.type));
    ok('le débit de l’appel est tracé',
       (txF.data.transactions || []).some(t => t.type === 'call_debit' && t.amount_cents < 0),
       txF.data.transactions?.map(t => t.type));

    // ─────────────── 4. Le bonus n'est versé qu'une fois ───────────────
    console.log('\n4. Deuxième appel → pas de nouveau bonus');
    const avantP2 = await bal(parrain);
    const f2 = await bal(filleul);
    const b = await appelFacture(filleul, gsm);
    ok('deuxième appel facturé', (b.end?.data?.cost_cents || 0) > 0, b.end?.data?.cost_cents);
    ok('le parrain ne touche rien de plus', (await bal(parrain)) === avantP2, await bal(parrain));
    ok('le filleul ne touche rien de plus',
       (await bal(filleul)) === f2 - b.end.data.cost_cents, await bal(filleul));
    ok('aucun solde négatif', (await bal(filleul)) >= 0 && (await bal(parrain)) >= 0);

    // ─────────────── 5. Appel MboteCall → MboteCall : gratuit ───────────────
    console.log('\n5. Appel entre comptes MboteCall (gratuit)');
    const autre = await login(`+2438503${s}`, 'Ami Mbote');
    const b0 = await bal(autre);
    const startFree = await call('POST', '/calls/start',
      { token: autre.token, body: { to: parrain.phone } });
    ok('appel MboteCall démarré', startFree.status === 200, startFree.data);
    ok('tarif nul annoncé', startFree.data?.price_per_min_cents === 0, startFree.data?.price_per_min_cents);
    const endFree = await call('POST', `/calls/${startFree.data.call_id}/hangup`, { token: autre.token });
    ok('coût nul', (endFree.data?.cost_cents ?? startFree.data?.cost_cents ?? 0) === 0, endFree.data);
    ok('solde inchangé après appel gratuit', (await bal(autre)) === b0, await bal(autre));

    // ─────────────── 6. Blocage par l'admin ───────────────
    console.log('\n6. Compte bloqué');
    const admin = await call('POST', '/admin/login',
      { body: { phone: '+243900000000', password: 'MboteAdmin2026' } });
    const block = await call('POST', `/admin/users/${filleul.id}/status`,
      { token: admin.data.token, body: { status: 'blocked' } });
    ok('blocage accepté', block.status === 200, block.data);
    ok('le compte bloqué ne peut plus appeler',
       (await call('POST', '/calls/start', { token: filleul.token, body: { to: gsm } })).status === 403);
    ok('son jeton est refusé partout (403)',
       (await call('GET', '/wallet', { token: filleul.token })).status === 403);
    ok('il ne peut pas se reconnecter', (await login(filleul.phone, 'Filleul')).verify.status === 403);
    ok('on ne peut pas l’appeler', (await call('POST', '/calls/start',
      { token: parrain.token, body: { to: filleul.phone } })).status === 403);
    const unblock = await call('POST', `/admin/users/${filleul.id}/status`,
      { token: admin.data.token, body: { status: 'active' } });
    ok('déblocage accepté', unblock.status === 200, unblock.data);
    ok('l’accès est rétabli', (await call('GET', '/wallet', { token: filleul.token })).status === 200);
    ok('statut inconnu refusé', (await call('POST', `/admin/users/${filleul.id}/status`,
      { token: admin.data.token, body: { status: 'peut-etre' } })).status === 400);

    // ─────────────── 7. Intégrité ───────────────
    console.log('\n7. Intégrité');
    const erreurs = srvOut.split('\n').filter(l => l.startsWith('💥') && /→ 5\d\d/.test(l));
    ok('aucune erreur serveur (5xx)', erreurs.length === 0, erreurs.slice(0, 3));
  } catch (e) {
    console.error('erreur inattendue :', e);
    console.error('--- sortie serveur ---\n' + srvOut.slice(-2000));
    fail++;
  } finally {
    srv.kill();
    await sleep(200);
  }

  console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} réussis · ${fail} échoués`);
  process.exit(fail === 0 ? 0 : 1);
})();
