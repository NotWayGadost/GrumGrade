'use strict';
// Вход через Steam (OpenID 2.0) и сессии в httpOnly-cookie.
const crypto = require('crypto');
const { db } = require('./db');

const OPENID = 'https://steamcommunity.com/openid/login';
const SESSION_DAYS = 30;

function steamLoginUrl(base) {
  const p = new URLSearchParams({
    'openid.ns': 'http://specs.openid.net/auth/2.0',
    'openid.mode': 'checkid_setup',
    'openid.return_to': base + '/auth/steam/return',
    'openid.realm': base,
    'openid.identity': 'http://specs.openid.net/auth/2.0/identifier_select',
    'openid.claimed_id': 'http://specs.openid.net/auth/2.0/identifier_select',
  });
  return OPENID + '?' + p;
}

// Проверяем ответ Steam: перепосылаем параметры с mode=check_authentication.
async function verifySteam(params, base) {
  if (params.get('openid.mode') !== 'id_res') return null;
  if (params.get('openid.op_endpoint') !== OPENID) return null;
  if (!(params.get('openid.return_to') || '').startsWith(base + '/auth/steam/return')) return null;
  const m = (params.get('openid.claimed_id') || '').match(/^https?:\/\/steamcommunity\.com\/openid\/id\/(\d{17})$/);
  if (!m) return null;
  const body = new URLSearchParams();
  for (const [k, v] of params) if (k.startsWith('openid.')) body.set(k, v);
  body.set('openid.mode', 'check_authentication');
  const r = await fetch(OPENID, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  const text = await r.text();
  return /is_valid\s*:\s*true/.test(text) ? m[1] : null;
}

// Ник и аватар — нужен STEAM_API_KEY (https://steamcommunity.com/dev/apikey). Без него будет «Player XXXX».
async function steamProfile(steamId) {
  const fallback = { name: 'Player ' + steamId.slice(-4), avatar: null };
  const key = process.env.STEAM_API_KEY;
  if (!key) return fallback;
  try {
    const r = await fetch(`https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${encodeURIComponent(key)}&steamids=${steamId}`);
    const p = (await r.json()).response.players[0];
    return p ? { name: String(p.personaname).slice(0, 40), avatar: p.avatarfull || null } : fallback;
  } catch { return fallback; }
}

const qSessGet = db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > ?');
const qSessAdd = db.prepare('INSERT INTO sessions(token, user_id, expires_at) VALUES (?, ?, ?)');
const qSessDel = db.prepare('DELETE FROM sessions WHERE token = ?');
const qSessGc  = db.prepare('DELETE FROM sessions WHERE expires_at <= ?');

function parseCookies(h = '') {
  const o = {};
  for (const part of h.split(';')) { const i = part.indexOf('='); if (i > 0) o[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); }
  return o;
}

function createSession(res, userId, secure) {
  const token = crypto.randomBytes(32).toString('base64url');
  const exp = Date.now() + SESSION_DAYS * 864e5;
  qSessAdd.run(token, userId, exp);
  res.setHeader('Set-Cookie', `sid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure ? '; Secure' : ''}`);
}

function sessionUser(req) {
  const t = parseCookies(req.headers.cookie).sid;
  return t ? qSessGet.get(t, Date.now()) || null : null;
}

function destroySession(req, res) {
  const t = parseCookies(req.headers.cookie).sid;
  if (t) qSessDel.run(t);
  res.setHeader('Set-Cookie', 'sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
}

setInterval(() => qSessGc.run(Date.now()), 3600e3).unref();

module.exports = { steamLoginUrl, verifySteam, steamProfile, createSession, sessionUser, destroySession };
