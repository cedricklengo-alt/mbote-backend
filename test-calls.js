/* 🧪 Tests de bout en bout v3.0 — standardiste d'appels, réveil, messages.
 *
 * Lancer le serveur en mode simulation PUIS ce script :
 *   PORT=3000 DEMO_MODE=true PUSH_DEBUG_FAKE=true RTC_RING_TTL_MS=12000 node src/server.js
 *   node test-calls.js
 *
 * Tous les scénarios tournent en parallèle (comptes distincts), ~20 s au total.
 */
const WebSocket = require('ws');

const HTTP = process.env.BASE || 'http://localhost:3000';
const WS = HTTP.replace(/^http/, 'ws');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RUN = String(Date.now()).slice(-6);
let seq = 0;

const results = [];
function check(name, ok, extra) {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? '✅' : '❌'} ${name}${!ok && extra !== undefined ? '  → ' + JSON.stringify(extra) : ''}`);
}

async function api(method, path, body, token) {
  const r = await fetch(HTTP + '/api' + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let j = {};
  try { j = await r.json(); } catch (_) {}
  return { status: r.status, ...j };
}

/** Crée un compte de test (téléphone unique) ; fcm=true → jeton de notification */
async function mk(label, { fcm = false, fcmToken } = {}) {
  const phone = `+2438${RUN}${String(++seq).padStart(2, '0')}`; // 11 chiffres après +
  const o = await api('POST', '/auth/request-otp', { phone });
  const v = await api('POST', '/auth/verify-otp', { phone, code: o.demo_code, name: label });
  if (!v.token) throw new Error('login KO ' + label + ' ' + JSON.stringify(v));
  const u = { label, phone, token: v.token, fcm: fcmToken || (fcm ? `tok-${label}-${RUN}` : null) };
  if (u.fcm) await api('POST', '/auth/fcm-token', { token: u.fcm }, u.token);
  return u;
}

class Client {
  constructor(user) { this.user = user; this.inbox = []; this.closed = null; }
  open() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`${WS}/ws?token=${this.user.token}`);
      this.ws.on('message', (d) => { try { this.inbox.push(JSON.parse(d)); } catch (_) {} });
      this.ws.on('close', (code) => { this.closed = code; });
      this.ws.on('open', () => resolve(this));
      this.ws.on('error', reject);
    });
  }
  send(o) { this.ws.send(JSON.stringify(o)); }
  presence(fg) { this.send({ type: 'presence', state: fg ? 'fg' : 'bg' }); }
  async wait(pred, ms = 3000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const m = this.inbox.find(pred);
      if (m) return m;
      await sleep(40);
    }
    return null;
  }
  count(pred) { return this.inbox.filter(pred).length; }
  close() { try { this.ws.close(); } catch (_) {} }
}

const sdp = { type: 'offer', sdp: 'v=0' };
const pushesFor = async (token, kind) => {
  const d = await api('GET', '/rtc/_debug');
  return (d.pushes || []).filter((p) => p.token === token && (!kind || p.kind === kind));
};

/* ───────────────────────── Scénarios ───────────────────────── */

async function t1_foreground() {
  const A = await mk('A1'), B = await mk('B1', { fcm: true });
  const wa = await new Client(A).open(), wb = await new Client(B).open();
  wb.presence(true); await sleep(150);
  const id = 'c_t1_' + RUN;
  wa.send({ type: 'offer', to: B.phone, call_id: id, sdp });
  const off = await wb.wait((m) => m.type === 'offer' && m.call_id === id);
  check('T1 app ouverte : l\'offre arrive par WebSocket', off && off.from === A.phone && off.from_name === 'A1');
  wb.send({ type: 'ringing', to: A.phone, call_id: id });
  check('T1 l\'appelant reçoit « ringing »', await wa.wait((m) => m.type === 'ringing' && m.call_id === id));
  check('T1 aucun push inutile quand l\'app est au premier plan', (await pushesFor(B.fcm)).length === 0);
  wa.send({ type: 'hangup', to: B.phone, call_id: id });
  check('T1 raccrocher → l\'appelé reçoit « hangup »', await wb.wait((m) => m.type === 'hangup' && m.call_id === id));
  wa.close(); wb.close();
}

async function t2_background() {
  const A = await mk('A2'), B = await mk('B2', { fcm: true });
  const wa = await new Client(A).open(), wb = await new Client(B).open();
  wb.presence(false); await sleep(150);
  const id = 'c_t2_' + RUN;
  wa.send({ type: 'offer', to: B.phone, call_id: id, sdp });
  check('T2 arrière-plan : offre aussi livrée par WebSocket', await wb.wait((m) => m.type === 'offer' && m.call_id === id));
  await sleep(300);
  const p = await pushesFor(B.fcm, 'call');
  check('T2 arrière-plan : réveil push ENVOYÉ en parallèle', p.length === 1, p.length);
  check('T2 le push d\'appel est data-only (le code de l\'app s\'exécute)',
    p[0] && !p[0].message.notification && p[0].message.data.kind === 'incoming_call'
    && p[0].message.data.call_id === id && p[0].message.android.priority === 'high', p[0]);
  check('T2 la clé réservée « from » n\'est pas utilisée', p[0] && p[0].message.data.from === undefined && p[0].message.data.from_phone === A.phone);
  wb.send({ type: 'ringing', to: A.phone, call_id: id });
  await sleep(6000);
  check('T2 acquitté → pas de notification de renfort', (await pushesFor(B.fcm, 'call_fallback')).length === 0);
  wa.send({ type: 'hangup', to: B.phone, call_id: id });
  await sleep(500);
  check('T2 raccrocher → push d\'annulation envoyé', (await pushesFor(B.fcm, 'call_cancel')).length === 1);
  check('T2 raccrocher → « appel manqué » remplace la notification', (await pushesFor(B.fcm, 'missed')).length === 1);
  wa.close(); wb.close();
}

async function t3_closed_no_ack() {
  const A = await mk('A3'), B = await mk('B3', { fcm: true });
  const wa = await new Client(A).open();
  const id = 'c_t3_' + RUN;
  wa.send({ type: 'offer', to: B.phone, call_id: id, sdp });
  wa.send({ type: 'ice', to: B.phone, call_id: id, candidate: { candidate: 'cand-1' } });
  check('T3 app fermée : l\'appelant reçoit « push-sent »', await wa.wait((m) => m.type === 'push-sent' && m.call_id === id));
  check('T3 app fermée : réveil data-only envoyé', (await pushesFor(B.fcm, 'call')).length === 1);
  await sleep(5800);
  const fb = await pushesFor(B.fcm, 'call_fallback');
  check('T3 sans acquittement → notification VISIBLE de renfort', fb.length === 1, fb.length);
  check('T3 le renfort utilise le canal « appels » + icône + son',
    fb[0] && fb[0].message.android.notification.channelId === 'mbote_calls'
    && fb[0].message.android.notification.icon === 'ic_stat_mbote'
    && fb[0].message.android.notification.defaultSound === true, fb[0] && fb[0].message.android);
  const wb = await new Client(B).open(); // le téléphone s'ouvre (notification touchée)
  const off = await wb.wait((m) => m.type === 'offer' && m.call_id === id);
  check('T3 à la connexion de l\'appelé : offre livrée', !!off);
  check('T3 à la connexion de l\'appelé : ICE rejoués', await wb.wait((m) => m.type === 'ice' && m.call_id === id));
  wb.send({ type: 'answer', to: A.phone, call_id: id, sdp: { type: 'answer', sdp: 'y' } });
  check('T3 réponse transmise à l\'appelant', await wa.wait((m) => m.type === 'answer' && m.call_id === id));
  await sleep(300);
  check('T3 décrocher → l\'écran d\'appel disparaît ailleurs (annulation push)', (await pushesFor(B.fcm, 'call_cancel')).length === 1);
  wa.send({ type: 'ice', to: B.phone, call_id: id, candidate: { candidate: 'cand-2' } });
  check('T3 ICE en conversation transmis', await wb.wait((m) => m.type === 'ice' && m.candidate && m.candidate.candidate === 'cand-2'));
  wb.send({ type: 'hangup', to: A.phone, call_id: id });
  check('T3 raccrochage de l\'appelé transmis', await wa.wait((m) => m.type === 'hangup' && m.call_id === id));
  wa.close(); wb.close();
}

async function t4_http_ack() {
  const A = await mk('A4'), B = await mk('B4', { fcm: true });
  const wa = await new Client(A).open();
  const id = 'c_t4_' + RUN;
  wa.send({ type: 'offer', to: B.phone, call_id: id, sdp });
  await wa.wait((m) => m.type === 'push-sent');
  const ack = await api('POST', '/rtc/ack', { call_id: id }, B.token);
  check('T4 acquittement HTTP accepté', ack.ok === true, ack);
  check('T4 l\'appelant reçoit « ringing » (app tuée, sans WebSocket)', await wa.wait((m) => m.type === 'ringing' && m.call_id === id));
  await sleep(6000);
  check('T4 acquitté → AUCUNE notification de renfort', (await pushesFor(B.fcm, 'call_fallback')).length === 0);
  const wb = await new Client(B).open();
  check('T4 offre encore livrée à l\'ouverture de l\'app (après acquittement)', await wb.wait((m) => m.type === 'offer' && m.call_id === id));
  wb.send({ type: 'reject', to: A.phone, call_id: id, reason: 'declined' });
  const rj = await wa.wait((m) => m.type === 'reject' && m.call_id === id);
  check('T4 refus transmis avec sa raison', rj && rj.reason === 'declined', rj);
  const bogus = await api('POST', '/rtc/ack', { call_id: 'inconnu' }, B.token);
  check('T4 acquittement d\'un appel inconnu : ok:false sans erreur', bogus.ok === false, bogus);
  wa.close(); wb.close();
}

async function t5_http_decline() {
  const A = await mk('A5'), B = await mk('B5', { fcm: true });
  const wa = await new Client(A).open();
  const id = 'c_t5_' + RUN;
  wa.send({ type: 'offer', to: B.phone, call_id: id, sdp });
  await wa.wait((m) => m.type === 'push-sent');
  const dc = await api('POST', '/rtc/decline', { call_id: id }, B.token);
  check('T5 refus HTTP accepté', dc.ok === true, dc);
  const rj = await wa.wait((m) => m.type === 'reject' && m.call_id === id);
  check('T5 l\'appelant est prévenu (raison « declined »)', rj && rj.reason === 'declined', rj);
  const wb = await new Client(B).open();
  await sleep(600);
  check('T5 appel refusé : plus jamais livré', wb.count((m) => m.type === 'offer') === 0);
  wa.close(); wb.close();
}

async function t6_busy() {
  const A = await mk('A6'), B = await mk('B6', { fcm: true }), C = await mk('C6');
  const wa = await new Client(A).open(), wc = await new Client(C).open();
  const id1 = 'c_t6a_' + RUN, id2 = 'c_t6c_' + RUN;
  wa.send({ type: 'offer', to: B.phone, call_id: id1, sdp });
  await wa.wait((m) => m.type === 'push-sent');
  wc.send({ type: 'offer', to: B.phone, call_id: id2, sdp });
  const rj = await wc.wait((m) => m.type === 'reject' && m.call_id === id2);
  check('T6 deuxième appelant : « occupé » IMMÉDIAT', rj && rj.reason === 'busy', rj);
  const wb = await new Client(B).open();
  check('T6 le premier appel reste intact', await wb.wait((m) => m.type === 'offer' && m.call_id === id1));
  await sleep(500);
  check('T6 le second appel n\'est jamais livré', wb.count((m) => m.call_id === id2) === 0);
  wa.close(); wb.close(); wc.close();
}

async function t7_ghost() {
  const A = await mk('A7'), B = await mk('B7', { fcm: true });
  const wb = await new Client(B).open(); // fantôme : connecté mais muet
  wb.presence(true);
  const wa = await new Client(A).open();
  await sleep(150);
  const id = 'c_t7_' + RUN;
  wa.send({ type: 'offer', to: B.phone, call_id: id, sdp });
  wa.send({ type: 'ice', to: B.phone, call_id: id, candidate: { candidate: 'g1' } });
  const ps = await wa.wait((m) => m.type === 'push-sent' && m.call_id === id, 8000);
  check('T7 socket fantôme : bascule sur le push au bout de ~4,5 s', !!ps);
  await sleep(200);
  check('T7 socket fantôme fermé par le serveur', wb.closed !== null);
  const wb2 = await new Client(B).open();
  check('T7 reconnexion : offre livrée', await wb2.wait((m) => m.type === 'offer' && m.call_id === id));
  check('T7 reconnexion : ICE rejoués', await wb2.wait((m) => m.type === 'ice' && m.call_id === id));
  wa.close(); wb2.close();
}

async function t8_unreachable() {
  const A = await mk('A8'), B = await mk('B8'); // B : aucun jeton
  const wa = await new Client(A).open();
  const id = 'c_t8_' + RUN;
  wa.send({ type: 'offer', to: B.phone, call_id: id, sdp });
  check('T8 injoignable (hors ligne, sans jeton) → « peer-offline »', await wa.wait((m) => m.type === 'peer-offline' && m.call_id === id));
  wa.close();
}

async function t9_caller_vanishes() {
  const A = await mk('A9'), B = await mk('B9', { fcm: true });
  const wa = await new Client(A).open(), wb = await new Client(B).open();
  wb.presence(true); await sleep(150);
  const id = 'c_t9_' + RUN;
  wa.send({ type: 'offer', to: B.phone, call_id: id, sdp });
  await wb.wait((m) => m.type === 'offer');
  wb.send({ type: 'ringing', to: A.phone, call_id: id });
  await sleep(200);
  wa.ws.terminate(); // l'appelant disparaît (réseau coupé net)
  const h = await wb.wait((m) => m.type === 'hangup' && m.call_id === id, 12000);
  check('T9 l\'appelant disparaît → l\'appelé arrête de sonner (≤ 9 s)', h && h.reason === 'caller_gone', h);
  wb.close();
}

async function t10_expiry() {
  const A = await mk('A10'), B = await mk('B10', { fcm: true });
  const wa = await new Client(A).open();
  const id = 'c_t10_' + RUN;
  wa.send({ type: 'offer', to: B.phone, call_id: id, sdp });
  await wa.wait((m) => m.type === 'push-sent');
  const po = await wa.wait((m) => m.type === 'peer-offline' && m.call_id === id, 16000);
  check('T10 personne ne répond → expiration côté serveur (« peer-offline »)', !!po);
  await sleep(300);
  check('T10 expiration → annulation + « appel manqué » chez l\'appelé',
    (await pushesFor(B.fcm, 'call_cancel')).length === 1 && (await pushesFor(B.fcm, 'missed')).length === 1);
  wa.close();
}

async function t11_injection_and_late() {
  const A = await mk('A11'), B = await mk('B11', { fcm: true }), C = await mk('C11');
  const wa = await new Client(A).open(), wc = await new Client(C).open();
  const id = 'c_t11_' + RUN;
  wa.send({ type: 'offer', to: B.phone, call_id: id, sdp });
  await wa.wait((m) => m.type === 'push-sent');
  wc.send({ type: 'hangup', to: B.phone, call_id: id }); // un tiers tente de couper l'appel
  wc.send({ type: 'answer', to: A.phone, call_id: id, sdp });
  await sleep(500);
  check('T11 un tiers ne peut pas injecter de signal dans l\'appel', wa.count((m) => m.type === 'answer' || m.type === 'hangup') === 0);
  const wb = await new Client(B).open();
  check('T11 l\'appel n\'a pas été annulé par le tiers', await wb.wait((m) => m.type === 'offer' && m.call_id === id));
  // réponse tardive à un appel déjà annulé
  wa.send({ type: 'hangup', to: B.phone, call_id: id });
  await wb.wait((m) => m.type === 'hangup');
  wb.send({ type: 'answer', to: A.phone, call_id: id, sdp: { type: 'answer', sdp: 'z' } });
  const late = await wb.wait((m) => m.type === 'hangup' && m.reason === 'ended', 2000);
  check('T11 réponse tardive à un appel annulé : l\'appelé est invité à raccrocher', !!late);
  wa.close(); wb.close(); wc.close();
}

async function t12_messages() {
  const A = await mk('A12'), B = await mk('B12', { fcm: true });
  const wb = await new Client(B).open();
  const cid = 'cli_' + RUN;
  const body = { to: B.phone, text: 'Mbote !', lang_from: 'fr', lang_to: 'fr', client_id: cid };
  const r1 = await api('POST', '/messages/send', body, A.token);
  const r2 = await api('POST', '/messages/send', body, A.token); // renvoi après « timeout »
  check('T12 messages : le renvoi retrouve le même message (idempotence)', r1.id && r1.id === r2.id && r2.duplicate === true, [r1, r2]);
  const th = await api('GET', '/messages/with/' + encodeURIComponent(B.phone), null, A.token);
  check('T12 messages : un seul message en base malgré 2 envois', (th.items || []).filter((i) => i.kind === 'text').length === 1, th.items && th.items.length);
  const live = await wb.wait((m) => m.type === 'msg', 2000);
  check('T12 messages : notification TEMPS RÉEL (sans Firebase)', live && live.from_phone === A.phone && live.msg_id === r1.id, live);
  const pm = (await pushesFor(B.fcm, 'info'))[0];
  check('T12 messages : push avec canal « messages » + icône + routage',
    pm && pm.message.android.notification.channelId === 'mbote_messages'
    && pm.message.android.notification.icon === 'ic_stat_mbote'
    && pm.message.data.kind === 'message' && pm.message.data.from_phone === A.phone, pm && pm.message);
  const aud = 'data:audio/m4a;base64,' + Buffer.alloc(1200, 1).toString('base64');
  const v1 = await api('POST', '/lokota/send', { to: B.phone, audio: aud, duration_sec: 3, lang_from: 'fr', lang_to: 'fr', translate: false, client_id: 'v' + cid }, A.token);
  const v2 = await api('POST', '/lokota/send', { to: B.phone, audio: aud, duration_sec: 3, lang_from: 'fr', lang_to: 'fr', translate: false, client_id: 'v' + cid }, A.token);
  check('T12 notes vocales : idempotence aussi', v1.id && v1.id === v2.id && v2.duplicate === true, [v1, v2]);
  // « écrit… »
  const wa = await new Client(A).open();
  wa.send({ type: 'typing', to: B.phone });
  check('T12 indicateur « écrit… » relayé', await wb.wait((m) => m.type === 'typing' && m.from === A.phone));
  wa.close(); wb.close();
}

async function t13_tokens() {
  const A = await mk('A13'), B = await mk('B13', { fcmToken: 'shared-' + RUN }), C = await mk('C13');
  const wa = await new Client(A).open();
  // Le même téléphone passe du compte B au compte C
  await api('POST', '/auth/fcm-token', { token: 'shared-' + RUN }, C.token);
  wa.send({ type: 'offer', to: B.phone, call_id: 'c_t13b_' + RUN, sdp });
  check('T13 ancien compte : plus de jeton → injoignable (pas de fuite de notifications)', await wa.wait((m) => m.type === 'peer-offline'));
  wa.send({ type: 'offer', to: C.phone, call_id: 'c_t13c_' + RUN, sdp });
  check('T13 nouveau compte : reçoit le réveil', await wa.wait((m) => m.type === 'push-sent'));
  wa.close();
}

async function t14_dead_token() {
  const A = await mk('A14'), D = await mk('D14', { fcmToken: 'dead-' + RUN });
  const wa = await new Client(A).open();
  wa.send({ type: 'offer', to: D.phone, call_id: 'c_t14a_' + RUN, sdp });
  check('T14 jeton périmé → injoignable', await wa.wait((m) => m.type === 'peer-offline' && m.call_id === 'c_t14a_' + RUN));
  await sleep(300);
  wa.send({ type: 'offer', to: D.phone, call_id: 'c_t14b_' + RUN, sdp });
  await wa.wait((m) => m.type === 'peer-offline' && m.call_id === 'c_t14b_' + RUN);
  const tries = await pushesFor('dead-' + RUN);
  check('T14 jeton périmé effacé : plus aucun envoi vers lui', tries.length === 1, tries.length);
  wa.close();
}

async function t15_incoming_log() {
  const A = await mk('A15'), B = await mk('B15');
  const body = { from: A.phone, billed_sec: 0, call_id: 'c_t15_' + RUN, cause: 'declined' };
  await api('POST', '/calls/log-incoming', body, B.token);
  await api('POST', '/calls/log-incoming', body, B.token); // 2e signalement du même appel
  const h = await api('GET', '/calls/history', null, B.token);
  const rows = (h.calls || []).filter((c) => c.direction === 'in' && c.callee === A.phone);
  check('T15 appel reçu journalisé UNE seule fois', rows.length === 1, rows.length);
  check('T15 cause « refusé » conservée', rows[0] && rows[0].hangup_cause === 'declined', rows[0]);
  await api('POST', '/calls/log-incoming', { ...body, billed_sec: 42, cause: undefined }, B.token);
  const h2 = await api('GET', '/calls/history', null, B.token);
  const r2 = (h2.calls || []).filter((c) => c.direction === 'in' && c.callee === A.phone);
  check('T15 la durée réelle remplace le « manqué » (toujours 1 ligne)', r2.length === 1 && r2[0].billed_sec === 42, r2);
}

async function t16_presence_stale_and_replace() {
  const A = await mk('A16');
  const w1 = await new Client(A).open();
  const w2 = await new Client(A).open(); // 2e appareil
  await sleep(300);
  check('T16 2e connexion : l\'ancienne est fermée avec le code 4002 (« remplacée »)', w1.closed === 4002, w1.closed);
  w2.close();
}

/* ───────────────────────── Exécution ───────────────────────── */
(async () => {
  const h = await api('GET', '/health');
  if (!h.ok) { console.log('❌ serveur injoignable', h); process.exit(2); }
  await api('POST', '/rtc/_debug/clear');
  console.log(`🧪 Serveur ${HTTP} — push simulé : ${h.push}\n`);
  const all = [t1_foreground, t2_background, t3_closed_no_ack, t4_http_ack, t5_http_decline,
    t6_busy, t7_ghost, t8_unreachable, t9_caller_vanishes, t10_expiry,
    t11_injection_and_late, t12_messages, t13_tokens, t14_dead_token, t15_incoming_log,
    t16_presence_stale_and_replace];
  await Promise.all(all.map((f) => f().catch((e) => check(f.name + ' a planté', false, e.stack || e.message))));
  const bad = results.filter((r) => !r.ok);
  console.log(`\n${bad.length ? '❌' : '🎉'} ${results.length - bad.length}/${results.length} vérifications réussies`);
  process.exit(bad.length ? 1 : 0);
})();
