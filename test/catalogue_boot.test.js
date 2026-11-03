/**
 * Catalogue boutique au démarrage.
 *
 * Constaté en production le 3 novembre 2026 : `GET /api/shop/catalog` répondait
 * `{"packages": []}` — la boutique n'affichait aucun produit. Le remplissage
 * dépendait entièrement de `src/seed.js`, dont l'exécution au démarrage n'est
 * pas garantie selon la commande configurée chez l'hébergeur. Le serveur
 * remplit donc lui-même le catalogue s'il est vide (idempotent).
 *
 * Le cas « catalogue vide » est testé DANS UNE TRANSACTION ANNULÉE : les
 * données réelles ne sont ni supprimées ni modifiées.
 *
 * Lancement :  node test/catalogue_boot.test.js
 */
const db = require('../src/db.js');
const shop = require('../src/services/shop.js');

let pass = 0, fail = 0;
const ok = (label, cond, detail) => {
  if (cond) { console.log(`  ✓ ${label}`); pass++; }
  else { console.log(`  ✗ ${label}${detail !== undefined ? ' → ' + JSON.stringify(detail) : ''}`); fail++; }
};

(async () => {
  await db.init();

  console.log('1. Sur la base courante');
  const avant = Number((await db.get('SELECT COUNT(*) n FROM shop_packages')).n);
  const crees = await shop.ensureCatalog();
  const apres = Number((await db.get('SELECT COUNT(*) n FROM shop_packages')).n);
  ok('un catalogue déjà rempli n’est pas touché', crees === 0 && apres === avant, { avant, crees, apres });
  ok('un second appel ne crée rien non plus', (await shop.ensureCatalog()) === 0);
  const catalogue = await shop.listCatalog();
  ok('le catalogue est lisible', Array.isArray(catalogue) && catalogue.length > 0, catalogue.length);
  ok('chaque forfait a un nom et un prix',
    catalogue.every((p) => p.name && typeof p.price_cents === 'number'));

  console.log('\n2. Sur un catalogue VIDE (transaction annulée à la fin)');
  let nbCrees = 0, nbDansTx = 0, actifs = 0;
  try {
    await db.tx(async () => {
      await db.run('DELETE FROM shop_packages');
      ok('catalogue bien vidé pour le test',
        Number((await db.get('SELECT COUNT(*) n FROM shop_packages')).n) === 0);
      nbCrees = await shop.ensureCatalog();
      nbDansTx = Number((await db.get('SELECT COUNT(*) n FROM shop_packages')).n);
      actifs = (await shop.listCatalog()).length;
      // Annulation volontaire : rien de tout cela ne doit rester en base.
      throw new Error('rollback volontaire');
    });
  } catch (e) {
    if (e.message !== 'rollback volontaire') throw e;
  }
  ok('un catalogue vide est rempli', nbCrees === 2 && nbDansTx === 2, { nbCrees, nbDansTx });
  ok('les forfaits créés sont visibles dans le catalogue', actifs === 2, actifs);

  const final = Number((await db.get('SELECT COUNT(*) n FROM shop_packages')).n);
  ok('la base réelle est intacte après le test', final === apres, { apres, final });

  console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} réussis · ${fail} échoués`);
  process.exit(fail === 0 ? 0 : 1);
})();
