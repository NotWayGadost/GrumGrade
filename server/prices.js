'use strict';
// Обновление цен из рыночных API.
//   1) Skinport  — https://api.skinport.com/v1/items (один запрос на все предметы, есть фазы допплеров)
//   2) market.csgo.com — запасной источник, если на Skinport предмета нет
// Цена в монетах сайта = цена в PRICE_CURRENCY × PRICE_MULTIPLIER.
// Ручные цены: data/price-overrides.json  { "AK-47 | Redline": 2500, ... }  — важнее рынка.
const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, '..', 'data');
const ITEMS_FILE = path.join(DATA, 'items.json');
const OVERRIDES_FILE = path.join(DATA, 'price-overrides.json');

const WEARS = [['FT', 'Field-Tested'], ['MW', 'Minimal Wear'], ['FN', 'Factory New'], ['WW', 'Well-Worn'], ['BS', 'Battle-Scarred']];
const WEAR_NAME = Object.fromEntries(WEARS);
const PHASE = /^(.*) (P[1-4]|Ruby|Sapphire|Black Pearl|Emerald)$/;
const UA = { 'User-Agent': 'GRUMGrade-price-updater/1.0' };

async function fetchJson(url, headers = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 30000);
  try {
    const r = await fetch(url, { headers: { ...UA, ...headers }, signal: ctrl.signal });
    if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

async function loadSources(currency) {
  const src = { skinport: new Map(), csgomarket: new Map(), errors: [] };
  try {
    const sp = await fetchJson(`https://api.skinport.com/v1/items?app_id=730&currency=${currency}&tradable=0`, { 'Accept-Encoding': 'br' });
    for (const x of sp) {
      const p = x.suggested_price ?? x.median_price ?? x.min_price;
      if (p > 0) src.skinport.set(x.market_hash_name + '|' + (x.version || ''), p);
    }
  } catch (e) { src.errors.push('skinport: ' + e.message); }
  try {
    const cm = await fetchJson(`https://market.csgo.com/api/v2/prices/${currency}.json`);
    for (const x of cm.items || []) { const p = Number(x.price); if (p > 0) src.csgomarket.set(x.market_hash_name, p); }
  } catch (e) { src.errors.push('market.csgo.com: ' + e.message); }
  if (!src.skinport.size && !src.csgomarket.size) throw new Error('Нет ни одного источника цен: ' + src.errors.join('; '));
  return src;
}

// Название на рынке + фаза допплера
function marketName(row) {
  const [w, s, t] = row;
  if (t === 'sticker') return { base: 'Sticker | ' + s, version: '' };
  const m = s.match(PHASE);
  const skin = m ? m[1] : s;
  const version = m ? (m[2].startsWith('P') ? 'Phase ' + m[2].slice(1) : m[2]) : '';
  return { base: `${w} | ${skin}`, version };
}

function lookup(src, name, version) {
  const sp = src.skinport.get(name + '|' + version);
  if (sp) return { price: sp, source: 'skinport' };
  if (!version) { const cm = src.csgomarket.get(name); if (cm) return { price: cm, source: 'market.csgo.com' }; }
  return null;
}

function priceRow(row, src) {
  const { base, version } = marketName(row);
  if (row[2] === 'sticker') { const r = lookup(src, base, version); return r && { ...r, wear: '' }; }
  // Если износ уже выбран — держим его, чтобы предмет не «прыгал» между FT и FN.
  const order = row[6] && WEAR_NAME[row[6]] ? [[row[6], WEAR_NAME[row[6]]]] : WEARS;
  for (const [code, full] of order) {
    const r = lookup(src, `${base} (${full})`, version);
    if (r) return { ...r, wear: code };
  }
  return null;
}

const round = p => p >= 100 ? Math.round(p) : Math.round(p * 100) / 100;

async function updatePrices({ log = console.log } = {}) {
  const currency = process.env.PRICE_CURRENCY || 'RUB';
  const mult = Number(process.env.PRICE_MULTIPLIER ?? 1);
  const maxJump = Number(process.env.PRICE_MAX_JUMP ?? 10); // защита от кривых данных: скачок больше чем в N раз — пропускаем
  const rows = JSON.parse(fs.readFileSync(ITEMS_FILE, 'utf8'));
  const overrides = fs.existsSync(OVERRIDES_FILE) ? JSON.parse(fs.readFileSync(OVERRIDES_FILE, 'utf8')) : {};
  const src = await loadSources(currency);
  src.errors.forEach(e => log('⚠ ' + e));

  const res = { updated: 0, overridden: 0, missing: [], suspicious: [], sources: { skinport: 0, 'market.csgo.com': 0 } };
  const now = Date.now();
  for (const row of rows) {
    const key = `${row[0]} | ${row[1]}`;
    if (overrides[key] > 0) { row[4] = round(overrides[key]); row[7] = now; res.overridden++; continue; }
    const r = priceRow(row, src);
    if (!r) { res.missing.push(key); continue; }
    const np = round(r.price * mult);
    if (row[7] && row[4] > 0 && (np / row[4] > maxJump || row[4] / np > maxJump)) { res.suspicious.push(`${key}: ${row[4]} → ${np}`); continue; }
    row[4] = np; row[6] = r.wear; row[7] = now;
    res.updated++; res.sources[r.source]++;
  }
  const tmp = ITEMS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(rows));
  fs.renameSync(tmp, ITEMS_FILE);
  log(`Цены обновлены: ${res.updated} (skinport ${res.sources.skinport}, market.csgo.com ${res.sources['market.csgo.com']}), вручную ${res.overridden}, не найдено ${res.missing.length}, подозрительных ${res.suspicious.length}`);
  if (res.missing.length) log('Не найдено на рынке (оставлена старая цена): ' + res.missing.join(', '));
  if (res.suspicious.length) log('Пропущены (скачок цены): ' + res.suspicious.join('; '));
  return res;
}

module.exports = { updatePrices, ITEMS_FILE };
