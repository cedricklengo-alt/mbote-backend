/**
 * HASHTAGS ET MENTIONS — tests de bout en bout.
 *
 * Ce que l'on vérifie, dans l'ordre du parcours réel :
 *   - un compte reçoit un identifiant public (@pseudo) ;
 *   - écrire « #MboteCall … @cedrick » produit les bons hashtags et la bonne
 *     mention, et RIEN de plus (pas d'auto-mention, pas de doublon) ;
 *   - la personne mentionnée reçoit une notification, dans l'application ;
 *   - la page du hashtag compte, abonne et trie ;
 *   - suivre un hashtag change le fil ;
 *   - la recherche universelle trouve par #, par @ et par texte, sans jamais
 *     franchir la visibilité ;
 *   - les limites anti-abus tiennent (10 hashtags, 10 mentions, plafond horaire).
 *
 * Lancement :  node test/social.test.js
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const PORT = 4802;
const B = `http://127.0.0.1:${PORT}/api`;

let pass = 0, fail = 0;
const ok = (label, cond, detail) => {
  if (cond) { console.log(`  ✓ ${label}`); pass++; }
  else { console.log(`  ✗ ${label}${detail !== undefined ? ' → ' + JSON.stringify(detail) : ''}`); fail++; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, p, { token, body, raw } = {}) {
  const h = { 'Content-Type': 'application/json' };
  if (token) h.Authorization = `Bearer ${token}`;
  const r = await fetch(B + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await r.json(); } catch { data = null; }
  return raw ? { status: r.status, data, texte: JSON.stringify(data) } : { status: r.status, data };
}

async function login(phone, name) {
  const a = await call('POST', '/auth/request-otp', { body: { phone } });
  const b = await call('POST', '/auth/verify-otp',
    { body: { phone, code: a.data.demo_code, name } });
  return { token: b.data.token, id: b.data.user.id, handle: b.data.user.handle, name };
}

(async () => {
  // La base n'est PAS effacée : ce test tourne au milieu de la suite, et les
  // autres suites comptent sur les tarifs et les données du seed. On utilise
  // donc des comptes neufs à chaque exécution, dérivés de l'horloge.
  const suffixe = String(Date.now()).slice(-7);
  const tel = (n) => `+2437${suffixe}${n}`;

  const srv = spawn('node', ['src/server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env, PORT: String(PORT), JWT_SECRET: 'test-social', DEMO_MODE: 'true',
      PUSH_DEBUG_FAKE: 'true', DATABASE_URL: '', PUBLIC_URL: `http://127.0.0.1:${PORT}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let srvOut = '';
  srv.stdout.on('data', (d) => { srvOut += d; });
  srv.stderr.on('data', (d) => { srvOut += d; });

  let up = false;
  for (let i = 0; i < 60; i++) {
    await sleep(300);
    try { const r = await fetch(`${B}/health`); if (r.ok) { up = true; break; } } catch { /* pas encore */ }
  }
  if (!up) { console.error('serveur non démarré\n' + srvOut); srv.kill(); process.exit(1); }

  try {
    const cedrick = await login(tel('01'), 'Cédrick Lengo');
    const patrick = await login(tel('02'), 'Patrick Mbala');
    const junior = await login(tel('03'), 'Junior Kasa');

    // ── 1. Identifiant public ───────────────────────────────────────────────
    console.log('1. Identifiant public (@pseudo)');
    ok('attribué à la connexion', !!cedrick.handle, cedrick.handle);
    // La base survit d'une exécution à l'autre : un suffixe numérique est
    // normal quand « cedricklengo » est déjà pris. Ce qui compte, c'est que
    // l'identifiant soit dérivé du nom, sans accent ni espace.
    ok('dérivé du nom', /^cedricklengo\d*$/.test(cedrick.handle || ''), cedrick.handle);
    ok('unique : deux noms voisins ne se marchent pas dessus',
      patrick.handle !== junior.handle && patrick.handle !== cedrick.handle,
      [cedrick.handle, patrick.handle, junior.handle]);
    const me = await call('GET', '/auth/me', { token: patrick.token });
    ok('exposé par /auth/me', !!me.data.user.handle, me.data.user.handle);

    // ── 2. Écriture : hashtags et mentions ─────────────────────────────────
    console.log('\n2. Détection à l’écriture');
    const cree = await call('POST', '/feed/posts', {
      token: cedrick.token,
      body: {
        type: 'texte',
        texte: `Bienvenue sur #MboteCall à #Kinshasa ! Merci @${patrick.handle} et @${junior.handle} #RDC`,
        visibilite: 'public',
        ville: 'Kinshasa',
      },
    });
    const post = cree.data.post;
    ok('publication créée', cree.status === 201, cree.status);
    ok('hashtags extraits', JSON.stringify(post.tags.sort()) === JSON.stringify(['kinshasa', 'mbotecall', 'rdc']), post.tags);
    ok('deux mentions résolues', (post.mentions || []).length === 2, post.mentions);
    ok('mention → identifiant et nom',
      post.mentions.some((m) => m.handle === patrick.handle && m.name === 'Patrick Mbala'), post.mentions);
    ok('compte-rendu du serveur', cree.data.social && cree.data.social.mentions === 2, cree.data.social);

    // Auto-mention : jamais notifiée, jamais enregistrée.
    const auto = await call('POST', '/feed/posts', {
      token: cedrick.token,
      body: { type: 'texte', texte: `Test @${cedrick.handle} #MboteCall`, visibilite: 'public' },
    });
    ok('auto-mention ignorée', (auto.data.post.mentions || []).length === 0, auto.data.post.mentions);

    // Adresse électronique : pas une mention.
    const mail = await call('POST', '/feed/posts', {
      token: cedrick.token,
      body: { type: 'texte', texte: 'Écris à contact@mbote.cd pour la suite', visibilite: 'public' },
    });
    ok('une adresse électronique n’est pas une mention',
      (mail.data.post.mentions || []).length === 0, mail.data.post.mentions);

    // ── 3. Notifications ───────────────────────────────────────────────────
    console.log('\n3. Notification de mention');
    const notifs = await call('GET', '/notifications', { token: patrick.token });
    ok('notification reçue', notifs.data.notifications.length >= 1, notifs.data.notifications.length);
    const n1 = notifs.data.notifications[0];
    ok('type mention', n1 && n1.type === 'mention', n1 && n1.type);
    ok('expéditeur renseigné', n1 && n1.expediteur && n1.expediteur.id === cedrick.id, n1 && n1.expediteur);
    ok('publication visée', n1 && n1.post_id === post.id, n1 && n1.post_id);
    ok('texte d’aperçu', n1 && n1.texte.includes('Bienvenue'), n1 && n1.texte);
    ok('compteur de non-lues', notifs.data.non_lues >= 1, notifs.data.non_lues);

    const pasDeNotif = await call('GET', '/notifications', { token: cedrick.token });
    ok('l’auteur n’est pas notifié de sa propre mention',
      pasDeNotif.data.notifications.length === 0, pasDeNotif.data.notifications.length);

    const badge = await call('GET', '/notifications/count', { token: patrick.token });
    ok('badge de l’en-tête', badge.data.non_lues >= 1, badge.data.non_lues);

    // Doublon : la même personne mentionnée deux fois ⇒ une seule notification.
    await call('POST', '/feed/posts', {
      token: cedrick.token,
      body: { type: 'texte', texte: `Merci @${patrick.handle} @${patrick.handle}`, visibilite: 'public' },
    });
    const apres = await call('GET', '/notifications', { token: patrick.token });
    const pourCePost = apres.data.notifications.filter(
      (n) => n.post_id !== post.id && n.type === 'mention');
    ok('mention répétée ⇒ une seule notification', pourCePost.length === 1, pourCePost.length);

    const lues = await call('POST', '/notifications/lues', { token: patrick.token });
    ok('tout marquer comme lu', lues.data.non_lues === 0, lues.data);

    // ── 4. Suggestions ─────────────────────────────────────────────────────
    console.log('\n4. Suggestions pendant la frappe');
    const suggTag = await call('GET', '/feed/tags/suggest?q=mbot', { token: junior.token });
    ok('hashtag proposé par préfixe',
      suggTag.data.tags.some((t) => t.tag === 'mbotecall'), suggTag.data.tags);
    ok('volume de publications joint',
      suggTag.data.tags.every((t) => typeof t.publications === 'number'), suggTag.data.tags[0]);

    // Requête sur le pseudo COMPLET : la recherche travaille par préfixe, et
    // la base de travail garde les comptes des exécutions précédentes
    // (« patrickilunga2 », « patrickilunga3 »…) qui saturent la liste.
    const suggMentions = await call('GET', `/feed/mentions/suggest?q=${patrick.handle}`,
      { token: junior.token });
    ok('personne proposée par identifiant',
      suggMentions.data.personnes.some((p) => p.handle === patrick.handle), suggMentions.data.personnes);
    const suggMentionsNom = await call('GET', '/feed/mentions/suggest?q=Patrick', { token: junior.token });
    ok('personne proposée par nom',
      suggMentionsNom.data.personnes.some((p) => p.name === 'Patrick Mbala'), suggMentionsNom.data.personnes);

    const assiste = await call('GET', '/feed/suggestions?texte=Concert%20de%20musique%20%C3%A0%20Kinshasa',
      { token: junior.token });
    ok('suggestions assistées répondent', Array.isArray(assiste.data.hashtags), assiste.data);
    ok('mode modèle annoncé', typeof assiste.data.modele === 'boolean', assiste.data.modele);

    // ── 5. Page du hashtag ─────────────────────────────────────────────────
    console.log('\n5. Page #MboteCall');
    const page = await call('GET', '/feed/tags/MboteCall', { token: junior.token });
    ok('page servie', page.status === 200, page.status);
    ok('nombre de publications', page.data.publications >= 2, page.data.publications);
    ok('nombre d’abonnés', typeof page.data.abonnes === 'number', page.data.abonnes);
    ok('non suivi au départ', page.data.suivi === 0, page.data.suivi);
    ok('publications listées', page.data.posts.length >= 2, page.data.posts.length);

    const pageVideo = await call('GET', '/feed/tags/MboteCall?tri=videos', { token: junior.token });
    ok('onglet Vidéos filtré',
      pageVideo.data.posts.every((p) => p.type === 'clip'), pageVideo.data.posts.map((p) => p.type));

    // ── 6. Suivre un hashtag ───────────────────────────────────────────────
    console.log('\n6. Suivre #MboteCall');
    const suivi = await call('POST', '/feed/tags/MboteCall/follow', { token: junior.token });
    ok('abonnement enregistré', suivi.data.suivi === 1, suivi.data.suivi);
    ok('compteur d’abonnés incrémenté', suivi.data.abonnes >= 1, suivi.data.abonnes);
    ok('idempotent', (await call('POST', '/feed/tags/MboteCall/follow', { token: junior.token })).data.abonnes === suivi.data.abonnes);

    const mesTags = await call('GET', '/feed/tags/followed', { token: junior.token });
    ok('liste des hashtags suivis',
      mesTags.data.tags.some((t) => t.tag === 'mbotecall'), mesTags.data.tags.map((t) => t.tag));

    const fil = await call('GET', '/feed', { token: junior.token });
    const vu = fil.data.posts.find((p) => p.id === post.id);
    ok('le fil signale les hashtags suivis',
      vu && Array.isArray(vu.tags_suivis) && vu.tags_suivis.includes('mbotecall'),
      vu && vu.tags_suivis);
    ok('le fil renvoie aussi les mentions',
      vu && Array.isArray(vu.mentions), vu && vu.mentions);

    const pourtoi = await call('GET', '/feed/pourtoi', { token: junior.token });
    ok('fil personnalisé servi', Array.isArray(pourtoi.data.posts) && pourtoi.data.posts.length > 0);
    ok('abonnements rappelés', pourtoi.data.abonnements.hashtags >= 1, pourtoi.data.abonnements);
    const p1 = pourtoi.data.posts.find((p) => p.id === post.id);
    ok('la raison du classement est expliquée',
      p1 && (p1.raison === 'hashtag:mbotecall' || p1.raison === null), p1 && p1.raison);

    const desabonne = await call('DELETE', '/feed/tags/MboteCall/follow', { token: junior.token });
    ok('désabonnement', desabonne.data.suivi === 0, desabonne.data.suivi);

    // ── 7. Tendances ───────────────────────────────────────────────────────
    console.log('\n7. Tendances');
    const tend = await call('GET', '/feed/tendances', { token: cedrick.token });
    ok('tendances servies', Array.isArray(tend.data.tags) && tend.data.tags.length >= 1, tend.data.tags.length);
    ok('#MboteCall présent', tend.data.tags.some((t) => t.tag === 'mbotecall'), tend.data.tags.map((t) => t.tag));
    ok('score de tendance calculé',
      tend.data.tags.every((t) => typeof t.score === 'number'), tend.data.tags[0]);
    ok('croissance exposée',
      tend.data.tags.every((t) => typeof t.croissance === 'number'), tend.data.tags[0]);

    const geo = await call('GET', '/feed/tendances?ville=kinshasa', { token: cedrick.token });
    ok('hashtags géographiques filtrés',
      geo.data.tags.every((t) => t.tag.includes('kinshasa')), geo.data.tags.map((t) => t.tag));

    // ── 8. Mentions dans commentaires et statuts ────────────────────────────
    console.log('\n8. Mentions dans les commentaires et les statuts');
    const com = await call('POST', `/feed/posts/${post.id}/comments`, {
      token: patrick.token,
      body: { texte: `Merci @${junior.handle} pour l’info #Kinshasa` },
    });
    ok('commentaire créé', com.status === 201, com.status);
    ok('mention du commentaire renvoyée',
      (com.data.comment.mentions || []).some((m) => m.handle === junior.handle), com.data.comment.mentions);

    const notifsJunior = await call('GET', '/notifications', { token: junior.token });
    const notifCom = notifsJunior.data.notifications.find((n) => n.source_type === 'comment');
    ok('notification de commentaire', !!notifCom, notifsJunior.data.notifications.map((n) => n.source_type));

    const statut = await call('POST', '/feed/stories', {
      token: patrick.token,
      body: { texte: `Statut du jour @${junior.handle} #Kinshasa` },
    });
    ok('statut accepté', statut.status === 201, statut.status);
    ok('hashtags du statut', Array.isArray(statut.data.story.tags) && statut.data.story.tags.includes('kinshasa'),
      statut.data.story.tags);
    const notifsJunior2 = await call('GET', '/notifications', { token: junior.token });
    ok('notification de statut',
      notifsJunior2.data.notifications.some((n) => n.source_type === 'story'),
      notifsJunior2.data.notifications.map((n) => n.source_type));

    // ── 9. Recherche universelle ───────────────────────────────────────────
    console.log('\n9. Recherche universelle');
    const rechTag = await call('GET', '/search?q=%23Mbote', { token: junior.token });
    ok('portée hashtag détectée', rechTag.data.portee === 'hashtags', rechTag.data.portee);
    ok('hashtag trouvé', rechTag.data.hashtags.some((h) => h.tag === 'mbotecall'), rechTag.data.hashtags);

    const rechMention = await call('GET', `/search?q=%40${patrick.handle}`, { token: junior.token });
    ok('portée personne détectée', rechMention.data.portee === 'personnes', rechMention.data.portee);
    ok('personne trouvée',
      rechMention.data.personnes.some((p) => p.handle === patrick.handle), rechMention.data.personnes);

    const rechTexte = await call('GET', '/search?q=Bienvenue', { token: junior.token });
    ok('publication trouvée par son texte',
      rechTexte.data.publications.some((p) => p.id === post.id), rechTexte.data.publications.map((p) => p.id));

    const sugg = await call('GET', '/search/suggestions?q=Pat', { token: junior.token });
    ok('amorce de la barre de recherche',
      sugg.data.elements.some((e) => e.type === 'personne'), sugg.data.elements);

    // Visibilité : une publication réservée aux contacts ne ressort pas.
    const prive = await call('POST', '/feed/posts', {
      token: cedrick.token,
      body: { type: 'texte', texte: 'Confidentiel secretdentaire #Kinshasa', visibilite: 'contacts' },
    });
    const rechPrive = await call('GET', '/search?q=secretdentaire', { token: junior.token });
    ok('une publication privée reste invisible à la recherche',
      !rechPrive.data.publications.some((p) => p.id === prive.data.post.id),
      rechPrive.data.publications.map((p) => p.id));

    // ── 10. Analytique des mentions ────────────────────────────────────────
    console.log('\n10. Analytique');
    const ana = await call('GET', '/feed/mentions/analytique', { token: junior.token });
    ok('mentions reçues', ana.data.recues >= 2, ana.data.recues);
    ok('mentions envoyées', typeof ana.data.envoyees === 'number', ana.data.envoyees);
    ok('portée exposée', ana.data.portee && typeof ana.data.portee.vues === 'number', ana.data.portee);

    // ── 11. Limites anti-abus ──────────────────────────────────────────────
    console.log('\n11. Limites anti-abus');
    const beaucoupTags = Array.from({ length: 16 }, (_, i) => `#tag${i + 100}`).join(' ');
    const flood = await call('POST', '/feed/posts', {
      token: cedrick.token,
      body: { type: 'texte', texte: `Trop de tags ${beaucoupTags}`, visibilite: 'public' },
    });
    ok('au plus 10 hashtags conservés', flood.data.post.tags.length <= 10, flood.data.post.tags.length);

    // Plafond horaire : la 11e notification de mention à la même personne est ignorée.
    let dernier = null;
    for (let i = 0; i < 12; i++) {
      dernier = await call('POST', '/feed/posts', {
        token: cedrick.token,
        body: { type: 'texte', texte: `Rappel ${i} @${patrick.handle}`, visibilite: 'public' },
      });
    }
    const notifsPatrick = await call('GET', '/notifications?limite=100', { token: patrick.token });
    const mentionsPatrick = notifsPatrick.data.notifications.filter((n) => n.type === 'mention');
    ok('plafond horaire respecté (≤ 10)',
      mentionsPatrick.length <= 10, mentionsPatrick.length);
    ok('le dernier contenu est publié malgré le plafond',
      dernier.status === 201, dernier.status);

    // ── 12. Rien n'est cassé ───────────────────────────────────────────────
    console.log('\n12. Le reste du fil fonctionne toujours');
    const sante = await call('GET', '/health');
    ok('santé du serveur', sante.status === 200, sante.status);
    const decouv = await call('GET', '/feed/discover?sort=recent', { token: junior.token });
    ok('découverte publique', decouv.status === 200, decouv.status);
    const like = await call('POST', `/feed/posts/${post.id}/like`, { token: junior.token });
    ok('j’aime', like.status === 200, like.status);
    const share = await call('POST', `/feed/posts/${post.id}/share`, { token: junior.token });
    ok('partage', share.status === 200, share.status);
  } finally {
    srv.kill();
    const erreurs = (srvOut.match(/Error|Unhandled|TypeError/g) || []).length;
    console.log('\n13. Journal du serveur');
    ok('aucune erreur serveur', erreurs === 0, srvOut.split('\n').filter((l) => /Error|TypeError/.test(l)).slice(0, 3));

    console.log(`\n${'─'.repeat(54)}`);
    console.log(fail === 0 ? `✅  ${pass} réussis · 0 échoué` : `❌  ${pass} réussis · ${fail} échoués`);
    process.exit(fail === 0 ? 0 : 1);
  }
})().catch((e) => { console.error(e); process.exit(1); });
