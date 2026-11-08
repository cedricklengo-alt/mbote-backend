/**
 * Réparation du schéma Postgres : colonnes historiquement BOOLEAN.
 *
 * Contexte réel (déploiement Render, 3 novembre 2026) :
 *   GET  /api/shop/catalog → 500 {"error":"Erreur interne","code":"42883"}
 *   POST /api/shop/orders  → 500
 * La toute première version Postgres du schéma déclarait
 * `shop_packages.active` en BOOLEAN ; elle est depuis en INTEGER, mais
 * `CREATE TABLE IF NOT EXISTS` ne modifie pas une table existante. La base de
 * production avait donc gardé un BOOLEAN, et `WHERE active = 1` échouait avec
 * « operator does not exist: boolean = integer » (code 42883). La boutique
 * était inaccessible alors que tout passait en local (SQLite ne vérifie pas les
 * types) : aucun test ne pouvait l'attraper sans interroger une vraie base.
 *
 * Ces vérifications portent sur la logique de réparation, sans base de données.
 * Lancement :  node test/schema_repair.test.js
 */
const fs = require('fs');
const path = require('path');
const pg = require('../src/db/pg.js');

const { LEGACY_BOOLEAN_COLUMNS, needsBooleanRepair, booleanRepairSql, repairLegacySchema } =
  pg._schema;

let pass = 0, fail = 0;
const ok = (label, cond, detail) => {
  if (cond) { console.log(`  ✓ ${label}`); pass++; }
  else { console.log(`  ✗ ${label}${detail !== undefined ? ' → ' + JSON.stringify(detail) : ''}`); fail++; }
};

/** Faux client Postgres : renvoie le type demandé et enregistre les requêtes. */
function fakeClient(dataTypeOrError) {
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      queries.push({ sql, params });
      if (sql.includes('information_schema')) {
        if (dataTypeOrError instanceof Error) throw dataTypeOrError;
        if (!dataTypeOrError) return { rows: [] }; // colonne/table absente
        return { rows: [{ data_type: dataTypeOrError }] };
      }
      if (dataTypeOrError instanceof Error) throw dataTypeOrError;
      return { rows: [] };
    },
  };
}

(async () => {
  console.log('1. Décision de réparation');
  ok('BOOLEAN doit être réparé', needsBooleanRepair('boolean') === true);
  ok('BOOLEAN en majuscules aussi', needsBooleanRepair('BOOLEAN') === true);
  ok('INTEGER déjà correct', needsBooleanRepair('integer') === false);
  ok('type inconnu : on ne touche à rien', needsBooleanRepair(undefined) === false);
  ok('chaîne vide : on ne touche à rien', needsBooleanRepair('') === false);

  console.log('\n2. Ordres SQL produits');
  const alters = booleanRepairSql({ table: 'shop_packages', column: 'active', defaultValue: 1 });
  ok('trois ordres', alters.length === 3, alters);
  ok('le défaut est retiré d\'abord', /DROP DEFAULT/.test(alters[0]), alters[0]);
  ok('conversion avec USING CASE WHEN', /TYPE INTEGER USING \(CASE WHEN active THEN 1 ELSE 0 END\)/.test(alters[1]), alters[1]);
  ok('défaut remis à 1', /SET DEFAULT 1/.test(alters[2]), alters[2]);
  const gift = booleanRepairSql({ table: 'user_plans', column: 'is_gift', defaultValue: 0 });
  ok('défaut remis à 0 pour is_gift', /SET DEFAULT 0/.test(gift[2]), gift[2]);

  console.log('\n3. Colonnes surveillées');
  const cles = LEGACY_BOOLEAN_COLUMNS.map((c) => `${c.table}.${c.column}`);
  for (const attendu of ['shop_packages.active', 'shop_packages.renewable',
                         'user_plans.unlimited', 'user_plans.is_gift']) {
    ok(`${attendu} surveillée`, cles.includes(attendu), cles);
  }

  console.log('\n4. Application sur une base qui a un BOOLEAN');
  const client = fakeClient('boolean');
  await repairLegacySchema(client);
  const nbAlter = client.queries.filter((q) => q.sql.startsWith('ALTER')).length;
  ok('les colonnes BOOLEAN sont converties', nbAlter === LEGACY_BOOLEAN_COLUMNS.length * 3,
    `${nbAlter} ordres ALTER`);
  ok('introspection passée par information_schema',
    client.queries.filter((q) => q.sql.includes('information_schema')).length ===
      LEGACY_BOOLEAN_COLUMNS.length);

  console.log('\n5. Base déjà correcte : aucune écriture');
  const propre = fakeClient('integer');
  await repairLegacySchema(propre);
  ok('aucun ALTER si tout est INTEGER',
    propre.queries.filter((q) => q.sql.startsWith('ALTER')).length === 0);

  console.log('\n6. Table absente : aucune écriture');
  const vide = fakeClient(null);
  await repairLegacySchema(vide);
  ok('aucune erreur et aucun ALTER si la table n\'existe pas',
    vide.queries.filter((q) => q.sql.startsWith('ALTER')).length === 0);

  console.log('\n7. Base cassée / injoignable : le serveur démarre quand même');
  const casse = fakeClient(new Error('permission denied'));
  let jete = false;
  try { await repairLegacySchema(casse); } catch { jete = true; }
  ok('aucune exception propagée', jete === false);

  console.log('\n8. Le schéma livré déclare bien des INTEGER');
  const schema = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'pg.js'), 'utf8');
  const blocShop = schema.slice(schema.indexOf('CREATE TABLE IF NOT EXISTS shop_packages'),
                                schema.indexOf('CREATE TABLE IF NOT EXISTS shop_orders'));
  ok('shop_packages.active est INTEGER', /\bactive\s+INTEGER\b/.test(blocShop), blocShop.slice(0, 200));
  ok('shop_packages.renewable est INTEGER', /\brenewable\s+INTEGER\b/.test(blocShop));
  ok('plus aucun BOOLEAN dans shop_packages', !/BOOLEAN/.test(blocShop));

  console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} réussis · ${fail} échoués`);
  process.exit(fail === 0 ? 0 : 1);
})();
