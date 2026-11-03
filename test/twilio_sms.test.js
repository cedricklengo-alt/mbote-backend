/**
 * Tests TWILIO · SMS · HISTORIQUE · PORTEFEUILLE — vrai serveur, vraies requêtes.
 *
 * Ce que l'on vérifie ici (et qui coûte de l'argent quand c'est faux) :
 *   1. la supervision Twilio ne confond JAMAIS « non configuré » et « solde 0 » ;
 *   2. les webhooks refusent une signature absente/invalide ;
 *   3. un webhook d'appel répété ne débite qu'UNE fois (idempotence) ;
 *   4. un SMS sans tarif configuré, ou sans fournisseur, n'est JAMAIS débité ;
 *   5. l'historique se filtre, se recherche, se détaille : sans masquer les
 *      données comptables quand l'utilisateur efface une entrée ;
 *   6. le tableau de bord du portefeuille ne renvoie que des chiffres réels ;
 *   7. l'administration Twilio est fermée aux comptes ordinaires.
 *
 * Lancement :  node test/twilio_sms.test.js
 */
const { spawn } = require('child_process');
const path = require('path');

const PORT = 4795;
const B = `http://127.0.0.1:${PORT}/api`;
let pass = 0, fail = 0;

const ok = (label, cond, detail) => {
  if (cond) { console.log(`  ✓ ${label}`); pass++; }
  else { console.log(`  ✗ ${label}${detail !== undefined ? ' → ' + JSON.stringify(detail) : ''}`); fail++; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, p, { token, body, form } = {}) {
  const h = {};
  let payload;
  if (form) {
    h['Content-Type'] = 'application/x-www-form-urlencoded';
    payload = new URLSearchParams(form).toString();
  } else if (body) {
    h['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  if (token) h.Authorization = `Bearer ${token}`;
  const r = await fetch(B + p, { method, headers: h, body: payload });
  let data = null;
  try { data = await r.json(); } catch { /* TwiML ou vide */ }
  return { status: r.status, data };
}

async function login(phone, name) {
  const a = await call('POST', '/auth/request-otp', { body: { phone, name } });
  const b = await call('POST', '/auth/verify-otp', { body: { phone, code: a.data.demo_code, name } });
  return { token: b.data.token, phone, name, id: b.data.user.id };
}

const balance = async (u) => (await call('GET', '/wallet', { token: u.token })).data.balance_cents;

(async () => {
  const srv = spawn('node', ['src/server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(PORT),
      JWT_SECRET: 'test-twilio-sms',
      DEMO_MODE: 'true',
      DATABASE_URL: '',
      PUBLIC_URL: `http://127.0.0.1:${PORT}`,
      MBOTE_MESSAGE_STORAGE: '/tmp/twilio-sms-test-storage',
      // Twilio n'est PAS configuré dans cet environnement : on veut vérifier
      // que l'absence de clés est signalée proprement (et non comme un solde 0).
      TWILIO_ACCOUNT_SID: '',
      TWILIO_AUTH_TOKEN: '',
      TWILIO_FROM_NUMBER: '',
      // Les webhooks sont testés sans signature : drapeau de DÉVELOPPEMENT.
      TWILIO_ALLOW_UNSIGNED: 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let srvOut = '';
  srv.stdout.on('data', (d) => { srvOut += d; });
  srv.stderr.on('data', (d) => { srvOut += d; });

  let up = false;
  for (let i = 0; i < 40; i++) {
    await sleep(300);
    try { const r = await fetch(`${B}/health`); if (r.ok) { up = true; break; } } catch { /* … */ }
  }
  ok('serveur démarré', up, srvOut.slice(-400));
  if (!up) { srv.kill(); process.exit(1); }

  try {
    // Numéros UNIQUES par exécution : la base SQLite de développement est
    // partagée entre les tests, et un appel resté « en cours » d'une exécution
    // précédente bloquerait le nouveau (« Un appel est déjà en cours »).
    const tag = String(Date.now()).slice(-6);
    const P_A = `+24381${tag}`;
    const P_B = `+24382${tag}`;
    const P_GSM = `+24389${tag}`;
    const A = await login(P_A, 'Alice Twilio');
    const Bb = await login(P_B, 'Bob Twilio');

    /* ═══════ 1. Supervision Twilio : non configuré ≠ solde nul ═══════ */
    console.log('\n1. Supervision Twilio (non configuré)');
    const st = await call('GET', '/twilio/admin/status', { token: A.token });
    ok('un compte ordinaire n’accède pas à la console Twilio', st.status === 403, st.status);

    const admin = await call('POST', '/admin/login',
      { body: { phone: '+243900000000', password: process.env.ADMIN_PASSWORD || 'MboteAdmin2026' } });
    ok('connexion admin', admin.status === 200 && !!admin.data.token, admin.data);
    const adminToken = admin.data.token;

    const st2 = await call('GET', '/twilio/admin/status', { token: adminToken });
    ok('admin : configuration renvoyée', st2.status === 200 && !!st2.data.config, st2.data);
    ok('admin : configured=false sans clés', st2.data.config.configured === false, st2.data.config);
    ok('admin : balance.ok=false (pas un solde de 0 $)',
      st2.data.balance.ok === false && st2.data.balance.amount === null, st2.data.balance);
    ok('admin : la cause de l’échec est donnée',
      typeof st2.data.balance.error === 'string' && st2.data.balance.error.length > 5, st2.data.balance);
    const clesSensibles = ['auth_token', 'api_secret', 'authToken', 'token'];
    ok('admin : aucune clé secrète exposée dans la réponse',
      clesSensibles.every((k) => !(k in st2.data.config)) &&
      clesSensibles.every((k) => !(k in st2.data.balance)),
      Object.keys(st2.data.config));
    ok('admin : URLs de webhook documentées', !!st2.data.config.webhook_urls.sms_status, st2.data.config.webhook_urls);

    const usage = await call('GET', '/twilio/admin/usage?days=7&category=calls', { token: adminToken });
    ok('admin : usage renvoie un tableau vide plutôt qu’une erreur 500',
      usage.status === 200 && Array.isArray(usage.data.records), usage.data);

    const nums = await call('GET', '/twilio/admin/numbers', { token: adminToken });
    ok('admin : inventaire des numéros vide si non configuré',
      nums.status === 200 && Array.isArray(nums.data.numbers) && nums.data.ok === false, nums.data);

    const overview = await call('GET', '/twilio/admin/overview', { token: adminToken });
    ok('admin : vue d’ensemble partielle (balance + usage + interne)',
      overview.status === 200 && !!overview.data.balance && !!overview.data.internal, Object.keys(overview.data || {}));

    /* ═══════ 2. Webhooks : signature et idempotence ═══════ */
    console.log('\n2. Webhooks Twilio');
    // Sans TWILIO_AUTH_TOKEN, la vérification est impossible : fail-closed.
    // (TWILIO_ALLOW_UNSIGNED=true est ici activé pour tester le traitement.)
    // La vérification est fail-closed : sans TWILIO_AUTH_TOKEN, une signature
    // ne peut PAS être validée. On le vérifie directement sur le service
    // (le serveur de test active TWILIO_ALLOW_UNSIGNED pour pouvoir jouer les
    // callbacks sans compte Twilio).
    const twilioSvc = require('../src/services/twilio');
    const fakeReq = { headers: {}, body: {}, originalUrl: '/api/twilio/status', protocol: 'http', get: () => 'x' };
    const ancienFlag = process.env.TWILIO_ALLOW_UNSIGNED;
    process.env.TWILIO_ALLOW_UNSIGNED = 'false';
    ok('signature refusée quand Twilio n’est pas configuré (fail-closed)',
      twilioSvc.validateSignature(fakeReq) === false);
    process.env.TWILIO_ALLOW_UNSIGNED = 'true';
    ok('dev uniquement : drapeau explicite accepté',
      twilioSvc.validateSignature(fakeReq) === true);
    process.env.TWILIO_ALLOW_UNSIGNED = ancienFlag;

    const badVoice = await call('POST', '/twilio/voice', { form: { To: P_B, From: 'client:user_x' } });
    ok('webhook voix : répond du TwiML (jamais une page d’erreur)', badVoice.status === 200, badVoice.status);

    // Appel GSM autorisé par /calls/start, puis statut final via webhook.
    const start = await call('POST', '/calls/start', { token: A.token, body: { to: P_GSM } });
    ok('appel GSM autorisé (CDR créé)', start.status === 200 && !!start.data.call_id, start.data);
    const callId = start.data.call_id;
    const soldeAvant = await balance(A);

    const callSid = 'CA_test_' + Date.now();
    const w1 = await call('POST', '/twilio/status', {
      form: { CallSid: callSid, CallStatus: 'completed', CallDuration: '65', To: P_GSM, From: P_A },
    });
    ok('webhook statut accepté (CallSid inconnu → résolu par destination)', w1.status === 200, w1.data);

    const detail1 = await call('GET', `/calls/${callId}`, { token: A.token });
    ok('appel marqué terminé', detail1.data.call.status === 'ended', detail1.data.call.status);
    ok('durée fournisseur enregistrée (65 s)', detail1.data.call.billed_sec === 65, detail1.data.call.billed_sec);
    const debite1 = detail1.data.call.cost_cents;
    ok('appel facturé au client', debite1 > 0, debite1);

    const soldeApres1 = await balance(A);
    ok('le solde a bien été débité du coût de l’appel',
      soldeAvant - soldeApres1 === debite1, { soldeAvant, soldeApres1, debite1 });

    // Twilio ré-essaie le MÊME événement (même CallSid) en cas de timeout.
    const w2 = await call('POST', '/twilio/status', {
      form: { CallSid: callSid, CallStatus: 'completed', CallDuration: '65', To: P_GSM, From: P_A },
    });
    ok('webhook répété : signalé comme doublon', w2.status === 200 && w2.data.duplicate === true, w2.data);
    ok('webhook répété : la cause fournisseur est conservée',
      (await call('GET', `/calls/${callId}`, { token: A.token })).data.call.hangup_cause === 'completed',
      (await call('GET', `/calls/${callId}`, { token: A.token })).data.call.hangup_cause);
    const soldeApres2 = await balance(A);
    ok('AUCUN second débit sur un webhook répété', soldeApres2 === soldeApres1, { soldeApres1, soldeApres2 });

    const smsHook = await call('POST', '/twilio/sms-status',
      { form: { MessageSid: 'SM_inconnu', MessageStatus: 'delivered' } });
    ok('webhook SMS : message inconnu ignoré sans erreur', smsHook.status === 200 && smsHook.data.updated === false, smsHook.data);

    /* ═══════ 3. SMS : aucun débit si le service n'est pas prêt ═══════ */
    console.log('\n3. SMS facturés (refus sûrs)');
    const quote = await call('GET', '/sms/quote?to=' + encodeURIComponent(P_B) + '', { token: A.token });
    ok('devis SMS calculé', quote.status === 200 && quote.data.to === P_B, quote.data);
    ok('devis : aucun prix inventé quand le tarif SMS est absent',
      quote.data.sms_price_cents === null && quote.data.can_send === false, quote.data);
    ok('devis : cause explicite (SMS_RATE_MISSING)', quote.data.reason === 'SMS_RATE_MISSING', quote.data.reason);
    ok('devis : fournisseur signalé comme non prêt', quote.data.provider_ready === false, quote.data.provider_ready);

    const soldeAvantSms = await balance(Bb);
    const envoi = await call('POST', '/sms/send', {
      token: Bb.token, body: { to: P_A, text: 'Bonjour depuis les tests' },
    });
    ok('envoi refusé quand le fournisseur n’est pas configuré', envoi.status === 409, envoi.data);
    ok('code d’erreur explicite (SMS_NOT_CONFIGURED)', envoi.data && envoi.data.code === 'SMS_NOT_CONFIGURED', envoi.data);
    const soldeApresSms = await balance(Bb);
    ok('AUCUN débit pour un SMS non envoyé', soldeApresSms === soldeAvantSms, { soldeAvantSms, soldeApresSms });

    const numInvalide = await call('POST', '/sms/send', {
      token: Bb.token, body: { to: 'pas-un-numero', text: 'test' },
    });
    ok('numéro invalide refusé (400)', numInvalide.status === 400, numInvalide.data);

    const vide = await call('POST', '/sms/send', { token: Bb.token, body: { to: P_A, text: '   ' } });
    ok('message vide refusé (400)', vide.status === 400, vide.data);

    const histoSms = await call('GET', '/sms', { token: Bb.token });
    ok('historique SMS accessible et vide', histoSms.status === 200 && Array.isArray(histoSms.data.messages), histoSms.data);
    ok('aucun SMS fantôme enregistré après un refus', (histoSms.data.messages || []).length === 0, histoSms.data.messages);

    /* ═══════ 4. Historique des appels : filtres, recherche, détail, masquage ═══════ */
    console.log('\n4. Historique des appels');
    // Un appel Internet (gratuit) et un appel reçu manqué, en plus de l'appel GSM.
    const appelMbote = await call('POST', '/calls/start', { token: A.token, body: { to: P_B } });
    ok('appel Internet autorisé et gratuit', appelMbote.status === 200 && appelMbote.data.free_reason === 'mbote', appelMbote.data);
    await call('POST', '/calls/log-incoming', {
      token: A.token, body: { from: '+243870000001', cause: 'missed', call_id: 'ca_missed_' + tag },
    });

    const tous = await call('GET', '/calls/history', { token: A.token });
    ok('historique : tout est là', tous.status === 200 && tous.data.calls.length >= 3, tous.data.total);
    ok('historique : le canal Internet est identifiable',
      tous.data.calls.some((c) => Number(c.rtc_mode) !== 0 || c.destination === 'MboteCall'), tous.data.calls.map((c) => c.destination));

    const gsm = await call('GET', '/calls/history?filter=gsm', { token: A.token });
    ok('filtre « gsm » : seulement le réseau téléphonique',
      gsm.data.calls.every((c) => Number(c.rtc_mode) === 0 && c.destination !== 'MboteCall'), gsm.data.calls.map((c) => c.destination));

    const internet = await call('GET', '/calls/history?filter=internet', { token: A.token });
    ok('filtre « internet » : seulement les appels MboteCall',
      internet.data.calls.length >= 1 && internet.data.calls.every((c) => Number(c.rtc_mode) !== 0 || c.destination === 'MboteCall'),
      internet.data.total);

    const manques = await call('GET', '/calls/history?filter=missed', { token: A.token });
    ok('filtre « manqués » : uniquement les appels non décrochés',
      manques.data.calls.length >= 1 && manques.data.calls.every((c) => !c.answered_at && !Number(c.billed_sec)),
      manques.data.calls.map((c) => [c.callee, c.answered_at, c.billed_sec]));

    const recherche = await call('GET', '/calls/history?q=' + tag, { token: A.token });
    ok('recherche par numéro', recherche.data.calls.length >= 1 &&
      recherche.data.calls.every((c) => String(c.callee).includes(tag)), recherche.data.calls.map((c) => c.callee));

    const rechercheVide = await call('GET', '/calls/history?q=zzzzintrouvable', { token: A.token });
    ok('recherche sans résultat : liste vide (pas d’erreur)', rechercheVide.status === 200 && rechercheVide.data.calls.length === 0, rechercheVide.data);

    const detail = await call('GET', `/calls/${callId}`, { token: A.token });
    ok('détail : canal « gsm »', detail.data.call.channel === 'gsm', detail.data.call.channel);
    ok('détail : tarif/minute exposé', detail.data.call.price_per_min_cents > 0, detail.data.call);
    ok('détail : coût et durée', detail.data.call.cost_cents > 0 && detail.data.call.billed_sec === 65, detail.data.call);

    const detailAutre = await call('GET', `/calls/${callId}`, { token: Bb.token });
    ok('un autre utilisateur ne lit pas l’appel (404)', detailAutre.status === 404, detailAutre.status);

    const masque = await call('POST', `/calls/${callId}/hide`, { token: A.token });
    ok('masquage de l’entrée accepté', masque.status === 200, masque.data);
    const apresMasquage = await call('GET', '/calls/history', { token: A.token });
    ok('l’entrée masquée disparaît de la liste',
      !apresMasquage.data.calls.some((c) => c.id === callId), apresMasquage.data.total);
    const detailApres = await call('GET', `/calls/${callId}`, { token: A.token });
    ok('la donnée comptable est CONSERVÉE après masquage',
      detailApres.status === 200 && detailApres.data.call.cost_cents === debite1, detailApres.data.call?.cost_cents);

    /* ═══════ 5. Portefeuille : résumé et transactions filtrables ═══════ */
    console.log('\n5. Portefeuille');
    const summary = await call('GET', '/wallet/summary', { token: A.token });
    ok('résumé : solde en cents', Number.isInteger(summary.data.balance_cents), summary.data);
    ok('résumé : devise', typeof summary.data.currency === 'string', summary.data.currency);
    ok('résumé : dépense d’aujourd’hui ≥ coût de l’appel',
      summary.data.today_cents >= debite1, { today: summary.data.today_cents, debite1 });
    ok('résumé : total des appels facturés', summary.data.month_calls_cents >= debite1, summary.data.month_calls_cents);
    ok('résumé : total des SMS facturés présent', Number.isInteger(summary.data.month_sms_cents), summary.data.month_sms_cents);
    ok('résumé : seuil d’alerte exposé', Number.isInteger(summary.data.threshold_cents), summary.data.threshold_cents);

    const txs = await call('GET', '/wallet/transactions?type=call_debit', { token: A.token });
    ok('transactions filtrées par type', txs.status === 200 && txs.data.transactions.every((t) => t.type === 'call_debit'), txs.data.total);
    ok('transactions : montants négatifs pour un débit',
      txs.data.transactions.every((t) => t.amount_cents < 0), txs.data.transactions[0]);
    ok('transactions : statut fourni', txs.data.transactions.every((t) => !!t.status), txs.data.transactions[0]);

    const txInconnu = await call('GET', '/wallet/transactions?type=inexistant', { token: A.token });
    ok('filtre inconnu : liste vide, pas d’erreur', txInconnu.status === 200 && txInconnu.data.transactions.length === 0, txInconnu.data);

    const txAutre = await call('GET', '/wallet/transactions', { token: Bb.token });
    ok('un utilisateur ne voit que SES transactions',
      txAutre.data.transactions.every((t) => t.type !== 'call_debit'), txAutre.data.transactions.map((t) => t.type));

    /* ═══════ 6. Intégrité ═══════ */
    console.log('\n6. Intégrité');
    ok('aucun solde négatif', (await balance(A)) >= 0 && (await balance(Bb)) >= 0, [await balance(A), await balance(Bb)]);
    const erreurs = srvOut.split('\n').filter((l) => l.startsWith('💥') && /→ 5\d\d/.test(l));
    ok('aucune erreur serveur (💥 5xx)', erreurs.length === 0, erreurs.slice(0, 3));
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
