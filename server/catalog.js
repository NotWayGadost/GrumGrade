'use strict';
// Каталог предметов и кейсов. Цены живут ТОЛЬКО на сервере — клиент их не может подменить.
// data/items.json: [оружие, скин, тип, редкость, цена в монетах, картинка, износ, когда обновлена цена]
// Порядок строк = id предмета. Не переставляйте строки — на id ссылается инвентарь. Новые — только в конец.
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'items.json');
const IMGP = 'https://community.akamai.steamstatic.com/economy/image/';
const CASE_MARGIN = Number(process.env.CASE_MARGIN ?? 0.15);   // наценка кейса над матожиданием

const ITEMS = [];
const CASES = [];
const meta = { pricesUpdatedAt: 0 };

const c2 = it => it.price / 100;
// cat — раздел на странице кейсов. Порядок = id кейса: старые не переставлять, новые только в конец.
const DEFS = [
  { name: 'Бомж',        col: '#8a9aa8', cat: 'Дешёвые',  f: it => c2(it) <= 40 },
  { name: 'Стартовый',   col: '#4b69ff', cat: 'Дешёвые',  f: it => c2(it) >= 10 && c2(it) <= 1100 },
  { name: 'Огненный',    col: '#ff6a1a', cat: 'Популярные', f: it => /Asiimov|Blaze|Howl|Redline|Water|Kill|Bloodsport|Candy|Cyrex|Hellfire|Fuel/.test(it.s), hot: 1 },
  { name: 'Снайпер',     col: '#3ab0a8', cat: 'Оружие',   f: it => it.t === 'sniper' },
  { name: 'Ножевой',     col: '#e4ae39', cat: 'Популярные', f: it => it.t === 'knife' || (c2(it) >= 1000 && c2(it) <= 12000 && it.t !== 'gloves'), hot: 1 },
  { name: 'Перчаточный', col: '#ff5ab0', cat: 'Ножи и перчатки', f: it => it.t === 'gloves' || (c2(it) >= 2000 && c2(it) <= 11200) },
  { name: 'Миллионер',   col: '#d32ce6', cat: 'Премиум',  f: it => c2(it) >= 9000 },
  { name: 'GRUM',        col: '#ffd21f', cat: 'Популярные', f: () => true, hot: 1, main: 1 },
  { name: 'Мини',        col: '#7d8794', cat: 'Дешёвые',  f: it => c2(it) <= 15 },
  { name: 'Армейский',   col: '#4b69ff', cat: 'Дешёвые',  f: it => it.r === 'mil' || it.r === 'ind' },
  { name: 'Запретка',    col: '#8847ff', cat: 'Дешёвые',  f: it => it.r === 'res' || it.r === 'mil' },
  { name: 'AK-47',       col: '#c0262e', cat: 'Оружие',   f: it => it.w === 'AK-47', hot: 1 },
  { name: 'AWP',         col: '#3a7ad8', cat: 'Оружие',   f: it => it.w === 'AWP' },
  { name: 'M4',          col: '#5ab0e0', cat: 'Оружие',   f: it => it.w.startsWith('M4') },
  { name: 'Пистолеты',   col: '#d0503a', cat: 'Оружие',   f: it => it.t === 'pistol' },
  { name: 'SMG',         col: '#6ad84a', cat: 'Оружие',   f: it => it.t === 'smg' },
  { name: 'Допплер',     col: '#7a4ad8', cat: 'Ножи и перчатки', f: it => it.t === 'knife' && /Doppler|Fade|Marble/.test(it.s), hot: 1 },
  { name: 'Ножи',        col: '#e4ae39', cat: 'Ножи и перчатки', f: it => it.t === 'knife' },
  { name: 'Перчатки',    col: '#ff5ab0', cat: 'Ножи и перчатки', f: it => it.t === 'gloves' },
  { name: 'Наклейки',    col: '#f0c040', cat: 'Наклейки', f: it => it.t === 'sticker' },
  { name: 'Катовице 2014', col: '#5ad0f0', cat: 'Наклейки', f: it => /Katowice 2014/.test(it.s) || (it.t === 'sticker' && c2(it) >= 5000) },
  { name: 'Засекреченный', col: '#d32ce6', cat: 'Премиум', f: it => it.r === 'cla' || it.r === 'cov' },
  { name: 'Тайный',      col: '#eb4b4b', cat: 'Премиум',  f: it => it.r === 'cov' || (it.r === 'gold' && c2(it) <= 60000) },
  { name: 'Хайроллер',   col: '#ffd21f', cat: 'Премиум',  f: it => c2(it) >= 100000 },
];

// Перечитать items.json и пересчитать кейсы. Массивы меняются на месте — все модули видят новые цены.
function reload() {
  const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  const items = raw.map((a, i) => ({
    id: i, w: a[0], s: a[1], t: a[2],
    r: a[2] === 'knife' || a[2] === 'gloves' ? 'gold' : a[3],
    price: Math.max(1, Math.round(a[4] * 100)),              // копейки
    img: a[5].startsWith('http') ? a[5] : IMGP + a[5],
    wear: a[6] || '',
  }));
  // Шанс предмета ∝ 1/цена. Цена кейса = матожидание × (1 + наценка).
  const cases = DEFS.map((c, i) => {
    const its = items.filter(c.f);
    const w = its.map(it => 1 / it.price);
    const sw = w.reduce((a, b) => a + b, 0);
    const probs = w.map(x => x / sw);
    const ev = its.reduce((a, it, k) => a + it.price * probs[k], 0);
    return { id: i, name: c.name, col: c.col, cat: c.cat, hot: !!c.hot, main: !!c.main, items: its.map(it => it.id), probs, price: Math.max(100, Math.round(ev * (1 + CASE_MARGIN))) };
  });
  ITEMS.splice(0, ITEMS.length, ...items);
  CASES.splice(0, CASES.length, ...cases);
  meta.pricesUpdatedAt = Math.max(0, ...raw.map(a => a[7] || 0));
}
reload();

function pickCaseItem(c, roll) {
  let acc = 0;
  for (let k = 0; k < c.items.length; k++) { acc += c.probs[k]; if (roll < acc) return ITEMS[c.items[k]]; }
  return ITEMS[c.items[c.items.length - 1]];
}

module.exports = { ITEMS, CASES, pickCaseItem, reload, meta };
