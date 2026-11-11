'use strict';
// База данных: встроенный SQLite из Node (node:sqlite), отдельный сервер БД не нужен.
// Все деньги хранятся в копейках (целые числа), чтобы не было ошибок округления.
const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const file = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'grumgrade.db');
const db = new DatabaseSync(file);

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  steam_id     TEXT UNIQUE NOT NULL,
  name         TEXT NOT NULL,
  avatar       TEXT,
  balance      INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
  server_seed  TEXT NOT NULL,
  client_seed  TEXT NOT NULL,
  nonce        INTEGER NOT NULL DEFAULT 0,
  trade_url    TEXT,
  banned       INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL
);

-- status: owned | used (сгорел в апгрейде) | sold | withdraw_pending | withdrawn
CREATE TABLE IF NOT EXISTS inventory (
  uid        INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  item_id    INTEGER NOT NULL,
  price      INTEGER NOT NULL,
  status     TEXT NOT NULL DEFAULT 'owned',
  source     TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS inv_user ON inventory(user_id, status);

CREATE TABLE IF NOT EXISTS games (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id          INTEGER NOT NULL REFERENCES users(id),
  type             TEXT NOT NULL,           -- upgrade | case
  stake            INTEGER NOT NULL,
  chance           REAL,
  roll             REAL NOT NULL,
  win              INTEGER NOT NULL,
  item_id          INTEGER,
  case_id          INTEGER,
  payout           INTEGER NOT NULL,
  server_seed_hash TEXT NOT NULL,
  client_seed      TEXT NOT NULL,
  nonce            INTEGER NOT NULL,
  created_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS games_user ON games(user_id, id);

-- раскрытые серверные сиды (после смены сида игрок может проверить все прошлые игры)
CREATE TABLE IF NOT EXISTS seeds_revealed (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id          INTEGER NOT NULL REFERENCES users(id),
  server_seed      TEXT NOT NULL,
  server_seed_hash TEXT NOT NULL,
  client_seed      TEXT NOT NULL,
  last_nonce       INTEGER NOT NULL,
  revealed_at      INTEGER NOT NULL
);

-- журнал всех движений баланса
CREATE TABLE IF NOT EXISTS ledger (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  type       TEXT NOT NULL,   -- deposit | demo_topup | upgrade_stake | case_open | sell
  amount     INTEGER NOT NULL,
  ref        TEXT,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ledger_deposit_ref ON ledger(ref) WHERE type = 'deposit';

CREATE TABLE IF NOT EXISTS withdrawals (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  inv_uid    INTEGER NOT NULL REFERENCES inventory(uid),
  trade_url  TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending', -- pending | sent | rejected
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`);

// Миграции для уже созданных баз
const userCols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
if (!userCols.includes('last_bonus')) db.exec('ALTER TABLE users ADD COLUMN last_bonus INTEGER NOT NULL DEFAULT 0');
db.exec(`
CREATE TABLE IF NOT EXISTS admin_sessions (
  token      TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  ip         TEXT
);
-- всё, что делает админ (выдача валюты, баны и т.д.), пишется сюда
CREATE TABLE IF NOT EXISTS admin_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  action      TEXT NOT NULL,
  target_user INTEGER,
  details     TEXT,
  ip          TEXT,
  created_at  INTEGER NOT NULL
);
`);

// Транзакция: всё внутри либо применяется целиком, либо откатывается.
function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

module.exports = { db, tx };
