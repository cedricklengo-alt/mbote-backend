'use strict';

/**
 * MINIATURES DE VIDÉO (thumbnail).
 *
 * Une vidéo publiée dans le fil n'a pas d'image d'aperçu : avant même de
 * lancer la lecture, il faut trouver un décodeur côté téléphone, ce qui coûte
 * des données et plusieurs secondes d'attente — ou échoue franchement sur les
 * réseaux mobiles congolais. Une miniature réglée à l'envoi change tout : le fil
 * s'affiche instantanément, sans lecture, et la vidéo ne se télécharge qu'au
 * moment où l'on appuie sur « lecture ».
 *
 * La capture est faite **à l'envoi du fichier**, par le serveur, donc elle est
 * automatique : l'auteur n'a rien à faire, et toutes les vidéos publiées depuis
 * n'importe quelle version de l'application en profitent.
 *
 * Le décodeur : `ffmpeg`. Trois sources possibles, essayées dans cet ordre :
 *   1. la variable d'environnement FFMPEG_PATH (binaire fourni par l'hébergeur) ;
 *   2. le paquet npm `ffmpeg-static`, qui embarque un binaire autonome — c'est
 *      le cas en production sur Render ;
 *   3. `ffmpeg` présent dans le PATH de la machine.
 * Si aucun n'est disponible, le service le dit UNE fois dans les journaux et
 * renvoie `null` : l'envoi du fichier réussit quand même, l'application
 * retombe simplement sur un bouton « lecture » sans aperçu.
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const UPLOADS = path.join(__dirname, '..', '..', 'uploads');

let _binaire;        // undefined = pas encore cherché, null = introuvable
let _avertissement = false;

/** Cherche un binaire ffmpeg utilisable. Résultat mémorisé. */
function ffmpeg() {
  if (_binaire !== undefined) return _binaire;

  const candidats = [];
  if (process.env.FFMPEG_PATH) candidats.push(process.env.FFMPEG_PATH);
  // Désactivation explicite, utile pour tester le comportement en l'absence
  // de décodeur (c'est le cas sur un hébergeur qui n'en fournit pas).
  if (process.env.MBOTE_NO_FFMPEG === '1') {
    _binaire = null;
    return _binaire;
  }
  try {
    // eslint-disable-next-line global-require, import/no-unresolved
    const statique = require('ffmpeg-static');
    if (statique) candidats.push(statique);
  } catch { /* paquet absent : ce n'est pas une erreur */ }
  candidats.push('ffmpeg');

  for (const c of candidats) {
    try {
      if (c !== 'ffmpeg' && !fs.existsSync(c)) continue;
      const { execFileSync } = require('child_process');
      execFileSync(c, ['-version'], { stdio: 'ignore', timeout: 5000 });
      _binaire = c;
      return _binaire;
    } catch { /* candidat suivant */ }
  }

  _binaire = null;
  if (!_avertissement) {
    _avertissement = true;
    console.warn('🖼️  Aucun décodeur vidéo (ffmpeg) : les vidéos du fil auront un '
      + 'aperçu générique au lieu d’une miniature. Installe ffmpeg-static ou '
      + 'renseigne FFMPEG_PATH.');
  }
  return _binaire;
}

/** Le décodeur est-il disponible ? (diagnostic, tests, /api/health) */
function disponible() {
  return ffmpeg() !== null;
}

/** Ce fichier est-il une vidéo ? (par son extension) */
function estVideo(nomFichier) {
  return /\.(mp4|mov|m4v|webm|avi|mkv|3gp)$/i.test(String(nomFichier || ''));
}

/**
 * Capture une image d'une vidéo.
 *
 * On vise la première seconde (souvent plus parlante que la première image,
 * qui est fréquemment noire). Si la vidéo est plus courte que ça, ffmpeg ne
 * produit rien : on refait alors un essai sur la toute première image.
 *
 * @param {string} source   chemin absolu de la vidéo
 * @param {string} sortie   chemin absolu du JPEG à écrire
 * @param {{largeur?: number, timeoutMs?: number}} [options]
 * @returns {Promise<boolean>} vrai si un JPEG a été écrit
 */
async function capturer(source, sortie, options = {}) {
  const binaire = ffmpeg();
  if (!binaire) return false;
  if (!fs.existsSync(source)) return false;

  const largeur = options.largeur || 720;
  const timeoutMs = options.timeoutMs || 25000;

  const essais = [
    ['-ss', '1'],
    ['-ss', '0'],
  ];

  for (const position of essais) {
    const args = [
      '-hide_banner', '-loglevel', 'error', '-y',
      ...position,
      '-i', source,
      '-frames:v', '1',
      // Largeur fixée, hauteur calculée : jamais de déformation, et jamais
      // d'image impaire (ffmpeg refuse les dimensions impaires en JPEG).
      '-vf', `scale=${largeur}:-2:flags=lanczos`,
      '-q:v', '4',
      sortie,
    ];

    const ok = await new Promise((resolve) => {
      let fini = false;
      const finir = (v) => { if (!fini) { fini = true; resolve(v); } };

      let enfant;
      try {
        enfant = spawn(binaire, args, { stdio: 'ignore' });
      } catch {
        return finir(false);
      }
      const minuteur = setTimeout(() => {
        try { enfant.kill('SIGKILL'); } catch { /* déjà mort */ }
        finir(false);
      }, timeoutMs);

      enfant.on('error', () => { clearTimeout(minuteur); finir(false); });
      enfant.on('close', (code) => {
        clearTimeout(minuteur);
        const ecrit = fs.existsSync(sortie) && fs.statSync(sortie).size > 0;
        finir(code === 0 && ecrit);
      });
    });

    if (ok) return true;
  }
  return false;
}

/**
 * Génère la miniature d'un fichier déjà rangé dans `uploads/`.
 *
 * Convention de nom : `1700000000-abc.mp4` → `1700000000-abc.jpg`.
 * Le nom est déterministe, ce qui permet de retrouver la miniature plus tard
 * sans colonne en base (et sert de repli pour les vidéos déjà publiées).
 *
 * @returns {Promise<string|null>} URL relative (`/uploads/….jpg`) ou null
 */
async function miniatureDepuisUpload(nomFichier) {
  if (!estVideo(nomFichier)) return null;
  if (!ffmpeg()) return null;

  const base = path.basename(nomFichier).replace(/\.[^.]+$/, '');
  const source = path.join(UPLOADS, path.basename(nomFichier));
  const sortie = path.join(UPLOADS, `${base}.jpg`);

  if (fs.existsSync(sortie) && fs.statSync(sortie).size > 0) {
    return `/uploads/${base}.jpg`;
  }
  if (!fs.existsSync(source)) return null;

  const ok = await capturer(source, sortie);
  if (!ok) {
    await fs.promises.unlink(sortie).catch(() => {});
    return null;
  }
  return `/uploads/${base}.jpg`;
}

/**
 * Miniature d'une URL de média déjà publiée, si le fichier est hébergé ici.
 * Sert de repli quand la publication arrive sans `thumb_url` (application
 * ancienne, ou envoi direct par l'API).
 */
async function miniaturePourUrl(mediaUrl) {
  try {
    if (!mediaUrl || typeof mediaUrl !== 'string') return null;
    const marqueur = '/uploads/';
    const i = mediaUrl.indexOf(marqueur);
    if (i === -1) return null; // média hébergé ailleurs : à l'appelant de voir
    const nom = path.basename(mediaUrl.slice(i + marqueur.length).split('?')[0]);
    if (!nom || nom.includes('..')) return null;
    if (!estVideo(nom)) return null;

    const base = nom.replace(/\.[^.]+$/, '');
    const chemin = path.join(UPLOADS, `${base}.jpg`);
    if (fs.existsSync(chemin) && fs.statSync(chemin).size > 0) return `/uploads/${base}.jpg`;

    return await miniatureDepuisUpload(nom);
  } catch {
    return null;
  }
}

/** Texte lisible au démarrage, pour savoir si les miniatures sont actives. */
function startupNotice() {
  const b = ffmpeg();
  return b
    ? `🖼️  Miniatures vidéo : actives (${path.basename(String(b))})`
    : '🖼️  Miniatures vidéo : DÉSACTIVÉES (aucun décodeur ffmpeg trouvé)';
}

module.exports = {
  disponible,
  estVideo,
  capturer,
  miniatureDepuisUpload,
  miniaturePourUrl,
  startupNotice,
  UPLOADS,
};
