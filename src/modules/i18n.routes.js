// 🗣️ i18n — langues téléchargeables par l'application MboteCall.
// Routes PUBLIQUES (pas d'authentification nécessaire) :
//   GET /api/i18n        → liste des langues téléchargeables [{code, name}]
//   GET /api/i18n/:code  → pack complet {code, name, strings:{...}}
// Pour ajouter une langue plus tard : ajouter une entrée dans PACKS, redéployer.

const express = require('express');
const router = express.Router();

const PACKS = {
  en: {
    name: 'English',
    strings: {
      hello: 'Mbote!',
      you: 'You',
      my_credit: 'MY CREDIT',
      min_to_drc: 'min to DRC',
      topup: '+ Top up',
      send_credit: 'Send credit',
      invite: 'Invite friends',
      favorites: 'Favorites',
      add: '+ Add',
      empty_fav: 'Add your loved ones to call them in one tap',
      low_credit: 'Credit almost gone — top up to keep calling your loved ones',
      profile: 'Profile',
      edit_name: 'Edit my name',
      rates_by_dest: 'Rates by destination',
      language: 'Language · Monɔkɔ · Lugha',
      logout: 'Log out',
      referral_title: 'Invite your loved ones',
      referral_body: 'Share your code: your friend gets $1 on their first call, and so do you!',
      referral_code: 'My referral code',
      referral_stats: 'referral(s) · earned',
      copy: 'Copy',
      copied: 'Code copied! Share it on WhatsApp',
      share_invite: 'Share the invitation',
      invite_message: 'Mbote! I call home with MboteCall, the app that lets me call DRC at low rates\n\n MboteCall → MboteCall calls 100% free\n Per-second rates to every GSM, even without Internet on the other side\n Remote Vodacom, Orange, Airtel airtime top-up\n\n Download the app and enter my code %CODE% when you sign up: you get $1 free on your first call!',
      transfer_title: 'Send credit',
      transfer_sub: "Credit arrives instantly on your loved one's MboteCall account.",
      recipient: 'Recipient number',
      amount: 'Amount',
      send: 'Send',
      sent_ok: 'Credit sent to',
      have_code: 'I have a referral code (optional)',
      promo_until: 'Enjoy it!',
      free_call: 'FREE',
      free_mbote: 'Free MboteCall call',
      free_package: 'Included in your package',
      packages_title: 'Packages & Passes',
      packages_sub: 'Pay once, call worry-free.',
      my_packages: 'MY PACKAGES',
      catalog: 'CATALOG',
      unlimited: 'Unlimited',
      remaining: 'remaining',
      expires: 'Expires on',
      buy: 'Buy',
      bought_ok: 'Package activated! Happy calling',
      airtime_title: 'Send GSM airtime',
      airtime_sub: "Top up a loved one's phone in DRC (Vodacom, Orange, Airtel, Africell) from your MboteCall balance.",
      airtime_sent: 'GSM airtime sent to',
      airtime_hist: 'RECENT TOP-UPS',
      pin_title: 'PIN code',
      pin_set: 'Enable PIN code',
      pin_change: 'Change PIN code',
      pin_off: 'Disable PIN code',
      pin_new: 'Choose a 4-digit code',
      pin_confirm: 'Confirm your code',
      pin_enter: 'Enter your PIN code',
      pin_wrong: 'Wrong code, try again',
      pin_saved: 'PIN code enabled',
      pin_removed: 'PIN code disabled',
      contacts_title: 'My contacts',
      contacts_all: 'See all my contacts',
      contacts_search: 'Search a contact…',
      contacts_perm: 'Allow access to your contacts to instantly spot the ones already on MboteCall',
      contacts_allow: 'Allow access',
      contacts_empty: 'No contact found',
      on_mbote: 'MboteCall',
      pick_contact: 'Pick from my contacts',
      nav_home: 'Home',
      nav_keypad: 'Keypad',
      nav_history: 'History',
      nav_profile: 'Profile',
      settings: 'Settings',
      theme_label: 'Theme',
      font_label: 'Font',
      about: 'About the app',
      about_text: 'MboteCall v1.3\n\nCall home, as if you were there.\n\nPer-second calls to every GSM in Africa, free calls between users, packages, credit transfer and remote GSM top-up.',
      lang_more: 'Download new languages',
      downloading: 'Downloading…',
      downloaded: 'Language installed',
      history_all: 'All',
      history_in: 'Incoming',
      history_out: 'Outgoing',
      history_missed: 'Missed',
      history_empty: 'No call in this category',
    },
  },
};

// Liste des langues disponibles au téléchargement
router.get('/', (req, res) => {
  res.json(Object.entries(PACKS).map(([code, p]) => ({ code, name: p.name })));
});

// Pack complet d'une langue
router.get('/:code', (req, res) => {
  const pack = PACKS[req.params.code];
  if (!pack) return res.status(404).json({ error: 'Langue inconnue' });
  res.json({ code: req.params.code, name: pack.name, strings: pack.strings });
});

module.exports = router;
