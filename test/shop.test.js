/**
 * Tests BOUTIQUE, NOTES VOCALES (Lokota), WEBHOOKS, INVITATIONS et WebRTC (HTTP)
 * — vrai serveur, vraies requêtes.
 *
 * Ce que l'on cherche : un forfait activé sans paiement, un forfait activé
 * deux fois, une note vocale livrée à la mauvaise personne, un webhook qui
 * crédite sur parole, une invitation réutilisable.
 *
 * Lancement :  node test/shop.test.js
 */
const { spawn } = require('child_process');
const path = require('path');

const PORT = 4794;
const B = `http://127.0.0.1:${PORT}`;
const API = `${B}/api`;
let pass = 0, fail = 0;

const ok = (label, cond, detail) => {
  if (cond) { console.log(`  ✓ ${label}`); pass++; }
  else { console.log(`  ✗ ${label}${detail !== undefined ? ' → ' + JSON.stringify(detail) : ''}`); fail++; }
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function call(method, p, { token, body, raw } = {}) {
  const h = { 'Content-Type': 'application/json' };
  if (token) h.Authorization = `Bearer ${token}`;
  const r = await fetch(API + p, { method, headers: h, body: body ? JSON.stringify(body) : raw });
  let data = null, text = null;
  try { data = await r.json(); } catch { text = await r.text().catch(() => ''); }
  return { status: r.status, data, text };
}

async function login(phone, name) {
  const a = await call('POST', '/auth/request-otp', { body: { phone, name } });
  const b = await call('POST', '/auth/verify-otp', { body: { phone, code: a.data.demo_code, name } });
  return { token: b.data.token, phone, name, id: b.data.user.id };
}

/** Attend la confirmation Mobile Money démo (≈ 8 s) puis renvoie l'état. */
async function attendreStatut(url, token, max = 30) {
  let last = null;
  for (let i = 0; i < max; i++) {
    await sleep(500);
    last = await call('GET', url, { token });
    if (last.data && last.data.status && last.data.status !== 'pending') return last;
  }
  return last;
}

const AUDIO = 'data:audio/wav;base64,' + Buffer.alloc(2000, 7).toString('base64');

(async () => {
  const srv = spawn('node', ['src/server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env, PORT: String(PORT), JWT_SECRET: 'test-shop', DEMO_MODE: 'true',
      DATABASE_URL: '', PUBLIC_URL: B, FLEXPAY_WEBHOOK_SECRET: 'secret-boutique-test',
      MBOTE_MESSAGE_STORAGE: '/tmp/shop-test-storage',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let srvOut = '';
  srv.stdout.on('data', d => { srvOut += d; });
  srv.stderr.on('data', d => { srvOut += d; });

  let up = false;
  for (let i = 0; i < 40; i++) {
    await sleep(300);
    try { const r = await fetch(`${B}/api/health`); if (r.ok) { up = true; break; } } catch { /* … */ }
  }
  if (!up) { console.error('serveur non démarré\n' + srvOut); srv.kill(); process.exit(1); }

  try {
    const s = String(Date.now() % 100000).padStart(5, '0'); // 5 chiffres garantis
    const A = await login(`+2438400${s}`, 'Alice Shop');     // acheteuse
    const Bb = await login(`+2438401${s}`, 'Bob Shop');      // bénéficiaire cadeau
    const C = await login(`+2438402${s}`, 'Carla Shop');     // intruse

    // ─────────────── 1. Catalogue ───────────────
    console.log('1. Catalogue de la boutique');
    const cat = await call('GET', '/shop/catalog', { token: A.token });
    const packs = cat.data?.packages || [];
    ok('catalogue accessible', cat.status === 200 && packs.length >= 2, packs.length);
    ok('champ prix présent', packs.every(p => Number.isInteger(p.price_cents)), packs.map(p => p.price_cents));
    ok('catalogue sans jeton → 401', (await call('GET', '/shop/catalog')).status === 401);
    const pack = packs[0];

    // ─────────────── 2. Commande ───────────────
    console.log('\n2. Commande');
    ok('package_id invalide refusé', (await call('POST', '/shop/orders', {
      token: A.token, body: { package_id: 'abc' } })).status === 400);
    const inconnu = await call('POST', '/shop/orders', { token: A.token, body: { package_id: 999999 } });
    ok('forfait inconnu → 404 (pas 500)', inconnu.status === 404, inconnu);
    const cmd = await call('POST', '/shop/orders', { token: A.token, body: { package_id: pack.id } });
    const ord = cmd.data?.order;
    ok('commande créée (201)', cmd.status === 201 && ord?.status === 'pending', cmd.data);
    ok('prix figé au moment de la commande', ord.amount_cents === pack.price_cents, ord?.amount_cents);
    ok('la commande appartient à l’acheteur', ord.user_id === A.id, ord?.user_id);
    ok('statut de commande lisible', (await call('GET', `/shop/orders/${ord.id}/status`,
      { token: A.token })).status === 200);
    ok('commande d’autrui invisible (404)',
       (await call('GET', `/shop/orders/${ord.id}/status`, { token: C.token })).status === 404);

    // ─────────────── 3. Paiement ───────────────
    console.log('\n3. Paiement Mobile Money');
    ok('méthode manquante refusée', (await call('POST', `/shop/orders/${ord.id}/pay`,
      { token: A.token, body: {} })).status === 400);
    ok('méthode inconnue refusée', (await call('POST', `/shop/orders/${ord.id}/pay`,
      { token: A.token, body: { method: 'bitcoin' } })).status === 400);
    ok('Mobile Money sans numéro refusé', (await call('POST', `/shop/orders/${ord.id}/pay`,
      { token: A.token, body: { method: 'mpesa' } })).status === 400);
    ok('numéro invalide refusé', (await call('POST', `/shop/orders/${ord.id}/pay`,
      { token: A.token, body: { method: 'mpesa', phone: 'abc' } })).status === 400);
    ok('paiement d’une commande d’autrui refusé (404)', (await call('POST', `/shop/orders/${ord.id}/pay`,
      { token: C.token, body: { method: 'card' } })).status === 404);
    const pay = await call('POST', `/shop/orders/${ord.id}/pay`,
      { token: A.token, body: { method: 'mpesa', phone: A.phone } });
    ok('paiement initié (201)', pay.status === 201 && pay.data?.payment?.status === 'pending', pay.data);
    const double = await call('POST', `/shop/orders/${ord.id}/pay`,
      { token: A.token, body: { method: 'mpesa', phone: A.phone } });
    ok('on ne crée pas un 2ᵉ paiement en attente',
       double.data?.payment?.id === pay.data.payment.id, double.data?.payment?.id);

    // ─────────────── 4. Activation après confirmation ───────────────
    console.log('\n4. Activation (confirmation opérateur simulée)');
    const suivi = await attendreStatut(`/shop/orders/${ord.id}/pay/status`, A.token);
    ok('paiement confirmé', suivi.data?.status === 'success', suivi.data);
    const plans = await call('GET', '/shop/my-plans', { token: A.token });
    const plan = (plans.data?.plans || []).find(p => p.order_id === ord.id);
    ok('forfait activé', !!plan, plans.data);
    ok('quota de minutes crédité', plan && plan.remaining_sec === pack.minutes * 60, plan?.remaining_sec);
    ok('forfait actif et non expiré', plan && plan.status === 'active' && plan.expires_at > Date.now());
    const st = await call('GET', `/shop/orders/${ord.id}/status`, { token: A.token });
    ok('commande marquée payée', st.data?.order?.status === 'paid', st.data?.order?.status);
    const again = await call('GET', `/shop/orders/${ord.id}/pay/status`, { token: A.token });
    ok('idempotence : 2ᵉ interrogation ne change rien', again.data?.status === 'success', again.data);
    const all = await call('GET', '/shop/my-plans/all', { token: A.token });
    ok('aucun forfait en double', (all.data?.plans || []).filter(p => p.order_id === ord.id).length === 1,
       (all.data?.plans || []).filter(p => p.order_id === ord.id).length);
    const walletA = await call('GET', '/wallet', { token: A.token });
    ok('le portefeuille MboteCall n’est pas débité (paiement Mobile Money direct)',
       walletA.data?.balance_cents === 50, walletA.data?.balance_cents);

    // ─────────────── 5. Cadeau ───────────────
    console.log('\n5. Forfait offert à un proche');
    ok('numéro bénéficiaire invalide refusé', (await call('POST', '/shop/gift-orders', {
      token: C.token, body: { package_id: pack.id, recipient_phone: '123' } })).status === 400);
    const gift = await call('POST', '/shop/gift-orders', {
      token: C.token, body: { package_id: pack.id, recipient_phone: Bb.phone, recipient_name: 'Bob' } });
    const gord = gift.data?.order;
    ok('commande cadeau créée (201)', gift.status === 201 && gord?.recipient_phone === Bb.phone, gift.data);
    await call('POST', `/shop/orders/${gord.id}/pay`, { token: C.token, body: { method: 'card' } });
    const gsuivi = await attendreStatut(`/shop/orders/${gord.id}/pay/status`, C.token);
    ok('paiement du cadeau confirmé', gsuivi.data?.status === 'success', gsuivi.data);
    const bPlans = await call('GET', '/shop/my-plans', { token: Bb.token });
    const bPlan = (bPlans.data?.plans || []).find(p => p.order_id === gord.id);
    ok('le bénéficiaire reçoit le forfait', !!bPlan, bPlans.data);
    ok('le forfait est marqué « cadeau »', bPlan?.is_gift === 1, bPlan?.is_gift);
    const cPlans = await call('GET', '/shop/my-plans/all', { token: C.token });
    ok('l’acheteur ne s’attribue pas le cadeau',
       !(cPlans.data?.plans || []).some(p => p.order_id === gord.id), cPlans.data?.plans?.length);

    // Cadeau vers un numéro PAS encore inscrit (acheteur neuf : quota de commandes)
    const inconnuPhone = '+243849' + String(Date.now() % 1000000).padStart(6, '0'); // 9 chiffres
    const D = await login(`+2438403${s}`, 'Denis Shop');
    const gift2 = await call('POST', '/shop/gift-orders', {
      token: D.token, body: { package_id: pack.id, recipient_phone: inconnuPhone } });
    ok('commande cadeau vers non-inscrit créée', gift2.status === 201, gift2.data);
    await call('POST', `/shop/orders/${gift2.data.order.id}/pay`, { token: D.token, body: { method: 'card' } });
    const g2 = await attendreStatut(`/shop/orders/${gift2.data.order.id}/pay/status`, D.token);
    ok('cadeau vers non-inscrit : paiement confirmé', g2.data?.status === 'success', g2.data);
    const nouveau = await login(inconnuPhone, 'Nouveau Cadeau');
    const nPlans = await call('GET', '/shop/my-plans', { token: nouveau.token });
    ok('le cadeau est livré à l’inscription du numéro',
       (nPlans.data?.plans || []).some(p => p.order_id === gift2.data.order.id), nPlans.data?.plans?.length);

    // ─────────────── 5 bis. Anti-abus commandes ───────────────
    console.log('\n5 bis. Limitation du nombre de commandes');
    const E = await login(`+2438404${s}`, 'Elie Shop');
    const codes = [];
    for (let i = 0; i < 6; i++) {
      codes.push((await call('POST', '/shop/orders', { token: E.token, body: { package_id: pack.id } })).status);
    }
    ok('5 premières commandes acceptées', codes.slice(0, 5).every(c => c === 201), codes);
    ok('6ᵉ commande refusée (429)', codes[5] === 429, codes);

    // ─────────────── 6. Webhook boutique (signature) ───────────────
    console.log('\n6. Webhook boutique');
    const whSansSig = await fetch(`${API}/shop/webhook`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reference: 'SHOP-XYZ' }) });
    ok('webhook sans signature → 401', whSansSig.status === 401, whSansSig.status);
    const whMauvaise = await fetch(`${API}/shop/webhook`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer mauvais' },
      body: JSON.stringify({ reference: 'SHOP-XYZ' }) });
    ok('webhook avec mauvaise signature → 401', whMauvaise.status === 401, whMauvaise.status);
    const whOk = await fetch(`${API}/shop/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer secret-boutique-test' },
      body: JSON.stringify({ reference: 'SHOP-INEXISTANT' }) });
    ok('webhook signé accepté (200)', whOk.status === 200, whOk.status);

    // ─────────────── 7. Notes vocales (Lokota) ───────────────
    console.log('\n7. Notes vocales traduites');
    ok('numéro invalide refusé', (await call('POST', '/lokota/send', {
      token: A.token, body: { to: 'abc', audio: AUDIO } })).status === 400);
    ok('destinataire inconnu → 404', (await call('POST', '/lokota/send', {
      token: A.token, body: { to: '+243999000111', audio: AUDIO } })).status === 404);
    ok('note à soi-même refusée', (await call('POST', '/lokota/send', {
      token: A.token, body: { to: A.phone, audio: AUDIO } })).status === 400);
    ok('audio manquant refusé', (await call('POST', '/lokota/send', {
      token: A.token, body: { to: Bb.phone } })).status === 400);
    const tropLong = await call('POST', '/lokota/send', {
      token: A.token, body: { to: Bb.phone, audio: 'data:audio/wav;base64,' + 'A'.repeat(460_000) } });
    ok('audio trop long refusé (400, pas 413)', tropLong.status === 400, tropLong.status);

    const note = await call('POST', '/lokota/send', {
      token: A.token, body: { to: Bb.phone, audio: AUDIO, duration_sec: 7, translate: false, client_id: 'cli-1', wave: '1234567890' } });
    ok('note envoyée', note.status === 200 && !!note.data?.id, note.data);
    ok('mode privé : pas de traduction IA', note.data?.status === 'no_ai', note.data?.status);
    const renvoi = await call('POST', '/lokota/send', {
      token: A.token, body: { to: Bb.phone, audio: AUDIO, duration_sec: 7, translate: false, client_id: 'cli-1' } });
    ok('renvoi idempotent (même id)', renvoi.data?.id === note.data.id && renvoi.data?.duplicate === true, renvoi.data);

    const threadsB = await call('GET', '/lokota/threads', { token: Bb.token });
    const fil = (threadsB.data || []).find(t => t.peer_phone === A.phone);
    ok('fil visible chez le destinataire', !!fil, threadsB.data);
    ok('1 note non lue comptée', fil?.unread === 1, fil?.unread);
    const threadsA = await call('GET', '/lokota/threads', { token: A.token });
    ok('aucune note non lue chez l’auteur',
       (threadsA.data || []).find(t => t.peer_phone === Bb.phone)?.unread === 0, threadsA.data);
    const conv = await call('GET', `/lokota/with/${encodeURIComponent(A.phone)}`, { token: Bb.token });
    ok('conversation accessible au destinataire', conv.status === 200 && conv.data?.notes?.length === 1, conv.data);
    ok('note reçue marquée « pas de moi »', conv.data?.notes?.[0]?.mine === false, conv.data?.notes?.[0]?.mine);
    ok('l’audio est restitué', String(conv.data?.notes?.[0]?.audio || '').startsWith('data:audio/'));
    const convA = await call('GET', `/lokota/with/${encodeURIComponent(Bb.phone)}`, { token: A.token });
    ok('note envoyée marquée « de moi »', convA.data?.notes?.[0]?.mine === true);
    ok('marquage lu accepté',
       (await call('POST', `/lokota/with/${encodeURIComponent(A.phone)}/read`, { token: Bb.token })).status === 200);
    const threadsB2 = await call('GET', '/lokota/threads', { token: Bb.token });
    ok('après lecture, plus de non-lu',
       (threadsB2.data || []).find(t => t.peer_phone === A.phone)?.unread === 0,
       (threadsB2.data || []).find(t => t.peer_phone === A.phone)?.unread);
    const intruse = await call('GET', `/lokota/with/${encodeURIComponent(A.phone)}`, { token: C.token });
    ok('un tiers ne voit pas la conversation', intruse.data?.notes?.length === 0, intruse.data?.notes?.length);

    // ─────────────── 8. Invitations ───────────────
    console.log('\n8. Liens d’invitation');
    const inv = await call('POST', '/invite', { token: A.token });   // POST /api/invite
    ok('token d’invitation généré', inv.status === 200 && !!inv.data?.token, inv.data);
    const page = await fetch(`${B}/invite/${inv.data.token}`, { headers: { 'User-Agent': 'Android' } });
    ok('page d’invitation servie (200 HTML)', page.status === 200);
    const val = await call('GET', `/invite/validate/${inv.data.token}`, { token: C.token }); // /api/invite/validate/:token
    ok('token validé après installation', val.status === 200 && val.data?.ok === true, val.data);
    ok('token réutilisé → refusé (410)',
       (await fetch(`${B}/invite/${inv.data.token}`)).status === 410);
    ok('token inconnu → 410', (await fetch(`${B}/invite/inconnu123`)).status === 410);

    // ─────────────── 9. WebRTC (HTTP) ───────────────
    console.log('\n9. WebRTC — serveurs ICE et accusés');
    const ice = await call('GET', '/rtc/ice', { token: A.token });
    ok('liste ICE fournie', ice.status === 200 && Array.isArray(ice.data?.iceServers) && ice.data.iceServers.length >= 2, ice.data);
    ok('au moins un serveur STUN', ice.data.iceServers.some(s => String(s.urls).includes('stun:')), ice.data.iceServers);
    ok('ICE sans jeton → 401', (await call('GET', '/rtc/ice')).status === 401);
    ok('ack d’appel inconnu → ok:false', (await call('POST', '/rtc/ack', {
      token: A.token, body: { call_id: 'nope' } })).data?.ok === false);
    ok('ack sans identifiant → 400', (await call('POST', '/rtc/ack', {
      token: A.token, body: {} })).status === 400);
    ok('refus d’appel inconnu → ok:false', (await call('POST', '/rtc/decline', {
      token: A.token, body: { call_id: 'nope' } })).data?.ok === false);

    // ─────────────── 10. Webhook paiement (portefeuille) ───────────────
    console.log('\n10. Webhook paiement portefeuille');
    const wh1 = await call('POST', '/payments/webhook', { body: { reference: 'MBOTE-INCONNU' } });
    ok('webhook inconnu → 200 (pas de nouvelle tentative)', wh1.status === 200, wh1.status);
    ok('webhook vide → 200', (await call('POST', '/payments/webhook', { body: {} })).status === 200);

    // ─────────────── 11. Aucune erreur serveur ───────────────
    console.log('\n11. Intégrité');
    // Les 4xx volontaires (« forfait inconnu », « solde insuffisant »…) sont
    // journalisés avec 💥 par le gestionnaire d'erreurs : on ne compte que les 5xx.
    const erreurs = srvOut.split('\n').filter(l => l.startsWith('💥') && /→ 5\d\d/.test(l));
    ok('aucune erreur serveur (💥)', erreurs.length === 0, erreurs.slice(0, 3));
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
