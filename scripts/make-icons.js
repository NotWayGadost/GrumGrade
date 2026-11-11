'use strict';
// Генерирует PNG-иконки приложения (лого GRUMGrade) без внешних библиотек: node scripts/make-icons.js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'public', 'icons');
fs.mkdirSync(OUT, { recursive: true });

// Знак GRUMGrade: жирная «G» + стрелка апгрейда в разрыве буквы (координаты 40×40)
const TRI = [[32.5, 2.5], [39, 10.5], [26, 10.5]];
function inG(x, y) {
  const dx = x - 20, dy = y - 20, d = Math.hypot(dx, dy);
  const ang = Math.atan2(-dy, dx) * 180 / Math.PI;
  const ring = d >= 9.5 && d <= 15 && !(ang > 5 && ang < 62);
  const bar = x >= 21 && x <= 35 && y >= 18.6 && y <= 23.6 && d <= 15;
  return ring || bar;
}
function inPoly(x, y, P) {
  let inside = false;
  for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
    const [xi, yi] = P[i], [xj, yj] = P[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

function render(size, logoScale) {
  const px = Buffer.alloc(size * size * 4);
  const SS = 4, k = 40 / (size * logoScale), off = (size - size * logoScale) / 2;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    // фон: тёмный с оранжевым свечением в центре
    const dx = (x + .5) / size - .5, dy = (y + .5) / size - .45, d = Math.sqrt(dx * dx + dy * dy);
    let c = mix([22, 23, 30], [15, 16, 21], (y + .5) / size);
    c = mix(c, [120, 70, 0], Math.max(0, .55 - d) * .9);
    let acc = [0, 0, 0];
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const lx = ((x + (sx + .5) / SS) - off) * k, ly = ((y + (sy + .5) / SS) - off) * k;
      let s = c;
      if (inG(lx, ly) || inPoly(lx, ly, TRI)) s = mix([255, 228, 80], [255, 128, 16], Math.min(1, Math.max(0, (lx + ly - 8) / 60)));
      acc = acc.map((v, i) => v + s[i]);
    }
    const o = (y * size + x) * 4;
    px[o] = acc[0] / (SS * SS); px[o + 1] = acc[1] / (SS * SS); px[o + 2] = acc[2] / (SS * SS); px[o + 3] = 255;
  }
  return png(size, size, px);
}

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4); }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const jobs = [['icon-180.png', 180, .66], ['icon-192.png', 192, .66], ['icon-512.png', 512, .66], ['icon-maskable-512.png', 512, .5], ['favicon-32.png', 32, .9],
  ['icon-1024.png', 1024, .66],            // иконка iOS-приложения
  ['splash-2732.png', 2732, .16]];         // экран запуска iOS-приложения
for (const [name, size, scale] of jobs) { fs.writeFileSync(path.join(OUT, name), render(size, scale)); console.log('✓', name); }
