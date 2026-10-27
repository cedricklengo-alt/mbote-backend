/**
 * 🗣️ LOKOTA 1 — Traduction des notes vocales
 * « Parle ta langue. Ils entendront la leur. »
 *
 * Pipeline : audio → transcription (reconnaissance vocale) → traduction.
 * Le service parle le protocole « OpenAI-compatible » : il fonctionne donc
 * avec PLUSIEURS fournisseurs, y compris des GRATUITS. Configuration :
 *
 *   LOKOTA_API_KEY   → clé unique (ou LOKOTA_OPENAI_KEY, toujours acceptée)
 *   LOKOTA_STT_URL   → endpoint transcription (défaut : OpenAI)
 *   LOKOTA_STT_MODEL → modèle de transcription (défaut : whisper-1)
 *   LOKOTA_STT_KEY   → clé spécifique transcription (défaut : LOKOTA_API_KEY)
 *   LOKOTA_LLM_URL   → endpoint traduction (défaut : OpenAI)
 *   LOKOTA_LLM_MODEL → modèle de traduction (défaut : gpt-4o-mini)
 *   LOKOTA_LLM_KEY   → clé spécifique traduction (défaut : LOKOTA_API_KEY)
 *
 * Recettes prêtes (voir GUIDE-LOKOTA-IA-GRATUITE.md) :
 *   💚 GROQ (gratuit, 1 seule clé) :
 *      LOKOTA_API_KEY=gsk_…
 *      LOKOTA_STT_URL=https://api.groq.com/openai/v1/audio/transcriptions
 *      LOKOTA_STT_MODEL=whisper-large-v3
 *      LOKOTA_LLM_URL=https://api.groq.com/openai/v1/chat/completions
 *      LOKOTA_LLM_MODEL=llama-3.3-70b-versatile
 *   💚 NVIDIA (gratuit, traduction) — combinable avec Groq pour l'audio :
 *      LOKOTA_LLM_KEY=nvapi-…
 *      LOKOTA_LLM_URL=https://integrate.api.nvidia.com/v1/chat/completions
 *      LOKOTA_LLM_MODEL=meta/llama-3.3-70b-instruct
 *   💰 OPENAI (payant, ≈0,006 $/min) : juste LOKOTA_API_KEY=sk-…
 *
 * Modes : 'ai' (clé présente) / 'demo' (simulation 🧪) / 'off' (no_ai).
 */

const db = require('../db');

const LANGS = { fr: 'français', ln: 'lingala', sw: 'swahili' };
const DEMO = () => String(process.env.DEMO_MODE || 'true') === 'true';

const CFG = () => {
  const base = process.env.LOKOTA_API_KEY || process.env.LOKOTA_OPENAI_KEY || '';
  return {
    sttUrl: process.env.LOKOTA_STT_URL || 'https://api.openai.com/v1/audio/transcriptions',
    sttModel: process.env.LOKOTA_STT_MODEL || 'whisper-1',
    sttKey: process.env.LOKOTA_STT_KEY || base,
    llmUrl: process.env.LOKOTA_LLM_URL || 'https://api.openai.com/v1/chat/completions',
    llmModel: process.env.LOKOTA_LLM_MODEL || 'gpt-4o-mini',
    llmKey: process.env.LOKOTA_LLM_KEY || base,
  };
};

function mode() {
  const c = CFG();
  if (c.sttKey && c.llmKey) return 'ai';
  if (DEMO()) return 'demo';
  return 'off';
}

/**
 * 🔁 fetch avec patience : les offres IA gratuites renvoient HTTP 429
 * (« trop de requêtes ») quand on dépasse leur cadence. Au lieu d'échouer,
 * on attend puis on réessaie (3 tentatives : +20 s, +45 s).
 */
async function fetchPatient(doFetch, label) {
  const delays = [0, 20_000, 45_000];
  let last;
  for (let i = 0; i < delays.length; i++) {
    if (delays[i]) {
      console.log(`🗣️ [LOKOTA] ${label} : limite atteinte (429) — nouvel essai dans ${delays[i] / 1000} s…`);
      await new Promise((r) => setTimeout(r, delays[i]));
    }
    last = await doFetch();
    if (last.ok) return last;
    if (last.status !== 429 && last.status !== 503) return last; // vraie erreur → inutile d'insister
  }
  return last;
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
        `🧪 (démo) Traduction simulée en ${LANGS[note.lang_to] || note.lang_to} — la vraie IA s'active avec une clé (gratuite : Groq/NVIDIA, voir guide).`,
        id,
      ]);
    console.log(`🗣️ [LOKOTA] Note ${id} traduite (simulation)`);
    return;
  }

  // ---- Mode réel : transcription + traduction (OpenAI-compatible) ----
  try {
    const c = CFG();
    const b64 = String(note.audio).split(',').pop();
    const buf = Buffer.from(b64, 'base64');

    // 1) Transcription (Whisper — OpenAI, Groq, ou tout endpoint compatible)
    const fd = new FormData();
    fd.append('file', new Blob([buf], { type: 'audio/mp4' }), 'note.m4a');
    fd.append('model', c.sttModel);
    if (LANGS[note.lang_from]) fd.append('language', note.lang_from);
    const tr = await fetchPatient(() => fetch(c.sttUrl, {
      method: 'POST', headers: { Authorization: `Bearer ${c.sttKey}` }, body: fd,
    }), 'transcription');
    if (!tr.ok) throw new Error(`transcription HTTP ${tr.status}`);
    const transcript = (await tr.json()).text || '';

    // 2) Traduction (OpenAI, NVIDIA, Groq… — même protocole)
    const cc = await fetchPatient(() => fetch(c.llmUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${c.llmKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: c.llmModel,
        temperature: 0.2,
        messages: [
          { role: 'system', content:
            `Tu es un traducteur familial chaleureux. Le texte provient d'une reconnaissance vocale automatique qui fait souvent des erreurs phonétiques, surtout en lingala et swahili : reconstruis d'abord mentalement la phrase la plus probable d'après le contexte, puis traduis fidèlement du ${LANGS[note.lang_from] || note.lang_from} vers le ${LANGS[note.lang_to] || note.lang_to}. Garde le ton affectueux et naturel d'un message familial. Réponds UNIQUEMENT avec la traduction, sans commentaire.` },
          { role: 'user', content: transcript },
        ],
      }),
    }), 'traduction');
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

/**
 * 💬 v2.0 MESSAGES — Traduit un message ÉCRIT (même IA que Lokota,
 * sans l'étape Whisper : plus simple, plus fiable, quasi gratuit).
 */
async function processMessage(id) {
  const msg = await db.get('SELECT * FROM text_messages WHERE id = ?', [id]);
  if (!msg || msg.status !== 'pending') return;
  const m = mode();

  if (m === 'off') {
    await db.run(`UPDATE text_messages SET status = 'no_ai' WHERE id = ?`, [id]);
    return;
  }

  if (m === 'demo') {
    await new Promise((r) => setTimeout(r, 1200));
    await db.run(
      `UPDATE text_messages SET translation = ?, status = 'done' WHERE id = ?`,
      [`🧪 (démo) Traduction simulée en ${LANGS[msg.lang_to] || msg.lang_to} — la vraie IA s'active avec une clé (voir guide).`, id]);
    console.log(`💬 [MESSAGES] ${id} traduit (simulation)`);
    return;
  }

  try {
    const c = CFG();
    const cc = await fetchPatient(() => fetch(c.llmUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${c.llmKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: c.llmModel,
        temperature: 0.2,
        messages: [
          { role: 'system', content:
            `Tu es un traducteur familial chaleureux. Traduis fidèlement ce message écrit du ${LANGS[msg.lang_from] || msg.lang_from} vers le ${LANGS[msg.lang_to] || msg.lang_to}. Garde le ton affectueux et naturel d'un message familial, y compris les emojis. Réponds UNIQUEMENT avec la traduction, sans commentaire.` },
          { role: 'user', content: msg.body },
        ],
      }),
    }), 'traduction message');
    if (!cc.ok) throw new Error(`traduction HTTP ${cc.status}`);
    const translation = (await cc.json()).choices?.[0]?.message?.content?.trim() || '';
    await db.run(
      `UPDATE text_messages SET translation = ?, status = 'done' WHERE id = ?`,
      [translation, id]);
    console.log(`💬 [MESSAGES] ${id} traduit (${msg.lang_from} → ${msg.lang_to})`);
  } catch (e) {
    console.error(`⚠️ [MESSAGES] Échec traduction ${id} :`, e.message);
    await db.run(`UPDATE text_messages SET status = 'failed' WHERE id = ?`, [id]);
  }
}

module.exports = { processNote, processMessage, mode, LANGS };
