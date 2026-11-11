'use strict';
// GRUMGrade — сервер. Запуск: npm start  (Node 22.13+; зависимостей нет)
const http = require('http');
const fs = require('fs');
const path = require('path');
const { db, tx } = require('./db');
const catalog = require('./catalog');
const { ITEMS, CASES, pickCaseItem } = catalog;
const prices = require('./prices');
const fair = require('./fair');
const auth = require('./auth');
const payments = require('./payments');
const admin = require('./admin');

const PORT = Number(process.env.PORT) || 3000;
const BASE = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const SECURE = BASE.startsWith('https://');
const DEMO = process.env.DEMO_MODE === '1';
const ADMINS = new Set((process.env.ADMIN_STEAM_IDS || '').split(',').map(s => s.trim()).filter(Boolean));
const UP_EDGE = Number(process.env.UPGRADE_HOUSE_EDGE ?? 0.10);
const UP_MAX = Number(process.env.UPGRADE_MAX_CHANCE ?? 0.75);
const PUB = path.join(__dirname, '..', 'public');
const TELEGRAM = /^https:\/\/t\.me\/[\w+/-]+$/.test(process.env.TELEGRAM_URL || '') ? process.env.TELEGRAM_URL : null;
const BONUS_MIN = Math.round(Number(process.env.BONUS_MIN ?? 5) * 100);
const BONUS_MAX = Math.round(Number(process.env.BONUS_MAX ?? 50) * 100);
const BONUS_MS = Number(process.env.BONUS_HOURS ?? 24) * 3600e3;
const now = () => Date.now();

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const fail = (s, m) => { throw new HttpError(s, m); };

/* ---------- SQL ---------- */
const q = {
  user:        db.prepare('SELECT * FROM users WHERE id = ?'),
  userBySteam: db.prepare('SELECT * FROM users WHERE steam_id = ?'),
  addUser:     db.prepare('INSERT INTO users(steam_id, name, avatar, balance, server_seed, client_seed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'),
  updProfile:  db.prepare('UPDATE users SET name = ?, avatar = COALESCE(?, avatar) WHERE id = ?'),
  inv:         db.prepare("SELECT uid, item_id, price, status FROM inventory WHERE user_id = ? AND status IN ('owned','withdraw_pending') ORDER BY uid DESC"),
  invOwned:    db.prepare("SELECT uid, item_id, price FROM inventory WHERE user_id = ? AND uid = ? AND status = 'owned'"),
  invStatus:   db.prepare('UPDATE inventory SET status = ? WHERE uid = ?'),
  invAdd:      db.prepare("INSERT INTO inventory(user_id, item_id, price, status, source, created_at) VALUES (?, ?, ?, 'owned', ?, ?)"),
  balAdd:      db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?'),
  balTake:     db.prepare('UPDATE users SET balance = balance - ? WHERE id = ? AND balance >= ?'),
  ledger:      db.prepare('INSERT INTO ledger(user_id, type, amount, ref, created_at) VALUES (?, ?, ?, ?, ?)'),
  nonceInc:    db.prepare('UPDATE users SET nonce = nonce + 1 WHERE id = ?'),
  game:        db.prepare('INSERT INTO games(user_id, type, stake, chance, roll, win, item_id, case_id, payout, server_seed_hash, client_seed, nonce, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
  setClient:   db.prepare('UPDATE users SET client_seed = ? WHERE id = ?'),
  rotate:      db.prepare('UPDATE users SET server_seed = ?, nonce = 0 WHERE id = ?'),
  reveal:      db.prepare('INSERT INTO seeds_revealed(user_id, server_seed, server_seed_hash, client_seed, last_nonce, revealed_at) VALUES (?, ?, ?, ?, ?, ?)'),
  revealed:    db.prepare('SELECT server_seed, server_seed_hash, client_seed, last_nonce, revealed_at FROM seeds_revealed WHERE user_id = ? ORDER BY id DESC LIMIT 20'),
  history:     db.prepare('SELECT id, type, stake, chance, roll, win, item_id, case_id, payout, server_seed_hash, client_seed, nonce, created_at FROM games WHERE user_id = ? ORDER BY id DESC LIMIT 50'),
  tradeUrl:    db.prepare('UPDATE users SET trade_url = ? WHERE id = ?'),
  wdAdd:       db.prepare("INSERT INTO withdrawals(user_id, inv_uid, trade_url, status, created_at, updated_at) VALUES (?, ?, ?, 'pending', ?, ?)"),
  wdList:      db.prepare("SELECT w.*, u.name, u.steam_id, i.item_id, i.price FROM withdrawals w JOIN users u ON u.id = w.user_id JOIN inventory i ON i.uid = w.inv_uid WHERE w.status = ? ORDER BY w.id LIMIT 200"),
  wdGet:       db.prepare('SELECT * FROM withdrawals WHERE id = ?'),
  wdSet:       db.prepare('UPDATE withdrawals SET status = ?, updated_at = ? WHERE id = ?'),
  countGames:  db.prepare('SELECT type, COUNT(*) n FROM games GROUP BY type'),
  feedInit:    db.prepare("SELECT g.type, g.item_id, u.name FROM games g JOIN users u ON u.id = g.user_id WHERE g.type = 'case' OR g.win = 1 ORDER BY g.id DESC LIMIT 20"),
};

/* ---------- живая лента и счётчики (только настоящие данные) ---------- */
const clients = new Set();
const counts = { upgrade: 0, case: 0 };
for (const r of q.countGames.all()) counts[r.type] = r.n;
const feed = q.feedInit.all().reverse().map(r => ({ kind: r.type, item: r.item_id, user: r.name }));
const stats = () => ({ online: clients.size, upgrades: counts.upgrade, cases: counts.case });
function broadcast(o) { const s = `data: ${JSON.stringify(o)}\n\n`; for (const c of clients) c.write(s); }
function pushDrop(kind, itemId, user) {
  const d = { kind, item: itemId, user: user.name };
  feed.push(d); if (feed.length > 20) feed.shift();
  broadcast({ type: 'drop', drop: d, stats: stats() });
}
setInterval(() => { broadcast({ type: 'stats', stats: stats() }); }, 5000).unref();

/* ---------- helpers ---------- */
// Предмет игрока оценивается по ТЕКУЩЕЙ рыночной цене (как продажа, так и ставка в апгрейде).
function owned(userId, uid) {
  const x = q.invOwned.get(userId, uid);
  if (x) x.price = ITEMS[x.item_id] ? ITEMS[x.item_id].price : x.price;
  return x;
}

function publicState(userId) {
  const u = q.user.get(userId);
  return {
    user: {
      id: u.id, name: u.name, avatar: u.avatar, balance: u.balance, steamId: u.steam_id,
      tradeUrl: u.trade_url, isAdmin: ADMINS.has(u.steam_id), nextBonusAt: BONUS_MAX > 0 ? u.last_bonus + BONUS_MS : null,
      fair: { serverSeedHash: fair.sha256(u.server_seed), clientSeed: u.client_seed, nonce: u.nonce },
    },
    inventory: q.inv.all(u.id).map(r => ({ uid: r.uid, id: r.item_id, price: ITEMS[r.item_id] ? ITEMS[r.item_id].price : r.price, status: r.status })),
  };
}

function upsertSteamUser(steamId, profile) {
  const ex = q.userBySteam.get(steamId);
  if (ex) { q.updProfile.run(profile.name, profile.avatar, ex.id); return ex.id; }
  return Number(q.addUser.run(steamId, profile.name, profile.avatar, 0, fair.newServerSeed(), fair.newClientSeed(), now()).lastInsertRowid);
}

const lastAction = new Map();
function rateLimit(userId) {
  const t = now(), prev = lastAction.get(userId) || 0;
  if (t - prev < 300) fail(429, 'Слишком быстро');
  lastAction.set(userId, t);
}

/* ---------- игры ---------- */
function doUpgrade(user, b) {
  rateLimit(user.id);
  const uids = Array.isArray(b.uids) ? [...new Set(b.uids.map(Number).filter(Number.isInteger))] : [];
  if (uids.length > 10) fail(400, 'Максимум 10 предметов');
  const amount = Math.floor(Number(b.amount) || 0);
  if (amount < 0) fail(400, 'Неверная сумма');
  const target = ITEMS[Number(b.target)];
  if (!target) fail(400, 'Выберите предмет для апгрейда');

  const result = tx(() => {
    const u = q.user.get(user.id);
    const its = uids.map(uid => owned(u.id, uid) || fail(400, 'Предмет недоступен'));
    if (amount > u.balance) fail(400, 'Недостаточно баланса');
    const stake = its.reduce((a, x) => a + x.price, 0) + amount;
    if (stake <= 0) fail(400, 'Выберите предметы или баланс');
    if (target.price <= stake) fail(400, 'Цель должна быть дороже ставки');
    const chance = Math.min(UP_MAX, stake / target.price * (1 - UP_EDGE));
    if (chance < 0.0001) fail(400, 'Слишком маленький шанс');

    const r = fair.roll(u.server_seed, u.client_seed, u.nonce);
    const win = r < chance;
    for (const x of its) q.invStatus.run('used', x.uid);
    if (amount) { q.balTake.run(amount, u.id, amount); q.ledger.run(u.id, 'upgrade_stake', -amount, null, now()); }
    let uid = null;
    if (win) uid = Number(q.invAdd.run(u.id, target.id, target.price, 'upgrade', now()).lastInsertRowid);
    q.game.run(u.id, 'upgrade', stake, chance, r, win ? 1 : 0, target.id, null, win ? target.price : 0, fair.sha256(u.server_seed), u.client_seed, u.nonce, now());
    q.nonceInc.run(u.id);
    return { win, roll: r, chance, nonce: u.nonce, item: target.id, uid };
  });
  counts.upgrade++;
  if (result.win) pushDrop('upgrade', target.id, user);
  return { result, ...publicState(user.id) };
}

function openCase(user, caseId) {
  rateLimit(user.id);
  const c = CASES[caseId];
  if (!c) fail(404, 'Кейс не найден');
  const result = tx(() => {
    const u = q.user.get(user.id);
    if (q.balTake.run(c.price, u.id, c.price).changes !== 1) fail(400, 'Недостаточно баланса');
    const r = fair.roll(u.server_seed, u.client_seed, u.nonce);
    const it = pickCaseItem(c, r);
    q.ledger.run(u.id, 'case_open', -c.price, String(c.id), now());
    const uid = Number(q.invAdd.run(u.id, it.id, it.price, 'case', now()).lastInsertRowid);
    q.game.run(u.id, 'case', c.price, null, r, 1, it.id, c.id, it.price, fair.sha256(u.server_seed), u.client_seed, u.nonce, now());
    q.nonceInc.run(u.id);
    return { item: it.id, uid, roll: r, nonce: u.nonce };
  });
  counts.case++;
  pushDrop('case', result.item, user);
  return { result, ...publicState(user.id) };
}

function sell(user, b) {
  const uids = Array.isArray(b.uids) ? [...new Set(b.uids.map(Number).filter(Number.isInteger))] : [];
  if (!uids.length) fail(400, 'Нечего продавать');
  const total = tx(() => {
    let sum = 0;
    for (const uid of uids) {
      const x = owned(user.id, uid) || fail(400, 'Предмет недоступен');
      q.invStatus.run('sold', uid); sum += x.price;
      q.ledger.run(user.id, 'sell', x.price, String(uid), now());
    }
    q.balAdd.run(sum, user.id);
    return sum;
  });
  return { result: { total }, ...publicState(user.id) };
}

/* ---------- роутинг ---------- */
const routes = [];
const on = (method, pattern, handler, opts = {}) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), handler, opts });
const needUser = ctx => ctx.user || fail(401, 'Войдите через Steam');
const needAdmin = ctx => ctx.admin || (ctx.user && ADMINS.has(ctx.user.steam_id)) || fail(403, 'Нет доступа');

on('GET', '/api/config', () => ({ demo: DEMO, upgradeEdge: UP_EDGE, upgradeMax: UP_MAX, payments: payments.configured(), telegram: TELEGRAM, bonus: BONUS_MAX > 0 ? { min: BONUS_MIN, max: BONUS_MAX, hours: BONUS_MS / 3600e3 } : null }));

/* ---------- бонус, профиль, топ ---------- */
const qBonus = db.prepare('UPDATE users SET last_bonus = ?, balance = balance + ? WHERE id = ? AND last_bonus <= ?');
on('POST', '/api/bonus', ctx => {
  const u = needUser(ctx);
  if (BONUS_MAX <= 0) fail(404, 'Бонус выключен');
  const t = now();
  const r = Math.random();
  const amount = Math.round(BONUS_MIN + (BONUS_MAX - BONUS_MIN) * r * r); // чаще маленький, иногда крупный
  const ok = tx(() => {
    if (qBonus.run(t, amount, u.id, t - BONUS_MS).changes !== 1) return false;
    q.ledger.run(u.id, 'bonus', amount, null, t);
    return true;
  });
  if (!ok) fail(400, 'Бонус уже получен, приходи позже');
  return { result: { amount }, ...publicState(u.id) };
});
const qProfile = db.prepare("SELECT COUNT(*) total, COALESCE(SUM(type='upgrade'),0) ups, COALESCE(SUM(type='upgrade' AND win=1),0) upWins, COALESCE(SUM(type='case'),0) cases, COALESCE(SUM(payout),0) won FROM games WHERE user_id = ?");
const qBest = db.prepare('SELECT item_id, payout FROM games WHERE user_id = ? AND payout > 0 ORDER BY payout DESC LIMIT 1');
on('GET', '/api/profile', ctx => {
  const u = needUser(ctx);
  const best = qBest.get(u.id);
  return { ...qProfile.get(u.id), best: best ? { item: best.item_id, price: best.payout } : null };
});
const qTop = db.prepare('SELECT g.item_id, g.payout, g.type, u.name FROM games g JOIN users u ON u.id = g.user_id WHERE g.payout > 0 AND g.created_at > ? ORDER BY g.payout DESC LIMIT 12');
on('GET', '/api/top', () => qTop.all(now() - 864e5).map(r => ({ item: r.item_id, price: r.payout, kind: r.type, user: r.name })));
on('GET', '/api/catalog', () => ({ items: ITEMS, cases: CASES, pricesUpdatedAt: catalog.meta.pricesUpdatedAt, currency: process.env.PRICE_CURRENCY || 'RUB' }));
on('GET', '/api/me', ctx => ctx.user ? publicState(ctx.user.id) : { user: null, inventory: [] });

on('GET', '/auth/steam', (ctx, req, res) => { res.writeHead(302, { Location: auth.steamLoginUrl(BASE) }); res.end(); }, { raw: true });
on('GET', '/auth/steam/return', async (ctx, req, res) => {
  const steamId = await auth.verifySteam(ctx.url.searchParams, BASE);
  if (!steamId) { res.writeHead(302, { Location: '/?login=failed' }); return res.end(); }
  const profile = await auth.steamProfile(steamId);
  const id = upsertSteamUser(steamId, profile);
  if (q.user.get(id).banned) { res.writeHead(302, { Location: '/?login=banned' }); return res.end(); }
  auth.createSession(res, id, SECURE);
  res.writeHead(302, { Location: '/' }); res.end();
}, { raw: true });
on('POST', '/auth/demo', (ctx, req, res) => {
  if (!DEMO) fail(404, 'Not found');
  const sid = 'demo_' + fair.newClientSeed();
  const id = Number(q.addUser.run(sid, 'Demo-' + sid.slice(-4), null, 100000, fair.newServerSeed(), fair.newClientSeed(), now()).lastInsertRowid);
  q.ledger.run(id, 'demo_topup', 100000, null, now());
  auth.createSession(res, id, SECURE);
  return publicState(id);
});
on('POST', '/auth/logout', (ctx, req, res) => { auth.destroySession(req, res); return { ok: true }; });

on('POST', '/api/upgrade', ctx => doUpgrade(needUser(ctx), ctx.body));
on('POST', '/api/cases/:id/open', ctx => openCase(needUser(ctx), Number(ctx.params.id)));
on('POST', '/api/sell', ctx => sell(needUser(ctx), ctx.body));

on('POST', '/api/fair/client-seed', ctx => {
  const u = needUser(ctx);
  const s = String(ctx.body.seed || '').trim();
  if (!/^[\w-]{1,64}$/.test(s)) fail(400, 'Сид: 1–64 символа, латиница/цифры/_/-');
  q.setClient.run(s, u.id);
  return publicState(u.id);
});
on('POST', '/api/fair/rotate', ctx => {
  const u0 = needUser(ctx);
  const revealed = tx(() => {
    const u = q.user.get(u0.id);
    const rec = { serverSeed: u.server_seed, serverSeedHash: fair.sha256(u.server_seed), clientSeed: u.client_seed, lastNonce: u.nonce - 1 };
    q.reveal.run(u.id, rec.serverSeed, rec.serverSeedHash, rec.clientSeed, rec.lastNonce, now());
    q.rotate.run(fair.newServerSeed(), u.id);
    return rec;
  });
  return { revealed, ...publicState(u0.id) };
});
on('GET', '/api/fair/history', ctx => {
  const u = needUser(ctx);
  return { revealed: q.revealed.all(u.id), games: q.history.all(u.id) };
});

on('POST', '/api/topup', async ctx => {
  const u = needUser(ctx);
  const amount = Math.floor(Number(ctx.body.amount) || 0);
  if (amount < 100 || amount > 100000000) fail(400, 'Неверная сумма');
  if (DEMO) {
    tx(() => { q.balAdd.run(amount, u.id); q.ledger.run(u.id, 'demo_topup', amount, null, now()); });
    return { demo: true, ...publicState(u.id) };
  }
  return await payments.createPayment(u, amount); // { url } для редиректа на оплату
});
on('POST', '/api/payments/webhook', async (ctx, req) => payments.handleWebhook(ctx.rawBody, req.headers), { webhook: true });

on('POST', '/api/trade-url', ctx => {
  const u = needUser(ctx);
  const url = String(ctx.body.url || '').trim();
  if (!/^https:\/\/steamcommunity\.com\/tradeoffer\/new\/\?partner=\d+&token=[\w-]{8}$/.test(url)) fail(400, 'Неверная трейд-ссылка');
  q.tradeUrl.run(url, u.id);
  return publicState(u.id);
});
on('POST', '/api/withdraw', ctx => {
  const u = needUser(ctx);
  const uid = Number(ctx.body.uid);
  tx(() => {
    const me = q.user.get(u.id);
    if (!me.trade_url) fail(400, 'Сначала укажите трейд-ссылку');
    q.invOwned.get(u.id, uid) || fail(400, 'Предмет недоступен');
    q.invStatus.run('withdraw_pending', uid);
    q.wdAdd.run(u.id, uid, me.trade_url, now(), now());
  });
  return publicState(u.id);
});

// Админка: вход по ADMIN_PASSWORD (или SteamID из ADMIN_STEAM_IDS). Панель — /admin
on('POST', '/api/admin/login', (ctx, req, res) => { admin.login(req, res, ctx.body.password, SECURE); return { ok: true }; });
on('POST', '/api/admin/logout', (ctx, req, res) => { admin.logout(req, res); return { ok: true }; });
on('GET', '/api/admin/me', ctx => ({ admin: !!(ctx.admin || (ctx.user && ADMINS.has(ctx.user.steam_id))), me: ctx.user ? { id: ctx.user.id, name: ctx.user.name } : null }));

const qaUsers = db.prepare("SELECT u.id, u.name, u.steam_id, u.balance, u.banned, u.created_at, (SELECT COUNT(*) FROM games g WHERE g.user_id = u.id) games FROM users u WHERE (? = '' OR u.name LIKE ? OR u.steam_id = ? OR u.id = ?) ORDER BY u.id DESC LIMIT 50");
const qaLedger = db.prepare('SELECT type, amount, ref, created_at FROM ledger WHERE user_id = ? ORDER BY id DESC LIMIT 30');
const qaGames = db.prepare('SELECT type, stake, chance, roll, win, item_id, case_id, payout, created_at FROM games WHERE user_id = ? ORDER BY id DESC LIMIT 30');
const qaBan = db.prepare('UPDATE users SET banned = ? WHERE id = ?');
const qaKill = db.prepare('DELETE FROM sessions WHERE user_id = ?');
const qaLog = db.prepare('SELECT * FROM admin_log ORDER BY id DESC LIMIT 100');
const targetUser = ctx => q.user.get(Number(ctx.params.id)) || fail(404, 'Игрок не найден');

on('GET', '/api/admin/users', ctx => {
  needAdmin(ctx);
  const s = String(ctx.url.searchParams.get('q') || '').trim();
  return qaUsers.all(s, `%${s}%`, s, Number(s) || -1);
});
on('GET', '/api/admin/users/:id', ctx => {
  needAdmin(ctx);
  const u = targetUser(ctx);
  return { user: { id: u.id, name: u.name, steamId: u.steam_id, balance: u.balance, banned: !!u.banned, tradeUrl: u.trade_url, createdAt: u.created_at }, inventory: publicState(u.id).inventory, ledger: qaLedger.all(u.id), games: qaGames.all(u.id) };
});
on('POST', '/api/admin/users/:id/balance', (ctx, req) => {
  needAdmin(ctx);
  const u = targetUser(ctx);
  const amount = Math.round(Number(ctx.body.amount) * 100);
  if (!Number.isFinite(amount) || amount === 0 || Math.abs(amount) > 1e12) fail(400, 'Неверная сумма');
  const reason = String(ctx.body.reason || '').slice(0, 200);
  tx(() => {
    if (amount < 0 && q.user.get(u.id).balance + amount < 0) fail(400, 'Баланс не может уйти в минус');
    q.balAdd.run(amount, u.id);
    q.ledger.run(u.id, 'admin_adjust', amount, reason || null, now());
  });
  admin.log(req, 'balance', u.id, { amount, reason });
  return { ok: true, balance: q.user.get(u.id).balance };
});
on('POST', '/api/admin/users/:id/give-item', (ctx, req) => {
  needAdmin(ctx);
  const u = targetUser(ctx);
  const it = ITEMS[Number(ctx.body.itemId)] || fail(400, 'Предмет не найден');
  const count = Math.min(50, Math.max(1, Math.floor(Number(ctx.body.count) || 1)));
  tx(() => { for (let i = 0; i < count; i++) q.invAdd.run(u.id, it.id, it.price, 'admin', now()); });
  admin.log(req, 'give_item', u.id, { item: it.id, name: `${it.w} | ${it.s}`, count });
  return { ok: true };
});
on('POST', '/api/admin/users/:id/ban', (ctx, req) => {
  needAdmin(ctx);
  const u = targetUser(ctx);
  const banned = ctx.body.banned ? 1 : 0;
  qaBan.run(banned, u.id); if (banned) qaKill.run(u.id);
  admin.log(req, banned ? 'ban' : 'unban', u.id);
  return { ok: true };
});
on('POST', '/api/admin/prices/refresh', (ctx, req) => { needAdmin(ctx); admin.log(req, 'prices_refresh'); refreshPrices(); return { ok: true, started: true }; });
on('GET', '/api/admin/log', ctx => { needAdmin(ctx); return qaLog.all(); });

on('GET', '/api/admin/stats', ctx => {
  needAdmin(ctx);
  const one = sql => db.prepare(sql).get();
  return {
    users: one('SELECT COUNT(*) n FROM users').n,
    deposits: one("SELECT COALESCE(SUM(amount),0) s FROM ledger WHERE type = 'deposit'").s,
    demoTopups: one("SELECT COALESCE(SUM(amount),0) s FROM ledger WHERE type = 'demo_topup'").s,
    stakes: one('SELECT COALESCE(SUM(stake),0) s FROM games').s,
    payouts: one('SELECT COALESCE(SUM(payout),0) s FROM games').s,
    adminAdjust: one("SELECT COALESCE(SUM(amount),0) s FROM ledger WHERE type = 'admin_adjust'").s,
    bonuses: one("SELECT COALESCE(SUM(amount),0) s FROM ledger WHERE type = 'bonus'").s,
    balances: one('SELECT COALESCE(SUM(balance),0) s FROM users').s,
    online: clients.size,
    games: counts,
    pendingWithdrawals: one("SELECT COUNT(*) n FROM withdrawals WHERE status = 'pending'").n,
  };
});
on('GET', '/api/admin/withdrawals', ctx => { needAdmin(ctx); return q.wdList.all(String(ctx.url.searchParams.get('status') || 'pending')); });
on('POST', '/api/admin/withdrawals/:id', ctx => {
  needAdmin(ctx);
  const st = ctx.body.status;
  if (!['sent', 'rejected'].includes(st)) fail(400, 'status: sent | rejected');
  tx(() => {
    const w = q.wdGet.get(Number(ctx.params.id)) || fail(404, 'Не найдено');
    if (w.status !== 'pending') fail(400, 'Уже обработано');
    q.wdSet.run(st, now(), w.id);
    q.invStatus.run(st === 'sent' ? 'withdrawn' : 'owned', w.inv_uid);
  });
  return { ok: true };
});

/* ---------- HTTP ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.webmanifest': 'application/manifest+json' };

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req, limit = 16384) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new HttpError(413, 'Слишком большой запрос')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.normalize(path.join(PUB, rel));
  if (!file.startsWith(PUB + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': /\.(html|js|css)$/.test(file) ? 'no-cache' : 'public, max-age=3600' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  const url = new URL(req.url, BASE);

  if (req.method === 'GET' && url.pathname === '/api/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    clients.add(res);
    res.write(`data: ${JSON.stringify({ type: 'init', feed, stats: stats() })}\n\n`);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => { clearInterval(ping); clients.delete(res); });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/admin') return serveStatic(req, res, '/admin.html');
  const route = routes.find(r => r.method === req.method && r.re.test(url.pathname));
  if (!route) {
    if (req.method === 'GET' && !url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname);
    return send(res, 404, { error: 'Not found' });
  }

  try {
    const ctx = { url, params: url.pathname.match(route.re).groups || {}, user: auth.sessionUser(req), admin: admin.isAdmin(req), body: {} };
    if (ctx.user && ctx.user.banned) ctx.user = null;
    if (req.method === 'POST') {
      const raw = await readBody(req);
      if (route.opts.webhook) ctx.rawBody = raw;
      else {
        // защита от CSRF: только JSON + свой заголовок + свой Origin
        const origin = req.headers.origin;
        // свой адрес из BASE_URL или тот же хост (например, телефон по Wi-Fi: http://192.168.x.x:3000)
        const host = req.headers.host;
        if (origin && origin !== BASE && origin !== `http://${host}` && origin !== `https://${host}`) fail(403, 'Bad origin');
        if (req.headers['x-grum'] !== '1') fail(403, 'Bad request');
        if (raw) { try { ctx.body = JSON.parse(raw); } catch { fail(400, 'Bad JSON'); } }
        if (typeof ctx.body !== 'object' || ctx.body === null) ctx.body = {};
      }
    }
    const out = await route.handler(ctx, req, res);
    if (!route.opts.raw && !res.headersSent) send(res, 200, out);
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error(e);
    if (!res.headersSent) send(res, status, { error: status === 500 ? 'Ошибка сервера' : e.message });
  }
});

/* ---------- автообновление цен ---------- */
const PRICE_HOURS = Number(process.env.PRICE_UPDATE_HOURS ?? 6);   // 0 = выключено
let priceBusy = false;
async function refreshPrices() {
  if (priceBusy) return; priceBusy = true;
  try {
    await prices.updatePrices({ log: m => console.log('[цены]', m) });
    catalog.reload();
    broadcast({ type: 'catalog', pricesUpdatedAt: catalog.meta.pricesUpdatedAt });
  } catch (e) { console.error('[цены] ошибка:', e.message); }
  finally { priceBusy = false; }
}
if (PRICE_HOURS > 0) {
  const ms = PRICE_HOURS * 3600e3;
  const age = Date.now() - catalog.meta.pricesUpdatedAt;
  setTimeout(refreshPrices, age >= ms ? 5000 : ms - age).unref?.();
  setInterval(refreshPrices, ms).unref();
}

server.listen(PORT, () => {
  console.log(`GRUMGrade: ${BASE}  (порт ${PORT}${DEMO ? ', DEMO_MODE включён' : ''})`);
  console.log(`Предметов: ${ITEMS.length}, кейсов: ${CASES.length}, цены от ${catalog.meta.pricesUpdatedAt ? new Date(catalog.meta.pricesUpdatedAt).toLocaleString('ru-RU') : '—'}${PRICE_HOURS > 0 ? `, автообновление каждые ${PRICE_HOURS} ч` : ''}`);
});
