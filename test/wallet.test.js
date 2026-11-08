/**
 * Tests du PORTEFEUILLE et des parcours « argent » — vrai serveur, vraies
 * requêtes HTTP : solde, recharge, transfert entre proches, achat de forfait,
 * crédit GSM, contacts, tarifs, parrainage, présence, appels programmés,
 * libellés, console admin.
 *
 * Ce que l'on cherche : de l'argent créé ou perdu, un solde négatif, un accès
 * sans autorisation, une route qui répond 500.
 *
 * Lancement :  node test/wallet.test.js
 */
const { spawn } = require('child_process');
const path = require('path');

const PORT = 4793;
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

const bal = async (u) => (await call('GET', '/wallet', { token: u.token })).data.balance_cents;

(async () => {
  const srv = spawn('node', ['src/server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env, PORT: String(PORT), JWT_SECRET: 'test-wallet', DEMO_MODE: 'true',
      DATABASE_URL: '', PUSH_DEBUG_FAKE: 'true', PUBLIC_URL: `http://127.0.0.1:${PORT}`,
      MBOTE_MESSAGE_STORAGE: '/tmp/wallet-test-storage',
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
    const suffix = String(Date.now() % 100000).padStart(5, '0'); // 5 chiffres garantis
    const A = await login(`+2438300${suffix}`, 'Alice Wallet');
    const Bb = await login(`+2438301${suffix}`, 'Bob Wallet');

    // ─────────────── 1. Profil ───────────────
    console.log('1. Profil');
    const me = await call('GET', '/auth/me', { token: A.token });
    ok('profil lisible', me.status === 200 && me.data.user.phone === A.phone, me.data);
    const upd = await call('PUT', '/auth/me', { token: A.token, body: { name: 'Alice K.' } });
    ok('nom modifiable', upd.status === 200, upd);
    const me2 = await call('GET', '/auth/me', { token: A.token });
    ok('nouveau nom enregistré', me2.data.user.name === 'Alice K.', me2.data.user.name);
    ok('profil sans jeton → 401', (await call('GET', '/auth/me')).status === 401);

    // ─────────────── 2. Portefeuille vide ───────────────
    console.log('\n2. Portefeuille au départ');
    const w0 = await call('GET', '/wallet', { token: A.token });
    ok('bonus de bienvenue de 0,50 $', w0.data.balance_cents === 50, w0.data.balance_cents);
    ok('devise USD', w0.data.currency === 'USD', w0.data.currency);
    const st0 = await call('GET', '/wallet/stats', { token: A.token });
    ok('statistiques numériques',
       st0.data.topup_cents === 50 && st0.data.spent_cents === 0 && Array.isArray(st0.data.transactions),
       st0.data);
    ok('chaque compte ne voit que son propre solde',
       (await call('GET', `/wallet`, { token: Bb.token })).data.balance_cents === 50);

    // ─────────────── 3. Recharge (Mobile Money, démo) ───────────────
    console.log('\n3. Recharge');
    ok('montant trop petit refusé', (await call('POST', '/wallet/topup', {
      token: A.token, body: { amount_cents: 10, method: 'mpesa' } })).status === 400);
    ok('moyen de paiement inconnu refusé', (await call('POST', '/wallet/topup', {
      token: A.token, body: { amount_cents: 1000, method: 'bitcoin' } })).status === 400);
    const topup = await call('POST', '/wallet/topup', {
      token: A.token, body: { amount_cents: 1000, method: 'mpesa' } });
    ok('recharge initiée (payment_id)', topup.status === 200 && !!topup.data.payment_id, topup.data);
    ok('statut « pending » au départ', topup.data.status === 'pending', topup.data.status);
    let suivi = null;
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      suivi = await call('GET', `/wallet/topup/${topup.data.payment_id}/status`, { token: A.token });
      if (suivi.data.status !== 'pending') break;
    }
    ok('suivi de recharge répond', suivi.status === 200, suivi);
    ok('statut final connu (démo : success)', ['success', 'failed'].includes(suivi.data.status),
       suivi.data.status);
    ok('le suivi d’un autre utilisateur est refusé',
       (await call('GET', `/wallet/topup/${topup.data.payment_id}/status`, { token: Bb.token })).status === 404);

    // ─────────────── 4. Crédit admin ───────────────
    console.log('\n4. Console admin');
    const admin = await call('POST', '/admin/login', {
      body: { phone: '+243900000000', password: 'MboteAdmin2026' } });
    ok('connexion admin', admin.status === 200 && !!admin.data.token, admin.data);
    ok('admin refusé à un simple utilisateur',
       (await call('GET', '/admin/stats', { token: A.token })).status === 403);
    const avantCredit = await bal(A);
    const credit = await call('POST', `/admin/users/${A.id}/credit`, {
      token: admin.data.token, body: { amount_cents: 5000 } });
    ok('crédit admin accepté', credit.status === 200, credit.data);
    ok('solde crédité (+5000)', (await bal(A)) === avantCredit + 5000, await bal(A));
    ok('montant nul refusé', (await call('POST', `/admin/users/${A.id}/credit`, {
      token: admin.data.token, body: { amount_cents: 0 } })).status === 400);

    // ─────────────── 5. Transfert entre proches ───────────────
    console.log('\n5. Transfert MboteCall → MboteCall');
    ok('transfert à soi-même refusé', (await call('POST', '/wallet/transfer', {
      token: A.token, body: { to_phone: A.phone, amount_cents: 100 } })).status === 400);
    ok('numéro inconnu refusé (404)', (await call('POST', '/wallet/transfer', {
      token: A.token, body: { to_phone: '+243999999999', amount_cents: 100 } })).status === 404);
    ok('montant trop petit refusé', (await call('POST', '/wallet/transfer', {
      token: A.token, body: { to_phone: Bb.phone, amount_cents: 10 } })).status === 400);
    const gros = await bal(A) + 1;   // un centime de plus que le solde
    ok('solde insuffisant → 402', (await call('POST', '/wallet/transfer', {
      token: A.token, body: { to_phone: Bb.phone, amount_cents: gros } })).status === 402, gros);

    const avantA = await bal(A), avantB = await bal(Bb);
    const tr = await call('POST', '/wallet/transfer', {
      token: A.token, body: { to_phone: Bb.phone, amount_cents: 1200 } });
    ok('transfert réussi', tr.status === 200 && tr.data.sent_cents === 1200, tr.data);
    ok('solde de l’envoyeur débité', tr.data.balance_cents === avantA - 1200, tr.data.balance_cents);
    ok('bénéficiaire crédité', (await bal(Bb)) === avantB + 1200, await bal(Bb));
    ok('total conservé (aucun argent créé)', (await bal(A)) + (await bal(Bb)) === avantA + avantB,
       (await bal(A)) + (await bal(Bb)));
    const txA = await call('GET', '/wallet', { token: A.token });
    ok('écriture « transfer_out » négative',
       txA.data.transactions.some(t => t.type === 'transfer_out' && t.amount_cents === -1200),
       txA.data.transactions.slice(0, 3));
    const txB = await call('GET', '/wallet', { token: Bb.token });
    ok('écriture « transfer_in » positive',
       txB.data.transactions.some(t => t.type === 'transfer_in' && t.amount_cents === 1200),
       txB.data.transactions.slice(0, 3));

    // ─────────────── 6. Forfaits ───────────────
    console.log('\n6. Forfaits');
    const packs = await call('GET', '/packages');
    ok('catalogue non vide', packs.status === 200 && packs.data.length > 0, packs.data && packs.data.length);
    const pack = packs.data.find(p => p.price_cents <= 3800) || packs.data[0];
    const avantPack = await bal(A);
    const buy = await call('POST', `/packages/${pack.id}/buy`, { token: A.token });
    ok('achat de forfait accepté', buy.status === 200 && buy.data.ok === true, buy.data);
    ok('solde débité du prix', buy.data.balance_cents === avantPack - pack.price_cents, buy.data.balance_cents);
    const mine = await call('GET', '/packages/mine', { token: A.token });
    ok('forfait visible dans « mes forfaits »', mine.status === 200 && mine.data.length >= 1, mine.data);
    ok('forfait inconnu → 404', (await call('POST', '/packages/999999/buy', { token: A.token })).status === 404);
    // Tous les forfaits coûtent plus que le solde de Bob → refus
    const pauvre = await call('POST', `/packages/${packs.data[packs.data.length - 1].id}/buy`,
      { token: Bb.token });
    ok('achat sans solde suffisant → 402', pauvre.status === 402, pauvre.status);
    ok('solde de Bob intact après refus', (await bal(Bb)) === avantB + 1200, await bal(Bb));

    // ─────────────── 7. Crédit GSM ───────────────
    console.log('\n7. Crédit GSM (airtime)');
    ok('numéro invalide refusé', (await call('POST', '/airtime', {
      token: A.token, body: { phone: 'abc', amount_cents: 100 } })).status === 400);
    ok('montant hors limites refusé', (await call('POST', '/airtime', {
      token: A.token, body: { phone: '+243990001112', amount_cents: 20 } })).status === 400);
    const avantAir = await bal(A);
    const air = await call('POST', '/airtime', {
      token: A.token, body: { phone: '+243990001113', amount_cents: 100 } });
    ok('crédit GSM accepté', air.status === 200 && air.data.ok === true, air.data);
    ok('solde débité de 1 $', air.data.balance_cents === avantAir - 100, air.data.balance_cents);
    const histAir = await call('GET', '/airtime', { token: A.token });
    ok('historique du crédit GSM', histAir.status === 200 && histAir.data.length >= 1, histAir.data);
    ok('crédit GSM sans solde → 402', (await call('POST', '/airtime', {
      token: Bb.token, body: { phone: '+243990001114', amount_cents: 5000 } })).status === 402);

    // ─────────────── 8. Contacts ───────────────
    console.log('\n8. Contacts');
    const add = await call('POST', '/contacts', {
      token: A.token, body: { name: 'Bob', phone: Bb.phone } });
    ok('contact ajouté', add.status === 200 && !!add.data.id, add.data);
    const list = await call('GET', '/contacts', { token: A.token });
    ok('contact visible dans la liste', list.data.some(c => c.phone === Bb.phone), list.data);
    const check = await call('POST', '/contacts/check', {
      token: A.token, body: { phones: [Bb.phone, '+243999999998'] } });
    ok('check : le compte existant est reconnu', !!check.data.mbote[Bb.phone], check.data);
    ok('check : l’inconnu n’est pas reconnu', !check.data.mbote['+243999999998'], check.data);
    const up = await call('POST', '/contacts', {
      token: A.token, body: { name: 'Bob le sage', phone: Bb.phone } });
    ok('ajout en double = mise à jour (pas de doublon)', up.data.id === add.data.id, up.data);
    const profil = await call('GET', `/contacts/profile/${encodeURIComponent(Bb.phone)}`, { token: A.token });
    ok('profil du contact lisible', profil.status === 200 && profil.data.phone === Bb.phone, profil.data);
    ok('profil d’un inconnu → 404',
       (await call('GET', '/contacts/profile/+243999999997', { token: A.token })).status === 404);
    const rem = await call('POST', `/contacts/${encodeURIComponent(Bb.phone)}/reminder`, { token: A.token });
    ok('rappel de présence activable', rem.status === 200 && rem.data.ok === true, rem.data);
    ok('rappel de présence annulable',
       (await call('DELETE', `/contacts/${encodeURIComponent(Bb.phone)}/reminder`, { token: A.token })).status === 200);
    ok('contact supprimé',
       (await call('DELETE', `/contacts/${add.data.id}`, { token: A.token })).status === 200
       && !(await call('GET', '/contacts', { token: A.token })).data.some(c => c.id === add.data.id));

    // ─────────────── 9. Tarifs, promos, parrainage ───────────────
    console.log('\n9. Tarifs, promos, parrainage');
    const rates = await call('GET', '/rates');
    ok('grille tarifaire non vide', rates.status === 200 && rates.data.length > 0, rates.data && rates.data.length);
    const lk = await call('GET', '/rates/lookup?phone=%2B243810000001', { token: A.token });
    ok('tarif d’un numéro RDC', lk.status === 200 && lk.data.price_per_min_cents > 0, lk.data);
    ok('tarif d’un numéro inconnu refusé', (await call('GET',
      '/rates/lookup?phone=abc', { token: A.token })).status === 400);
    ok('promos répond', (await call('GET', '/rates/promos')).status === 200);
    const ref = await call('GET', '/referral', { token: A.token });
    ok('code de parrainage fourni', ref.status === 200 && !!ref.data.code, ref.data);
    const inv = await call('POST', '/referral/invite', {
      token: A.token, body: { phone: `+2439999${String(suffix).slice(-4)}` } });
    ok('invitation traitée (SMS peut être non configuré)', inv.status === 200 && inv.data.code, inv.data);

    // ─────────────── 9 bis. Promos / Happy Hours ───────────────
    console.log('\n9 bis. Promos (remises pilotées par la console)');
    const numPromo = '+243999999001';   // préfixe réservé à ce test
    const base = (await call('GET', `/rates/lookup?phone=${encodeURIComponent(numPromo)}`,
      { token: A.token })).data;
    ok('tarif de référence connu', base.price_per_min_cents > 1, base);

    ok('remise hors bornes refusée (95 %)', (await call('POST', '/admin/promos', {
      token: admin.data.token, body: { title: 'Trop', discount_pct: 95 } })).status === 400);
    const promo1 = await call('POST', '/admin/promos', {
      token: admin.data.token,
      body: { title: 'Happy hour test', discount_pct: 50, prefix: '243999999' } });
    ok('promo créée', promo1.status === 200 && !!promo1.data.id, promo1.data);

    const remise = (await call('GET', `/rates/lookup?phone=${encodeURIComponent(numPromo)}`,
      { token: A.token })).data;
    const attendu = Math.max(1, Math.round(base.price_per_min_cents * 0.5));
    ok('le tarif baisse de 50 %', remise.price_per_min_cents === attendu,
       { base: base.price_per_min_cents, obtenu: remise.price_per_min_cents, attendu });
    ok('la promo est annoncée au client', remise.promo && remise.promo.discount_pct === 50,
       remise.promo);
    const listePromos = await call('GET', '/rates/promos');
    ok('promo listée sur l’écran d’accueil',
       (listePromos.data || []).some(p => p.discount_pct === 50), listePromos.data);

    // Une meilleure remise gagne
    const promo2 = await call('POST', '/admin/promos', {
      token: admin.data.token,
      body: { title: 'Meilleure', discount_pct: 70, prefix: '243999999' } });
    const remise2 = (await call('GET', `/rates/lookup?phone=${encodeURIComponent(numPromo)}`,
      { token: A.token })).data;
    ok('la meilleure remise s’applique (70 %)',
       remise2.price_per_min_cents === Math.max(1, Math.round(base.price_per_min_cents * 0.3)),
       remise2.price_per_min_cents);

    // Désactivation → retour au tarif normal
    await call('PUT', `/admin/promos/${promo1.data.id}`, {
      token: admin.data.token, body: { active: false } });
    await call('PUT', `/admin/promos/${promo2.data.id}`, {
      token: admin.data.token, body: { active: false } });
    const apres = (await call('GET', `/rates/lookup?phone=${encodeURIComponent(numPromo)}`,
      { token: A.token })).data;
    ok('promo désactivée → tarif normal', apres.price_per_min_cents === base.price_per_min_cents,
       apres.price_per_min_cents);

    await call('DELETE', `/admin/promos/${promo1.data.id}`, { token: admin.data.token });
    await call('DELETE', `/admin/promos/${promo2.data.id}`, { token: admin.data.token });
    ok('promos supprimées', !(await call('GET', '/admin/promos', { token: admin.data.token }))
       .data.some(p => p.id === promo1.data.id || p.id === promo2.data.id));

    // ─────────────── 10. Présence, appels programmés, libellés ───────────────
    console.log('\n10. Présence, appels programmés, libellés');
    const pres = await call('GET', `/presence?phones=${encodeURIComponent(Bb.phone)}`, { token: A.token });
    ok('présence répond', pres.status === 200 && typeof pres.data === 'object', pres.data);
    const soon = Date.now() + 3 * 60 * 60 * 1000;
    const dl = await call('POST', '/dial-later', {
      token: A.token, body: { target_phone: Bb.phone, target_name: 'Bob', scheduled_at: soon } });
    ok('appel programmé créé', dl.status === 200 && !!dl.data.id, dl.data);
    ok('date passée refusée', (await call('POST', '/dial-later', {
      token: A.token, body: { target_phone: Bb.phone, scheduled_at: Date.now() - 1000 } })).status === 400);
    ok('appel programmé listé',
       (await call('GET', '/dial-later', { token: A.token })).data.some(d => d.id === dl.data.id));
    ok('appel programmé annulable',
       (await call('DELETE', `/dial-later/${dl.data.id}`, { token: A.token })).status === 200);
    ok('annulé → absent de la liste',
       !(await call('GET', '/dial-later', { token: A.token })).data.some(d => d.id === dl.data.id));
    const langs = await call('GET', '/i18n');
    ok('langues disponibles', langs.status === 200, langs.data);
    const enPack = await call('GET', '/i18n/en');
    ok('pack de langue complet (anglais)', enPack.status === 200 && !!enPack.data.strings.hello,
       enPack.status);
    ok('langue inconnue → 404', (await call('GET', '/i18n/xx')).status === 404);

    // ─────────────── 11. Console admin : lecture ───────────────
    console.log('\n11. Console admin');
    for (const [label, p] of [
      ['statistiques', '/admin/stats'], ['utilisateurs', '/admin/users'],
      ['tarifs', '/admin/rates'], ['promos', '/admin/promos'],
      ['CDR', '/admin/cdrs'], ['paiements', '/admin/payments'],
      ['transactions', '/admin/transactions'],
    ]) {
      const r = await call('GET', p, { token: admin.data.token });
      ok(`admin ${label} répond`, r.status === 200, r.status);
    }
    // Onglets « Forfaits » et « Crédit GSM » de la console admin
    const adminPacks = await call('GET', '/admin/packages', { token: admin.data.token });
    ok('console : liste des forfaits', adminPacks.status === 200 && Array.isArray(adminPacks.data),
       adminPacks.status);
    const nouveauPack = await call('POST', '/admin/packages', {
      token: admin.data.token,
      body: { name: 'Pack test console', price_cents: 300, minutes: 30, days: 7, prefix: '243' } });
    ok('console : création d’un forfait', nouveauPack.status === 200 || nouveauPack.status === 201,
       nouveauPack.data);
    const packId = (nouveauPack.data.package || nouveauPack.data).id;
    const majPack = await call('PUT', `/admin/packages/${packId}`, {
      token: admin.data.token, body: { active: false } });
    ok('console : forfait désactivable', majPack.status === 200 && majPack.data.package.active === 0,
       majPack.data);
    ok('console : forfait modifiable (prix)',
       (await call('PUT', `/admin/packages/${packId}`, {
         token: admin.data.token, body: { price_cents: 250 } })).data.package.price_cents === 250);
    ok('console : champ inconnu refusé', (await call('PUT', `/admin/packages/${packId}`, {
      token: admin.data.token, body: {} })).status === 400);
    ok('console : forfait supprimé',
       (await call('DELETE', `/admin/packages/${packId}`, { token: admin.data.token })).status === 200);
    const adminAir = await call('GET', '/admin/airtime', { token: admin.data.token });
    ok('console : historique du crédit GSM', adminAir.status === 200 && Array.isArray(adminAir.data),
       adminAir.status);
    ok('console : numéro du bénéficiaire affiché',
       (adminAir.data || []).every(a => 'user_phone' in a), adminAir.data?.[0]);

    const newRate = await call('POST', '/admin/rates', {
      token: admin.data.token, body: { prefix: '999', destination: 'Test', flag: '🧪', price_per_min_cents: 7 } });
    ok('tarif créé', newRate.status === 200 && !!newRate.data.id, newRate.data);
    const delRate = await call('DELETE', `/admin/rates/${newRate.data.id}`, { token: admin.data.token });
    ok('tarif supprimé', delRate.status === 200, delRate.data);

    // ─────────────── 12. Rien de négatif, aucun 500 ───────────────
    console.log('\n12. Intégrité');
    ok('aucun solde négatif', (await bal(A)) >= 0 && (await bal(Bb)) >= 0, [await bal(A), await bal(Bb)]);
    // Les 4xx volontaires (« forfait inconnu », « solde insuffisant »…) sont
    // journalisés avec 💥 par le gestionnaire d'erreurs : on ne compte que les 5xx.
    const erreurs = srvOut.split('\n').filter(l => l.startsWith('💥') && /→ 5\d\d/.test(l));
    ok('aucune erreur serveur (💥) pendant les tests', erreurs.length === 0, erreurs.slice(0, 3));
  } catch (e) {
    console.error('erreur inattendue :', e);
    console.error('--- sortie serveur ---\n' + srvOut);
    fail++;
  } finally {
    srv.kill();
    await sleep(200);
  }

  console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} réussis · ${fail} échoués`);
  process.exit(fail === 0 ? 0 : 1);
})();
