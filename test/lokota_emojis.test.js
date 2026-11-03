/**
 * Filtre d'emojis sur les traductions Lokota.
 *
 * Constaté en production : la traduction d'un message de test est revenue sous
 * la forme « Mbote, oyo ezali test ya solo 😊 ». L'application n'affiche plus
 * aucun emoji (tâche F : tout est en icônes Material), et certains téléphones
 * d'entrée de gamme rendent ces caractères en carrés vides.
 *
 * Ces vérifications portent sur la fonction de nettoyage, sans IA ni base.
 * Lancement :  node test/lokota_emojis.test.js
 */
const fs = require('fs');
const path = require('path');
const { sansEmoji } = require('../src/services/lokota.js');

let pass = 0, fail = 0;
const ok = (label, cond, detail) => {
  if (cond) { console.log(`  ✓ ${label}`); pass++; }
  else { console.log(`  ✗ ${label}${detail !== undefined ? ' → ' + JSON.stringify(detail) : ''}`); fail++; }
};

const nettoie = (avant) => sansEmoji(avant);

console.log('1. Emojis retirés');
ok('emoji en fin de phrase (cas réel de production)',
  nettoie('Mbote, oyo ezali test ya solo 😊') === 'Mbote, oyo ezali test ya solo',
  nettoie('Mbote, oyo ezali test ya solo 😊'));
ok('coche ✅ et main 👋 au milieu',
  nettoie('Bien reçu ✅ ! À demain 👋🏽') === 'Bien reçu ! À demain',
  nettoie('Bien reçu ✅ ! À demain 👋🏽'));
ok('emoji avec carnation 🏽 retiré entièrement',
  !/[\u{1F000}-\u{1FAFF}]/u.test(nettoie('Salut 👋🏽 toi')));
ok('cœurs multiples', nettoie('Nakupenda ❤️❤️') === 'Nakupenda',
  nettoie('Nakupenda ❤️❤️'));
ok('séparateur invisible (ZWJ) retiré',
  !/\u200D/.test(nettoie('Famille 👨‍👩‍👧 ici')));

console.log('\n2. Le texte utile est conservé');
ok('accents et apostrophes',
  nettoie("Ça coûte 1 $ par minute, d'accord ?") === "Ça coûte 1 $ par minute, d'accord ?",
  nettoie("Ça coûte 1 $ par minute, d'accord ?"));
ok('lingala sans emoji intact',
  nettoie('Nazali na ndako, yo?') === 'Nazali na ndako, yo?',
  nettoie('Nazali na ndako, yo?'));
ok('swahili sans emoji intact',
  nettoie('Habari ya asubuhi, rafiki') === 'Habari ya asubuhi, rafiki');
ok('l’espace avant le point d’interrogation du français est gardé',
  nettoie('Ça va ?').includes(' ?'), nettoie('Ça va ?'));

console.log('\n3. Cas limites');
ok('chaîne vide', nettoie('') === '');
ok('valeur nulle', nettoie(null) === '');
ok('valeur indéfinie', nettoie(undefined) === '');
ok('espaces seuls', nettoie('   ') === '');
ok('emoji seul', nettoie('😊') === '');
ok('double espace laissé par un emoji retiré', nettoie('Bonjour 😊 monde') === 'Bonjour monde',
  nettoie('Bonjour 😊 monde'));

console.log('\n4. La consigne donnée au modèle ne réclame plus d’emojis');
const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'lokota.js'), 'utf8');
ok('« y compris les emojis » n’est plus demandé', !/y compris les emojis/.test(src));
ok('la consigne interdit explicitement les emojis', /n'utilise AUCUN emoji/.test(src));
ok('la traduction des notes vocales est nettoyée', /sansEmoji\(translation\)/.test(src));
const nbNettoyages = (src.match(/sansEmoji\(translation\)/g) || []).length;
ok('les deux chemins (message et note vocale) sont nettoyés', nbNettoyages === 2, nbNettoyages);

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} réussis · ${fail} échoués`);
process.exit(fail === 0 ? 0 : 1);
