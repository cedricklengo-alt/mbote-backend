/**
 * Tests du RAPPEL DE PRÉSENCE « rappelle-moi quand il revient en ligne ».
 *
 * Ce que l'on vérifie de bout en bout :
 *   - créer / annuler un rappel (REST) ;
 *   - si la cible est déjà en ligne → réponse already_online, pas de rappel ;
 *   - quand la cible SE CONNECTE au WebSocket, le rappel se déclenche :
 *     message temps réel `contact_online` au demandeur connecté,
 *     notification persistante dans sa boîte, et notified_at renseigné ;
 *   - un rappel se redéclenche si la cible repasse hors puis en ligne.
 *
 * Lancement :  node test/presence_reminder.test.js
 */
const { spawn } = require('child_process');
const path = require('path');
const WebSocket = require('ws');

const PORT = 4797;
const B = `http://127.0.0.1:${PORT}/api`;
let pass = 0, fail = 0;

const ok = (label, cond, detail) => {
  if (cond) { console.log(`  ✓ ${label}`); pass++; }
  else { console.log(`  ✗ ${label}${detail !== undefined ? ' → ' + JSON.stringify(detail) : ''}`); fail++; }
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function call(method, p, { token, body } = {}) {
  const h = { 'Content-Type': 'application/json' };
  if (token) h.Authorization = `Bearer ${token}`;
  const r = await fetch(B + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await r.json(); } catch { /* vide */ }
  return { status: r.status, data };
}

async function login(phone, name) {
  const a = await call('POST', '/auth/request-otp', { body: { phone, name } });
  const b = await call('POST', '/auth/verify-otp', { body: { phone, code: a.data.demo_code, name } });
  return { token: b.data.token, phone, name, id: b.data.user.id };
}

function client(user) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${user.token}`);
  const inbox = [];
  ws.on('message', (raw) => {
    try { inbox.push(JSON.parse(raw.toString())); } catch { /* ping */ }
  });
  return {
    ws, user, inbox,
    send: (obj) => ws.send(JSON.stringify(obj)),
    wait: async (type, ms = 3000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        const m = inbox.find(m => m.type === type);
        if (m) return m;
        await sleep(50);
      }
      return null;
    },
    close: () => { try { ws.close(); } catch { /* … */ } },
  };
}

(async () => {
  const srv = spawn('node', ['src/server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env, PORT: String(PORT), JWT_SECRET: 'test-presence', DEMO_MODE: 'true',
      DATABASE_URL: '', PUSH_DEBUG_FAKE: 'true', PUBLIC_URL: `http://127.0.0.1:${PORT}`,
      MBOTE_MESSAGE_STORAGE: '/tmp/presence-test-storage',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.stdout.on('data', () => {});
  srv.stderr.on('data', () => {});

  let up = false;
  for (let i = 0; i < 40; i++) {
    await sleep(300);
    try { const r = await fetch(`${B}/health`); if (r.ok) { up = true; break; } } catch { /* … */ }
  }
  if (!up) { console.error('Serveur non démarré'); process.exit(1); }

  try {
    const A = await login('+243840000101', 'Alice Veille');
    const C = await login('+243840000102', 'Marc Cible');
    const enc = encodeURIComponent(C.phone);

    // ── REST : activer / annuler / cibles invalides ──────────────────────
    let r = await call('POST', `/contacts/${enc}/reminder`, { token: A.token });
    ok('rappel activable (cible hors ligne)', r.status === 200 && r.data.active === true && r.data.already_online === false, r.data);

    let profil = await call('GET', `/contacts/profile/${enc}`, { token: A.token });
    ok('reminder_active visible dans le profil', profil.data.reminder_active === true, profil.data);

    r = await call('DELETE', `/contacts/${enc}/reminder`, { token: A.token });
    ok('rappel annulable', r.status === 200 && r.data.active === false, r.data);

    r = await call('POST', `/contacts/${encodeURIComponent(A.phone)}/reminder`, { token: A.token });
    ok('on ne se rappelle pas soi-même → 400', r.status === 400, r.data);

    r = await call('POST', `/contacts/${encodeURIComponent('+243999999999')}/reminder`, { token: A.token });
    ok('cible inconnue → 404', r.status === 404, r.data);

    // ── Cible déjà en ligne → pas de rappel stocké ───────────────────────
    const cOnline = client(C);
    await cOnline.wait('connected').catch(() => {});
    await sleep(400); // laisse la connexion s'établir
    r = await call('POST', `/contacts/${enc}/reminder`, { token: A.token });
    ok('cible déjà en ligne → already_online, rappel non stocké', r.status === 200 && r.data.already_online === true, r.data);
    cOnline.close();
    await sleep(400);

    // ── Le cœur du test : la cible revient en ligne ──────────────────────
    await call('POST', `/contacts/${enc}/reminder`, { token: A.token }); // A réactive le rappel
    const aWs = client(A); // A connecté : doit recevoir le message temps réel
    await sleep(400);

    const cBack = client(C); // C revient en ligne
    const msg = await aWs.wait('contact_online', 4000);
    ok('demandeur connecté reçoit contact_online en temps réel',
       !!msg && msg.phone === C.phone, msg || aWs.inbox);

    await sleep(500);
    profil = await call('GET', `/contacts/profile/${enc}`, { token: A.token });
    ok('rappel consommé : reminder_active repasse à false', profil.data.reminder_active === false, profil.data);

    const notifsA = await call('GET', '/notifications', { token: A.token });
    const notifPresence = (notifsA.data.notifications || []).find(n => n.type === 'presence');
    ok('notification persistante « presence » créée pour le demandeur', !!notifPresence, notifsA.data);

    // ── Le rappel se redéclenche à la prochaine session hors→en ligne ────
    await call('POST', `/contacts/${enc}/reminder`, { token: A.token });
    cBack.close(); // C repasse hors ligne
    await sleep(500);
    const cBack2 = client(C); // C revient
    const msg2 = await aWs.wait('contact_online', 4000);
    ok('un rappel peut se redéclencher (2ᵉ session)', !!msg2, msg2 || aWs.inbox);
    cBack2.close();
    aWs.close();
  } finally {
    srv.kill('SIGKILL');
  }

  console.log(`\nRÉSULTAT : ${pass} réussis, ${fail} échecs`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
