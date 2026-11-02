/**
 * Test du FIL DE PUBLICATION (backend) — parcours complet :
 * création, visibilité, contacts, numéro de l'auteur, likes, commentaires,
 * pagination par curseur, stories et événements.
 *
 * Lancement :  node test/feed.test.js
 */
const { spawn } = require('child_process');
const path = require('path');

const PORT = 4788;
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
  try { data = await r.json(); } catch { /* corps vide */ }
  return { status: r.status, data };
}

async function login(phone, name) {
  const a = await call('POST', '/auth/request-otp', { body: { phone, name } });
  const b = await call('POST', '/auth/verify-otp', { body: { phone, code: a.data.demo_code, name } });
  return { token: b.data.token, phone, name, id: b.data.user.id };
}

(async () => {
  const srv = spawn('node', ['src/server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), JWT_SECRET: 'test-feed', DEMO_MODE: 'true',
           PUSH_DEBUG_FAKE: 'true', DATABASE_URL: '', MBOTE_MESSAGE_STORAGE: '/tmp/feed-test-storage' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let srvOut = '';
  srv.stdout.on('data', d => { srvOut += d; });
  srv.stderr.on('data', d => { srvOut += d; });

  let up = false;
  for (let i = 0; i < 40; i++) {
    await sleep(300);
    try { const r = await fetch(B + '/health'); if (r.ok) { up = true; break; } } catch {}
  }
  if (!up) { console.error('serveur non démarré\n' + srvOut); srv.kill(); process.exit(1); }

  try {
    const A = await login('+243800000101', 'Alice');
    const Bc = await login('+243800000102', 'Bob');
    const C = await login('+243800000103', 'Chantal');

    console.log('1. Contacts');
    await call('POST', '/contacts', { token: A.token, body: { name: 'Bob', phone: '+243800000102' } });
    const mesContacts = await call('GET', '/contacts', { token: A.token });
    ok('Alice a Bob dans ses contacts',
      (mesContacts.data || []).some(c => c.phone === '+243800000102'), mesContacts.data);

    console.log('\n2. Création de publications');
    const pPublic = await call('POST', '/feed/posts', {
      token: Bc.token, body: { type: 'texte', texte: 'Bonjour Kin', visibilite: 'public' } });
    ok('post public créé (201)', pPublic.status === 201, pPublic);
    const pContacts = await call('POST', '/feed/posts', {
      token: Bc.token, body: { type: 'texte', texte: 'Pour mes contacts', visibilite: 'contacts' } });
    ok('post « contacts » créé', pContacts.status === 201, pContacts);
    const pComm = await call('POST', '/feed/posts', {
      token: Bc.token, body: { type: 'texte', texte: 'À la communauté', visibilite: 'communauté' } });
    ok('post « communauté » créé', pComm.status === 201, pComm);
    const cPublic = await call('POST', '/feed/posts', {
      token: C.token, body: { type: 'texte', texte: 'Salut de Chantal', visibilite: 'public' } });
    const cContacts = await call('POST', '/feed/posts', {
      token: C.token, body: { type: 'texte', texte: 'Chantal : contacts seulement', visibilite: 'contacts' } });
    ok('post de Chantal créé', cPublic.status === 201 && cContacts.status === 201);

    const evt = await call('POST', '/feed/posts', {
      token: Bc.token, body: {
        type: 'event', event_title: 'Concert rumba', event_date: 1767225600000,
        event_lieu: 'Palais du Peuple', event_tags: ['musique', 'kin'], visibilite: 'public',
      } });
    ok('événement créé avec lieu et tags', evt.status === 201, evt);
    ok('les tags reviennent en JSON', typeof evt.data.post.event_tags === 'string',
      evt.data.post && evt.data.post.event_tags);
    ok('le lieu d’événement est conservé', evt.data.post.event_lieu === 'Palais du Peuple', evt.data.post);

    console.log('\n3. Lecture du fil (visibilité)');
    const feed1 = await call('GET', '/feed', { token: A.token });
    const textes = (feed1.data.posts || []).map(p => p.texte);
    ok('fil lu (200)', feed1.status === 200 && Array.isArray(feed1.data.posts), feed1.status);
    ok('le post public de Bob apparaît', textes.includes('Bonjour Kin'), textes);
    ok('le post « contacts » de Bob apparaît (Bob est dans mes contacts)',
      textes.includes('Pour mes contacts'), textes);
    ok('le post « communauté » apparaît', textes.includes('À la communauté'), textes);
    ok('le post public de Chantal apparaît', textes.includes('Salut de Chantal'), textes);
    ok('le post « contacts » de Chantal N’apparaît PAS',
      !textes.includes('Chantal : contacts seulement'), textes);

    console.log('\n4. Numéro de l’auteur (bouton Appeler)');
    const bobPost = (feed1.data.posts || []).find(p => p.texte === 'Bonjour Kin');
    const chantalPost = (feed1.data.posts || []).find(p => p.texte === 'Salut de Chantal');
    ok('numéro fourni pour un contact', bobPost && bobPost.author_phone === '+243800000102', bobPost && bobPost.author_phone);
    ok('numéro MASQUÉ pour un inconnu', chantalPost && chantalPost.author_phone === null, chantalPost && chantalPost.author_phone);
    ok('avatar de l’auteur exposé', bobPost && 'author_avatar' in bobPost, bobPost && Object.keys(bobPost));
    ok('drapeau « déjà aimé » exposé', bobPost && bobPost.liked === 0, bobPost && bobPost.liked);
    ok('pagination : curseur renvoyé quand il y a plus de 20 posts',
      'next' in feed1.data, Object.keys(feed1.data));

    console.log('\n5. J’aime');
    const like1 = await call('POST', `/feed/posts/${bobPost.id}/like`, { token: A.token });
    ok('like ajouté', like1.data.liked === true && like1.data.likes === 1, like1.data);
    const like2 = await call('POST', `/feed/posts/${bobPost.id}/like`, { token: A.token });
    ok('like retiré au 2ᵉ appui', like2.data.liked === false && like2.data.likes === 0, like2.data);
    await call('POST', `/feed/posts/${bobPost.id}/like`, { token: A.token });
    const feedAfterLike = await call('GET', '/feed', { token: A.token });
    const relu = (feedAfterLike.data.posts || []).find(p => p.id === bobPost.id);
    ok('l’état « aimé » est relu depuis le serveur', relu && relu.liked === 1 && relu.likes === 1,
      relu && { liked: relu.liked, likes: relu.likes });

    console.log('\n6. Commentaires');
    const cm = await call('POST', `/feed/posts/${bobPost.id}/comments`, {
      token: A.token, body: { texte: 'Bien vu !' } });
    ok('commentaire créé (201)', cm.status === 201 && cm.data.comment.texte === 'Bien vu !', cm);
    const cms = await call('GET', `/feed/posts/${bobPost.id}/comments`, { token: A.token });
    ok('commentaire relu', cms.data.comments.length === 1, cms.data.comments);
    const feedAfterComment = await call('GET', '/feed', { token: A.token });
    const relu2 = (feedAfterComment.data.posts || []).find(p => p.id === bobPost.id);
    ok('compteur de commentaires à jour', relu2 && relu2.comments === 1, relu2 && relu2.comments);
    const vide = await call('POST', `/feed/posts/${bobPost.id}/comments`, { token: A.token, body: { texte: '   ' } });
    ok('commentaire vide refusé (400)', vide.status === 400, vide.status);

    console.log('\n7. Pagination (25 posts)');
    for (let i = 0; i < 25; i++) {
      await call('POST', '/feed/posts', { token: C.token, body: { type: 'texte', texte: `série ${i}`, visibilite: 'public' } });
    }
    const page1 = await call('GET', '/feed', { token: A.token });
    ok('première page limitée à 20', page1.data.posts.length === 20, page1.data.posts.length);
    ok('curseur suivant fourni', !!page1.data.next, page1.data.next);
    const q = `/feed?before=${page1.data.next.before}&cursor=${encodeURIComponent(page1.data.next.cursor)}`;
    const page2 = await call('GET', q, { token: A.token });
    ok('deuxième page non vide', page2.data.posts.length > 0, page2.data.posts.length);
    const ids1 = new Set(page1.data.posts.map(p => p.id));
    ok('aucun doublon entre les deux pages', page2.data.posts.every(p => !ids1.has(p.id)));
    const ordered = page1.data.posts.every((p, i, arr) => i === 0 || arr[i - 1].created_at >= p.created_at);
    ok('tri décroissant respecté', ordered);

    console.log('\n8. Stories');
    const st = await call('POST', '/feed/stories', {
      token: Bc.token, body: { media_url: 'https://exemple.cd/photo.jpg' } });
    ok('story créée (201)', st.status === 201, st);
    const sts = await call('GET', '/feed/stories', { token: A.token });
    const mine = (sts.data.stories || []).find(s => s.user_id === Bc.id);
    ok('story visible dans la bande', !!mine, sts.data.stories && sts.data.stories.length);
    ok('story non vue au départ', mine && mine.seen === 0, mine && mine.seen);
    ok('avatar de l’auteur exposé sur la story', mine && 'author_avatar' in mine);
    await call('POST', `/feed/stories/${mine.id}/seen`, { token: A.token });
    const sts2 = await call('GET', '/feed/stories', { token: A.token });
    const mine2 = (sts2.data.stories || []).find(s => s.id === mine.id);
    ok('story marquée vue', mine2 && mine2.seen === 1, mine2 && mine2.seen);

    console.log('\n9. Ville et statut texte (champs du modèle Flutter)');
    const pVille = await call('POST', '/feed/posts', {
      token: A.token,
      body: { type: 'texte', texte: 'Depuis Kin', ville: '  Kinshasa  ', visibilite: 'public' } });
    ok('ville acceptée à la création', pVille.status === 201 && pVille.data.post.ville === 'Kinshasa',
      pVille.data && pVille.data.post && pVille.data.post.ville);
    const feedVille = await call('GET', '/feed', { token: A.token });
    const reluVille = (feedVille.data.posts || []).find(p => p.id === pVille.data.post.id);
    ok('ville relue dans le fil', reluVille && reluVille.ville === 'Kinshasa', reluVille && reluVille.ville);
    const villeVide = await call('POST', '/feed/posts', {
      token: A.token, body: { type: 'texte', texte: 'sans ville', ville: '   ' } });
    ok('ville vide → null (pas de chaîne vide)', villeVide.data.post.ville === null,
      villeVide.data.post && villeVide.data.post.ville);

    const stTexte = await call('POST', '/feed/stories', {
      token: Bc.token, body: { texte: '  Bonjour Kin  ' } });
    ok('statut sans photo accepté (texte seul)', stTexte.status === 201, stTexte);
    ok('texte du statut nettoyé', stTexte.data && stTexte.data.story && stTexte.data.story.texte === 'Bonjour Kin',
      stTexte.data && stTexte.data.story && stTexte.data.story.texte);
    const stVide = await call('POST', '/feed/stories', { token: Bc.token, body: {} });
    ok('statut totalement vide refusé (400)', stVide.status === 400, stVide.status);

    console.log('\n10. Garde-fous');
    const sansTexte = await call('POST', '/feed/posts', { token: A.token, body: { type: 'texte' } });
    ok('post texte vide refusé (400)', sansTexte.status === 400, sansTexte.status);
    const mauvaisType = await call('POST', '/feed/posts', { token: A.token, body: { type: 'audio' } });
    ok('type inconnu refusé (400)', mauvaisType.status === 400, mauvaisType.status);
    const anonyme = await call('GET', '/feed');
    ok('fil sans jeton → 401', anonyme.status === 401, anonyme.status);
    const likeInexistant = await call('POST', '/feed/posts/inexistant/like', { token: A.token });
    ok('like sur post inconnu → 404', likeInexistant.status === 404, likeInexistant.status);
  } catch (e) {
    console.error('\n💥 exception du test :', e.message);
    fail++;
  }

  const erreurs = srvOut.split('\n').filter(l => l.startsWith('💥'));
  if (erreurs.length) { console.log('\nErreurs serveur :'); erreurs.forEach(l => console.log('  ' + l)); fail += erreurs.length; }

  console.log('\n──────────────────────────────────────────────────────');
  console.log(`RÉSULTAT : ${pass} réussis, ${fail} échecs`);
  srv.kill();
  process.exit(fail ? 1 : 0);
})();
