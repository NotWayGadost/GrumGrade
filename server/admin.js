'use strict';
// Админ-панель: вход по паролю из .env (ADMIN_PASSWORD), отдельная cookie-сессия,
// защита от перебора, журнал всех действий.
const crypto = require('crypto');
const { db, tx } = require('./db');

const SESSION_HOURS = 12;
const MAX_FAILS = 5;
const BLOCK_MIN = 15;

const q = {
  add:   db.prepare('INSERT INTO admin_sessions(token, expires_at, ip) VALUES (?, ?, ?)'),
  get:   db.prepare('SELECT token FROM admin_sessions WHERE token = ? AND expires_at > ?'),
  del:   db.prepare('DELETE FROM admin_sessions WHERE token = ?'),
  gc:    db.prepare('DELETE FROM admin_sessions WHERE expires_at <= ?'),
  log:   db.prepare('INSERT INTO admin_log(action, target_user, details, ip, created_at) VALUES (?, ?, ?, ?, ?)'),
};
setInterval(() => q.gc.run(Date.now()), 3600e3).unref();

const ipOf = req => (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '';
const cookie = (req, name) => {
  for (const p of (req.headers.cookie || '').split(';')) { const i = p.indexOf('='); if (i > 0 && p.slice(0, i).trim() === name) return decodeURIComponent(p.slice(i + 1).trim()); }
  return null;
};

function passwordOk(input) {
  const pass = process.env.ADMIN_PASSWORD || '';
  if (pass.length < 6) return false; // без пароля в .env админка выключена
  const a = crypto.createHash('sha256').update(String(input ?? '')).digest();
  const b = crypto.createHash('sha256').update(pass).digest();
  return crypto.timingSafeEqual(a, b);
}

const fails = new Map(); // ip → { n, until }
function login(req, res, password, secure) {
  const ip = ipOf(req), f = fails.get(ip) || { n: 0, until: 0 };
  if (f.until > Date.now()) { const e = new Error(`Слишком много попыток. Подождите ${Math.ceil((f.until - Date.now()) / 60000)} мин.`); e.status = 429; throw e; }
  if (!passwordOk(password)) {
    f.n++; if (f.n >= MAX_FAILS) { f.until = Date.now() + BLOCK_MIN * 60e3; f.n = 0; }
    fails.set(ip, f);
    q.log.run('login_failed', null, null, ip, Date.now());
    const e = new Error('Неверный пароль'); e.status = 401; throw e;
  }
  fails.delete(ip);
  const token = crypto.randomBytes(32).toString('base64url');
  q.add.run(token, Date.now() + SESSION_HOURS * 3600e3, ip);
  res.setHeader('Set-Cookie', `adm=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_HOURS * 3600}${secure ? '; Secure' : ''}`);
  q.log.run('login', null, null, ip, Date.now());
}

function logout(req, res) {
  const t = cookie(req, 'adm'); if (t) q.del.run(t);
  res.setHeader('Set-Cookie', 'adm=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
}

const isAdmin = req => { const t = cookie(req, 'adm'); return !!(t && q.get.get(t, Date.now())); };
const log = (req, action, targetUser, details) => q.log.run(action, targetUser ?? null, details ? JSON.stringify(details) : null, ipOf(req), Date.now());

module.exports = { login, logout, isAdmin, log, tx };
