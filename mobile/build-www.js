'use strict';
// Собирает mobile/www — всё, что попадёт внутрь iOS-приложения:
//   • файлы из public/ (без админки и service worker)
//   • каталог предметов и кейсов (catalog.json) — офлайн работает без сервера
//   • картинки всех скинов (img/*.png) — работает даже без интернета
//   • шрифт Exo 2 (fonts/) — без Google Fonts
// Запуск: node build-www.js   (нужен интернет для первой загрузки картинок; дальше берутся из .cache)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const PUB = path.join(ROOT, 'public');
const WWW = path.join(__dirname, 'www');
const CACHE = path.join(__dirname, '.cache');
const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, 'app.config.json'), 'utf8'));
const SKIP = new Set(['admin.html', 'sw.js', 'splash-2732.png', 'icon-1024.png']);
// --web: сборка для GitHub Pages (ставится на iPhone через «На экран Домой», работает офлайн)
const WEB = process.argv.includes('--web');

const { ITEMS, CASES, meta } = require(path.join(ROOT, 'server', 'catalog.js'));

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const f of fs.readdirSync(src, { withFileTypes: true })) {
    if (SKIP.has(f.name)) continue;
    const s = path.join(src, f.name), d = path.join(dst, f.name);
    f.isDirectory() ? copyDir(s, d) : fs.copyFileSync(s, d);
  }
}

async function download(url, file, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 GRUMGrade-build' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
      return true;
    } catch (e) { if (i === tries - 1) return false; await new Promise(r => setTimeout(r, 800 * (i + 1))); }
  }
}

async function pool(list, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < list.length) { const k = i++; await fn(list[k], k); } }));
}

async function images() {
  const dir = path.join(WWW, 'img'), cdir = path.join(CACHE, 'img');
  fs.mkdirSync(dir, { recursive: true }); fs.mkdirSync(cdir, { recursive: true });
  let ok = 0, fail = 0;
  const items = ITEMS.map(it => ({ ...it }));
  await pool(items, 8, async it => {
    const url = `${it.img}/256fx256f`;
    const cached = path.join(cdir, crypto.createHash('sha1').update(url).digest('hex') + '.png');
    if (fs.existsSync(cached) || await download(url, cached)) {
      fs.copyFileSync(cached, path.join(dir, `${it.id}.png`));
      it.img = `img/${it.id}.png`; it.local = true; ok++;
    } else fail++;  // останется картинка из интернета
  });
  console.log(`Картинки скинов: ${ok} в приложении${fail ? `, ${fail} не скачались (будут грузиться из интернета)` : ''}`);
  return items;
}

async function fonts(html) {
  const cssUrl = 'https://fonts.googleapis.com/css2?family=Exo+2:wght@400;600;700;800;900&display=swap';
  try {
    const r = await fetch(cssUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    let css = await r.text();
    const dir = path.join(WWW, 'fonts'), cdir = path.join(CACHE, 'fonts');
    fs.mkdirSync(dir, { recursive: true }); fs.mkdirSync(cdir, { recursive: true });
    const urls = [...new Set([...css.matchAll(/url\((https:[^)]+)\)/g)].map(m => m[1]))];
    for (const u of urls) {
      const name = crypto.createHash('sha1').update(u).digest('hex').slice(0, 16) + path.extname(new URL(u).pathname);
      const cached = path.join(cdir, name);
      if (!fs.existsSync(cached) && !(await download(u, cached))) throw new Error('font ' + u);
      fs.copyFileSync(cached, path.join(dir, name));
      css = css.split(u).join(name);
    }
    fs.writeFileSync(path.join(dir, 'exo2.css'), css);
    console.log(`Шрифт Exo 2: ${urls.length} файлов в приложении`);
    return html.replace(/<link rel="preconnect"[^>]*>\s*/g, '').replace(/<link href="https:\/\/fonts\.googleapis\.com[^>]*>/, '<link href="fonts/exo2.css" rel="stylesheet">');
  } catch (e) {
    console.log('⚠ Шрифт не скачался, будет системный: ' + e.message);
    return html;
  }
}

(async () => {
  fs.rmSync(WWW, { recursive: true, force: true });
  copyDir(PUB, WWW);

  const items = await images();
  fs.writeFileSync(path.join(WWW, 'catalog.json'), JSON.stringify({ items, cases: CASES, pricesUpdatedAt: meta.pricesUpdatedAt, currency: 'RUB' }));

  const native = {
    demo: true, offline: true, native: true,
    upgradeEdge: CFG.upgradeEdge, upgradeMax: CFG.upgradeMax,
    telegram: CFG.telegram || null,
    startBalance: Math.round((CFG.startBalance ?? 1000) * 100),
    bonus: CFG.bonus && CFG.bonus.max > 0 ? { min: Math.round(CFG.bonus.min * 100), max: Math.round(CFG.bonus.max * 100), hours: CFG.bonus.hours } : null,
  };
  let html = fs.readFileSync(path.join(WWW, 'index.html'), 'utf8');
  html = await fonts(html);
  if (WEB) native.web = true;
  // относительные пути: приложение должно работать и из capacitor://localhost/, и из подпапки GitHub Pages (/GrumGrade/)
  html = html.replace(/(href|src)="\/(?!\/)/g, '$1="');
  if (!WEB) html = html.replace(/<link rel="manifest"[^>]*>\s*/, '');
  html = html.replace('<script src="app.js"></script>', `<script>window.GRUM_NATIVE=${JSON.stringify(native)}</script>\n<script src="app.js"></script>`);
  if (!html.includes('GRUM_NATIVE')) throw new Error('Не нашёл <script src="/app.js"> в index.html');
  fs.writeFileSync(path.join(WWW, 'index.html'), html);

  if (WEB) {
    // manifest с относительными путями
    const man = JSON.parse(fs.readFileSync(path.join(WWW, 'manifest.webmanifest'), 'utf8'));
    man.start_url = './#upgrade'; man.scope = './';
    man.icons = man.icons.map(i => ({ ...i, src: i.src.replace(/^\//, '') }));
    fs.writeFileSync(path.join(WWW, 'manifest.webmanifest'), JSON.stringify(man, null, 2));
    // service worker: заранее кладёт в телефон ВСЕ файлы — после первого открытия работает без интернета
    const files = listFiles(WWW).filter(f => f !== 'sw.js');
    const ver = crypto.createHash('sha1').update(files.map(f => f + fs.statSync(path.join(WWW, f)).size).join('|') + fs.readFileSync(path.join(WWW, 'app.js'))).digest('hex').slice(0, 10);
    fs.writeFileSync(path.join(WWW, 'sw.js'), `'use strict';
// Сгенерировано build-www.js. Всё приложение хранится в телефоне — работает без интернета.
const V='grum-app-${ver}';
const FILES=${JSON.stringify(['./', ...files])};
const abs=f=>new URL(f,self.registration.scope).href;
self.addEventListener('install',e=>e.waitUntil(caches.open(V).then(c=>c.addAll(FILES.map(abs))).then(()=>self.skipWaiting())));
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==V).map(x=>caches.delete(x)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',e=>{const r=e.request;if(r.method!=='GET'||new URL(r.url).origin!==location.origin)return;
  e.respondWith(caches.open(V).then(async c=>{const hit=await c.match(r.mode==='navigate'?abs('./'):r,{ignoreSearch:true});if(hit)return hit;
    try{const res=await fetch(r);if(res.ok)c.put(r,res.clone());return res}catch(err){return (await c.match(abs('./')))||Response.error()}}))});
`);
    console.log(`Офлайн-кэш (Pages): ${files.length} файлов, версия ${ver}`);
  }

  const size = dirSize(WWW);
  console.log(`Готово: mobile/www (${(size / 1048576).toFixed(1)} МБ), предметов ${items.length}, кейсов ${CASES.length}`);
})().catch(e => { console.error('Ошибка сборки:', e); process.exit(1); });

function listFiles(d, base = d) { let out = []; for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); out = out.concat(f.isDirectory() ? listFiles(p, base) : [path.relative(base, p).split(path.sep).join('/')]); } return out; }
function dirSize(d) { let s = 0; for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); s += f.isDirectory() ? dirSize(p) : fs.statSync(p).size; } return s; }
