/**
 * PARTAGE D'UNE PUBLICATION EN DEHORS DE L'APPLICATION.
 *
 * Un lien n'a de valeur que s'il s'affiche. Ces tests vérifient donc :
 *   - la page publique /p/:id existe et porte les balises d'aperçu
 *     (og:title, og:description, og:image, og:url) que lisent WhatsApp,
 *     Facebook, Telegram et consorts ;
 *   - l'image d'aperçu est la miniature de la vidéo quand il y en a une ;
 *   - une publication NON publique n'est jamais exposée par ce lien
 *     (ni contacts, ni communauté) — sinon partager serait une fuite ;
 *   - le contenu de l'utilisateur est échappé : pas d'injection HTML ;
 *   - le compteur de partages fonctionne, et le fil renvoie `share_url`.
 *
 * Lancement :  node test/partage.test.js
 */
const { spawn } = require('child_process');
const path = require('path');

const PORT = 4799;
const B = `http://127.0.0.1:${PORT}/api`;
const RACINE = `http://127.0.0.1:${PORT}`;

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
  try { data = await r.json(); } catch { /* page HTML */ }
  return { status: r.status, data };
}

async function login(phone, name) {
  const a = await call('POST', '/auth/request-otp', { body: { phone, name } });
  const b = await call('POST', '/auth/verify-otp', { body: { phone, code: a.data.demo_code, name } });
  return { token: b.data.token, phone, name, id: b.data.user.id };
}

const page = (id) => fetch(`${RACINE}/p/${id}`).then(async (r) => ({ status: r.status, html: await r.text() }));
const og = (html, prop) => {
  const m = html.match(new RegExp(`<meta property="${prop}" content="([^"]*)"`));
  return m ? m[1] : null;
};

(async () => {
  const srv = spawn('node', ['src/server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), JWT_SECRET: 'test-partage', DEMO_MODE: 'true',
           PUSH_DEBUG_FAKE: 'true', DATABASE_URL: '', PUBLIC_URL: RACINE },
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
    const A = await login('+243750000101', 'Auteur Partage');
    const C = await login('+243750000102', 'Contact Partage');

    console.log('1. Le fil fournit un lien de partage tout prêt');
    const pub = await call('POST', '/feed/posts', {
      token: A.token,
      body: { type: 'texte', texte: 'Concert ce soir à Kinshasa', visibilite: 'public' },
    });
    const idPub = pub.data.post.id;
    ok('la publication est créée', pub.status === 201, pub.status);
    ok('share_url renvoyé à la création',
      pub.data.post.share_url === `${RACINE}/p/${idPub}`, pub.data.post.share_url);
    ok('compteur de partages à zéro', pub.data.post.partages === 0, pub.data.post.partages);
    const fil = await call('GET', '/feed', { token: C.token });
    const relu = (fil.data.posts || []).find((p) => p.id === idPub);
    ok('share_url présent aussi dans le fil', relu && relu.share_url === `${RACINE}/p/${idPub}`,
      relu && relu.share_url);

    console.log('\n2. La page publique s’affiche avec son aperçu');
    const vue = await page(idPub);
    ok('page servie (200)', vue.status === 200, vue.status);
    ok('titre lisible', /<title>[^<]*Auteur Partage[^<]*<\/title>/.test(vue.html),
      (vue.html.match(/<title>[^<]*<\/title>/) || [])[0]);
    ok('og:title présent', (og(vue.html, 'og:title') || '').includes('Auteur Partage'), og(vue.html, 'og:title'));
    ok('og:description reprend le texte',
      (og(vue.html, 'og:description') || '').includes('Concert ce soir'), og(vue.html, 'og:description'));
    ok('og:url pointe sur la publication', og(vue.html, 'og:url') === `${RACINE}/p/${idPub}`, og(vue.html, 'og:url'));
    ok('og:type déclaré', og(vue.html, 'og:type') === 'article', og(vue.html, 'og:type'));
    ok('bouton d’ouverture dans l’application',
      vue.html.includes(`mbote://post/${idPub}`), 'lien mbote:// absent');
    ok('le texte de la publication est affiché', vue.html.includes('Concert ce soir à Kinshasa'));

    console.log('\n3. JSON public sans jeton');
    const json = await fetch(`${B}/feed/posts/${idPub}/public`).then((r) => r.json());
    ok('publication accessible sans jeton', !!json.post, Object.keys(json));
    ok('lien de partage inclus', json.post && json.post.share_url === `${RACINE}/p/${idPub}`);
    ok('auteur résumé', json.auteur && json.auteur.name === 'Auteur Partage', json.auteur);
    ok('numéro de l’auteur masqué sans jeton', json.post && json.post.author_phone === null,
      json.post && json.post.author_phone);

    console.log('\n4. Une publication non publique n’est JAMAIS exposée');
    const pContacts = await call('POST', '/feed/posts', {
      token: A.token, body: { type: 'texte', texte: 'Secret de contacts', visibilite: 'contacts' },
    });
    const idContacts = pContacts.data.post.id;
    const vueContacts = await page(idContacts);
    ok('page refusée (404)', vueContacts.status === 404, vueContacts.status);
    ok('le texte n’apparaît pas dans la page', !vueContacts.html.includes('Secret de contacts'));
    ok('message clair pour le visiteur', /pas publique/i.test(vueContacts.html));
    const jsonContacts = await fetch(`${B}/feed/posts/${idContacts}/public`).then((r) => r.json());
    ok('JSON refusé sans jeton', !jsonContacts.post, jsonContacts);
    ok('mais accessible avec le jeton d’un contact',
      await (async () => {
        await call('POST', '/contacts', { token: C.token, body: { name: 'Auteur', phone: A.phone } });
        const r = await fetch(`${B}/feed/posts/${idContacts}/public`,
          { headers: { Authorization: `Bearer ${C.token}` } }).then((x) => x.json());
        return !!r.post;
      })());

    const pComm = await call('POST', '/feed/posts', {
      token: A.token, body: { type: 'texte', texte: 'Réservé communauté', visibilite: 'communaute' },
    });
    ok('« communauté » non exposée hors application',
      (await page(pComm.data.post.id)).status === 404);

    console.log('\n5. Vidéo : la miniature sert d’image d’aperçu');
    const clip = await call('POST', '/feed/posts', {
      token: A.token,
      body: {
        type: 'clip',
        media_url: `${RACINE}/uploads/exemple.mp4`,
        thumb_url: `${RACINE}/uploads/exemple.jpg`,
        texte: 'Clip de rumba',
        visibilite: 'public',
      },
    });
    const vueClip = await page(clip.data.post.id);
    ok('og:image = la miniature', og(vueClip.html, 'og:image') === `${RACINE}/uploads/exemple.jpg`,
      og(vueClip.html, 'og:image'));
    ok('carte large déclarée pour Twitter', /summary_large_image/.test(vueClip.html));

    console.log('\n6. Le contenu est échappé (pas d’injection)');
    const mechant = await call('POST', '/feed/posts', {
      token: A.token,
      body: { type: 'texte', texte: '<script>alert("x")</script> & "guillemets"', visibilite: 'public' },
    });
    const vueMechant = await page(mechant.data.post.id);
    ok('aucune balise script exécutable', !/<script>alert/.test(vueMechant.html));
    ok('le texte reste lisible sous forme échappée', vueMechant.html.includes('&lt;script&gt;'));

    console.log('\n7. Compteur de partages');
    const s1 = await call('POST', `/feed/posts/${idPub}/share`, { token: C.token });
    ok('premier partage compté', s1.data.partages === 1, s1.data);
    const s2 = await fetch(`${B}/feed/posts/${idPub}/share`, { method: 'POST' }).then((r) => r.json());
    ok('partage compté même sans jeton (lien ouvert)', s2.partages === 2, s2);
    const reluFil = await call('GET', '/feed', { token: C.token });
    const maj = (reluFil.data.posts || []).find((p) => p.id === idPub);
    ok('le compteur remonte dans le fil', maj && maj.partages === 2, maj && maj.partages);
    ok('partage d’une publication privée → 404',
      (await call('POST', `/feed/posts/${idContacts}/share`, {})).status === 404);

    console.log('\n8. Nettoyage et santé du serveur');
    for (const id of [idPub, idContacts, pComm.data.post.id, clip.data.post.id, mechant.data.post.id]) {
      await call('DELETE', `/feed/posts/${id}`, { token: A.token });
    }
    ok('page supprimée → 404', (await page(idPub)).status === 404);
    const erreurs = srvOut.split('\n').filter((l) => l.startsWith('💥'));
    ok('aucune erreur serveur', erreurs.length === 0, erreurs.slice(0, 2));

  } catch (e) {
    console.error('\n💥 exception du test :', e && e.stack);
    console.error('--- sortie serveur ---\n' + srvOut.slice(-1500));
    fail++;
  } finally {
    srv.kill();
    await sleep(300);
    console.log('\n──────────────────────────────────────────────────────');
    console.log(`${fail === 0 ? '✅' : '❌'}  ${pass} réussis · ${fail} échoués`);
    process.exit(fail === 0 ? 0 : 1);
  }
})();
