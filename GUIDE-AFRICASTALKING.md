# 📲 GUIDE — Activer les VRAIS SMS avec Africa's Talking

MboteCall envoie désormais par vrai SMS :
- le **code OTP** d'inscription / connexion ;
- le **code de réinitialisation du PIN** (protocole sécurité v1.7.2).

Dès que les clés sont en place, **plus besoin de regarder les logs Render** :
le code arrive directement sur le téléphone. Sans les clés, rien ne change
(mode démo actuel).

---

## Étape 1 — Récupérer tes identifiants (5 min)

1. Connecte-toi sur **https://account.africastalking.com**
2. Deux environnements existent :
   - **Sandbox** (test) : username = `sandbox` — les SMS ne partent PAS
     vraiment, ils s'affichent dans le simulateur du dashboard.
   - **Production** : crée une app (bouton « Create new app ») → son
     **username** est celui qu'il faudra mettre.
3. Récupère la **clé API** : Dashboard → Settings → **API Key**
   (⚠️ elle ne s'affiche qu'une fois — copie-la tout de suite).
4. **Crédit SMS** : en production il faut un petit solde
   (Dashboard → Billing → Top up). Vérifie le tarif RDC dans
   Dashboard → SMS → Pricing (Congo DRC).

## Étape 2 — Variables d'environnement sur Render (2 min)

Render → ton service `mbote-backend` → **Environment** → ajouter :

| Variable       | Valeur                                   |
|----------------|------------------------------------------|
| `AT_USERNAME`  | le username de ton app (ou `sandbox` pour tester) |
| `AT_API_KEY`   | ta clé API                               |
| `AT_SENDER_ID` | *(optionnel)* ton nom d'expéditeur approuvé |

Sans `AT_SENDER_ID`, les SMS partent avec l'expéditeur par défaut
**AFRICASTKNG** — parfait pour démarrer. Pour afficher « MBOTECALL »
comme expéditeur, il faut demander un **Sender ID alphanumérique**
dans le dashboard (SMS → Sender IDs) : approbation en 2 à 5 jours
ouvrés, lettre à en-tête demandée selon les pays.

## Étape 3 — Redéployer et tester

1. **Redéploie** le backend (le zip `mbote-backend-deploy.zip` contient
   le nouveau service SMS) → « Manual Deploy ».
2. Tant que `DEMO_MODE=true` : le SMS réel est envoyé **ET** le code
   reste visible dans les logs — idéal pour vérifier que tout marche
   avec TON numéro réel.
3. Teste depuis l'app avec ton vrai numéro +243… → le SMS doit arriver
   en ~5-15 secondes. Dans les logs Render tu verras :
   `📲 [SMS] Envoyé à +243… — Success, coût …`
4. Quand les SMS arrivent bien : passe `DEMO_MODE=false` → les codes
   ne sont plus jamais exposés (ni réponse API, ni logs pour le PIN).

## Comportement selon la configuration

| Config                        | OTP inscription            | Code reset PIN              |
|-------------------------------|----------------------------|-----------------------------|
| Sans clés AT + démo           | code dans la réponse (app) | code dans les logs          |
| Clés AT + `DEMO_MODE=true`    | SMS réel **et** code démo  | SMS réel **et** log         |
| Clés AT + `DEMO_MODE=false`   | SMS réel uniquement        | SMS réel uniquement         |
| Sans clés AT + démo désactivé | erreur 503 claire          | code dans les logs          |

## En cas d'échec d'envoi

Le serveur journalise la raison exacte (`📲 [SMS] ÉCHEC vers … : raison`) :
- **InsufficientBalance** → recharger le solde Africa's Talking ;
- **InvalidSenderId** → retirer `AT_SENDER_ID` ou attendre l'approbation ;
- **UnsupportedNumberType / InvalidPhoneNumber** → numéro mal formaté
  (il faut le format international `+243…` — l'app le fait déjà) ;
- en production, l'app reçoit une erreur propre (« SMS non envoyé — réessaie »)
  au lieu d'un silence.

## 💡 Bonus possible plus tard

Africa's Talking propose aussi **Airtime** (envoi de crédit téléphonique) :
à terme, la fonction « Crédit GSM » de MboteCall pourrait utiliser la même
plateforme au lieu d'un agrégateur séparé. On garde ça pour la Phase B.
