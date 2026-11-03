/**
 * Tests du DRIVER de base de données (SQLite en local) — atomicité, réentrance
 * et concurrence. Ces tests protègent contre les pannes les plus graves :
 * un serveur figé (deadlock) ou de l'argent qui apparaît / disparaît.
 *
 * Lancement :  node test/db_tx.test.js
 */
const db = require('../src/db');

let pass = 0, fail = 0;
const ok = (label, cond, detail) => {
  if (cond) { console.log(`  ✓ ${label}`); pass++; }
  else { console.log(`  ✗ ${label}${detail !== undefined ? ' → ' + JSON.stringify(detail) : ''}`); fail++; }
};

const withTimeout = (p, ms, label) => Promise.race([
  p,
  new Promise((_, rej) => setTimeout(() => rej(new Error(`BLOCAGE (> ${ms} ms) : ${label}`)), ms)),
]);

const P = '+0000dbtx';
const cleanup = async () => {
  await db.run('DELETE FROM transactions WHERE user_id = ?', [P]);
  await db.run('DELETE FROM wallets WHERE user_id = ?', [P]);
  await db.run('DELETE FROM users WHERE id = ?', [P]);
};

(async () => {
  await db.init();
  await cleanup();
  await db.run('INSERT INTO users(id, phone, name, created_at) VALUES(?,?,?,?)',
    [P, '+000000000001', 'Tx Test', Date.now()]);
  await db.run('INSERT INTO wallets(user_id, balance_cents) VALUES(?, 1000)', [P]);
  const solde = async () => (await db.get('SELECT balance_cents FROM wallets WHERE user_id = ?', [P])).balance_cents;

  try {
    // ─────────────── 1. Réentrance ───────────────
    console.log('1. Appels db.* à l’intérieur d’un db.tx');
    const r1 = await withTimeout(db.tx(async (t) => {
      await t.run('UPDATE wallets SET balance_cents = 500 WHERE user_id = ?', [P]);
      // ⚠️ Appel du module (pas de `t`) : auparavant → blocage définitif
      const vu = await db.get('SELECT balance_cents FROM wallets WHERE user_id = ?', [P]);
      await db.run('UPDATE wallets SET balance_cents = 600 WHERE user_id = ?', [P]);
      return vu;
    }), 3000, 'db.get dans db.tx');
    ok('db.get dans db.tx ne bloque pas', r1 !== undefined, r1);
    ok('db.get voit les écritures non validées de la transaction', r1.balance_cents === 500, r1);
    ok('db.run dans db.tx est bien validé', (await solde()) === 600, await solde());

    // ─────────────── 2. Annulation ───────────────
    console.log('\n2. Annulation (ROLLBACK)');
    await withTimeout(db.tx(async (t) => {
      await t.run('UPDATE wallets SET balance_cents = 0 WHERE user_id = ?', [P]);
      throw new Error('panne simulée');
    }), 3000, 'tx en échec').catch(e => ok('la transaction remonte l’erreur', /panne simulée/.test(e.message), e.message));
    ok('ROLLBACK : solde inchangé après erreur', (await solde()) === 600, await solde());

    await withTimeout(db.tx(async (t) => {
      await t.run('UPDATE wallets SET balance_cents = 0 WHERE user_id = ?', [P]);
      await db.run('UPDATE wallets SET balance_cents = 1 WHERE user_id = ?', [P]); // via le module
      throw new Error('panne');
    }), 3000, 'tx mixte').catch(() => {});
    ok('ROLLBACK : les écritures db.run internes sont annulées aussi', (await solde()) === 600, await solde());

    // ─────────────── 3. Sous-transactions (SAVEPOINT) ───────────────
    console.log('\n3. db.tx imbriquée (SAVEPOINT)');
    const r3 = await withTimeout(db.tx(async (t) => {
      await t.run('UPDATE wallets SET balance_cents = 700 WHERE user_id = ?', [P]);
      return db.tx(async () => {
        await db.run('UPDATE wallets SET balance_cents = 800 WHERE user_id = ?', [P]);
        return 'interne';
      });
    }), 3000, 'tx imbriquée');
    ok('transaction imbriquée exécutée', r3 === 'interne', r3);
    ok('transaction imbriquée validée avec la parente', (await solde()) === 800, await solde());

    await withTimeout(db.tx(async (t) => {
      await t.run('UPDATE wallets SET balance_cents = 900 WHERE user_id = ?', [P]);
      await db.tx(async () => {
        await db.run('UPDATE wallets SET balance_cents = 111 WHERE user_id = ?', [P]);
        throw new Error('sous-tx en échec');
      }).catch(() => {});
    }), 3000, 'sous-tx en échec');
    ok('sous-transaction en échec : seule la sous-partie est annulée', (await solde()) === 900, await solde());

    // ─────────────── 4. Concurrence ───────────────
    console.log('\n4. Concurrence (100 débits simultanés de 1 ¢)');
    await db.run('UPDATE wallets SET balance_cents = 100 WHERE user_id = ?', [P]);
    await withTimeout(Promise.all(Array.from({ length: 100 }, () => db.tx(async (t) => {
      const w = await t.get('SELECT balance_cents FROM wallets WHERE user_id = ?', [P]);
      await new Promise(r => setTimeout(r, 1));      // laisse la place aux autres
      await t.run('UPDATE wallets SET balance_cents = ? WHERE user_id = ?', [w.balance_cents - 1, P]);
    }))), 20000, '100 transactions concurrentes');
    ok('aucune écriture perdue (solde = 0)', (await solde()) === 0, await solde());

    // ─────────────── 5. Route chaude : transfert réel ───────────────
    console.log('\n5. Transferts concurrents (pas de double dépense)');
    await db.run('UPDATE wallets SET balance_cents = 100 WHERE user_id = ?', [P]);
    const essais = await Promise.all(Array.from({ length: 30 }, () => db.tx(async (t) => {
      const deb = await t.get(
        'UPDATE wallets SET balance_cents = balance_cents - ? WHERE user_id = ? AND balance_cents >= ? RETURNING balance_cents',
        [10, P, 10]);
      return !!deb;
    })));
    const reussis = essais.filter(Boolean).length;
    ok('exactement 10 débits de 10 ¢ acceptés sur 30 tentatives', reussis === 10, reussis);
    ok('le solde ne devient jamais négatif', (await solde()) === 0, await solde());

    // ─────────────── 6. Le serveur reste vivant ───────────────
    console.log('\n6. La file n’est jamais bloquée après une erreur');
    const t0 = Date.now();
    await db.get('SELECT 1 AS un');
    ok('une requête simple répond immédiatement après les tests', Date.now() - t0 < 500, Date.now() - t0);
  } catch (e) {
    console.error('erreur inattendue :', e.message);
    fail++;
  } finally {
    await cleanup();
  }

  console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} réussis · ${fail} échoués`);
  process.exit(fail === 0 ? 0 : 1);
})();
