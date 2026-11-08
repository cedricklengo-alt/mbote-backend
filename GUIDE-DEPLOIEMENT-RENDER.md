# 🚀 Guide de déploiement Mbote! — Render + PostgreSQL + Flutter

> Version 3.2.0 — Backend Node.js · PostgreSQL Render · Flutter Android

---

## Vue d'ensemble

```
GitHub (code)
  └─→ Render Blueprint (render.yaml)
         ├─→ mbote-db       (PostgreSQL géré, gratuit)
         └─→ mbote-backend  (Node.js Express, gratuit)
                              ↑ appelé par l'app Flutter Android
```

**Durée estimée : 30 à 45 minutes**

---

## PARTIE 1 — Préparer le dépôt GitHub

### 1.1 Créer un dépôt GitHub pour le backend

1. Va sur [github.com](https://github.com) → **New repository**
2. Nom : `mbote-backend`
3. Visibilité : **Private** (recommandé)
4. **Ne coche pas** « Initialize with README »
5. Clique **Create repository**

### 1.2 Pousser le code backend

Depuis le dossier `C:\Users\PC\Pictures\mbote-backend-v3_2_0\` :

```bash
git init
git add .
git commit -m "chore: déploiement initial Mbote! v3.2.0"
git branch -M main
git remote add origin https://github.com/TON_COMPTE/mbote-backend.git
git push -u origin main
```

> **Remplace `TON_COMPTE`** par ton nom d'utilisateur GitHub.

---

## PARTIE 2 — Déployer sur Render via Blueprint

### 2.1 Créer un compte Render

→ [render.com](https://render.com) → **Get Started for Free**  
Connecte-toi avec ton compte GitHub (plus simple).

### 2.2 Déployer via Blueprint (render.yaml)

1. Dashboard Render → **New** → **Blueprint**
2. Connecte ton compte GitHub si ce n'est pas fait
3. Sélectionne le dépôt `mbote-backend`
4. Render détecte automatiquement `render.yaml`
5. Clique **Apply** (ou **Deploy Blueprint**)

Render va créer :
- `mbote-db` — base PostgreSQL gratuite (256 Mo)
- `mbote-backend` — service web Node.js

Le premier déploiement prend **3 à 5 minutes**.

### 2.3 Récupérer l'URL du backend

Une fois déployé :
1. Dashboard Render → **mbote-backend** → onglet **Overview**
2. Note l'URL affichée, exemple :  
   `https://mbote-backend-xxxx.onrender.com`

> ⚠️ Le plan gratuit Render "s'endort" après 15 min d'inactivité.  
> Le premier appel après la veille prend ~30 secondes. C'est normal.

---

## PARTIE 3 — Configurer les variables d'environnement

### 3.1 Accéder aux variables

Dashboard Render → **mbote-backend** → onglet **Environment**

### 3.2 Variables OBLIGATOIRES

#### 🔔 Firebase (notifications push — appels entrants)

Sans cette variable, l'app ne peut pas recevoir d'appels quand elle est fermée.

**Comment obtenir la clé :**
1. [Firebase Console](https://console.firebase.google.com) → ton projet → ⚙️ Paramètres du projet
2. Onglet **Comptes de service**
3. Clic sur **Générer une nouvelle clé privée** → télécharge le JSON
4. Ouvre le fichier JSON dans un éditeur texte
5. **Copie TOUT le contenu** (le JSON entier, sur une seule ligne)
6. Dans Render → Environment → Ajouter :
   - Clé : `FIREBASE_SERVICE_ACCOUNT`
   - Valeur : *(le JSON complet, en une seule ligne)*

> **Astuce** : Pour mettre le JSON sur une seule ligne dans PowerShell :
> ```powershell
> (Get-Content firebase-key.json -Raw) -replace "`n","" -replace "`r","" | Set-Clipboard
> ```

### 3.3 Variables OPTIONNELLES (à activer progressivement)

#### 📱 Twilio — Appels app → GSM réels

Quand tu es prêt à activer les vrais appels GSM :

1. [twilio.com](https://twilio.com) → créer un compte
2. Dashboard → Account SID + Auth Token
3. Console Twilio → API Keys → **Create API Key** (type Standard)
4. Voice → TwiML Apps → Create → URL de voix = `https://TON_URL_RENDER.onrender.com/api/rtc/twiml`
5. Dans Render → Environment :

| Clé | Valeur |
|-----|--------|
| `TWILIO_ACCOUNT_SID` | `ACxxxxxxx` (Dashboard Twilio) |
| `TWILIO_API_KEY` | `SKxxxxxxx` (API Key SID) |
| `TWILIO_API_SECRET` | *(secret de l'API Key)* |
| `TWILIO_TWIML_APP_SID` | `APxxxxxxx` (TwiML App SID) |
| `TWILIO_CALLER_ID` | `+1xxxxxxxxxx` (ton numéro Twilio vérifié) |
| `DEMO_MODE` | `false` ← **important : changer à false** |

#### 🌐 URL publique (webhooks FlexPay)

| Clé | Valeur |
|-----|--------|
| `PUBLIC_URL` | `https://mbote-backend-xxxx.onrender.com` |

#### 📡 Relais TURN (appels sur Wi-Fi d'entreprise/4G stricte)

1. [metered.ca](https://metered.ca) → Free account
2. Dashboard → Application → note le sous-domaine et la clé API

| Clé | Valeur |
|-----|--------|
| `METERED_SUBDOMAIN` | `ton-sous-domaine` |
| `METERED_API_KEY` | `ta-cle-api` |

#### 💳 FlexPay (Mobile Money RDC)

| Clé | Valeur |
|-----|--------|
| `FLEXPAY_MERCHANT` | *(identifiant marchand FlexPay)* |
| `FLEXPAY_TOKEN` | *(token FlexPay)* |
| `FLEXPAY_WEBHOOK_SECRET` | *(secret webhook)* |

---

## PARTIE 4 — Configurer l'app Flutter

### 4.1 Modifier config.dart

Fichier : `lib/config.dart`  
Remplace `[VOTRE_SERVICE]` par le nom de ton service Render :

```dart
static const String apiBase =
    'https://mbote-backend-xxxx.onrender.com/api';
```

Exemple :
```dart
static const String apiBase =
    'https://mbote-backend-a1b2.onrender.com/api';
```

### 4.2 Vérifier google-services.json

Le fichier `android/app/google-services.json` doit être présent.  
*(Tu as confirmé qu'il est déjà configuré ✅)*

### 4.3 Lancer l'application

```bash
cd C:\Users\PC\Pictures\mbote-app-v3_2_0\mbote_app
flutter pub get
flutter run --release
```

> Pour un émulateur Android uniquement (pas de vrai téléphone) :
> ```dart
> // Dans config.dart, utilise :
> static const String apiBase = 'http://10.0.2.2:4000/api';
> ```

---

## PARTIE 5 — Vérifications après déploiement

### 5.1 Tester que le backend répond

Dans ton navigateur ou Postman :

```
GET https://mbote-backend-xxxx.onrender.com/api/health
```

Réponse attendue :
```json
{
  "ok": true,
  "service": "mbote-backend",
  "db": "postgres",
  "push": false,
  "demo_mode": "true"
}
```

> `"db": "postgres"` confirme que PostgreSQL est utilisé ✅  
> `"push": false` = Firebase pas encore configuré  
> `"push": true` = Firebase OK ✅

### 5.2 Tester l'authentification

```bash
curl -X POST https://mbote-backend-xxxx.onrender.com/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"phone":"+243810000001","name":"Test User","password":"Test1234"}'
```

Réponse attendue : `{"token":"...", "user":{...}}`

### 5.3 Vérifier les logs Render

Dashboard Render → **mbote-backend** → onglet **Logs**

Cherche :
```
✅ MboteCall backend démarré sur le port 10000
   Base de données : postgres
```

### 5.4 Console admin

```
https://mbote-backend-xxxx.onrender.com/admin
```

- Login : `admin`
- Mot de passe : `MboteAdmin2026` (ou la valeur de `ADMIN_PASSWORD`)

---

## PARTIE 6 — Fonctionnalités et leur état

| Fonctionnalité | Dépendance | État par défaut |
|----------------|-----------|-----------------|
| ✅ Inscription / Connexion | Backend | Fonctionnel |
| ✅ Messagerie (Lokota) | Backend | Fonctionnel |
| ✅ Feed (Publications) | Backend | Fonctionnel |
| ✅ Portefeuille (Wallet) | Backend | Fonctionnel |
| ✅ Profil utilisateur | Backend | Fonctionnel |
| ✅ Thème clair/sombre | Flutter | Fonctionnel |
| ✅ Langue / Traduction | Flutter | Fonctionnel |
| ✅ Appels audio/vidéo P2P | WebRTC | Fonctionnel (Wi-Fi local) |
| ⚠️ Appels sur 4G/réseau strict | TURN (Metered) | Nécessite config TURN |
| ⚠️ Notifications push | Firebase | Nécessite `FIREBASE_SERVICE_ACCOUNT` |
| ⚠️ Appels app → GSM | Twilio | Nécessite config Twilio |
| ⚠️ Paiement Mobile Money | FlexPay | Nécessite compte marchand |

---

## PARTIE 7 — Problèmes courants

### Le backend répond avec "503 Service Unavailable"

→ Service en veille (plan gratuit). Attendre 30 secondes et réessayer.  
→ Solution permanente : passer au plan **Starter** ($7/mois) sur Render.

### "db error: relation does not exist"

→ Les tables ne se sont pas créées.  
→ Dashboard Render → Logs → cherche l'erreur d'initialisation.  
→ Essaie de redéployer : **Manual Deploy** → **Deploy latest commit**.

### L'app Flutter dit "Connection refused" ou "SocketException"

→ `config.dart` a toujours `[VOTRE_SERVICE]`.  
→ Remplace par l'URL Render exacte puis `flutter run`.

### Les notifications push ne fonctionnent pas

→ `FIREBASE_SERVICE_ACCOUNT` pas configuré dans Render → Environment.  
→ Vérifie que `/api/health` retourne `"push": true`.

### Les appels P2P ne passent pas hors Wi-Fi local

→ Configurer les variables METERED (relais TURN).

### "DEMO_MODE=true" — les OTP sont renvoyés dans la réponse API

→ C'est voulu en développement. Pour la production, garde `DEMO_MODE=true`  
   jusqu'à avoir configuré un vrai service SMS.

---

## Récapitulatif des fichiers modifiés

```
mbote-backend-v3_2_0/
  render.yaml                ← Blueprint Render (PostgreSQL + Web Service)
  src/
    db/
      pg.js                  ← +5 tables feed (posts, stories, likes, etc.)

mbote-app-v3_2_0/
  mbote_app/lib/
    config.dart              ← URL Render à renseigner
```

---

## Ordre de priorité pour une mise en service rapide

1. ✅ Déployer sur Render (Parties 1 + 2)
2. ✅ Mettre à jour `config.dart` avec l'URL Render (Partie 4.1)
3. ✅ Tester le backend `/api/health` (Partie 5.1)
4. ✅ Lancer l'app Flutter (Partie 4.3)
5. 🔔 Configurer Firebase pour les notifications push
6. 📱 Configurer Twilio pour les appels GSM (si besoin)

---

*Guide généré pour Mbote! v3.2.0 — Backend Node.js/Express + PostgreSQL Render + Flutter Android*
