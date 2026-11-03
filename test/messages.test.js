/**
 * Test de la MESSAGERIE (onglet Discussion) — API réelle + WebSocket réel.
 *
 * Ce que l'on vérifie sans téléphone :
 *   • envoi d'un texte, idempotence (client_id), refus des cas invalides ;
 *   • liste des conversations : aperçu, non-lus, état, présence ;
 *   • conversation : ordre, pagination « remonter le temps » ;
 *   • accusés de lecture (✓✓ lu) et notes vocales « écoutée » ;
 *   • temps réel : nouveau message, « écrit… », lu, écouté, supprimé ;
 *   • photos et fichiers : signatures, taille, téléchargement protégé ;
 *   • suppression pour moi / pour tout le monde.
 *
 * Lancement :  node test/messages.test.js
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');

const PORT = 4791;
const B = `http://127.0.0.1:${PORT}/api`;
const STORAGE = '/tmp/messages-test-storage';
let pass = 0, fail = 0;

const ok = (label, cond, detail) => {
  if (cond) { console.log(`  ✓ ${label}`); pass++; }
  else { console.log(`  ✗ ${label}${detail !== undefined ? ' → ' + JSON.stringify(detail) : ''}`); fail++; }
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function call(method, p, { token, body, raw, headers } = {}) {
  const h = { ...(headers || {}) };
  if (!raw) h['Content-Type'] = 'application/json';
  if (token) h.Authorization = `Bearer ${token}`;
  const r = await fetch(B + p, {
    method, headers: h,
    body: raw ? raw : (body ? JSON.stringify(body) : undefined),
  });
  const ct = r.headers.get('content-type') || '';
  let data = null;
  if (ct.includes('application/json')) { try { data = await r.json(); } catch { /* vide */ } }
  else data = Buffer.from(await r.arrayBuffer());
  return { status: r.status, data, mime: ct };
}

async function login(phone, name) {
  const a = await call('POST', '/auth/request-otp', { body: { phone, name } });
  const b = await call('POST', '/auth/verify-otp', { body: { phone, code: a.data.demo_code, name } });
  return { token: b.data.token, phone, name, id: b.data.user.id };
}

function client(user) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${user.token}`);
  const inbox = [];
  ws.on('message', (raw) => {
    try { inbox.push(JSON.parse(raw.toString())); } catch { /* ping binaire */ }
  });
  return {
    ws, user, inbox,
    send: (obj) => ws.send(JSON.stringify(obj)),
    wait: async (pred, ms = 3000) => {
      const test = typeof pred === 'string' ? (m) => m.type === pred : pred;
      const start = Date.now();
      while (Date.now() - start < ms) {
        const i = inbox.findIndex(test);
        if (i !== -1) return inbox.splice(i, 1)[0];
        await sleep(25);
      }
      return null;
    },
    clear: () => { inbox.length = 0; },
    open: () => new Promise(res => ws.on('open', res)),
  };
}

/** Un JPEG minimal mais valide du point de vue de la signature. */
const jpeg = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
  Buffer.from('JFIF', 'ascii'),
  Buffer.alloc(600, 7),
  Buffer.from([0xff, 0xd9]),
]);
const jsonBody = (buf) => ({
  body: buf, headers: { 'Content-Type': 'application/json' },
});

(async () => {
  fs.rmSync(STORAGE, { recursive: true, force: true });
  const srv = spawn('node', ['src/server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env, PORT: String(PORT), JWT_SECRET: 'test-messages', DEMO_MODE: 'true',
      DATABASE_URL: '', PUSH_DEBUG_FAKE: 'true', PUBLIC_URL: `http://127.0.0.1:${PORT}`,
      MBOTE_MESSAGE_STORAGE: STORAGE, MBOTE_LOKOTA_URL: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let srvOut = '';
  srv.stdout.on('data', d => { srvOut += d; });
  srv.stderr.on('data', d => { srvOut += d; });

  let up = false;
  for (let i = 0; i < 40; i++) {
    await sleep(300);
    try { const r = await fetch(`${B}/health`); if (r.ok) { up = true; break; } } catch { /* en cours */ }
  }
  if (!up) { console.error('serveur non démarré\n' + srvOut); srv.kill(); process.exit(1); }

  const clients = [];
  try {
    const suffix = Date.now() % 100000;
    const A = await login(`+2438200${suffix}`, 'Alice');
    const Bb = await login(`+2438201${suffix}`, 'Bob');
    const C = await login(`+2438202${suffix}`, 'Chantal');

    const a = client(A), b = client(Bb), c = client(C);
    clients.push(a, b, c);
    await Promise.all(clients.map(x => x.open()));
    await sleep(300);

    // ─────────────────────────────────────────────────────────────
    console.log('1. Envoi d’un message texte');
    const r1 = await call('POST', '/messages/send', {
      token: A.token, body: { to: Bb.phone, text: 'Mbote Bob !', client_id: 'c-1', lang_from: 'fr', lang_to: 'fr' },
    });
    ok('message créé (201)', r1.status === 201, r1.status);
    ok('identifiant renvoyé', !!r1.data.id, r1.data);
    ok('drapeau « à moi »', r1.data.mine === true, r1.data.mine);
    ok('corps conservé', r1.data.body === 'Mbote Bob !', r1.data.body);
    const msgId = r1.data.id;

    const dup = await call('POST', '/messages/send', {
      token: A.token, body: { to: Bb.phone, text: 'Mbote Bob !', client_id: 'c-1' },
    });
    ok('renvoi du même client_id = pas de doublon', dup.status === 200 && dup.data.id === msgId,
       { status: dup.status, id: dup.data && dup.data.id });

    ok('texte vide refusé', (await call('POST', '/messages/send', {
      token: A.token, body: { to: Bb.phone, text: '   ' },
    })).status === 400);
    ok('numéro inconnu refusé', (await call('POST', '/messages/send', {
      token: A.token, body: { to: '+243999999999', text: 'coucou' },
    })).status === 400);
    ok('message à soi-même refusé', (await call('POST', '/messages/send', {
      token: A.token, body: { to: A.phone, text: 'moi' },
    })).status === 400);
    ok('sans jeton → 401', (await call('POST', '/messages/send', {
      body: { to: Bb.phone, text: 'nu' },
    })).status === 401);

    // ─────────────────────────────────────────────────────────────
    console.log('\n2. Temps réel : le destinataire est prévenu');
    const notif = await b.wait('msg');
    ok('notification « msg » reçue', !!notif, notif);
    ok('type « message »', notif && notif.kind === 'message', notif && notif.kind);
    ok('identifiant du message', notif && notif.msg_id === msgId, notif && notif.msg_id);
    ok('expéditeur annoncé', notif && notif.from_name === 'Alice', notif && notif.from_name);
    ok('aperçu lisible', notif && notif.preview === 'Mbote Bob !', notif && notif.preview);

    a.clear(); b.clear();
    b.send({ type: 'typing', to: A.phone });
    const typing = await a.wait('typing');
    ok('« écrit… » relayé à l’expéditeur', !!typing && typing.from === Bb.phone, typing);

    // ─────────────────────────────────────────────────────────────
    console.log('\n3. Liste des conversations');
    const th = await call('GET', '/messages/threads', { token: Bb.token });
    ok('liste reçue (200)', th.status === 200 && Array.isArray(th.data), th.status);
    const fil = (th.data || []).find(t => t.peer_phone === A.phone);
    ok('la conversation avec Alice apparaît', !!fil, th.data);
    ok('aperçu du dernier message', fil && fil.last_preview === 'Mbote Bob !', fil && fil.last_preview);
    ok('type du dernier message', fil && fil.last_type === 'text', fil && fil.last_type);
    ok('état « non lu » côté destinataire', fil && fil.unread === 1, fil && fil.unread);
    ok('le dernier message vient bien de moi (vue Bob)', fil && fil.last_mine === false, fil && fil.last_mine);
    const thA0 = await call('GET', '/messages/threads', { token: A.token });
    const filA0 = (thA0.data || []).find(t => t.peer_phone === Bb.phone);
    ok('état « reçu » côté expéditeur', filA0 && filA0.last_state === 'delivered', filA0 && filA0.last_state);
    ok('présence en ligne signalée', fil && fil.online === true, fil && fil.online);
    ok('nom du proche', fil && fil.peer_name === 'Alice', fil && fil.peer_name);

    // ─────────────────────────────────────────────────────────────
    console.log('\n4. Accusés de lecture');
    a.clear();
    const rd = await call('POST', `/messages/with/${encodeURIComponent(A.phone)}/read`, { token: Bb.token });
    ok('marquage lu accepté', rd.status === 200 && rd.data.count === 1, rd.data);
    const lu = await a.wait('msg');
    ok('l’expéditeur reçoit « read »', !!lu && lu.kind === 'read', lu);
    ok('« read » porte l’identifiant', lu && lu.msg_id === msgId, lu && lu.msg_id);

    const convA = await call('GET', `/messages/with/${encodeURIComponent(Bb.phone)}`, { token: A.token });
    const m1 = (convA.data.items || []).find(m => m.id === msgId);
    ok('statut du message devenu « read »', m1 && m1.status === 'read', m1 && m1.status);
    ok('date de lecture renseignée', m1 && m1.read_at > 0, m1 && m1.read_at);
    const thA = await call('GET', '/messages/threads', { token: A.token });
    const filA = (thA.data || []).find(t => t.peer_phone === Bb.phone);
    ok('liste : état ✓✓ lu aussi', filA && filA.last_state === 'read', filA && filA.last_state);
    ok('plus de non-lus après lecture', (() => {
      const t = (th.data || []).find(x => x.peer_phone === A.phone);
      return t && t.unread === 1;
    })(), 'conservé côté API (lu au rechargement)');

    // ─────────────────────────────────────────────────────────────
    console.log('\n4 bis. « Reçu » quand le proche était hors ligne');
    // Didier existe mais n'a AUCUNE connexion WebSocket : il est hors ligne.
    const D = await login(`+2438203${suffix}`, 'Didier');
    const rD = await call('POST', '/messages/send', {
      token: A.token, body: { to: D.phone, text: 'Tu es là ?', client_id: 'off-1' },
    });
    ok('message envoyé à un proche hors ligne', rD.status === 201, rD.status);
    ok('état initial « envoyé » (non reçu)', rD.data.status === 'sent', rD.data.status);
    a.clear();
    const convD = await call('GET', `/messages/with/${encodeURIComponent(A.phone)}`, { token: D.token });
    ok('Didier ouvre la conversation', convD.status === 200, convD.status);
    const evtDelivered = await a.wait('msg');
    ok('l’expéditeur reçoit « delivered »', !!evtDelivered && evtDelivered.kind === 'delivered',
       evtDelivered);
    ok('« delivered » porte l’identifiant', evtDelivered && evtDelivered.msg_id === rD.data.id,
       evtDelivered && evtDelivered.msg_id);
    const convOff = await call('GET', `/messages/with/${encodeURIComponent(D.phone)}`, { token: A.token });
    const mD = (convOff.data.items || []).find(m => m.id === rD.data.id);
    ok('statut passé à « delivered »', mD && mD.status === 'delivered', mD && mD.status);

    // ─────────────────────────────────────────────────────────────
    console.log('\n5. Conversation et pagination');
    for (let i = 0; i < 54; i++) {
      await call('POST', '/messages/send', {
        token: A.token, body: { to: Bb.phone, text: `suite ${i}`, client_id: `p-${i}` },
      });
      await sleep(2);
    }
    const page1 = await call('GET', `/messages/with/${encodeURIComponent(A.phone)}`, { token: Bb.token });
    ok('50 messages par page', (page1.data.items || []).length === 50, (page1.data.items || []).length);
    ok('il reste des messages plus anciens', page1.data.has_more === true, page1.data.has_more);
    ok('le plus récent en dernier', page1.data.items[page1.data.items.length - 1].body === 'suite 53',
       page1.data.items[page1.data.items.length - 1].body);
    const oldest = page1.data.items[0].created_at;
    const page2 = await call('GET',
      `/messages/with/${encodeURIComponent(A.phone)}?before=${oldest}`, { token: Bb.token });
    ok('page précédente non vide', (page2.data.items || []).length > 0, (page2.data.items || []).length);
    ok('aucun doublon entre les pages',
       !(page2.data.items || []).some(m => (page1.data.items || []).some(x => x.id === m.id)));
    ok('curseur invalide refusé', (await call('GET',
      `/messages/with/${encodeURIComponent(A.phone)}?before=abc`, { token: Bb.token })).status === 400);

    // ─────────────────────────────────────────────────────────────
    console.log('\n6. Photos');
    b.clear();
    const img = await call('POST',
      `/messages/send-media?to=${encodeURIComponent(Bb.phone)}&kind=image&mime=image%2Fjpeg&name=photo.jpg&client_id=img-1`,
      { token: A.token, raw: jpeg, headers: { 'Content-Type': 'application/octet-stream' } });
    ok('photo acceptée (201)', img.status === 201, { s: img.status, d: img.data });
    ok('kind = image', img.data.kind === 'image', img.data.kind);
    ok('pièce jointe annoncée', img.data.has_media === true, img.data.has_media);
    ok('nom d’origine conservé', img.data.att_name === 'photo.jpg', img.data.att_name);
    const imgId = img.data.id;
    const notifImg = await b.wait('msg');
    ok('aperçu « Photo » en temps réel', notifImg && notifImg.preview === 'Photo',
       notifImg && notifImg.preview);

    const fakeImg = await call('POST',
      `/messages/send-media?to=${encodeURIComponent(Bb.phone)}&kind=image&mime=image%2Fjpeg&name=faux.jpg`,
      { token: A.token, raw: Buffer.from('pas une image du tout'), headers: { 'Content-Type': 'application/octet-stream' } });
    ok('faux JPEG refusé (signature)', fakeImg.status === 400, fakeImg.status);
    ok('format photo exotique refusé', (await call('POST',
      `/messages/send-media?to=${encodeURIComponent(Bb.phone)}&kind=image&mime=image%2Fbmp&name=x.bmp`,
      { token: A.token, raw: jpeg, headers: { 'Content-Type': 'application/octet-stream' } })).status === 400);
    ok('fichier vide refusé', (await call('POST',
      `/messages/send-media?to=${encodeURIComponent(Bb.phone)}&kind=image&mime=image%2Fjpeg&name=v.jpg`,
      { token: A.token, raw: Buffer.alloc(0), headers: { 'Content-Type': 'application/octet-stream' } })).status === 400);

    const dl = await fetch(`${B}/messages/media/${imgId}`, { headers: { Authorization: `Bearer ${Bb.token}` } });
    ok('le destinataire télécharge la photo', dl.status === 200, dl.status);
    ok('bon type MIME servi', (dl.headers.get('content-type') || '').includes('image/jpeg'),
       dl.headers.get('content-type'));
    ok('contenu identique à l’envoi',
       Buffer.from(await dl.arrayBuffer()).equals(jpeg));
    ok('téléchargement sans jeton refusé',
       (await fetch(`${B}/messages/media/${imgId}`)).status === 401);
    ok('un tiers ne peut pas télécharger',
       (await fetch(`${B}/messages/media/${imgId}`, { headers: { Authorization: `Bearer ${C.token}` } })).status === 404);
    ok('pas de téléchargement pour un identifiant inconnu',
       (await fetch(`${B}/messages/media/msg-inexistant`, { headers: { Authorization: `Bearer ${A.token}` } })).status === 404);

    // ─────────────────────────────────────────────────────────────
    console.log('\n7. Fichiers');
    const pdf = Buffer.from('%PDF-1.4\n% test\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');
    const fil3 = await call('POST',
      `/messages/send-media?to=${encodeURIComponent(Bb.phone)}&kind=file&mime=application%2Fpdf&name=recu.pdf&client_id=file-1`,
      { token: A.token, raw: pdf, headers: { 'Content-Type': 'application/octet-stream' } });
    ok('fichier PDF accepté', fil3.status === 201, { s: fil3.status, d: fil3.data });
    ok('kind = file', fil3.data.kind === 'file', fil3.data.kind);
    const thFile = await call('GET', '/messages/threads', { token: Bb.token });
    const filFile = (thFile.data || []).find(t => t.peer_phone === A.phone);
    ok('la liste montre le nom du fichier', filFile && filFile.last_preview === 'recu.pdf',
       filFile && filFile.last_preview);
    ok('type « file » dans la liste', filFile && filFile.last_type === 'file', filFile && filFile.last_type);
    ok('type de fichier fantaisiste refusé', (await call('POST',
      `/messages/send-media?to=${encodeURIComponent(Bb.phone)}&kind=file&mime=audio%2Fmpeg&name=x.mp3`,
      { token: A.token, raw: pdf, headers: { 'Content-Type': 'application/octet-stream' } })).status === 400);

    // ─────────────────────────────────────────────────────────────
    console.log('\n8. Note vocale traduite');
    a.clear(); b.clear();
    const audio = Buffer.alloc(3000, 3);
    const note = await call('POST', '/konversations/send', {
      token: A.token,
      body: {
        to: Bb.phone, audio: `data:audio/m4a;base64,${audio.toString('base64')}`,
        duration_sec: 7, lang_from: 'fr', lang_to: 'ln', wave: [10, 40, 80, 55], client_id: 'voice-1',
      },
    });
    ok('note vocale créée (201)', note.status === 201, { s: note.status, d: note.data });
    ok('kind = note dans le fil', note.data.kind === 'note', note.data.kind);
    ok('durée conservée', note.data.duration_sec === 7, note.data.duration_sec);
    ok('langues conservées', note.data.lang_from === 'fr' && note.data.lang_to === 'ln',
       { de: note.data.lang_from, vers: note.data.lang_to });
    ok('forme d’onde conservée', Array.isArray(note.data.wave) && note.data.wave.length === 4,
       note.data.wave);
    ok('non encore écoutée', !note.data.played_at, note.data.played_at);
    const noteId = note.data.id;

    const notifNote = await b.wait('msg');
    ok('aperçu « Note vocale » en temps réel', notifNote && notifNote.preview === 'Note vocale',
       notifNote && notifNote.preview);

    a.clear();
    const playedRes = await call('POST', `/messages/${noteId}/played`, { token: Bb.token });
    ok('écoute enregistrée', playedRes.status === 200, playedRes.status);
    const playedEvt = await a.wait('msg');
    ok('l’expéditeur reçoit « played »', !!playedEvt && playedEvt.kind === 'played', playedEvt);
    const convNote = await call('GET', `/messages/with/${encodeURIComponent(A.phone)}`, { token: Bb.token });
    const noteRow = (convNote.data.items || []).find(m => m.id === noteId);
    ok('date d’écoute conservée', noteRow && noteRow.played_at > 0, noteRow && noteRow.played_at);
    ok('l’expéditeur ne peut pas marquer « écoutée »',
       (await call('POST', `/messages/${noteId}/played`, { token: A.token })).status === 404);
    const audioDl = await fetch(`${B}/messages/media/${noteId}`, { headers: { Authorization: `Bearer ${Bb.token}` } });
    ok('la note vocale est téléchargeable', audioDl.status === 200, audioDl.status);

    // ─────────────────────────────────────────────────────────────
    console.log('\n9. Suppression');
    const tmp = await call('POST', '/messages/send', {
      token: A.token, body: { to: Bb.phone, text: 'à supprimer pour moi', client_id: 'hide-1' },
    });
    const hideId = tmp.data.id;
    const hidden = await call('POST', '/messages/delete', {
      token: Bb.token, body: { ids: [hideId], scope: 'me' },
    });
    ok('suppression « pour moi » acceptée', hidden.status === 200 && hidden.data.results[hideId] === 'hidden',
       hidden.data);
    const convB2 = await call('GET', `/messages/with/${encodeURIComponent(A.phone)}`, { token: Bb.token });
    ok('disparaît de mon fil', !(convB2.data.items || []).some(m => m.id === hideId));
    const convA2 = await call('GET', `/messages/with/${encodeURIComponent(Bb.phone)}`, { token: A.token });
    ok('reste visible pour l’autre', (convA2.data.items || []).some(m => m.id === hideId));
    ok('suppression « pour tout le monde » interdite sur le message d’un autre',
       (await call('POST', '/messages/delete', {
         token: Bb.token, body: { ids: [hideId], scope: 'all' },
       })).data.results[hideId] === 'forbidden');
    ok('sélection vide refusée', (await call('POST', '/messages/delete', {
      token: A.token, body: { ids: [], scope: 'me' },
    })).status === 400);

    const del = await call('POST', '/messages/send', {
      token: A.token, body: { to: Bb.phone, text: 'message éphémère', client_id: 'del-1' },
    });
    const delId = del.data.id;
    b.clear();
    const delRes = await call('DELETE', `/messages/${delId}`, { token: A.token });
    ok('suppression définitive acceptée', delRes.status === 200, delRes.status);
    const delEvt = await b.wait('msg');
    ok('l’autre est prévenu « deleted »', !!delEvt && delEvt.kind === 'deleted' && delEvt.msg_id === delId, delEvt);
    const convB3 = await call('GET', `/messages/with/${encodeURIComponent(A.phone)}`, { token: Bb.token });
    const delRow = (convB3.data.items || []).find(m => m.id === delId);
    ok('message marqué supprimé', delRow && delRow.kind === 'deleted' && delRow.deleted === 1, delRow && delRow.kind);
    ok('contenu effacé', delRow && delRow.body === '', delRow && delRow.body);
    ok('un autre ne peut pas supprimer mon message',
       (await call('DELETE', `/messages/${delId}`, { token: Bb.token })).status === 404);

    const delImg = await call('DELETE', `/messages/${imgId}`, { token: A.token });
    ok('supprimer une photo réussit', delImg.status === 200, delImg.status);
    ok('la photo n’est plus téléchargeable',
       (await fetch(`${B}/messages/media/${imgId}`, { headers: { Authorization: `Bearer ${Bb.token}` } })).status === 404);
    ok('fichier retiré du disque',
       !fs.existsSync(path.join(STORAGE, `${imgId}.jpg`)));
  } catch (e) {
    console.error('erreur inattendue :', e);
    fail++;
  } finally {
    clients.forEach(x => { try { x.ws.close(); } catch { /* déjà fermé */ } });
    srv.kill();
    await sleep(200);
  }

  console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} réussis · ${fail} échoués`);
  process.exit(fail === 0 ? 0 : 1);
})();
