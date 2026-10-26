/**
 * 🗣️ LOKOTA 1 — Traduction des notes vocales
 * « Parle ta langue. Ils entendront la leur. »
 *
 * Pipeline : audio → transcription (reconnaissance vocale) → traduction.
 * Trois modes, selon la configuration :
 *   - 'openai' : clé LOKOTA_OPENAI_KEY présente → Whisper (transcription,
 *                le lingala 'ln' et le swahili 'sw' sont couverts) puis
 *                gpt-4o-mini (traduction). Coût ≈ 0,006 $/minute d'audio.
 *   - 'demo'   : DEMO_MODE=true sans clé → transcription/traduction
 *                SIMULÉES (marquées 🧪) pour valider toute l'expérience.
 *   - 'off'    : ni clé ni démo → les notes vocales marchent quand même,
 *                simplement sans traduction (statut 'no_ai').
 */

const db = require('../db');

const LANGS = { fr: 'français', ln: 'lingala', sw: 'swahili' };
const DEMO = () => String(process.env.DEMO_MODE || 'true') === 'true';

function mode() {
  if (process.env.LOKOTA_OPENAI_KEY) return 'openai';
  if (DEMO()) return 'demo';
  return 'off';
}

/** Traite une note (appelé en tâche de fond juste après l'envoi) */
async function processNote(id) {
  const note = await db.get('SELECT * FROM voice_notes WHERE id = ?', [id]);
  if (!note || note.status !== 'pending') return;
  const m = mode();

  if (m === 'off') {
    await db.run(`UPDATE voice_notes SET status = 'no_ai' WHERE id = ?`, [id]);
    return;
  }

  if (m === 'demo') {
    // 🧪 Simulation : montre l'expérience complète sans clé IA
    await new Promise((r) => setTimeout(r, 2500)); // petit délai réaliste
    await db.run(
      `UPDATE voice_notes SET transcript = ?, translation = ?, status = 'done' WHERE id = ?`,
      [
        `🧪 (démo) Transcription simulée de ta note en ${LANGS[note.lang_from] || note.lang_from}.`,
        `🧪 (démo) Traduction simulée en ${LANGS[note.lang_to] || note.lang_to} — la vraie IA s'active avec la clé LOKOTA_OPENAI_KEY.`,
        id,
      ]);
    console.log(`🗣️ [LOKOTA] Note ${id} traduite (simulation)`);
    return;
  }

  // ---- Mode réel : Whisper + gpt-4o-mini ----
  try {
    const key = process.env.LOKOTA_OPENAI_KEY;
    const b64 = String(note.audio).split(',').pop();
    const buf = Buffer.from(b64, 'base64');

    // 1) Transcription
    const fd = new FormData();
    fd.append('file', new Blob([buf], { type: 'audio/mp4' }), 'note.m4a');
    fd.append('model', 'whisper-1');
    if (LANGS[note.lang_from]) fd.append('language', note.lang_from);
    const tr = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: fd,
    });
    if (!tr.ok) throw new Error(`transcription HTTP ${tr.status}`);
    const transcript = (await tr.json()).text || '';

    // 2) Traduction
    const cc = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0.2,
        messages: [
          { role: 'system', content:
            `Tu es un traducteur familial chaleureux. Traduis fidèlement du ${LANGS[note.lang_from] || note.lang_from} vers le ${LANGS[note.lang_to] || note.lang_to}. Garde le ton affectueux et naturel. Réponds UNIQUEMENT avec la traduction.` },
          { role: 'user', content: transcript },
        ],
      }),
    });
    if (!cc.ok) throw new Error(`traduction HTTP ${cc.status}`);
    const translation = (await cc.json()).choices?.[0]?.message?.content?.trim() || '';

    await db.run(
      `UPDATE voice_notes SET transcript = ?, translation = ?, status = 'done' WHERE id = ?`,
      [transcript, translation, id]);
    console.log(`🗣️ [LOKOTA] Note ${id} traduite (${note.lang_from} → ${note.lang_to})`);
  } catch (e) {
    console.error(`⚠️ [LOKOTA] Échec traduction note ${id} :`, e.message);
    await db.run(`UPDATE voice_notes SET status = 'failed' WHERE id = ?`, [id]);
  }
}

module.exports = { processNote, mode, LANGS };
