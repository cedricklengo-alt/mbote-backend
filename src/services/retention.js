/**
 * 🧹 v2.2 CONFIDENTIALITÉ — Purge automatique des contenus livrés.
 *
 * Principe : le serveur est un RELAIS, pas une archive.
 *   - Audio des notes vocales : effacé N jours après LECTURE par le
 *     destinataire (défaut 7 j) — le texte traduit reste un peu plus.
 *   - Notes et messages entiers : supprimés N jours après lecture
 *     (défaut 30 j). L'historique vit dans le cache local du téléphone.
 *
 * Réglages (variables d'environnement, 0 = désactivé) :
 *   RETENTION_AUDIO_DAYS    (défaut 7)
 *   RETENTION_MEDIA_DAYS    (défaut 14) — photos et fichiers, après lecture
 *   RETENTION_MESSAGES_DAYS (défaut 30)
 */

const db = require('../db');

const DAY = 24 * 60 * 60 * 1000;

function cfg() {
  const a = process.env.RETENTION_AUDIO_DAYS;
  const m = process.env.RETENTION_MESSAGES_DAYS;
  const f = process.env.RETENTION_MEDIA_DAYS;
  return {
    mediaMs: (f === undefined ? 14 : parseInt(f, 10) || 0) * DAY,
    audioMs: (a === undefined ? 7 : parseInt(a, 10) || 0) * DAY,
    msgMs: (m === undefined ? 30 : parseInt(m, 10) || 0) * DAY,
  };
}

/** Une passe de purge — retourne les compteurs (utile pour les tests). */
async function purge(now = Date.now()) {
  const c = cfg();
  const out = { audio: 0, media: 0, notes: 0, texts: 0 };
  const count = async (sql, p) => (await db.get(sql, p))?.n ?? 0;

  if (c.audioMs > 0) {
    const cut = now - c.audioMs;
    out.audio = await count(
      `SELECT COUNT(*) AS n FROM voice_notes WHERE read_at IS NOT NULL AND read_at < ? AND audio != ''`, [cut]);
    if (out.audio) await db.run(
      `UPDATE voice_notes SET audio = '' WHERE read_at IS NOT NULL AND read_at < ? AND audio != ''`, [cut]);
  }
  if (c.mediaMs > 0) {
    // photos et fichiers lus depuis N jours : le contenu est effacé, le message reste
    const cut = now - c.mediaMs;
    out.media = await count(
      `SELECT COUNT(*) AS n FROM text_messages WHERE read_at IS NOT NULL AND read_at < ?
         AND attachment IS NOT NULL AND attachment <> ''`, [cut]);
    if (out.media) await db.run(
      `UPDATE text_messages SET attachment = NULL WHERE read_at IS NOT NULL AND read_at < ?
         AND attachment IS NOT NULL AND attachment <> ''`, [cut]);
  }
  if (c.msgMs > 0) {
    const cut = now - c.msgMs;
    out.notes = await count(
      `SELECT COUNT(*) AS n FROM voice_notes WHERE read_at IS NOT NULL AND read_at < ?`, [cut]);
    if (out.notes) await db.run(
      `DELETE FROM voice_notes WHERE read_at IS NOT NULL AND read_at < ?`, [cut]);
    out.texts = await count(
      `SELECT COUNT(*) AS n FROM text_messages WHERE read_at IS NOT NULL AND read_at < ?`, [cut]);
    if (out.texts) await db.run(
      `DELETE FROM text_messages WHERE read_at IS NOT NULL AND read_at < ?`, [cut]);
  }
  // masquages devenus sans objet (le message n'existe plus)
  await db.run(
    `DELETE FROM msg_hidden WHERE msg_id NOT IN (SELECT id FROM text_messages)
       AND msg_id NOT IN (SELECT id FROM voice_notes)`);
  if (out.audio || out.media || out.notes || out.texts) {
    console.log(`🧹 [RETENTION] Purge : ${out.audio} audio et ${out.media} médias effacés, ${out.notes} notes et ${out.texts} messages supprimés`);
  }
  return out;
}

/** Démarre la purge périodique (toutes les heures). */
function start() {
  const c = cfg();
  if (!c.audioMs && !c.msgMs && !c.mediaMs) {
    console.log('🧹 [RETENTION] Désactivée (RETENTION_*_DAYS = 0)');
    return;
  }
  console.log(`🧹 [RETENTION] Active — audio ${c.audioMs / DAY} j, médias ${c.mediaMs / DAY} j après lecture, contenus ${c.msgMs / DAY} j`);
  setTimeout(() => purge().catch(() => {}), 30_000); // 1re passe au démarrage
  setInterval(() => purge().catch(() => {}), 60 * 60_000).unref();
}

module.exports = { start, purge };
