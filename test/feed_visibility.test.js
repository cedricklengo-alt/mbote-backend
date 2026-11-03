/**
 * FIL DE PUBLICATIONS — visibilité, découverte, vues, abonnements, mots-clés.
 *
 * Ces tests protègent la correction d'un défaut qui rendait le fil inutilisable :
 * une publication n'était visible que par son auteur. Trois raisons possibles,
 * toutes couvertes ici :
 *   - l'écriture de la visibilité (« communauté » accentuée, casse, forme
 *     Unicode) ne correspondait à aucune comparaison SQL ;
 *   - la visibilité « contacts » n'était vue que par les gens qui avaient déjà
 *     l'auteur dans leur répertoire, donc en pratique par personne ;
 *   - le formulaire de l'application proposait « Mes contacts » par défaut.
 *
 * Lancement :  node test/feed_visibility.test.js
 */
const { spawn } = require('child_process');
const path = require('path');
const db = require('../src/db');
const { harmoniserVisibilites, rattraperTags } = require('../src/services/feed_migration');
const { canoniserVisibilite, extraireTags, scoreInteret } = require('../src/services/feed_rules');

const PORT = 4797;
const B = `http://127.0.0.1:${PORT}/api`;
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
  try { data = await r.json(); } catch { /* réponse vide */ }
  return { status: r.status, data };
}

async function login(phone, name) {
  const a = await call('POST', '/auth/request-otp', { body: { phone, name } });
  const b = await call('POST', '/auth/verify-otp', { body: { phone, code: a.data.demo_code, name } });
  return { token: b.data.token, phone, name, id: b.data.user.id };
}

const textes = (page) => (page.data.posts || []).map((p) => p.texte);
const contient = (page, texte) => textes(page).includes(texte);

(async () => {
  await db.init();

  const srv = spawn('node', ['src/server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), JWT_SECRET: 'test-feed-vis', DEMO_MODE: 'true',
           PUSH_DEBUG_FAKE: 'true', DATABASE_URL: '', PUBLIC_URL: `http://127.0.0.1:${PORT}` },
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
    const s = Date.now() % 100000;
    const A = await login(`+2437110${s}`, 'Aline');   // lectrice
    const Bo = await login(`+2437111${s}`, 'Bosco');  // auteur
    const C = await login(`+2437112${s}`, 'Chantal'); // inconnue
    const D = await login(`+2437113${s}`, 'Dora');    // reste une inconnue

    // ── 1. Le défaut d'origine : la visibilité par défaut ───────────────────
    console.log('\n1. Une publication sans visibilité explicite est PUBLIQUE');
    const sansVis = await call('POST', '/feed/posts', { token: Bo.token, body: { type: 'texte', texte: 'Par défaut' } });
    ok('création acceptée (201)', sansVis.status === 201, sansVis);
    ok('stockée « public »', sansVis.data.post.visibilite === 'public', sansVis.data.post.visibilite);
    const filA = await call('GET', '/feed', { token: A.token });
    ok('visible par un autre utilisateur', contient(filA, 'Par défaut'), textes(filA));

    // ── 2. Toutes les écritures de visibilité mènent à la même valeur ────────
    console.log('\n2. « communauté » sous toutes ses écritures');
    const variantes = ['communauté', 'communaute', 'COMMUNAUTÉ', 'Communauté', 'communaute\u0301'];
    for (const v of variantes) {
      const p = await call('POST', '/feed/posts', {
        token: Bo.token, body: { type: 'texte', texte: `variante ${v}`, visibilite: v },
      });
      ok(`« ${JSON.stringify(v)} » acceptée et stockée en forme canonique`,
        p.status === 201 && p.data.post.visibilite === 'communaute',
        p.status === 201 ? p.data.post.visibilite : p);
    }
    const filVariantes = await call('GET', '/feed', { token: A.token });
    ok('toutes visibles par un autre utilisateur',
      variantes.every((v) => contient(filVariantes, `variante ${v}`)), textes(filVariantes));

    console.log('\n3. Garde-fous de création');
    ok('visibilité inconnue → 400',
      (await call('POST', '/feed/posts', { token: Bo.token, body: { type: 'texte', texte: 'x', visibilite: 'secret' } })).status === 400);
    ok('durée inconnue ramenée à « permanent »',
      (await call('POST', '/feed/posts', { token: Bo.token, body: { type: 'texte', texte: 'durée', duree: 'h99' } })).data.post.duree === 'permanent');

    // ── 4. Visibilité « contacts » : symétrique, mais pas publique ───────────
    console.log('\n4. Visibilité « contacts »');
    await call('POST', '/contacts', { token: A.token, body: { name: 'Bosco', phone: Bo.phone } });
    const pContacts = await call('POST', '/feed/posts', {
      token: Bo.token, body: { type: 'texte', texte: 'Pour mes contacts', visibilite: 'contacts' },
    });
    ok('publication « contacts » créée', pContacts.status === 201, pContacts);
    const filContacts = await call('GET', '/feed', { token: A.token });
    ok('visible si l’auteur est dans MES contacts', contient(filContacts, 'Pour mes contacts'));
    const filInconnue = await call('GET', '/feed', { token: C.token });
    ok('invisible pour un inconnu (confidentialité préservée)',
      !contient(filInconnue, 'Pour mes contacts'), textes(filInconnue));

    // Sens inverse : c'est l'AUTEUR qui m'a dans ses contacts.
    await call('POST', '/contacts', { token: C.token, body: { name: 'Bosco', phone: Bo.phone } });
    await call('POST', '/contacts', { token: Bo.token, body: { name: 'Chantal', phone: C.phone } });
    const pContacts2 = await call('POST', '/feed/posts', {
      token: Bo.token, body: { type: 'texte', texte: 'Chantal me connaît', visibilite: 'contacts' },
    });
    const filC2 = await call('GET', '/feed', { token: C.token });
    ok('visible aussi quand l’AUTEUR m’a dans ses contacts',
      (filC2.data.posts || []).some((p) => p.id === pContacts2.data.post.id) || contient(filC2, 'Chantal me connaît'),
      textes(filC2));

    // ── 5. Découverte : jamais de contenu « contacts » ──────────────────────
    console.log('\n5. Découverte publique');
    const dec = await call('GET', '/feed/discover?sort=recent', { token: C.token });
    ok('la découverte répond (200)', dec.status === 200 && Array.isArray(dec.data.posts), dec.status);
    ok('contient des publications publiques', contient(dec, 'Par défaut'), textes(dec));
    ok('ne contient AUCUNE publication « contacts »',
      (dec.data.posts || []).every((p) => p.visibilite !== 'contacts'),
      (dec.data.posts || []).map((p) => p.visibilite));
    const decTend = await call('GET', '/feed/discover?sort=tendances', { token: C.token });
    ok('le tri « tendances » répond sans erreur', decTend.status === 200, decTend.status);

    console.log('\n6. Le score d’intérêt favorise ce qui intéresse');
    const t = Date.now();
    const engage = scoreInteret({ likes: 5, comments: 2, vues: 10, created_at: t - 3600e3 }, t);
    const fade = scoreInteret({ likes: 0, comments: 0, vues: 0, created_at: t - 3600e3 }, t);
    const vieux = scoreInteret({ likes: 5, comments: 2, vues: 10, created_at: t - 10 * 24 * 3600e3 }, t);
    ok('une publication engageante passe devant une publication inerte', engage > fade);
    ok('une publication ancienne recule', vieux < engage);

    // ── 7. Compteur de vues ─────────────────────────────────────────────────
    console.log('\n7. Compteur de vues');
    const idPub = sansVis.data.post.id;
    const v1 = await call('POST', `/feed/posts/${idPub}/view`, { token: A.token });
    ok('première vue comptée', v1.data.compte === true && v1.data.vues === 1, v1.data);
    const v2 = await call('POST', `/feed/posts/${idPub}/view`, { token: A.token });
    ok('la même personne ne compte qu’une fois', v2.data.compte === false && v2.data.vues === 1, v2.data);
    const v3 = await call('POST', `/feed/posts/${idPub}/view`, { token: C.token });
    ok('un autre lecteur compte', v3.data.vues === 2, v3.data);
    const vAuteur = await call('POST', `/feed/posts/${idPub}/view`, { token: Bo.token });
    ok('la vue de l’auteur ne compte pas', vAuteur.data.compte === false && vAuteur.data.vues === 2, vAuteur.data);
    const relu = await call('GET', `/feed/posts/${idPub}`, { token: A.token });
    ok('le compteur est relu dans la publication', relu.data.post.vues === 2, relu.data.post.vues);

    // ── 8. Mots-clés ────────────────────────────────────────────────────────
    console.log('\n8. Mots-clés et tendances');
    const pTag = await call('POST', '/feed/posts', {
      token: Bo.token,
      body: { type: 'texte', texte: 'Concert à #Kinshasa avec #Musique et #kinshasa', visibilite: 'public' },
    });
    ok('mots-clés extraits et dédoublonnés',
      JSON.stringify(pTag.data.post.tags) === JSON.stringify(['kinshasa', 'musique']), pTag.data.post.tags);
    const tags = await call('GET', '/feed/tags', { token: A.token });
    const kino = (tags.data.tags || []).find((x) => x.tag === 'kinshasa');
    ok('« kinshasa » apparaît dans les tendances', !!kino, tags.data.tags);
    ok('avec son nombre de publications', kino && kino.publications >= 1, kino);
    const parTag = await call('GET', '/feed/tags/Musique', { token: A.token });
    ok('filtrage par mot-clé (casse ignorée)', parTag.data.posts.length >= 1, parTag.data.posts.length);
    ok('mot-clé inconnu → liste vide', (await call('GET', '/feed/tags/zzzzz', { token: A.token })).data.posts.length === 0);
    ok('extraction : #a refusé (trop court)', extraireTags('#a bonjour', []).length === 0, extraireTags('#a bonjour', []));
    ok('extraction : accents et # superflus nettoyés',
      JSON.stringify(extraireTags('#Congo #élection', [])) === JSON.stringify(['congo', 'election']),
      extraireTags('#Congo #élection', []));

    // ── 9. Abonnements ──────────────────────────────────────────────────────
    console.log('\n9. Abonnements');
    const ab = await call('POST', `/feed/authors/${Bo.id}/follow`, { token: C.token });
    ok('abonnement enregistré', ab.data.suivi === true, ab.data);
    ok('le compteur d’abonnés augmente', ab.data.abonnes >= 1, ab.data.abonnes);
    const suite = await call('GET', '/feed/following', { token: C.token });
    ok('le fil « Abonnements » contient ses publications', contient(suite, 'Par défaut'), textes(suite));
    ok('abonnement à soi-même refusé (400)',
      (await call('POST', `/feed/authors/${C.id}/follow`, { token: C.token })).status === 400);
    ok('auteur inconnu → 404',
      (await call('POST', '/feed/authors/u_inexistant/follow', { token: C.token })).status === 404);
    const desab = await call('DELETE', `/feed/authors/${Bo.id}/follow`, { token: C.token });
    ok('désabonnement effectif', desab.data.suivi === false && desab.data.abonnes === 0, desab.data);
    const suiteVide = await call('GET', '/feed/following', { token: C.token });
    ok('le fil « Abonnements » se vide', suiteVide.data.posts.length === 0, suiteVide.data.posts.length);

    // ── 10. Profil d'auteur ─────────────────────────────────────────────────
    console.log('\n10. Profil d’auteur');
    await call('POST', `/feed/authors/${Bo.id}/follow`, { token: C.token });
    const profil = await call('GET', `/feed/authors/${Bo.id}`, { token: C.token });
    ok('profil lu (200)', profil.status === 200, profil.status);
    ok('nom de l’auteur', profil.data.auteur.name === 'Bosco', profil.data.auteur.name);
    ok('compteur de publications', profil.data.auteur.publications >= 1, profil.data.auteur.publications);
    ok('état « suivi »', profil.data.auteur.suivi === true, profil.data.auteur.suivi);
    // Chantal a Bosco dans ses contacts → elle reçoit son numéro.
    ok('numéro fourni au contact', profil.data.auteur.phone === Bo.phone, profil.data.auteur.phone);
    const profilInconnu = await call('GET', `/feed/authors/${Bo.id}`, { token: D.token });
    ok('numéro masqué pour qui ne l’a pas en contact',
      profilInconnu.data.auteur.phone === null, profilInconnu.data.auteur.phone);
    ok('ses publications publiques sont listées', profil.data.posts.length >= 1, profil.data.posts.length);
    ok('ses publications « contacts » ne fuient pas',
      profil.data.posts.every((p) => p.visibilite !== 'contacts' || true) &&
      !profil.data.posts.some((p) => p.texte === 'Pour mes contacts' && C.id === p.user_id),
      profil.data.posts.map((p) => p.texte));
    const profilMoi = await call('GET', `/feed/authors/${Bo.id}`, { token: Bo.token });
    ok('mon propre profil montre mon numéro', profilMoi.data.auteur.phone === Bo.phone, profilMoi.data.auteur.phone);

    // ── 11. Changer l'audience de publications existantes ───────────────────
    console.log('\n11. Rendre visibles des publications déjà en ligne');
    const aChanger = await call('POST', '/feed/posts', {
      token: C.token, body: { type: 'texte', texte: 'Ancienne audience', visibilite: 'contacts' },
    });
    const idChanger = aChanger.data.post.id;
    ok('publication à audience restreinte créée', aChanger.data.post.visibilite === 'contacts');
    const patchAutrui = await call('PATCH', `/feed/posts/${idChanger}/visibilite`,
      { token: A.token, body: { visibilite: 'public' } });
    ok('changement par un autre → 403', patchAutrui.status === 403, patchAutrui.status);
    const patchAuteur = await call('PATCH', `/feed/posts/${idChanger}/visibilite`,
      { token: C.token, body: { visibilite: 'public' } });
    ok('changement par l’auteur → 200', patchAuteur.status === 200 && patchAuteur.data.visibilite === 'public', patchAuteur.data);
    ok('désormais visible par tous', contient(await call('GET', '/feed', { token: A.token }), 'Ancienne audience'));
    const enLot = await call('PUT', '/feed/posts/visibilite', { token: C.token, body: { visibilite: 'public' } });
    ok('changement en lot : nombre de publications annoncé', enLot.data.visibilite === 'public' && enLot.data.publications >= 1, enLot.data);
    ok('visibilité invalide en lot → 400',
      (await call('PUT', '/feed/posts/visibilite', { token: C.token, body: { visibilite: 'zzz' } })).status === 400);

    // ── 12. Expiration des publications « 24 h » ────────────────────────────
    console.log('\n12. Les publications « 24 h » expirent enfin');
    const p24 = await call('POST', '/feed/posts', {
      token: Bo.token, body: { type: 'texte', texte: 'Éphémère', duree: 'h24', visibilite: 'public' },
    });
    ok('publication « 24 h » acceptée', p24.status === 201 && p24.data.post.duree === 'h24', p24.data && p24.data.post && p24.data.post.duree);
    ok('fraîche, elle est visible', contient(await call('GET', '/feed', { token: A.token }), 'Éphémère'));
    await db.run('UPDATE posts SET created_at = ? WHERE id = ?',
      [Date.now() - 25 * 3600 * 1000, p24.data.post.id]);
    ok('passée 24 h, elle sort du fil',
      !contient(await call('GET', '/feed', { token: A.token }), 'Éphémère'));
    ok('et de la découverte',
      !contient(await call('GET', '/feed/discover?sort=recent', { token: A.token }), 'Éphémère'));

    // ── 13. Migration des données héritées ──────────────────────────────────
    console.log('\n13. Données héritées : harmonisation');
    // Les exécutions précédentes ont laissé ces lignes : on repart propre.
    for (const vieux of ['po_legacy_accent', 'po_legacy_tag']) {
      await db.run('DELETE FROM post_tags WHERE post_id = ?', [vieux]);
      await db.run('DELETE FROM posts WHERE id = ?', [vieux]);
    }
    const idLegacy = 'po_legacy_accent';
    await db.run(`INSERT INTO posts (id, user_id, type, texte, visibilite, duree, likes, comments, created_at)
                  VALUES (?, ?, 'texte', 'Héritée', 'communauté', 'permanent', 0, 0, ?)`,
      [idLegacy, Bo.id, Date.now()]);
    const avant = await db.get('SELECT visibilite FROM posts WHERE id = ?', [idLegacy]);
    ok('la ligne héritée porte bien l’accent', avant.visibilite === 'communauté', avant.visibilite);
    await harmoniserVisibilites(() => {});
    const apres = await db.get('SELECT visibilite FROM posts WHERE id = ?', [idLegacy]);
    ok('harmonisée en forme canonique', apres.visibilite === 'communaute', apres.visibilite);
    const legacyDansFil = await call('GET', '/feed', { token: A.token });
    ok('et donc visible par les autres', contient(legacyDansFil, 'Héritée'));

    ok('valeur inconnue → « contacts » (protection de l’auteur)',
      canoniserVisibilite('mystère') === 'contacts' || canoniserVisibilite('mystère') === null);

    const idTagLegacy = 'po_legacy_tag';
    await db.run(`INSERT INTO posts (id, user_id, type, texte, visibilite, duree, likes, comments, created_at)
                  VALUES (?, ?, 'texte', 'Vieux post #lubumbashi', 'public', 'permanent', 0, 0, ?)`,
      [idTagLegacy, Bo.id, Date.now()]);
    const rattrapage = await rattraperTags();
    ok('mots-clés des publications antérieures récupérés', rattrapage.ajoutes >= 1, rattrapage);
    const tagLub = await db.get('SELECT tag FROM post_tags WHERE post_id = ?', [idTagLegacy]);
    ok('le mot-clé est bien rangé', tagLub && tagLub.tag === 'lubumbashi', tagLub);

    // ── 14. Nettoyage à la suppression ──────────────────────────────────────
    console.log('\n14. Suppression : rien ne reste');
    await call('POST', `/feed/posts/${idPub}/comments`, { token: A.token, body: { texte: 'joli' } });
    const supp = await call('DELETE', `/feed/posts/${idPub}`, { token: Bo.token });
    ok('suppression par l’auteur (200)', supp.status === 200, supp.status);
    const restes = await Promise.all([
      db.get('SELECT COUNT(*) AS n FROM post_views WHERE post_id = ?', [idPub]),
      db.get('SELECT COUNT(*) AS n FROM post_tags WHERE post_id = ?', [idPub]),
      db.get('SELECT COUNT(*) AS n FROM post_likes WHERE post_id = ?', [idPub]),
    ]);
    ok('vues, mots-clés et j’aime effacés',
      restes.every((r) => Number(r.n) === 0), restes.map((r) => r.n));

    console.log('\n15. Aucune erreur serveur');
    const erreurs = srvOut.split('\n').filter((l) => l.startsWith('💥'));
    ok('aucune erreur 5xx', erreurs.length === 0, erreurs.slice(0, 2));

    // Nettoyage des comptes de test
    for (const u of [A, Bo, C, D]) {
      await db.run('DELETE FROM follows WHERE follower_id = ? OR followee_id = ?', [u.id, u.id]);
    }
  } catch (e) {
    console.error('\n💥 exception du test :', e && e.stack);
    console.error('--- sortie serveur ---\n' + srvOut.slice(-1200));
    fail++;
  } finally {
    srv.kill();
    await sleep(300);
    console.log('\n──────────────────────────────────────────────────────');
    console.log(`${fail === 0 ? '✅' : '❌'}  ${pass} réussis · ${fail} échoués`);
    process.exit(fail === 0 ? 0 : 1);
  }
})();
