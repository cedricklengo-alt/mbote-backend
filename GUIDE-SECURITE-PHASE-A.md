# 🛡️ GUIDE PHASE A — Serveur TURN + Rotation des secrets

Deux chantiers critiques avant d'accueillir de vrais utilisateurs.
Tout est déjà codé côté serveur et app (v1.8.1) — il ne reste que
la configuration sur Render + les consoles externes.

---

# 1️⃣ SERVEUR TURN (fiabilité des appels)

## Pourquoi c'est critique

Sans TURN, ~20-30 % des appels échouent (4G stricte, certains WiFi).
⚠️ **Et l'ancien TURN public gratuit utilisé jusqu'ici (« openrelay »)
a été RETIRÉ par Metered** : il ne faut plus compter dessus du tout.

## Nouvelle architecture (déjà codée)

- Les identifiants TURN vivent **sur le serveur** (variables Render),
  plus jamais dans l'app.
- L'app appelle `GET /api/rtc/ice` (route protégée par jeton) au début
  de chaque session d'appel pour recevoir la liste STUN/TURN.
- Si le serveur est injoignable : repli STUN intégré (appel tenté quand même).
- **Rotation TURN = changer 2 variables sur Render.** Aucune recompilation.

## Configuration Metered.ca (~10 min, gratuit)

1. Crée un compte sur **https://dashboard.metered.ca/signup** (offre
   TURN gratuite : ~20 Go/mois, largement assez pour le pilote —
   la voix consomme ~0,5 Mo/min seulement quand le relais est utilisé).
2. Crée une app → onglet **TURN Server** → note le **username** et le
   **credential** générés.
3. Sur le plan gratuit, le domaine est `standard.relay.metered.ca`.
4. Render → Environment → ajoute :

```
TURN_URLS=turn:standard.relay.metered.ca:80,turn:standard.relay.metered.ca:80?transport=tcp,turn:standard.relay.metered.ca:443,turns:standard.relay.metered.ca:443?transport=tcp
TURN_USERNAME=<ton username Metered>
TURN_CREDENTIAL=<ton credential Metered>
```

5. Redéploie. Vérification : connecté dans l'app, un appel doit
   fonctionner même en 4G des deux côtés. (Techniquement :
   `GET /api/rtc/ice` avec un jeton doit renvoyer `"turn": true`.)

Les 4 URLs couvrent tous les cas : UDP, TCP (pare-feu), et TLS sur 443
(réseaux qui ne laissent passer que le HTTPS).

Alternative plus tard (Phase B/C, trafic élevé) : ton propre **coturn**
sur un VPS à 5 $/mois — mêmes variables, rien d'autre à changer.

---

# 2️⃣ ROTATION DES SECRETS

Les secrets actuels ont circulé pendant le développement (chats, zips).
Avant tout vrai utilisateur, on les remplace TOUS. Ordre conseillé :

## A. Mot de passe de la base Neon (5 min)

1. **https://console.neon.tech** → ton projet → Roles (ou Branches →
   ton rôle) → **Reset password** → copie la nouvelle chaîne de connexion.
2. Render → Environment → remplace `DATABASE_URL` par la nouvelle.
3. Redéploie. L'ancienne chaîne est morte instantanément. ✅

## B. Clé JWT — SANS déconnecter les utilisateurs (déjà codé)

Le serveur accepte désormais **deux clés** pendant la transition :

1. Génère une nouvelle clé forte (64 caractères hexadécimaux) :
   PowerShell → `-join ((1..64) | ForEach-Object { '{0:x}' -f (Get-Random -Max 16) })`
2. Render → Environment :
   - `JWT_SECRET` = **la nouvelle clé**
   - `JWT_SECRET_OLD` = l'ancienne (`mbote-prod-7f3a…`)
3. Redéploie → personne n'est déconnecté : les anciens jetons restent
   lus, les nouveaux sont signés avec la nouvelle clé.
4. **Dans 30 jours** (durée de vie max d'un jeton) : supprime
   `JWT_SECRET_OLD` → rotation terminée, l'ancienne clé est morte.

(Pendant le pilote, tu peux aussi sauter l'étape douce : changer
`JWT_SECRET` sans `JWT_SECRET_OLD` déconnecte tout le monde — ils se
reconnectent par SMS, acceptable avec 20 testeurs.)

## C. Mot de passe admin console (2 min)

Render → Environment → `ADMIN_PASSWORD=<nouveau mot de passe fort>`
→ redéploie. Le seed le resynchronise au démarrage. N'utilise plus
jamais « MboteAdmin2026 ».

## D. Clé API Africa's Talking

Si la clé a déjà transité par un chat/mail : Dashboard AT → Settings →
régénère l'API Key → mets à jour `AT_API_KEY` sur Render.

## E. Hygiène continue

- Un secret ne se partage JAMAIS par WhatsApp/mail : seulement saisi
  directement dans Render → Environment.
- Rotation planifiée : tous les 6 mois, ou immédiatement après le
  départ d'un prestataire / une fuite suspectée.
- `TURN_CREDENTIAL` : régénérable en 1 min dans Metered → mise à jour
  de la variable → c'est tout (l'app suit automatiquement).

---

# ✅ Check-list finale Phase A

| # | Action | Où | Fait |
|---|--------|----|------|
| 1 | Redéployer le backend v1.8.1 (`mbote-backend-deploy.zip`) | Render | ☐ |
| 2 | `AT_USERNAME` + `AT_API_KEY` (SMS réels) | Render | ☐ |
| 3 | Compte Metered + `TURN_URLS`/`TURN_USERNAME`/`TURN_CREDENTIAL` | Metered + Render | ☐ |
| 4 | Reset mot de passe Neon → `DATABASE_URL` | Neon + Render | ☐ |
| 5 | Nouvelle `JWT_SECRET` (+ `JWT_SECRET_OLD` 30 j) | Render | ☐ |
| 6 | `ADMIN_PASSWORD` fort | Render | ☐ |
| 7 | Recompiler l'app v1.8.1 (elle lit le TURN via le serveur) | PC | ☐ |
| 8 | Test : appel 4G↔4G + SMS OTP sur vrai numéro | téléphones | ☐ |

Après ça : **MboteCall est prêt pour le pilote 20 familles.** 🚀
