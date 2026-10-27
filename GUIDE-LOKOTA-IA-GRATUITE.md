# 🗣️ GUIDE — Activer les VRAIES traductions Lokota GRATUITEMENT

Lokota a besoin de deux services IA :
1. **Transcription** (audio → texte) : modèle Whisper
2. **Traduction** (texte → texte) : un modèle de langage

Le serveur MboteCall parle désormais le protocole « OpenAI-compatible » :
tu peux brancher **OpenAI (payant)**, **Groq (gratuit)** ou **NVIDIA
(gratuit)** en changeant simplement des variables sur Render. Aucune
recompilation, aucun changement de code.

---

## 💚 RECETTE 1 (recommandée) — Groq : UNE clé gratuite pour tout

Groq héberge gratuitement Whisper ET des modèles de traduction.
Limites gratuites : ~2 000 transcriptions/jour, 1 000 traductions/jour
→ très largement assez pour le pilote 20 familles.

1. Va sur **https://console.groq.com** → crée un compte (gratuit, sans
   carte bancaire).
2. Menu **API Keys** → **Create API Key** → copie la clé (`gsk_…`).
3. Render → Environment → ajoute :

```
LOKOTA_API_KEY=gsk_...ta clé...
LOKOTA_STT_URL=https://api.groq.com/openai/v1/audio/transcriptions
LOKOTA_STT_MODEL=whisper-large-v3
LOKOTA_LLM_URL=https://api.groq.com/openai/v1/chat/completions
LOKOTA_LLM_MODEL=llama-3.3-70b-versatile
```

4. Save → redéploiement → envoie une note Lokota → la vraie
   transcription + traduction apparaissent (plus de 🧪).

## 💚 RECETTE 2 — NVIDIA pour la traduction (+ Groq pour l'audio)

NVIDIA (build.nvidia.com) offre une clé gratuite (`nvapi-…`, ~40
requêtes/min) pour ses modèles de langage, via une API compatible.
Son Whisper hébergé n'utilise pas le protocole standard → on garde
Groq pour l'audio et on confie la traduction à NVIDIA :

1. **https://build.nvidia.com** → connecte-toi (compte développeur
   NVIDIA gratuit) → ouvre un modèle (ex. « llama-3.3-70b-instruct »)
   → bouton **Get API Key** → copie la clé `nvapi-…` (affichée une
   seule fois !).
2. Render → Environment :

```
LOKOTA_API_KEY=gsk_...clé Groq (pour l'audio)...
LOKOTA_STT_URL=https://api.groq.com/openai/v1/audio/transcriptions
LOKOTA_STT_MODEL=whisper-large-v3
LOKOTA_LLM_KEY=nvapi-...ta clé NVIDIA...
LOKOTA_LLM_URL=https://integrate.api.nvidia.com/v1/chat/completions
LOKOTA_LLM_MODEL=meta/llama-3.3-70b-instruct
```

## 💰 RECETTE 3 — OpenAI (payant, la référence qualité)

Une seule variable : `LOKOTA_API_KEY=sk-…` (rien d'autre à régler,
les valeurs par défaut pointent sur OpenAI). Coût ≈ 0,006 $ par
minute de note (~5 $ = plus de 800 minutes).

---

## ⚠️ À savoir honnêtement

- **Lingala** : Whisper le connaît (code `ln`) mais moins bien que le
  français ou le swahili. Les transcriptions lingala seront parfois
  approximatives — c'est vrai chez TOUS les fournisseurs aujourd'hui.
  C'est précisément l'opportunité long terme de MBOTE (corpus Lokota).
- **Conditions gratuites** : NVIDIA réserve officiellement sa clé
  gratuite au développement/test (pas à la production), Groq impose
  des quotas journaliers. Pour le pilote c'est parfait ; au-delà de
  quelques centaines d'utilisateurs actifs, on passera sur OpenAI
  payant ou un contrat — à ce stade tu auras des revenus.
- **Confidentialité** : les audios partent chez le fournisseur choisi
  (serveurs US). À mentionner dans la future page de confidentialité
  (audit design n°2, correction 3.1).
- **Si la traduction échoue** (quota dépassé, panne) : la note reste
  écoutable, statut « échec » affiché — rien ne se perd.

## 🔁 Changer de fournisseur = changer les variables. C'est tout.
