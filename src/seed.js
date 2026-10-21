/**
 * Données initiales : grille tarifaire + compte admin + utilisateur de démo.
 *   Admin console : +243900000000 / mot de passe : MboteAdmin2026
 *   Utilisateur démo : +243811112222 (OTP affiché en mode démo)
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

const seed = db.transaction(() => {
  if (db.prepare('SELECT COUNT(*) n FROM rates').get().n === 0) {
    const ins = db.prepare('INSERT INTO rates(prefix,destination,flag,price_per_min_cents) VALUES(?,?,?,?)');
    RATES.forEach((r) => ins.run(...r));
    console.log(`✅ ${RATES.length} tarifs insérés`);
  }

  if (!db.prepare(`SELECT 1 FROM users WHERE role = 'admin'`).get()) {
    const id = uid('u');
    db.prepare('INSERT INTO users(id,phone,name,role,password_hash,created_at) VALUES(?,?,?,?,?,?)')
      .run(id, '+243900000000', 'Admin Mbote', 'admin', hashPassword('MboteAdmin2026'), now());
    db.prepare('INSERT INTO wallets(user_id) VALUES(?)').run(id);
    console.log('✅ Admin créé : +243900000000 / MboteAdmin2026');
  }

  if (!db.prepare('SELECT 1 FROM users WHERE phone = ?').get('+243811112222')) {
    const id = uid('u');
    db.prepare('INSERT INTO users(id,phone,name,created_at) VALUES(?,?,?,?)')
      .run(id, '+243811112222', 'Papa Jean', now());
    db.prepare('INSERT INTO wallets(user_id,balance_cents) VALUES(?,?)').run(id, 1250); // 12,50 $
    db.prepare('INSERT INTO transactions(id,user_id,type,amount_cents,method,reference,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(uid('tx'), id, 'topup', 1250, 'mpesa', 'Recharge initiale démo', now());
    const c = db.prepare('INSERT INTO contacts(id,user_id,name,phone) VALUES(?,?,?,?)');
    c.run(uid('ct'), id, 'Maman Nzuzi', '+243812345678');
    c.run(uid('ct'), id, 'Didier Frère', '+243991234567');
    c.run(uid('ct'), id, 'Tantine Aya', '+2250701234567');
    console.log('✅ Utilisateur démo : +243811112222 (solde 12,50 $)');
  }
});
seed();
console.log('🌱 Seed terminé.');
