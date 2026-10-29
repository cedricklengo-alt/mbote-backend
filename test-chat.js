/* Tests de bout en bout v3.1 — messagerie : texte, photo, fichier, note vocale,
 * téléchargement, suppression pour moi / pour tous (groupée), écoute, lecture.
 *
 * Lancer le serveur en mode simulation PUIS ce script :
 *   PORT=3000 DEMO_MODE=true PUSH_DEBUG_FAKE=true node src/server.js
 *   node test-chat.js
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
  return Array.isArray(j) ? j : { httpStatus: r.status, ...j };
}

/** Envoi binaire : corps brut + paramètres d'URL */
async function sendMedia(token, params, bytes) {
  const qs = new URLSearchParams(params).toString();
  const r = await fetch(`${HTTP}/api/messages/send-media?${qs}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', Authorization: 'Bearer ' + token },
    body: bytes,
  });
  let j = {};
  try { j = await r.json(); } catch (_) {}
  return { httpStatus: r.status, ...j };
}

async function media(token, id) {
  const r = await fetch(`${HTTP}/api/messages/media/${id}`, { headers: { Authorization: 'Bearer ' + token } });
  const buf = Buffer.from(await r.arrayBuffer());
  return { httpStatus: r.status, type: r.headers.get('content-type'), disp: r.headers.get('content-disposition'), buf };
}

async function mk(label) {
  const phone = `+2438${RUN}${String(++seq).padStart(2, '0')}`;
  const o = await api('POST', '/auth/request-otp', { phone });
  const v = await api('POST', '/auth/verify-otp', { phone, code: o.demo_code, name: label });
  if (!v.token) throw new Error('login KO ' + label + ' ' + JSON.stringify(v));
  return { label, phone, token: v.token };
}

function openWs(user) {
  return new Promise((resolve, reject) => {
    const inbox = [];
    const ws = new WebSocket(`${WS}/ws?token=${user.token}`);
    ws.on('message', (d) => { try { inbox.push(JSON.parse(d)); } catch (_) {} });
    ws.on('open', () => resolve({ ws, inbox }));
    ws.on('error', reject);
  });
}
async function waitFor(inbox, pred, ms = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const f = inbox.find(pred);
    if (f) return f;
    await sleep(40);
  }
  return null;
}

// Petits contenus valides
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const M4A = 'data:audio/m4a;base64,' + Buffer.alloc(1200, 7).toString('base64');
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u;

(async () => {
  const A = await mk('Alice');
  const B = await mk('Bob');
  const C = await mk('Chloe'); // tierce personne
  const wsA = await openWs(A);
  const wsB = await openWs(B);

  // ───────── Texte ─────────
  const t1 = await api('POST', '/messages/send', { to: B.phone, text: 'Bonjour Bob', lang_from: 'fr', lang_to: 'fr', client_id: 'k-1' }, A.token);
  check('texte envoyé', t1.id && t1.httpStatus === 200, t1);
  const t1b = await api('POST', '/messages/send', { to: B.phone, text: 'Bonjour Bob', lang_from: 'fr', lang_to: 'fr', client_id: 'k-1' }, A.token);
  check('renvoi avec la même clé : pas de doublon', t1b.duplicate === true && t1b.id === t1.id, t1b);
  const live = await waitFor(wsB.inbox, (m) => m.type === 'msg' && m.kind === 'message' && m.msg_id === t1.id);
  check('destinataire prévenu en temps réel (avec aperçu)', live && live.preview === 'Bonjour Bob' && live.mtype === 'text', live);

  // ───────── Photo (octets bruts) ─────────
  const img = await sendMedia(A.token, { to: B.phone, kind: 'image', name: 'photo.png', text: 'Ma légende', lang_from: 'fr', lang_to: 'fr', translate: '0', client_id: 'k-img' }, PNG);
  check('photo envoyée (octets bruts)', img.id && img.httpStatus === 200, img);
  const imgLive = await waitFor(wsB.inbox, (m) => m.msg_id === img.id);
  check('aperçu photo sans emoji', imgLive && imgLive.mtype === 'image' && imgLive.preview.startsWith('Photo') && !EMOJI.test(imgLive.preview), imgLive);
  const imgDup = await sendMedia(A.token, { to: B.phone, kind: 'image', name: 'photo.png', client_id: 'k-img' }, PNG);
  check('photo renvoyée : pas de doublon', imgDup.duplicate === true && imgDup.id === img.id, imgDup);

  const fakeImg = await sendMedia(A.token, { to: B.phone, kind: 'image', name: 'x.png' }, Buffer.from('ceci n est pas une image du tout'));
  check('faux fichier image refusé (vérifié sur les octets)', fakeImg.httpStatus === 400, fakeImg);
  const bigImg = await sendMedia(A.token, { to: B.phone, kind: 'image', name: 'grosse.png' }, Buffer.concat([PNG, Buffer.alloc(1_600_000)]));
  check('photo trop lourde refusée (413)', bigImg.httpStatus === 413, bigImg);

  // ───────── Fichier ─────────
  const pdf = await sendMedia(A.token, { to: B.phone, kind: 'file', name: '../../Rapport mensuel.pdf', mime: 'application/pdf', client_id: 'k-pdf' }, PDF);
  check('document envoyé', pdf.id && pdf.httpStatus === 200, pdf);
  const exe = await sendMedia(A.token, { to: B.phone, kind: 'file', name: 'installer.exe' }, Buffer.from('MZ....'));
  check('fichier exécutable refusé', exe.httpStatus === 400 && exe.code === 'BLOCKED', exe);
  const bigFile = await sendMedia(A.token, { to: B.phone, kind: 'file', name: 'gros.zip' }, Buffer.alloc(5_100_000, 1));
  check('fichier de plus de 5 Mo refusé (413)', bigFile.httpStatus === 413, bigFile);
  const empty = await sendMedia(A.token, { to: B.phone, kind: 'file', name: 'vide.txt' }, Buffer.alloc(0));
  check('fichier vide refusé', empty.httpStatus === 400, empty);
  const toNobody = await sendMedia(A.token, { to: '+243000000000', kind: 'file', name: 'a.txt' }, Buffer.from('a'));
  check('destinataire sans compte : refus clair', toNobody.httpStatus === 404 && !EMOJI.test(toNobody.error || ''), toNobody);

  // ───────── Note vocale (avec forme d'onde) ─────────
  const wave = '3579864213579864213579864213579864';
  const vn = await api('POST', '/lokota/send', { to: B.phone, audio: M4A, duration_sec: 12, lang_from: 'fr', lang_to: 'fr', translate: false, wave, client_id: 'k-vn' }, A.token);
  check('note vocale envoyée', vn.id && vn.httpStatus === 200, vn);
  const vnLive = await waitFor(wsB.inbox, (m) => m.msg_id === vn.id);
  check('aperçu vocal « Note vocale · 0:12 » sans emoji', vnLive && vnLive.mtype === 'voice' && vnLive.preview === 'Note vocale · 0:12', vnLive);

  // ───────── Conversation allégée ─────────
  const lite = await api('GET', `/messages/with/${encodeURIComponent(A.phone)}?lite=1`, null, B.token);
  const items = lite.items || [];
  const byId = Object.fromEntries(items.map((i) => [i.id, i]));
  check('conversation : tous les messages présents', [t1.id, img.id, pdf.id, vn.id].every((i) => byId[i]), items.map((i) => i.id));
  check('mode léger : AUCUN contenu lourd dans la liste',
    items.every((i) => i.attachment === undefined && i.audio === undefined), items.map((i) => Object.keys(i)));
  check('photo : métadonnées présentes', byId[img.id].has_media === true && byId[img.id].attachment_type === 'image' && byId[img.id].att_mime === 'image/png' && byId[img.id].att_size === PNG.length, byId[img.id]);
  check('document : nom nettoyé (sans chemin) + taille + type',
    byId[pdf.id].att_name === 'Rapport mensuel.pdf' && byId[pdf.id].att_mime === 'application/pdf' && byId[pdf.id].att_size === PDF.length, byId[pdf.id]);
  check('vocal : forme d\'onde et durée conservées', byId[vn.id].wave === wave && byId[vn.id].duration_sec === 12 && byId[vn.id].has_media === true, byId[vn.id]);
  const heavy = await api('GET', `/messages/with/${encodeURIComponent(A.phone)}`, null, B.token);
  check('ancienne app (sans lite) : contenus encore fournis', (heavy.items || []).some((i) => i.id === img.id && String(i.attachment).startsWith('data:image/png')), null);

  // ───────── Téléchargement ─────────
  const m1 = await media(B.token, img.id);
  check('téléchargement photo : octets identiques + bon type', m1.httpStatus === 200 && m1.type === 'image/png' && m1.buf.equals(PNG), { s: m1.httpStatus, t: m1.type });
  const m2 = await media(B.token, pdf.id);
  check('téléchargement document : nom proposé + octets identiques', m2.httpStatus === 200 && m2.type === 'application/pdf' && /Rapport%20mensuel\.pdf/.test(m2.disp || '') && m2.buf.equals(PDF), { t: m2.type, d: m2.disp });
  const m3 = await media(B.token, vn.id);
  check('téléchargement vocal', m3.httpStatus === 200 && m3.type.startsWith('audio/') && m3.buf.length === 1200, { s: m3.httpStatus, t: m3.type, n: m3.buf.length });
  const m4 = await media(A.token, pdf.id);
  check('l\'expéditeur peut aussi télécharger', m4.httpStatus === 200, m4.httpStatus);
  const m5 = await media(C.token, pdf.id);
  check('un tiers ne peut PAS télécharger (404)', m5.httpStatus === 404, m5.httpStatus);
  const m6 = await media(B.token, 'tm_inexistant');
  check('identifiant inconnu : 404', m6.httpStatus === 404, m6.httpStatus);

  // ───────── Écoute d'un vocal ─────────
  const pl0 = await api('POST', `/messages/${vn.id}/played`, null, A.token);
  check('l\'expéditeur ne peut pas marquer « écouté » (404)', pl0.httpStatus === 404, pl0);
  const pl = await api('POST', `/messages/${vn.id}/played`, null, B.token);
  check('écoute enregistrée', pl.ok === true, pl);
  const plLive = await waitFor(wsA.inbox, (m) => m.type === 'msg' && m.kind === 'played' && (m.ids || []).includes(vn.id));
  check('expéditeur prévenu : vocal écouté', !!plLive, wsA.inbox.slice(-3));
  const afterPlay = await api('GET', `/messages/with/${encodeURIComponent(B.phone)}?lite=1`, null, A.token);
  check('played_at visible côté expéditeur', (afterPlay.items || []).find((i) => i.id === vn.id)?.played_at > 0, null);

  // ───────── Lecture ─────────
  await api('POST', `/messages/with/${encodeURIComponent(A.phone)}/read`, null, B.token);
  const readLive = await waitFor(wsA.inbox, (m) => m.type === 'msg' && m.kind === 'read');
  check('expéditeur prévenu : messages lus', !!readLive, null);
  const th0 = await api('GET', '/messages/threads', null, A.token);
  const thB = (Array.isArray(th0) ? th0 : []).find((t) => t.peer_phone === B.phone);
  check('fil : dernier message = note vocale, état « lu », sans emoji',
    thB && thB.last_type === 'voice' && thB.last_state === 'read' && thB.last_preview === 'Note vocale · 0:12' && !EMOJI.test(thB.last_preview), thB);

  // ───────── Suppression : pour moi ─────────
  const del1 = await api('POST', '/messages/delete', { ids: [t1.id, img.id], scope: 'me' }, B.token);
  check('suppression pour moi (groupée)', del1.ok && del1.results[t1.id] === 'hidden' && del1.results[img.id] === 'hidden', del1);
  const bView = await api('GET', `/messages/with/${encodeURIComponent(A.phone)}?lite=1`, null, B.token);
  check('masqués chez moi', !(bView.items || []).some((i) => i.id === t1.id || i.id === img.id), (bView.items || []).map((i) => i.id));
  const aView = await api('GET', `/messages/with/${encodeURIComponent(B.phone)}?lite=1`, null, A.token);
  check('toujours visibles chez l\'autre personne', (aView.items || []).some((i) => i.id === t1.id) && (aView.items || []).some((i) => i.id === img.id), null);
  const hiddenMedia = await media(B.token, img.id);
  check('média masqué : non téléchargeable par moi (404)', hiddenMedia.httpStatus === 404, hiddenMedia.httpStatus);

  // ───────── Suppression : pour tous ─────────
  const forbid = await api('POST', '/messages/delete', { ids: [pdf.id], scope: 'all' }, B.token);
  check('supprimer pour tous un message reçu : refusé', forbid.results && forbid.results[pdf.id] === 'forbidden', forbid);
  const stranger = await api('POST', '/messages/delete', { ids: [pdf.id], scope: 'all' }, C.token);
  check('un tiers ne peut rien supprimer', stranger.results && stranger.results[pdf.id] === 'missing', stranger);
  const del2 = await api('POST', '/messages/delete', { ids: [pdf.id, vn.id], scope: 'all' }, A.token);
  check('supprimer pour tous (groupé, expéditeur)', del2.results[pdf.id] === 'deleted' && del2.results[vn.id] === 'deleted', del2);
  const delLive = await waitFor(wsB.inbox, (m) => m.type === 'msg' && m.kind === 'deleted' && (m.ids || []).includes(pdf.id) && (m.ids || []).includes(vn.id));
  check('l\'autre personne est prévenue en direct', !!delLive, wsB.inbox.slice(-3));
  const bView2 = await api('GET', `/messages/with/${encodeURIComponent(A.phone)}?lite=1`, null, B.token);
  const dPdf = (bView2.items || []).find((i) => i.id === pdf.id);
  check('contenu effacé chez l\'autre (deleted=1, plus de média)', dPdf && dPdf.deleted === 1 && dPdf.has_media === false && !dPdf.att_name, dPdf);
  const gone = await media(B.token, pdf.id);
  check('média supprimé : 410', gone.httpStatus === 410, gone.httpStatus);
  const noIds = await api('POST', '/messages/delete', { ids: [], scope: 'me' }, A.token);
  check('suppression sans sélection : refus', noIds.httpStatus === 400, noIds);

  // ───────── Aperçu du fil après suppressions ─────────
  const th1 = await api('GET', '/messages/threads', null, B.token);
  const thA = (Array.isArray(th1) ? th1 : []).find((t) => t.peer_phone === A.phone);
  check('fil : dernier message supprimé → « Message supprimé » sans emoji', thA && thA.last_type === 'deleted' && thA.last_preview === 'Message supprimé', thA);
  check('compteur de non lus ignore les supprimés', thA && thA.unread === 0, thA);

  // ───────── Messages d'erreur sans emoji ─────────
  const self = await api('POST', '/messages/send', { to: A.phone, text: 'moi' }, A.token);
  check('messages d\'erreur sans emoji', self.httpStatus === 400 && !EMOJI.test(self.error), self);

  for (const c of [wsA, wsB]) c.ws.close();
  const bad = results.filter((r) => !r.ok);
  console.log(`\n${bad.length === 0 ? '🎉' : '⚠️'} ${results.length - bad.length}/${results.length} vérifications réussies`);
  process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.error('Test interrompu :', e); process.exit(2); });
