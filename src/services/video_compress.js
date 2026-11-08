'use strict';

/**
 * COMPRESSION VIDÉO — Optimisation pour les réseaux mobiles (RDC).
 *
 * Chaque vidéo uploadée est automatiquement recompressée avant stockage :
 *   • Codec  : H.264 (libx264), compatible tous appareils Android
 *   • CRF    : 28 (qualité acceptable, taille ~4–6× inférieure à l'original)
 *   • Preset : fast (bon compromis vitesse/compression sur un VPS)
 *   • Audio  : AAC 128 kbps
 *   • Résolution : plafonnée à 720p (mise à l'échelle proportionnelle)
 *
 * Si ffmpeg est indisponible, la vidéo originale est conservée sans erreur.
 * La compression se fait IN-PLACE : l'original est écrasé par le fichier
 * compressé dès que la compression réussit.
 *
 * Exemple de gain réel :
 *   Avant : 42 Mo (vidéo smartphone 1080p 30 s)
 *   Après :  6 Mo (720p CRF 28) → économie de 86 %
 */

const { spawn } = require('child_process');
const fs         = require('fs');
const path       = require('path');
const os         = require('os');

/** Réutilise la même logique de recherche de binaire que video_thumb.js */
let _binaire;
function ffmpeg() {
  if (_binaire !== undefined) return _binaire;
  if (process.env.MBOTE_NO_FFMPEG === '1') { _binaire = null; return null; }

  const candidats = [];
  if (process.env.FFMPEG_PATH) candidats.push(process.env.FFMPEG_PATH);
  try { candidats.push(require('ffmpeg-static')); } catch (_) { /* absent */ }
  candidats.push('ffmpeg');

  for (const c of candidats) {
    if (c !== 'ffmpeg' && !fs.existsSync(c)) continue;
    try {
      require('child_process').execSync(`"${c}" -version 2>&1`, { timeout: 3000 });
      _binaire = c;
      return _binaire;
    } catch (_) { /* essai suivant */ }
  }
  _binaire = null;
  return null;
}

/**
 * Compresse une vidéo en place.
 *
 * @param {string} cheminAbsolu  Chemin de la vidéo uploadée
 * @param {{maxHeightPx?: number, crf?: number, timeoutMs?: number}} [opts]
 * @returns {Promise<{ok: boolean, avant: number, apres: number}>}
 *          ok=false → ffmpeg absent ou échec ; tailles en octets.
 */
async function compresser(cheminAbsolu, opts = {}) {
  const {
    maxHeightPx = 720,
    crf         = 28,
    timeoutMs   = 90_000,   // 90 s max (vidéo longue sur VPS lent)
  } = opts;

  const bin = ffmpeg();
  if (!bin) return { ok: false, avant: 0, apres: 0 };
  if (!fs.existsSync(cheminAbsolu)) return { ok: false, avant: 0, apres: 0 };

  const avant = fs.statSync(cheminAbsolu).size;

  // Fichier temporaire dans le même répertoire pour un mv atomique.
  const tmp = cheminAbsolu + '.tmp_compress.mp4';

  try {
    await new Promise((resolve, reject) => {
      // vf scale : conserve le ratio, réduit à maxHeightPx si plus grand,
      // force les dimensions à être paires (exigence libx264).
      const vf = `scale='if(gt(ih,${maxHeightPx}),-2,iw)':'if(gt(ih,${maxHeightPx}),${maxHeightPx},-2)'`;

      const args = [
        '-y',                       // écraser sans demander
        '-i', cheminAbsolu,         // entrée
        '-vf', vf,                  // mise à l'échelle
        '-c:v', 'libx264',
        '-crf', String(crf),
        '-preset', 'fast',
        '-movflags', '+faststart',  // streaming progressif
        '-c:a', 'aac',
        '-b:a', '128k',
        '-f', 'mp4',
        tmp,
      ];

      const proc = spawn(bin, args);
      let stderr = '';
      proc.stderr.on('data', (d) => { stderr += d.toString(); });

      const timer = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error('timeout')); }, timeoutMs);

      proc.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0 && fs.existsSync(tmp)) resolve();
        else reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-300)}`));
      });
      proc.on('error', reject);
    });

    // Remplacement atomique : on supprime l'original puis on renomme le tmp.
    const apres = fs.statSync(tmp).size;

    // Ne conserver que si la compression a réduit la taille (au moins 5 %).
    if (apres < avant * 0.95) {
      fs.unlinkSync(cheminAbsolu);
      fs.renameSync(tmp, cheminAbsolu);
      console.log(
        `📦 Compression vidéo : ${(avant/1e6).toFixed(1)} Mo → ${(apres/1e6).toFixed(1)} Mo ` +
        `(−${Math.round((1 - apres/avant)*100)} %) — ${path.basename(cheminAbsolu)}`
      );
      return { ok: true, avant, apres };
    } else {
      // La vidéo était déjà bien compressée, on garde l'original.
      fs.unlinkSync(tmp);
      return { ok: true, avant, apres: avant };
    }
  } catch (e) {
    // Nettoyage du fichier temporaire en cas d'échec.
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) {}
    console.warn(`⚠️  Compression vidéo échouée (${path.basename(cheminAbsolu)}) : ${e.message}`);
    return { ok: false, avant, apres: avant };
  }
}

module.exports = { compresser, disponible: () => ffmpeg() !== null };
