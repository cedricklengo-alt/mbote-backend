/**
 * Configuration STUN/TURN remise aux applications (services/ice.js).
 *
 * Constaté sur le déploiement Render le 3 novembre 2026 : /api/rtc/ice ne
 * renvoyait que des serveurs STUN. Sur les réseaux mobiles congolais, les
 * téléphones sont derrière un NAT symétrique (CGNAT) : sans relais TURN, deux
 * appareils ne trouvent aucun chemin direct, l'appel reste en « Ça sonne… »
 * puis se termine tout seul — d'où le retour « les appels ne passent pas ».
 *
 * Lancement :  node test/rtc_ice.test.js
 */
const {
  STUN_SERVERS, turnUrls, turnConfigured, buildIceServers, startupNotice,
} = require('../src/services/ice');

let pass = 0, fail = 0;
const ok = (label, cond, detail) => {
  if (cond) { console.log(`  ✓ ${label}`); pass++; }
  else { console.log(`  ✗ ${label}${detail !== undefined ? ' → ' + JSON.stringify(detail) : ''}`); fail++; }
};

const urlsDe = (serveurs) => serveurs.map((s) => s.urls).flat();

console.log('1. Sans aucune variable d’environnement');
const nu = buildIceServers('u_test', {});
ok('des serveurs STUN sont toujours proposés', nu.length === STUN_SERVERS.length, nu);
ok('aucun TURN inventé', !urlsDe(nu).some((u) => /^turns?:/i.test(u)), urlsDe(nu));
ok('pas de faux STUN (stun.relay.metered.ca retiré)',
  !urlsDe(nu).includes('stun:stun.relay.metered.ca:80'), urlsDe(nu));
ok('turnConfigured() est faux', turnConfigured({}) === false);

console.log('\n2. Identifiants TURN fixes (Metered, Cloudflare, Twilio…)');
const fixe = {
  TURN_URLS: 'turn:relay.example.com:80, turn:relay.example.com:443 ,n-importe-quoi',
  TURN_USERNAME: 'mbote',
  TURN_CREDENTIAL: 'secret-123',
};
ok('TURN_URLS est nettoyé (espaces, entrées parasites)',
  turnUrls(fixe).length === 2, turnUrls(fixe));
ok('les adresses non turn: sont ignorées', !turnUrls(fixe).includes('n-importe-quoi'));
ok('turnConfigured() est vrai', turnConfigured(fixe) === true);
const avecTurn = buildIceServers('u_test', fixe);
const entreeTurn = avecTurn.find((s) => String(s.urls).includes('turn:'));
ok('le relais TURN est envoyé', !!entreeTurn, avecTurn);
ok('les identifiants accompagnent le relais',
  entreeTurn && entreeTurn.username === 'mbote' && entreeTurn.credential === 'secret-123', entreeTurn);
ok('les deux adresses TURN sont transmises ensemble',
  entreeTurn && Array.isArray(entreeTurn.urls) && entreeTurn.urls.length === 2, entreeTurn && entreeTurn.urls);
ok('le STUN reste présent en plus du TURN',
  urlsDe(avecTurn).some((u) => u.startsWith('stun:')));

console.log('\n3. Identifiants éphémères (coturn mode REST)');
const coturn = { TURN_URLS: 'turn:coturn.example.com:3478', TURN_SHARED_SECRET: 'cle-partagee' };
const eph = buildIceServers('u_42', coturn, (secret, texte) => `hmac(${secret}|${texte})`);
const turnEph = eph.find((s) => String(s.urls).includes('turn:'));
ok('le relais est envoyé', !!turnEph, eph);
ok('le nom d’utilisateur contient l’expiration et l’identifiant',
  /^\d{10}:u_42$/.test(turnEph.username), turnEph && turnEph.username);
ok('le mot de passe est signé avec le secret',
  turnEph.credential === `hmac(cle-partagee|${turnEph.username})`, turnEph.credential);
const expiration = Number(turnEph.username.split(':')[0]) * 1000;
ok('l’identifiant expire dans environ une heure',
  expiration - Date.now() > 55 * 60_000 && expiration - Date.now() < 65 * 60_000,
  Math.round((expiration - Date.now()) / 60000) + ' min');

console.log('\n4. Configurations incomplètes');
ok('TURN_URLS sans identifiants → STUN seulement',
  buildIceServers('u', { TURN_URLS: 'turn:x:80' }).every((s) => !String(s.urls).includes('turn:')));
ok('identifiants sans TURN_URLS → STUN seulement',
  buildIceServers('u', { TURN_USERNAME: 'a', TURN_CREDENTIAL: 'b' }).every((s) => !String(s.urls).includes('turn:')));
ok('TURN_URLS avec seulement un nom d’utilisateur → STUN seulement',
  buildIceServers('u', { TURN_URLS: 'turn:x:80', TURN_USERNAME: 'a' }).every((s) => !String(s.urls).includes('turn:')));

console.log('\n5. Message de démarrage');
ok('sans TURN : avertissement explicite', /Aucun relais TURN/.test(startupNotice({})));
ok('avec TURN : confirmation', /Relais TURN configuré/.test(startupNotice(fixe)));
ok('l’avertissement parle du CGNAT', /CGNAT/.test(startupNotice({})));

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} réussis · ${fail} échoués`);
process.exit(fail === 0 ? 0 : 1);
