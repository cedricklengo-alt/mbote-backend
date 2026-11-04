/**
 * Test de l'extraction des hashtags depuis le texte d'une publication
 * (normalisation, accents, chiffres, underscore, dédup, faux positifs).
 *
 * Lancement :  node test/hashtags.test.js
 */
const ts = require('../src/services/texte_social');

let pass = 0, fail = 0;
const ok = (label, cond) => {
  if (cond) { console.log(`  ✓ ${label}`); pass++; }
  else { console.log(`  ✗ ${label}`); fail++; }
};

const texte = 'Aujourd’hui, nouvelle étape ! La communauté grandit.\n\n'
  + '#Innovation #Technologie #RDC #RDC #technologie #Pro_jet #Tech2026 email@test.com #Café';
const cles = ts.extraireHashtags(texte).map(t => t.cle);

ok('lettres + majuscules normalisées', cles.includes('innovation'));
ok('doublon supprimé (#RDC x2, #technologie)', cles.filter(c => c === 'rdc').length === 1
   && cles.filter(c => c === 'technologie').length === 1);
ok('chiffres acceptés (#Tech2026)', cles.includes('tech2026'));
ok('underscore accepté (#Pro_jet)', cles.includes('pro_jet'));
ok('accents normalisés (#Café → cafe)', cles.includes('cafe'));
ok('email ignoré (pas de faux positif)', !cles.some(c => c.includes('test') || c.includes('com')));
ok('hashtag en début/milieu/fin détecté', cles.length >= 5);
ok('ordre d\'apparition conservé', cles[0] === 'innovation' && cles[1] === 'technologie');

// Délimitation : # collé à un mot n'est pas un hashtag.
const colle = ts.extraireHashtags('mot#Tag fin').map(t => t.cle);
ok('# collé à un mot ignoré', colle.length === 0);

// Hashtag trop court (<2) ignoré.
ok('#a trop court ignoré', ts.extraireHashtags('#a #ab').map(t => t.cle).join() === 'ab');

console.log(`\n${pass} ✓ / ${fail} ✗`);
process.exit(fail ? 1 : 0);
