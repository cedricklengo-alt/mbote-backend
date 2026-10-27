# 💰 GUIDE — Activer les VRAIES recharges avec PayPay RDC

Le backend MboteCall sait maintenant encaisser via **PayPay RDC**
(cd-paypay.com) : M-Pesa, Orange Money et Airtel Money par USSD Push.
Sans les clés, rien ne change (recharges simulées comme avant).

---

## Étape 1 — Obtenir ton compte développeur PayPay

1. Va sur **https://cd-paypay.com** → « Développeurs ».
2. Demande un **compte développeur** (formulaire
   https://cd-paypay.com/developer-request). ⚠️ L'activation passe
   par une **validation manuelle** de leur équipe — compte un délai.
3. Une fois approuvé : Dashboard → génère ta **clé API**.
   - `pk_live_…` / `sk_…` → production
   - Il existe aussi un **bac à sable** : https://sandbox.cd-paypay.com/api
4. 💬 Questions à leur poser à l'activation (important) :
   - les **frais exacts** (le site public annonce ~5 % — négocie en
     annonçant tes volumes ; FlexPay était à ~2-3 %) ;
   - le **reversement** : vers quel compte, sous quel délai ;
   - confirmation des statuts (`accepted` → `completed`/`failed`) ;
   - si un **compte en USD** est possible (sinon, voir le taux ci-dessous).

## Étape 2 — Variables sur Render

Render → `mbote-backend` → Environment → **+ Add** :

| Key | Value |
|---|---|
| `PAYPAY_API_KEY` | ta clé PayPay |
| `PAYPAY_CDF_PER_USD` | taux du jour, ex. `2800` |
| `PAYPAY_URL` | *(optionnel)* `https://sandbox.cd-paypay.com/api` pour tester, rien pour la production |

Save → redéploiement. C'est tout : le serveur bascule automatiquement
de la simulation vers PayPay (priorité : PayPay → FlexPay → démo).

## ⚠️ Le taux CDF — à comprendre absolument

- Ton app affiche et crédite des **dollars** (USD).
- PayPay encaisse des **francs congolais** (CDF).
- Le serveur convertit avec `PAYPAY_CDF_PER_USD` : pour une recharge
  de 5 $, il demande `5 × 2800 = 14 000 CDF` au client.
- **Mets le taux réel du marché + un petit coussin** (1-2 %) pour ne
  pas perdre sur les variations, et **mets-le à jour régulièrement**
  (c'est une variable : changement en 30 secondes, sans redéploiement
  de code — juste Save qui relance le service).

## Étape 3 — Tester

1. D'abord en **sandbox** (`PAYPAY_URL` sandbox) : depuis l'app,
   Recharger → montant → M-Pesa → le parcours complet doit se dérouler.
2. Puis en production avec un **petit montant réel** (ex. 1 $) sur ton
   propre numéro : le popup USSD arrive, tu tapes ton PIN, et le solde
   MboteCall se crédite en ~5-15 s.
3. Logs Render : `💰 [PAYPAY] USSD Push → +243… : 14000 CDF (≈ 5.00 $…)`.

## Comment ça marche derrière (pour info)

- L'app crée le paiement → le serveur appelle
  `POST /v1/payments/initiate` → PayPay envoie le push USSD au client.
- Le serveur **interroge le statut** (`GET /v1/transactions/{id}/status`)
  pendant que l'app attend — les webhooks PayPay sont en maintenance,
  mais notre architecture a toujours fonctionné au polling → parfait.
- Le crédit du solde est **idempotent** : impossible de créditer deux
  fois le même paiement, même en cas de double vérification.
- `accepted` = le client n'a pas encore tapé son PIN (en attente) ;
  `completed` = crédité ; `failed` = refusé/annulé.

## 🔁 Changer d'agrégateur plus tard

Rien à coder : retire `PAYPAY_API_KEY` et mets les clés FlexPay
(`FLEXPAY_MERCHANT` + `FLEXPAY_TOKEN`), ou demande-moi d'ajouter
SerdiPay/MaxiCash — c'est un fichier de 60 lignes à chaque fois.
