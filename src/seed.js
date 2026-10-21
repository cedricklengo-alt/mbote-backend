/**
 * Données initiales : grille tarifaire + compte admin + utilisateur de démo.
 *   Admin console : +243900000000 / mot de passe : MboteAdmin2026
 *   Utilisateur démo : +243811112222 (OTP affiché en mode démo)
 * Fonctionne en SQLite (local) comme en PostgreSQL (DATABASE_URL définie).
 */
require('dotenv').config();
const db = require('./db');
const { uid, now, hashPassword } = require('./util');

/* ---- Grille tarifaire (prix de VENTE en centimes/min) ---- */
const RATES = [
  ['24381', 'RDC — Vodacom', '🇨🇩', 9],
  ['24382', 'RDC — Vodacom', '🇨🇩', 9],
  ['24389', 'RDC — Orange', '🇨🇩', 10],
  ['24384', 'RDC — Orange', '🇨🇩', 10],
  ['24385', 'RDC — Orange', '🇨🇩', 10],
  ['24399', 'RDC — Airtel', '🇨🇩', 11],
  ['24397', 'RDC — Airtel', '🇨🇩', 11],
  ['243',   'RDC — Autres', '🇨🇩', 12],
  ['242',   'Congo-Brazzaville', '🇨🇬', 14],
  ['225',   "Côte d'Ivoire", '🇨🇮', 14],
  ['221',   'Sénégal', '🇸🇳', 13],
  ['237',   'Cameroun', '🇨🇲', 13],
  ['234',   'Nigeria', '🇳🇬', 8],
  ['254',   'Kenya', '🇰🇪', 9],
  ['27',    'Afrique du Sud', '🇿🇦', 7],
  ['32',    'Belgique', '🇧🇪', 5],
  ['33',    'France', '🇫🇷', 4],
  ['1',     'USA / Canada', '🇺🇸', 3],
  ['44',    'Royaume-Uni', '🇬🇧', 4],
];

async function main() {
  await db.init();
  console.log(`🗄️  Base de données : ${db.name}`);

  await db.tx(async (t) => {
    const count = await t.get('SELECT COUNT(*) n FROM rates');
    if (Number(count.n) === 0) {
      for (const r of RATES)
        await t.run('INSERT INTO rates(prefix,destination,flag,price_per_min_cents) VALUES(?,?,?,?)', r);
      console.log(`✅ ${RATES.length} tarifs insérés`);
    }

    // Admin : créé s'il n'existe pas, et mot de passe RESYNCHRONISÉ à chaque démarrage
    // (modifiable via la variable d'environnement ADMIN_PASSWORD)
    const ADMIN_PASS = process.env.ADMIN_PASSWORD || 'MboteAdmin2026';
    const admin = await t.get(`SELECT * FROM users WHERE role = 'admin'`);
    if (!admin) {
      const id = uid('u');
      await t.run('INSERT INTO users(id,phone,name,role,password_hash,created_at) VALUES(?,?,?,?,?,?)',
        [id, '+243900000000', 'Admin Mbote', 'admin', hashPassword(ADMIN_PASS), now()]);
      await t.run('INSERT INTO wallets(user_id) VALUES(?)', [id]);
      console.log('✅ Admin créé : +243900000000');
    } else {
      await t.run('UPDATE users SET password_hash = ? WHERE id = ?', [hashPassword(ADMIN_PASS), admin.id]);
      console.log('✅ Mot de passe admin resynchronisé');
    }

    const demo = await t.get('SELECT 1 x FROM users WHERE phone = ?', ['+243811112222']);
    if (!demo) {
      const id = uid('u');
      await t.run('INSERT INTO users(id,phone,name,created_at) VALUES(?,?,?,?)',
        [id, '+243811112222', 'Papa Jean', now()]);
      await t.run('INSERT INTO wallets(user_id,balance_cents) VALUES(?,?)', [id, 1250]); // 12,50 $
      await t.run('INSERT INTO transactions(id,user_id,type,amount_cents,method,reference,created_at) VALUES(?,?,?,?,?,?,?)',
        [uid('tx'), id, 'topup', 1250, 'mpesa', 'Recharge initiale démo', now()]);
      await t.run('INSERT INTO contacts(id,user_id,name,phone) VALUES(?,?,?,?)', [uid('ct'), id, 'Maman Nzuzi', '+243812345678']);
      await t.run('INSERT INTO contacts(id,user_id,name,phone) VALUES(?,?,?,?)', [uid('ct'), id, 'Didier Frère', '+243991234567']);
      await t.run('INSERT INTO contacts(id,user_id,name,phone) VALUES(?,?,?,?)', [uid('ct'), id, 'Tantine Aya', '+2250701234567']);
      console.log('✅ Utilisateur démo : +243811112222 (solde 12,50 $)');
    }
  });

  console.log('🌱 Seed terminé.');
  process.exit(0);
}

main().catch((e) => {
  console.error('💥 Seed échoué :', e);
  process.exit(1);
});
