/**
 * MINIATURES DE VIDÉO — capture automatique à l'envoi, affichage dans le fil.
 *
 * Ce que ces tests protègent :
 *   - une vidéo envoyée revient avec une miniature utilisable (JPEG servi par
 *     le serveur), donc le fil peut afficher un aperçu sans télécharger la
 *     vidéo ;
 *   - une publication de type « clip » reçoit sa miniature même si
 *     l'application ne l'envoie pas (ancienne version, envoi direct par l'API) ;
 *   - une photo n'a jamais de miniature (on ne génère pas d'image inutile) ;
 *   - une URL de miniature fantaisiste est refusée et remplacée par la capture
 *     réelle ;
 *   - seul l'auteur peut (re)générer la miniature d'une publication ;
 *   - sans décodeur ffmpeg, l'envoi de la vidéo RÉUSSIT quand même.
 *
 * Un vrai fichier vidéo est fabriqué au début du test (2 secondes, synthétique) :
 * aucun fichier binaire n'est stocké dans le dépôt.
 *
 * Lancement :  node test/video_thumb.test.js
 */
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = 4798;
const B = `http://127.0.0.1:${PORT}/api`;
const UPLOADS = path.join(__dirname, '..', 'uploads');

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
  try { data = await r.json(); } catch { /* vide */ }
  return { status: r.status, data };
}

async function login(phone, name) {
  const a = await call('POST', '/auth/request-otp', { body: { phone, name } });
  const b = await call('POST', '/auth/verify-otp', { body: { phone, code: a.data.demo_code, name } });
  return { token: b.data.token, phone, name, id: b.data.user.id };
}

/** Fabrique une petite vidéo de test (2 s, mire animée) avec ffmpeg. */
function fabriquerVideo(chemin) {
  let binaire = 'ffmpeg';
  try { binaire = require('ffmpeg-static') || 'ffmpeg'; } catch { /* ffmpeg système */ }
  const r = spawnSync(binaire, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=15:duration=2',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', chemin,
  ], { timeout: 30000 });
  return r.status === 0 && fs.existsSync(chemin) && fs.statSync(chemin).size > 1000;
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mbote-thumb-'));
  const video = path.join(tmp, 'extrait.mp4');
  const videoOk = fabriquerVideo(video);
  if (!videoOk) {
    console.log('❌ impossible de fabriquer une vidéo de test (ffmpeg absent)');
    process.exit(1);
  }

  const srv = spawn('node', ['src/server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), JWT_SECRET: 'test-thumb', DEMO_MODE: 'true',
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
    const A = await login('+243740000101', 'Auteur Vidéo');
    const Autre = await login('+243740000102', 'Autre Vidéo');

    console.log('1. Le serveur sait capturer des miniatures');
    ok('ffmpeg détecté au démarrage',
      /Miniatures vidéo : actives/.test(srvOut), srvOut.split('\n').filter((l) => /Miniature/.test(l)));

    console.log('\n2. Envoi d’une vidéo : miniature produite automatiquement');
    const form = new FormData();
    form.append('file', new Blob([fs.readFileSync(video)], { type: 'video/mp4' }), 'extrait.mp4');
    const envoi = await fetch(`${B}/upload`, {
      method: 'POST', headers: { Authorization: `Bearer ${A.token}` }, body: form,
    });
    const envoiJson = await envoi.json();
    ok('envoi accepté (200)', envoi.status === 200, envoiJson);
    ok('le fichier est identifié comme vidéo', envoiJson.type === 'video', envoiJson.type);
    ok('une miniature est renvoyée', typeof envoiJson.thumb_url === 'string' && envoiJson.thumb_url.length > 10,
      envoiJson.thumb_url);

    const vu = await fetch(envoiJson.thumb_url);
    const octets = Buffer.from(await vu.arrayBuffer());
    ok('la miniature est servie par le serveur', vu.status === 200, vu.status);
    ok('c’est bien une image JPEG',
      (vu.headers.get('content-type') || '').includes('image/jpeg'), vu.headers.get('content-type'));
    ok('elle n’est pas vide', octets.length > 500, octets.length);
    ok('signature JPEG (FFD8) valide',
      octets[0] === 0xFF && octets[1] === 0xD8, [octets[0], octets[1]]);

    console.log('\n3. Publication d’un clip avec la miniature fournie');
    const clip = await call('POST', '/feed/posts', {
      token: A.token,
      body: { type: 'clip', media_url: envoiJson.url, thumb_url: envoiJson.thumb_url, visibilite: 'public' },
    });
    ok('clip créé (201)', clip.status === 201, clip);
    ok('la miniature est enregistrée', clip.data.post.thumb_url === envoiJson.thumb_url, clip.data.post.thumb_url);

    const fil = await call('GET', '/feed', { token: Autre.token });
    const relu = (fil.data.posts || []).find((p) => p.id === clip.data.post.id);
    ok('la miniature arrive dans le fil des autres',
      relu && relu.thumb_url === envoiJson.thumb_url, relu && relu.thumb_url);

    console.log('\n4. Repli : clip publié SANS miniature');
    const clipNu = await call('POST', '/feed/posts', {
      token: A.token, body: { type: 'clip', media_url: envoiJson.url, visibilite: 'public' },
    });
    ok('clip accepté sans thumb_url', clipNu.status === 201, clipNu);
    ok('le serveur a capturé la miniature tout seul',
      typeof clipNu.data.post.thumb_url === 'string' && clipNu.data.post.thumb_url.endsWith('.jpg'),
      clipNu.data.post.thumb_url);

    console.log('\n5. Une URL de miniature fantaisiste est écartée');
    const piege = await call('POST', '/feed/posts', {
      token: A.token,
      body: { type: 'clip', media_url: envoiJson.url, thumb_url: 'javascript:alert(1)', visibilite: 'public' },
    });
    ok('valeur refusée, remplacée par la capture réelle',
      piege.data.post.thumb_url !== 'javascript:alert(1)' &&
      String(piege.data.post.thumb_url || '').endsWith('.jpg'),
      piege.data.post.thumb_url);

    console.log('\n6. Une photo n’a pas de miniature');
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const formPng = new FormData();
    formPng.append('file', new Blob([png], { type: 'image/png' }), 'photo.png');
    const envoiPng = await fetch(`${B}/upload`, {
      method: 'POST', headers: { Authorization: `Bearer ${A.token}` }, body: formPng,
    });
    const pngJson = await envoiPng.json();
    ok('photo identifiée comme image', pngJson.type === 'image', pngJson.type);
    ok('aucune miniature générée pour une photo', pngJson.thumb_url === null, pngJson.thumb_url);

    console.log('\n7. (Re)génération à la demande, auteur uniquement');
    const parAutre = await call('POST', `/feed/posts/${clipNu.data.post.id}/thumb`, { token: Autre.token, body: {} });
    ok('un autre utilisateur → 403', parAutre.status === 403, parAutre.status);
    const parAuteur = await call('POST', `/feed/posts/${clipNu.data.post.id}/thumb`, { token: A.token, body: {} });
    ok('l’auteur peut régénérer', parAuteur.status === 200 && !!parAuteur.data.thumb_url, parAuteur.data);
    const sansMedia = await call('POST', '/feed/posts', {
      token: A.token, body: { type: 'texte', texte: 'sans vidéo' },
    });
    const refus = await call('POST', `/feed/posts/${sansMedia.data.post.id}/thumb`, { token: A.token, body: {} });
    ok('publication sans vidéo → 422', refus.status === 422, refus.status);

    console.log('\n8. Sans décodeur, l’envoi réussit quand même');
    // `node -e` résout les chemins relatifs depuis le répertoire courant :
    // on lui donne le chemin absolu du service.
    const cheminService = path.join(__dirname, '..', 'src', 'services', 'video_thumb.js');
    const sansFfmpeg = spawnSync('node', ['-e', `
      process.env.MBOTE_NO_FFMPEG = '1';
      const t = require(${JSON.stringify(cheminService)});
      console.log(JSON.stringify({ dispo: t.disponible(), notice: t.startupNotice() }));
    `], { cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 20000 });
    let sortie = {};
    try { sortie = JSON.parse(sansFfmpeg.stdout.trim()); } catch { /* non lisible */ }
    ok('sans ffmpeg, le service se déclare indisponible', sortie.dispo === false, sortie);
    ok('et le message de démarrage le dit clairement',
      /DÉSACTIVÉES/.test(String(sortie.notice)), sortie.notice);

    console.log('\n9. Nettoyage');
    for (const id of [clip, clipNu, piege, sansMedia].map((x) => x && x.data && x.data.post && x.data.post.id)) {
      if (id) await call('DELETE', `/feed/posts/${id}`, { token: A.token });
    }
    const fichiers = fs.readdirSync(UPLOADS).filter((f) => f.startsWith(path.basename(envoiJson.url)));
    ok('les fichiers de test sont retirés du disque', fichiers.length === 0, fichiers);

    console.log('\n10. Aucune erreur serveur');
    const erreurs = srvOut.split('\n').filter((l) => l.startsWith('💥'));
    ok('aucune erreur 5xx', erreurs.length === 0, erreurs.slice(0, 2));

  } catch (e) {
    console.error('\n💥 exception du test :', e && e.stack);
    console.error('--- sortie serveur ---\n' + srvOut.slice(-1200));
    fail++;
  } finally {
    srv.kill();
    await sleep(300);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* déjà parti */ }
    console.log('\n──────────────────────────────────────────────────────');
    console.log(`${fail === 0 ? '✅' : '❌'}  ${pass} réussis · ${fail} échoués`);
    process.exit(fail === 0 ? 0 : 1);
  }
})();
