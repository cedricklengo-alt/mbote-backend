/**
 * NOTIFICATIONS D'INTERACTION — tests de bout en bout.
 *
 * Parcours réel, dans l'ordre où un utilisateur le vit :
 *   - A publie ; B aime → A reçoit « B a aimé votre publication » ;
 *   - B retire son j'aime → la notification disparaît (pas de « X a aimé »
 *     fantôme) ;
 *   - B aime, retire, aime dix fois → UNE seule notification, un seul auteur ;
 *   - C aime aussi → la même ligne grossit : « B, C et 1 autre personne » ;
 *   - A aime sa propre publication → rien (jamais d'auto-notification) ;
 *   - B commente → A est notifié ; A répond à B → B reçoit une réponse ;
 *   - une réponse ne notifie pas deux fois la même personne ;
 *   - B partage → A reçoit « a partagé » ; un anonyme ne notifie personne ;
 *   - une mention produit toujours une notification (fabrique unique) ;
 *   - le badge suit : /count, marquage global, marquage unitaire ;
 *   - supprimer la publication efface les notifications qui la visaient ;
 *   - l'analytique d'engagement compte likes, commentaires, partages.
 *
 * Lancement :  node test/notifs.test.js
 */
const { spawn } = require('child_process');
const path = require('path');

const PORT = 4804;
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
  try { data = await r.json(); } catch { data = null; }
  return { status: r.status, data };
}

async function login(phone, name) {
  const a = await call('POST', '/auth/request-otp', { body: { phone } });
  const b = await call('POST', '/auth/verify-otp',
    { body: { phone, code: a.data.demo_code, name } });
  return { token: b.data.token, id: b.data.user.id, handle: b.data.user.handle, name };
}

const notifsDe = async (u, q = '') => (await call('GET', `/notifications${q}`, { token: u.token })).data;

(async () => {
  const suffixe = String(Date.now()).slice(-7);
  const tel = (n) => `+2438${suffixe}${n}`;

  const srv = spawn('node', ['src/server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env, PORT: String(PORT), JWT_SECRET: 'test-notifs', DEMO_MODE: 'true',
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
  if (!up) {
    console.log('Serveur non démarré :\n' + srvOut.slice(-2000));
    srv.kill('SIGKILL');
    process.exit(1);
  }

  try {
    console.log('\n── Comptes ───────────────────────────────────────────────');
    const A = await login(tel('01'), 'Aline Mbala');
    const B = await login(tel('02'), 'Patrick Ilunga');
    const C = await login(tel('03'), 'Junior Kasongo');
    ok('trois comptes créés', !!(A.token && B.token && C.token));

    console.log('\n── J’aime ───────────────────────────────────────────────');
    const pub = await call('POST', '/feed/posts', {
      token: A.token,
      body: { texte: 'Le fleuve monte ce matin à Kinshasa #Fleuve', type: 'texte' },
    });
    const postId = pub.data.post && pub.data.post.id;
    ok('Aline publie', !!postId, pub.data);

    let like = await call('POST', `/feed/posts/${postId}/like`, { token: B.token });
    ok('Patrick aime', like.data.liked === true && like.data.likes === 1, like.data);

    let boiteA = await notifsDe(A);
    const likeNotif = (boiteA.notifications || []).find((n) => n.type === 'post_like');
    ok('Aline reçoit une notification de j’aime', !!likeNotif);
    ok('le message nomme Patrick',
      !!likeNotif && /Patrick Ilunga a aimé votre publication/.test(likeNotif.message),
      likeNotif && likeNotif.message);
    ok('la notification porte la publication', likeNotif && String(likeNotif.post_id) === String(postId));
    ok('la notification est non lue', likeNotif && likeNotif.lu === 0);
    ok('le badge compte 1', boiteA.non_lues === 1, boiteA.non_lues);

    // Retrait : la notification doit disparaître.
    await call('POST', `/feed/posts/${postId}/like`, { token: B.token });
    boiteA = await notifsDe(A);
    ok('j’aime retiré → plus de notification',
      !(boiteA.notifications || []).some((n) => n.type === 'post_like'),
      boiteA.notifications);

    // Dix allers-retours : une seule notification, un seul auteur.
    for (let i = 0; i < 10; i++) {
      await call('POST', `/feed/posts/${postId}/like`, { token: B.token });
      if (i < 9) await call('POST', `/feed/posts/${postId}/like`, { token: B.token });
    }
    boiteA = await notifsDe(A);
    const apresSpam = (boiteA.notifications || []).filter((n) => n.type === 'post_like');
    ok('dix j’aime → une seule ligne', apresSpam.length === 1, apresSpam.length);
    ok('un seul auteur compté', apresSpam[0] && apresSpam[0].nb_acteurs === 1,
      apresSpam[0] && apresSpam[0].nb_acteurs);

    // Regroupement.
    await call('POST', `/feed/posts/${postId}/like`, { token: C.token });
    boiteA = await notifsDe(A);
    const groupe = (boiteA.notifications || []).find((n) => n.type === 'post_like');
    ok('deux auteurs → une ligne groupée', groupe && groupe.nb_acteurs === 2, groupe && groupe.nb_acteurs);
    ok('le message annonce plusieurs personnes',
      groupe && /ont aimé votre publication/.test(groupe.message), groupe && groupe.message);
    ok('les auteurs sont listés', groupe && Array.isArray(groupe.acteurs) && groupe.acteurs.length === 2,
      groupe && groupe.acteurs);

    // Auto-notification interdite.
    const avantAuto = (await notifsDe(A)).notifications.filter((n) => n.type === 'post_like')[0].nb_acteurs;
    await call('POST', `/feed/posts/${postId}/like`, { token: A.token });
    const apresAuto = (await notifsDe(A)).notifications.filter((n) => n.type === 'post_like')[0];
    ok('Aline qui aime sa publication ne se notifie pas',
      apresAuto.nb_acteurs === avantAuto, { avant: avantAuto, apres: apresAuto.nb_acteurs });
    await call('POST', `/feed/posts/${postId}/like`, { token: A.token }); // on remet à zéro

    console.log('\n── Commentaires et réponses ─────────────────────────────');
    const c1 = await call('POST', `/feed/posts/${postId}/comments`, {
      token: B.token, body: { texte: 'Superbe photo du fleuve !' },
    });
    ok('Patrick commente', c1.status === 201 && !!c1.data.comment.id, c1.data);
    const cmId = c1.data.comment.id;

    boiteA = await notifsDe(A);
    const comNotif = (boiteA.notifications || []).find((n) => n.type === 'comment');
    ok('Aline reçoit le commentaire', !!comNotif);
    ok('le message porte le nom de Patrick',
      comNotif && /Patrick Ilunga a commenté/.test(comNotif.message), comNotif && comNotif.message);
    ok('la notification pointe le commentaire pour s’y positionner',
      comNotif && String(comNotif.comment_id) === String(cmId), comNotif && comNotif.comment_id);
    ok('un aperçu du texte accompagne', comNotif && /fleuve/.test(comNotif.texte || ''));

    // Réponse d'Aline au commentaire de Patrick.
    const c2 = await call('POST', `/feed/posts/${postId}/comments`, {
      token: A.token, body: { texte: 'Merci Patrick !', parent_id: cmId },
    });
    ok('réponse acceptée', c2.status === 201, c2.data);
    ok('la réponse porte parent_id',
      c2.data.comment && String(c2.data.comment.parent_id) === String(cmId), c2.data.comment);

    const boiteB = await notifsDe(B);
    const reponseNotif = (boiteB.notifications || []).find((n) => n.type === 'comment_reply');
    ok('Patrick reçoit la réponse', !!reponseNotif);
    ok('le message dit « a répondu à votre commentaire »',
      reponseNotif && /a répondu à votre commentaire/.test(reponseNotif.message),
      reponseNotif && reponseNotif.message);
    ok('Aline n’est pas notifiée de son propre commentaire',
      !(await notifsDe(A)).notifications.some(
        (n) => n.type === 'comment' && String(n.comment_id) === String(c2.data.comment.id)));

    // Le parent doit appartenir à la publication.
    const autre = await call('POST', '/feed/posts', {
      token: C.token, body: { texte: 'Autre publication #Kin', type: 'texte' },
    });
    const mauvaisParent = await call('POST', `/feed/posts/${autre.data.post.id}/comments`, {
      token: A.token, body: { texte: 'réponse volante', parent_id: cmId },
    });
    ok('répondre à un commentaire d’une autre publication est refusé',
      mauvaisParent.status === 400, mauvaisParent.status);

    // La liste des commentaires expose les réponses.
    const liste = await call('GET', `/feed/posts/${postId}/comments`, { token: A.token });
    const rep = (liste.data.comments || []).find((c) => String(c.id) === String(c2.data.comment.id));
    ok('la liste des commentaires expose parent_id', rep && String(rep.parent_id) === String(cmId));

    console.log('\n── Partages ─────────────────────────────────────────────');
    const part = await call('POST', `/feed/posts/${postId}/share`, { token: C.token });
    ok('Junior partage', part.data && part.data.partages >= 1, part.data);
    boiteA = await notifsDe(A);
    const partNotif = (boiteA.notifications || []).find((n) => n.type === 'share');
    ok('Aline est notifiée du partage', !!partNotif);
    ok('le message dit « a partagé votre publication »',
      partNotif && /a partagé votre publication/.test(partNotif.message),
      partNotif && partNotif.message);

    // Un visiteur non connecté ne produit pas de notification nominative.
    const avant = (await notifsDe(A)).notifications.filter((n) => n.type === 'share')[0].nb_acteurs;
    await call('POST', `/feed/posts/${postId}/share`, {});
    const apres = (await notifsDe(A)).notifications.filter((n) => n.type === 'share')[0].nb_acteurs;
    ok('partage anonyme : compteur sans nouvelle notification', apres === avant, { avant, apres });

    console.log('\n── Mentions ─────────────────────────────────────────────');
    const mention = await call('POST', '/feed/posts', {
      token: B.token,
      body: { texte: `Merci @${A.handle} pour cette photo`, type: 'texte' },
    });
    ok('publication avec mention créée', !!mention.data.post, mention.data);
    boiteA = await notifsDe(A);
    const mentionNotif = (boiteA.notifications || []).find((n) => n.type === 'mention');
    ok('la mention notifie par la fabrique unique', !!mentionNotif);
    ok('le message de mention est cohérent',
      mentionNotif && /vous a mentionné/.test(mentionNotif.message),
      mentionNotif && mentionNotif.message);

    console.log('\n── Badge et lecture ─────────────────────────────────────');
    const compte = await call('GET', '/notifications/count', { token: A.token });
    ok('le badge renvoie un nombre', typeof compte.data.non_lues === 'number' && compte.data.non_lues > 0,
      compte.data);

    const uneSeule = (await notifsDe(A)).notifications[0];
    const lue = await call('POST', `/notifications/${uneSeule.id}/lue`, { token: A.token });
    ok('marquer une notification comme lue', lue.status === 200, lue.status);
    const apresUne = await call('GET', '/notifications/count', { token: A.token });
    ok('le badge diminue de 1', apresUne.data.non_lues === compte.data.non_lues - 1,
      { avant: compte.data.non_lues, apres: apresUne.data.non_lues });

    const toutes = await call('POST', '/notifications/lues', { token: A.token });
    ok('marquer tout comme lu', toutes.data.non_lues === 0, toutes.data);

    const filtre = await call('GET', '/notifications?non_lues=1', { token: A.token });
    ok('filtre non lues vide', (filtre.data.notifications || []).length === 0, filtre.data);

    const page = await call('GET', '/notifications?limite=2', { token: A.token });
    ok('pagination par curseur', (page.data.notifications || []).length === 2 && !!page.data.next,
      { n: (page.data.notifications || []).length, next: page.data.next });

    const intrusion = await call('POST', `/notifications/${uneSeule.id}/lue`, { token: B.token });
    ok('on ne peut pas marquer la notification d’un autre', intrusion.status === 404, intrusion.status);

    console.log('\n── Analytique d’engagement ──────────────────────────────');
    const stats = await call('GET', '/feed/analytique', { token: A.token });
    const e = (stats.data && stats.data.engagement) || {};
    ok('les interactions sont comptées', e.likes >= 2 && e.commentaires >= 2 && e.partages >= 2,
      { likes: e.likes, commentaires: e.commentaires, partages: e.partages });
    ok('le taux d’engagement est calculé', typeof e.taux === 'number' && e.taux >= 0, e.taux);
    ok('les publications populaires sont classées',
      Array.isArray(e.top) && e.top.length >= 1 && typeof e.top[0].score === 'number', e.top && e.top[0]);
    ok('les notifications reçues sont comptées', e.notifications >= 3, e.notifications);
    ok('les mentions reçues restent disponibles', stats.data.mentions.recues >= 1, stats.data.mentions);

    console.log('\n── Suppression de la publication ────────────────────────');
    const supp = await call('DELETE', `/feed/posts/${postId}`, { token: A.token });
    ok('publication supprimée', supp.status === 200 || supp.status === 204, supp.status);
    boiteA = await notifsDe(A);
    ok('les notifications de cette publication disparaissent',
      !(boiteA.notifications || []).some((n) => String(n.post_id) === String(postId)),
      boiteA.notifications);
  } catch (err) {
    console.log('\nErreur de test : ' + (err && err.stack || err));
    fail++;
  } finally {
    srv.kill('SIGKILL');
  }

  console.log(`\n${pass} réussis · ${fail} échoués`);
  process.exit(fail ? 1 : 0);
})();
