'use strict';

/**
 * Tests du moteur de ranking v4.1 (unitaires purs + persistance SQLite).
 */

const assert = require('assert');

process.env.DATABASE_URL = ''; // force SQLite local (mbote.db de test)
delete require.cache[require.resolve('../src/db')];
const db = require('../src/db');
const R = require('../src/services/ranking');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  ✓', msg); }
  else { failed++; console.error('  ✗', msg); }
}

async function main() {
  const m = Date.now();
  const UID1 = `u1-${m}`;
  const UID2 = `u2-${m}`;
  const PID = `p1-${m}`;

  console.log('── 1. computeScore (pur) ──');
  const ctx = {
    maintenant: m,
    tagsInteret: ['kinshasa', 'musique'],
    auteursSuivis: ['auteur-aime'],
    likesAuteur: { 'auteur-aime': 5 },
    commentairesAuteur: { 'auteur-aime': 2 },
    profilVisites: { 'auteur-aime': 3 },
    ville: 'Kinshasa',
    amis: ['ami-1'],
  };
  const postA = { id: 'pA', user_id: 'auteur-aime', created_at: m - 3600e3, tags: ['kinshasa'], likes: 10, comments: 4, shares: 2, views: 50, ville: 'Kinshasa' };
  const postB = { id: 'pB', user_id: 'inconnu', created_at: m - 30 * 24 * 3600e3, tags: ['sport'], likes: 0, comments: 0, shares: 0, views: 0 };
  const sA = R.computeScore(postA, ctx);
  const sB = R.computeScore(postB, ctx);
  ok(sA.score > sB.score, `post pertinent (${sA.score}) > post froid (${sB.score})`);
  ok(sA.score <= 1 && sA.score >= 0, 'score borné [0,1]');
  ok(Object.keys(sA.detail).length === 5, 'détail des 5 composantes présent');
  const sumW = Object.values(R.W).reduce((a, b) => a + b, 0);
  ok(Math.abs(sumW - 1) < 1e-9, 'poids = 100 %');

  console.log('── 2. fraîcheur ──');
  ok(R.composanteFraicheur(m, m) === 1, 'fraîcheur max à t=0');
  const f24 = R.composanteFraicheur(m - 24 * 3600e3, m);
  ok(f24 < 0.51 && f24 > 0.49, 'demi-vie 24 h');

  console.log('── 3. rankPosts ──');
  const ranked = R.rankPosts([postB, postA], ctx);
  ok(ranked[0].id === 'pA', 'tri décroissant par score');

  console.log('── 4. réactions ──');
  ok(R.REACTIONS.length === 8, '8 types de réactions');

  console.log('── 5. persistance + événements (sqlite) ──');
  await db.init();
  await db.run(`INSERT INTO users (id, phone, name, created_at) VALUES (?, ?, 'Test', ?)`, [UID1, `+243${String(m).slice(-9)}1`, m]);
  await db.run(`INSERT INTO users (id, phone, name, created_at) VALUES (?, ?, 'Auteur', ?)`, [UID2, `+243${String(m).slice(-9)}2`, m]);
  await db.run(`INSERT INTO posts (id, user_id, texte, visibilite, created_at) VALUES (?, ?, 'salut #kinshasa', 'public', ?)`, [PID, UID2, m]);
  await R.recordEvent(db, UID1, 'like', { postId: PID, authorId: UID2, tag: 'kinshasa' });
  await R.recordEvent(db, UID1, 'view', { postId: PID, authorId: UID2 });
  const prefs = await db.get(`SELECT interests FROM user_preferences WHERE user_id = ?`, [UID1]);
  const inter = JSON.parse(prefs.interests);
  ok(inter.affinity[UID2].likes === 1 && inter.affinity[UID2].views === 1, 'affinité auteur incrémentée');
  ok(inter.tags['kinshasa'] === 1, 'tag pondéré');
  await R.persistScore(db, PID, 0.75, { interest: 1 });
  const sc = await db.get(`SELECT score FROM feed_scores WHERE post_id = ?`, [PID]);
  ok(sc && sc.score === 0.75, 'score persisté dans feed_scores');
  await db.run(`INSERT INTO post_reactions (id, post_id, user_id, type, created_at) VALUES (?, ?, ?, 'love', ?)
                ON CONFLICT(post_id, user_id) DO NOTHING`, [`r-${m}`, PID, UID1, m]);
  await db.run(`INSERT INTO post_reactions (id, post_id, user_id, type, created_at) VALUES (?, ?, ?, 'wow', ?)
                ON CONFLICT(post_id, user_id) DO UPDATE SET type=excluded.type`, [`r-${m}`, PID, UID1, m]);
  const rc = await db.get(`SELECT type FROM post_reactions WHERE post_id = ? AND user_id = ?`, [PID, UID1]);
  ok(rc.type === 'wow', 'réaction upsert (love → wow)');

  console.log(`\nRÉSULTAT : ${passed} réussis, ${failed} échecs`);
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
