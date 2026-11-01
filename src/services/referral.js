/**
 * Service PARRAINAGE — « mets mon code, on gagne 1 $ chacun ».
 *
 * Règles anti-fraude :
 *  - le bonus (1 $ parrain + 1 $ filleul) n'est versé qu'au PREMIER APPEL
 *    FACTURÉ du filleul (pas à l'inscription → pas de fermes de comptes) ;
 *  - un filleul ne rapporte qu'une seule fois (flag referral_rewarded) ;
 *  - on ne peut pas se parrainer soi-même.
 */
const crypto = require('crypto');
const db = require('../db');
const { uid, now } = require('../util');

const BONUS_CENTS = 100; // 1 $ chacun

// Code court lisible : MBOTE-X7K2 (sans 0/O/1/I pour éviter les confusions)
function makeCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (const b of crypto.randomBytes(4)) s += alphabet[b % alphabet.length];
  return 'MBOTE-' + s;
}

/** Garantit que l'utilisateur possède un code de parrainage ; le renvoie. */
async function ensureCode(userId) {
  const u = await db.get('SELECT referral_code FROM users WHERE id = ?', [userId]);
  if (u && u.referral_code) return u.referral_code;
  // petites collisions possibles → on réessaie
  for (let i = 0; i < 5; i++) {
    const code = makeCode();
    const taken = await db.get('SELECT 1 x FROM users WHERE referral_code = ?', [code]);
    if (!taken) {
      await db.run('UPDATE users SET referral_code = ? WHERE id = ?', [code, userId]);
      return code;
    }
  }
  throw new Error('Impossible de générer un code de parrainage');
}

/** Relie un nouveau compte à son parrain (à l'inscription). */
async function linkReferral(newUserId, rawCode) {
  const code = String(rawCode || '').trim().toUpperCase();
  if (!code) return null;
  const sponsor = await db.get(
    `SELECT id, name, phone FROM users WHERE referral_code = ? AND id != ?`, [code, newUserId]);
  if (!sponsor) return null;
  await db.run('UPDATE users SET referred_by = ? WHERE id = ?', [sponsor.id, newUserId]);
  return sponsor;
}

/**
 * Appelé à la fin de chaque appel facturé : si c'est le premier appel payant
 * d'un filleul non encore récompensé → 1 $ pour lui + 1 $ pour le parrain.
 * S'exécute DANS la transaction de facturation (t = handle de transaction).
 */
async function maybeRewardInsideTx(t, userId) {
  const u = await t.get(
    `UPDATE users SET referral_rewarded = 1
     WHERE id = ? AND referred_by IS NOT NULL AND referral_rewarded = 0
     RETURNING referred_by`, [userId]);
  if (!u) return false; // pas de parrain, ou déjà récompensé

  for (const [who, label] of [[userId, 'Bonus filleul 🎁'], [u.referred_by, 'Bonus parrainage 🎁']]) {
    await t.run('UPDATE wallets SET balance_cents = balance_cents + ? WHERE user_id = ?',
      [BONUS_CENTS, who]);
    await t.run(
      'INSERT INTO transactions(id,user_id,type,amount_cents,method,reference,created_at) VALUES(?,?,?,?,?,?,?)',
      [uid('tx'), who, 'referral_bonus', BONUS_CENTS, 'system', label, now()]);
  }
  return true;
}

/** Statistiques pour l'écran « Inviter des amis ». */
async function stats(userId) {
  const code = await ensureCode(userId);
  const filleuls = await db.get(
    'SELECT COUNT(*) n FROM users WHERE referred_by = ?', [userId]);
  const gains = await db.get(
    `SELECT COALESCE(SUM(amount_cents),0) c FROM transactions
     WHERE user_id = ? AND type = 'referral_bonus'`, [userId]);
  return {
    code,
    filleuls: Number(filleuls.n),
    earned_cents: Number(gains.c),
    bonus_cents: BONUS_CENTS,
  };
}

module.exports = { ensureCode, linkReferral, maybeRewardInsideTx, stats, BONUS_CENTS };
