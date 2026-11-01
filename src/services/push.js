'use strict';

const https = require('https');
const jwt = require('jsonwebtoken');
const db = require('../db');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
let cachedAccessToken = null;
let cachedUntil = 0;

function postJson(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = https.request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': data.length, ...headers },
      timeout: 10000,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        let parsed = {};
        try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
        resolve({ status: res.statusCode || 0, body: parsed });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(data);
  });
}

function credentials() {
  const projectId = process.env.FCM_PROJECT_ID;
  const clientEmail = process.env.FCM_CLIENT_EMAIL;
  const privateKey = process.env.FCM_PRIVATE_KEY?.replace(/\\n/g, '\n');
  return projectId && clientEmail && privateKey ? { projectId, clientEmail, privateKey } : null;
}

async function accessToken(creds) {
  if (cachedAccessToken && Date.now() < cachedUntil - 60000) return cachedAccessToken;
  const issuedAt = Math.floor(Date.now() / 1000);
  const assertion = jwt.sign({
    iss: creds.clientEmail,
    scope: FCM_SCOPE,
    aud: TOKEN_URL,
    iat: issuedAt,
    exp: issuedAt + 3600,
  }, creds.privateKey, { algorithm: 'RS256' });
  const form = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion,
  }).toString();
  const response = await new Promise((resolve, reject) => {
    const data = Buffer.from(form);
    const req = https.request(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': data.length },
      timeout: 10000,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        let parsed = {};
        try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
        resolve({ status: res.statusCode || 0, body: parsed });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(data);
  });
  if (response.status < 200 || response.status >= 300 || !response.body.access_token) {
    throw new Error('FCM OAuth token unavailable');
  }
  cachedAccessToken = response.body.access_token;
  cachedUntil = Date.now() + Number(response.body.expires_in || 3600) * 1000;
  return cachedAccessToken;
}

/** Sends a data notification to every current device registered for a user. */
async function sendUser(userId, { data, title, body, channel = 'messages', collapseKey }) {
  const creds = credentials();
  if (!creds || !userId) return false;
  try {
    const prefs = await db.get('SELECT notifications_enabled FROM users WHERE id = ?', [userId]);
    if (!prefs || prefs.notifications_enabled === 0) return false;
    const tokens = await db.all('SELECT token FROM device_tokens WHERE user_id = ?', [userId]);
    if (!tokens.length) return false;
    const bearer = await accessToken(creds);
    const values = Object.fromEntries(Object.entries(data || {}).map(([k, v]) => [k, String(v ?? '')]));
    let delivered = false;
    await Promise.all(tokens.map(async ({ token }) => {
      try {
        const response = await postJson(
          `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(creds.projectId)}/messages:send`,
          {
            message: {
              token,
              data: values,
              ...(title && body ? { notification: { title, body } } : {}),
              android: {
                priority: channel === 'calls' ? 'HIGH' : 'NORMAL',
                ...(collapseKey ? { collapse_key: collapseKey } : {}),
                ttl: channel === 'calls' ? '60s' : '86400s',
                notification: {
                  channel_id: channel === 'calls' ? 'mbote_calls' : 'mbote_messages',
                  ...(channel === 'calls' ? { sound: 'default' } : {}),
                },
              },
            },
          },
          { authorization: `Bearer ${bearer}` },
        );
        if (response.status >= 200 && response.status < 300) delivered = true;
        else if (JSON.stringify(response.body).includes('UNREGISTERED')) {
          await db.run('DELETE FROM device_tokens WHERE token = ?', [token]);
        }
      } catch {
        // A push outage must not fail a message, call, or presence update.
      }
    }));
    return delivered;
  } catch {
    return false;
  }
}

module.exports = { sendUser };
