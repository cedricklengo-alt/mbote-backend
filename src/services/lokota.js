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

/* 📚 v2.8.2 — Bibliothèque lingala/swahili RENFORCÉE : lexique familial
 * organisé par thèmes de vie + corrections des erreurs phonétiques typiques
 * de la reconnaissance vocale + gestion du lingala de Kinshasa (mélange
 * naturel avec le français). Guide le traducteur à chaque message. */
const LEXIQUE = `Lexique fiable du lingala de Kinshasa (à respecter) :

SALUTATIONS & POLITESSE :
- mbote = bonjour/salut · mbote na yo = bonjour à toi · losako = salut respectueux aux aînés
- boni ozali ? / ozali malamu ? = comment vas-tu ? · sango nini ? = quoi de neuf ?
- nazali malamu = je vais bien · sango malamu = bonne nouvelle · melesi / matondo (mingi) = merci (beaucoup)
- butu malamu = bonne nuit · mbote ya tongo = bonjour (matin) · tokomonana = on se verra

FAMILLE (le cœur des messages) :
- mama = maman · tata/papa = papa · koko = grand-mère/grand-père · noko = oncle
- mwana na ngai = mon enfant · bana = les enfants · libota = la famille
- ndeko = frère/sœur · yaya = grand frère/grande sœur · leki = petit frère/petite sœur
- mobali = mari · mwasi = épouse/femme · bato = les gens · pesa bango mbote = passe-leur le bonjour

AMOUR & ÉMOTIONS :
- bolingo = amour · nalingi yo (mingi) = je t'aime (beaucoup) · bolingo na ngai = mon amour
- nazali koyoka mposa na yo = tu me manques · esengo = joie · mawa = tristesse/peine
- motema pasi = chagrin, mal au cœur (peine) · komitungisa te = ne t'inquiète pas
- nazali na posa na yo = j'ai envie de toi / je te désire (c'est LA tournure correcte —
  « nazali na nzala ya yo » ne se dit PAS ; nzala = uniquement la faim)
- opesi nga lokumu = tu m'as honoré = « je suis fier de toi » (lokumu = honneur —
  c'est AINSI qu'un parent dit sa fierté à son enfant, pas par une traduction littérale)
- kolela = pleurer · kimia = paix/tranquille · keba = fais attention/prends soin de toi
- posa / mposa = envie, désir, besoin · « nazali na posa ya ko… » = « j'ai envie de… » + verbe qui suit
  (traduis TOUJOURS le verbe qui suit « posa ya », jamais un autre verbe)

INTIMITÉ ENTRE ADULTES (messages privés entre époux — traduire FIDÈLEMENT, sans censure ni détournement) :
- kosiba (argot cru de Kinshasa) = faire l'amour / avoir des rapports sexuels
  · « nazali na posa ya kosiba » = « j'ai envie de faire l'amour » (et SURTOUT PAS « prier » !)
- kosangisa nzoto = faire l'amour (forme soutenue) · kobeta mabe = tromper (infidélité)
- zemi = grossesse · azali na zemi = elle est enceinte
- Anatomie (registre VULGAIRE — mots d'apparence anodine, attention !) :
  masoko = les fesses · makunza = les poils du sexe · libolo / vangi = le sexe féminin (très cru)
- Règle : respecte le registre du message (cru → direct, poli → poli) ; ne JAMAIS
  remplacer un mot intime par un mot religieux ou anodin — le couple doit se comprendre.

HOMONYMES PIÈGES (le contexte décide — ne JAMAIS se tromper de sens) :
- moto = le FEU ou la MOTO (véhicule) — à Kinshasa, une PERSONNE se dit « mutu » (pluriel : bato)
  · « moto ezali kopela » = « le feu brûle » · « nakei na moto » = « j'y vais à moto » · « mutu wana » = « cette personne-là »
- lidesu (SINGULIER) = selon le contexte : UN haricot OU le clitoris (vulgaire) ;
  madesu (PLURIEL) = les haricots (le plat, toujours innocent)
  · contexte cuisine/repas → haricot(s) · contexte intime → sens vulgaire
- nzala = la FAIM uniquement (désir de quelqu'un = posa, jamais nzala)
- lobi = demain OU hier (trancher avec le temps du verbe)

ARGENT & ENVOIS (très fréquent) :
- mbongo / mosolo / falanga = argent · natindi yo mbongo = je t'ai envoyé de l'argent
- kotinda = envoyer · nazali kozela mbongo = j'attends l'argent · matabisi = cadeau/bonus
- futa = payer · niongo = dette · soki ozwi yango = quand tu l'auras reçu

SANTÉ :
- bokolongono = santé · nazali kobela = je suis malade · maladi/bokono = maladie
- lopitalo = hôpital · monganga = docteur · kisi = médicament · abiki = il/elle est guéri(e)

FOI (omniprésente dans les familles) :
- Nzambe = Dieu · Nzambe apambola yo = que Dieu te bénisse · mapamboli = bénédictions
- Nzambe asunga yo = que Dieu t'aide · Ngolu ya Nzambe = la grâce de Dieu
- losambo = prière · nasambeli mpo na yo = je prie pour toi · lingomba/ndako ya Nzambe = église

QUOTIDIEN, TEMPS & VOYAGE :
- lelo = aujourd'hui · lobi = demain OU hier (contexte !) · sika oyo = maintenant · na nsima = après
- poso = semaine · sanza = mois · mbula = année/pluie · ntango = temps/heure
- ndako = maison · mboka = pays/village · Poto = l'Europe · kelasi = école · mosala = travail
- nakei = je pars · nakoya = je viendrai · nakozonga = je reviendrai · mobembo malamu = bon voyage
- kolia = manger · bilei = nourriture · mayi = eau · lipa = pain · loso = riz · fufu, pondu, madesu, makemba = plats congolais (ne pas traduire)
- benga ngai = appelle-moi · nabengaki yo = je t'ai appelé · nakobenga yo lobi = je t'appellerai demain
- yebisa mama = dis à maman · zela moke = attends un peu · yaka = viens · likambo te / eloko te = pas de problème / de rien
- malamu = bien · mabe = mauvais · kitoko = beau/joli · mingi = beaucoup · moke = un peu

VERBES DU QUOTIDIEN (avec leurs formes conjuguées courantes — « na- » = je, « o- » = tu, « a- » = il/elle, « to- » = nous, « bo- » = vous, « ba- » = ils/elles ; le suffixe « -i » marque le présent/passé proche, « nako- » le futur) :
- kotelema = se lever / se tenir DEBOUT · natelemi = je suis debout / je me suis levé(e) · telema = lève-toi
- kolala = dormir / se coucher · nalali = je dors / je suis couché(e) · lala malamu = dors bien
- kofanda / kovanda = s'asseoir / habiter · nafandi = je suis assis(e) / j'habite
- kobima = sortir · nabimi = je suis sorti(e) · kokota = entrer · nakoti = je suis entré(e)
- kokoma = arriver (ou écrire) · nakomi = je suis arrivé(e) · kotambola = marcher
- kopema = se reposer · napemi = je me repose · kokima = courir / fuir
- kosala = faire / travailler · nasali = j'ai fait · kozwa = recevoir / prendre · nazwi = j'ai reçu
- komona = voir · namoni = j'ai vu · koyoka = entendre / sentir · nayoki = j'ai entendu
- koyeba = savoir · nayebi = je sais · nayebi te = je ne sais pas
- koloba = dire / parler · nalobi = j'ai dit · kokanisa = penser · nakanisi = je pense
- kosomba = acheter · koteka = vendre · kolamba = cuisiner · kosukola = laver
- kozela = attendre · nazali kozela = j'attends · kobanga = avoir peur · kobanga te = n'aie pas peur
- Négation : « te » en FIN de phrase = ne…pas (nalali te = je ne dors pas) · naino te = pas encore

LIEUX & POSITIONS (ne JAMAIS les confondre) :
- libanda = DEHORS / à l'extérieur · na libanda = dehors · « natelemi na libanda » = « je me suis tenu(e) debout dehors / je suis dehors »
- na kati = à l'intérieur / dedans · na kati ya ndako = dans la maison
- mbeto = lit · na mbeto = au lit (SEUL « mbeto » signifie « lit » — libanda n'a RIEN à voir avec le lit)
- likolo = en haut / le ciel · na nse = en bas / par terre · pembeni = à côté · mosika = loin · pene = près
- zando = marché · na zando = au marché · nzela = route / chemin · na nzela = en route
- balabala = rue / avenue · esika = endroit · awa = ici · kuna = là-bas

ARGOT DE KINSHASA (validé par des locuteurs — traduire avec le sens populaire exact) :
- kobeta libanga = faire un petit boulot (la débrouille au jour le jour)
  · « nazali kobeta libanga » = « je fais un petit boulot » · « akei kobeta libanga » = « il/elle est parti(e) faire un petit boulot »
- mopao = le patron (aussi surnom de Koffi Olomide) · masta = l'ami, le pote
- kiekie = mdr / rires (à garder comme rire : « mdr » ou « haha »)
- eza boye = c'est comme ça · eza bien = c'est bien
- eloko ya somo = selon le CONTEXTE : « un truc effrayant » (peur) OU « un truc incroyable/impressionnant » (admiration)
- kolia mbongo (litt. « manger l'argent ») = selon le CONTEXTE : dépenser, gaspiller OU détourner/voler
  · « azali moyibi, alie mbongo na ngai » = « c'est un voleur, il a détourné mon argent » · moyibi = voleur

VIE MODERNE — TÉLÉPHONE & MOBILE MONEY (très fréquent, à traduire tel quel) :
- « nazali lisusu na crédit/unité te » = « je n'ai plus de crédit/d'unités »
- « réseau ezali mabe » = « le réseau est mauvais » · « batterie na ngai ekufi / ebebi » = « ma batterie est morte »
- kobimisa mbongo = retirer l'argent (faire le retrait) · « mbongo po na kobimisa » = « l'argent à retirer »
- « ekati boni ? » = « combien ça a coupé/prélevé ? » (les frais) · « mbongo po na kobimisa ekati boni ? » = « le retrait a pris combien de frais ? »

SWAHILI DE L'EST (familles de Lubumbashi/Goma/Bukavu) :
- jambo/habari = bonjour · habari yako ? = comment vas-tu ? · asante sana = merci beaucoup
- mtoto wangu = mon enfant · bibi = grand-mère · babu = grand-père · ndugu = frère/parent
- nakupenda = je t'aime · nimekukumbuka = tu me manques · pole = désolé/courage
- pesa/fedha = argent · nitakutumia pesa = je t'enverrai de l'argent · kazi = travail · shule = école
- mgonjwa = malade · dawa = médicament · Mungu akubariki = que Dieu te bénisse
- kesho = demain · leo = aujourd'hui · sasa = maintenant · safari njema = bon voyage
- hakuna shida = pas de problème · lala salama = dors bien · nipigie simu = appelle-moi

PROVERBES (traduire par le SENS, en gardant l'image si elle reste claire) :
- « mosapi moko esokolaka elongi te » (litt. « un seul doigt ne lave pas le visage »)
  = ensemble nous sommes forts / l'union fait la force
- Règle : un proverbe ne se traduit JAMAIS mot à mot sans son sens — donner le sens,
  éventuellement suivi de l'image entre parenthèses si elle enrichit le message.

CONTRACTIONS COURANTES (parler de Kin & écriture SMS — MÊME SENS que la forme pleine) :
- nga = ngai (moi/je) · « bolingo na nga » = « bolingo na ngai » = mon amour
- naza = nazali (je suis) — le modèle « -zali → -za » vaut pour toutes les personnes :
  oza = ozali (tu es) · aza = azali (il/elle est) · eza = ezali (c'est) · toza = tozali (nous sommes) · baza = bazali (ils/elles sont)
- po = mpo (pour / parce que) · « po na yo » = « mpo na yo » = pour toi · po na nini = pourquoi
- Ces formes contractées sont NORMALES dans les messages : les comprendre sans les « corriger »,
  et traduire exactement comme la forme pleine.

ERREURS FRÉQUENTES DE LA RECONNAISSANCE VOCALE → FORME CORRECTE :
- « m'boté, embouté, bothé » → mbote · « bony/bonne i ozali » → boni ozali
- « na zali, nasali » → nazali · « ozari, o zali » → ozali · « malamou, ma lamou, malamo » → malamu
- « mélési, mélessi, merci si » → melesi · « n'zambé, zambe » → Nzambe · « bolingue, bolingô » → bolingo
- « m'bongo, bongo » (contexte argent) → mbongo · « lobby » → lobi · « coco » (contexte famille) → koko
- « kin shasa, kinchasa » → Kinshasa · « na lingui yo » → nalingi yo
- Si un mot français/anglais aberrant apparaît au milieu d'une phrase lingala,
  reconstruis le mot lingala le plus proche phonétiquement d'après le contexte.

RÈGLES DE STYLE :
1. Le lingala de Kinshasa mélange NATURELLEMENT des mots français (téléphone,
   rendez-vous, l'école, ça va…) : c'est normal, ne les « corrige » pas.
2. Vers le lingala : écris un lingala parlé et chaleureux, pas un lingala littéraire.
3. Garde les noms propres, plats (fufu, pondu…) et sommes d'argent tels quels.
4. « lobi » = demain OU hier : choisis selon le verbe (nakoya lobi = futur → demain).
5. INTERDIT d'inventer un sens : si un mot t'échappe, appuie-toi sur le lexique
   ci-dessus et le contexte ; décompose le verbe (préfixe sujet + racine + temps)
   plutôt que de deviner. Ne remplace JAMAIS un lieu par un autre (libanda ≠ mbeto),
   ni un mot intime par un mot religieux ou anodin (kosiba ≠ kosambela).
6. « posa ya ko-X » = « envie de X » : c'est le verbe X qu'il faut traduire,
   exactement lui, rien d'autre.

Exemples de style attendu :
- « Mbote koko, boni ozali ? » → « Bonjour grand-mère, comment vas-tu ? »
- « Tu me manques beaucoup maman » → « Nazali koyoka mposa na yo mingi mama »
- « Natindi yo mbongo lelo, yebisa ngai soki ozwi yango » → « Je t'ai envoyé l'argent aujourd'hui, dis-moi quand tu l'as reçu »
- « Les enfants vont bien, ils sont à l'école » → « Bana bazali malamu, bazali na kelasi »
- « Na telemi na libanda » → « Je me suis tenu(e) debout dehors » (et SURTOUT PAS « je suis au lit »)
- « Nalali naino te, nazali kozela yo » → « Je ne dors pas encore, je t'attends »
- « Nazali na posa ya kosiba » → « J'ai envie de faire l'amour » (registre intime assumé — PAS « prier »)`;

/* 🗣️ Amorces Whisper v2.8.2 : phrases authentiques, enrichies des sonorités
 * les plus fréquentes (famille, argent, foi, santé) pour caler l'oreille du
 * modèle AVANT la transcription. (Limite Whisper ≈ 224 tokens : respectée.) */
const AMORCES = {
  ln: 'Mbote mama, boni ozali ? Nazali malamu mwana na ngai, melesi mingi. ' +
      'Nzambe apambola yo koko, nasambeli mpo na yo. Natindi yo mbongo lelo, ' +
      'yebisa ngai soki ozwi yango. Bana bazali malamu, bazali na kelasi. ' +
      'Natelemi na libanda ya ndako, nazali kozela yo. Nalali naino te. ' +
      'Nazali koyoka mposa na yo, nalingi yo mingi. Nakobenga yo lobi na Kinshasa. ' +
      'Pesa libota mobimba mbote, likambo te. Bolingo na ngai, butu malamu.',
  sw: 'Jambo mama, habari yako ? Niko salama mtoto wangu, asante sana. ' +
      'Mungu akubariki bibi, ninakuombea kila siku. Nimekutumia pesa leo, ' +
      'niambie ukipokea. Watoto wako salama, wako shuleni. Nimekukumbuka sana, ' +
      'nakupenda. Nitakupigia simu kesho Kinshasa. Salamia familia yote, hakuna shida. Lala salama.',
  fr: 'Bonjour maman, comment vas-tu ? Je vais bien mon enfant, merci beaucoup. ' +
      'Que Dieu te bénisse, je prie pour toi. Je t\'ai envoyé l\'argent aujourd\'hui, ' +
      'dis-moi quand tu le reçois. Les enfants vont bien, ils sont à l\'école. ' +
      'Tu me manques beaucoup, je t\'appellerai demain à Kinshasa. Bonne nuit.',
};
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
/* ── Filtre d'emojis ──────────────────────────────────────────────────────
 * Depuis la tâche F, l'application n'affiche plus aucun emoji : tout est passé
 * en icônes Material. Un texte traduit qui contient encore des emojis détonne
 * dans l'interface, et certains téléphones d'entrée de gamme les rendent en
 * carrés vides. On les retire donc À LA SORTIE du traducteur — les accents, la
 * ponctuation et les chiffres sont conservés.
 * ---------------------------------------------------------------------- */
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2190}-\u{21FF}\u{2900}-\u{297F}\u{FE0F}\u{200D}\u{3030}\u{303D}\u{3297}\u{3299}]/gu;

/** Nettoie un texte traduit : plus d'emoji, plus d'espace doublé. */
function sansEmoji(texte) {
  return String(texte || '')
    .replace(EMOJI, '')
    .replace(/[ \t]{2,}/g, ' ') // l'emoji retiré laisse souvent deux espaces
    .trim();
}

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
        `(démo) Transcription simulée de ta note en ${LANGS[note.lang_from] || note.lang_from}.`,
        `(démo) Traduction simulée en ${LANGS[note.lang_to] || note.lang_to} — la vraie IA s'active avec une clé (gratuite : Groq/NVIDIA, voir guide).`,
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
    if (AMORCES[note.lang_from]) fd.append('prompt', AMORCES[note.lang_from]);
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
            `Tu es un traducteur familial chaleureux, expert du lingala de Kinshasa et du swahili de l'Est du Congo. Le texte provient d'une reconnaissance vocale automatique qui fait souvent des erreurs phonétiques, surtout en lingala et swahili : reconstruis d'abord mentalement la phrase la plus probable d'après le contexte, puis traduis fidèlement du ${LANGS[note.lang_from] || note.lang_from} vers le ${LANGS[note.lang_to] || note.lang_to}. Garde le ton affectueux et naturel d'un message familial.\n${LEXIQUE}\nRéponds UNIQUEMENT avec la traduction, sans commentaire.` },
          { role: 'user', content: transcript },
        ],
      }),
    }), 'traduction');
    if (!cc.ok) throw new Error(`traduction HTTP ${cc.status}`);
    const translation = (await cc.json()).choices?.[0]?.message?.content?.trim() || '';

    await db.run(
      `UPDATE voice_notes SET transcript = ?, translation = ?, status = 'done' WHERE id = ?`,
      [transcript, sansEmoji(translation), id]);
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
  const msg = await db.get('SELECT * FROM messages WHERE id = ? AND kind = \'text\'', [id]);
  if (!msg) return;
  // les messages n'ont pas de colonne status : on traduit si la translation est vide
  if (msg.translation) return; // déjà traduit
  const m = mode();

  if (m === 'off') {
    // messages n'a pas de colonne status, on laisse translation vide (= 'off')
    return;
    return;
  }

  if (m === 'demo') {
    await new Promise((r) => setTimeout(r, 1200));
    await db.run(
      `UPDATE messages SET translation = ? WHERE id = ?`,
      [`(démo) Traduction simulée en ${LANGS[msg.lang_to] || msg.lang_to} — la vraie IA s'active avec une clé (voir guide).`, id]);
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
            `Tu es un traducteur familial chaleureux, expert du lingala de Kinshasa et du swahili de l'Est du Congo. Traduis fidèlement ce message écrit du ${LANGS[msg.lang_from] || msg.lang_from} vers le ${LANGS[msg.lang_to] || msg.lang_to}. Garde le ton affectueux et naturel d'un message familial, mais n'utilise AUCUN emoji ni pictogramme.\n${LEXIQUE}\nRéponds UNIQUEMENT avec la traduction, sans commentaire.` },
          { role: 'user', content: msg.body },
        ],
      }),
    }), 'traduction message');
    if (!cc.ok) throw new Error(`traduction HTTP ${cc.status}`);
    const translation = (await cc.json()).choices?.[0]?.message?.content?.trim() || '';
    await db.run(
      `UPDATE messages SET translation = ? WHERE id = ?`,
      [sansEmoji(translation), id]);
    console.log(`💬 [MESSAGES] ${id} traduit (${msg.lang_from} → ${msg.lang_to})`);
  } catch (e) {
    console.error(`⚠️ [MESSAGES] Échec traduction ${id} :`, e.message);
    await db.run(`UPDATE text_messages SET status = 'failed' WHERE id = ?`, [id]);
  }
}

module.exports = { processNote, processMessage, mode, LANGS, sansEmoji };
