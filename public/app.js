'use strict';
/* GRUMGrade — приложение.
   Онлайн: всё считает сервер (баланс, игры, цены).
   Офлайн: игра без интернета на виртуальном балансе в телефоне, тот же provably fair алгоритм. */
const R={cons:{n:'Ширпотреб',c:'#b0c3d9'},ind:{n:'Промышленное',c:'#5e98d9'},mil:{n:'Армейское',c:'#4b69ff'},res:{n:'Запрещённое',c:'#8847ff'},cla:{n:'Засекреченное',c:'#d32ce6'},cov:{n:'Тайное',c:'#eb4b4b'},gold:{n:'Редкое ★',c:'#e4ae39'}};
const ext=it=>it.wear||'—';
const CATS=['Популярные','Дешёвые','Оружие','Ножи и перчатки','Наклейки','Премиум'];
let CFG={upgradeEdge:.1,upgradeMax:.75,demo:false},ITEMS=[],CASES=[],ME=null,INV=[],CAT_AT=0;

/* ---------- настройки устройства ---------- */
const P={sound:true,fast:false,upMode:'bottom',mode:'online',installHidden:false};
try{Object.assign(P,JSON.parse(localStorage.getItem('grum_prefs'))||{})}catch(e){}
const savePrefs=()=>{try{localStorage.setItem('grum_prefs',JSON.stringify(P))}catch(e){}};
// Нативное iOS-приложение (Capacitor): всё внутри, сервер не нужен → всегда офлайн
const NATIVE=window.GRUM_NATIVE||null;
if(NATIVE)P.mode='offline';
const OFFLINE=()=>P.mode==='offline';
const imgSrc=(it,s=256)=>it.local?it.img:`${it.img}/${s}fx${s}f`;

/* ---------- utils ---------- */
const $=s=>document.querySelector(s);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt=n=>Number(n).toLocaleString('ru-RU',{minimumFractionDigits:2,maximumFractionDigits:2});
const coin='<i class="coin">G</i>';
const money=n=>coin+fmt(n);
const pct=c=>(c*100).toLocaleString('ru-RU',{minimumFractionDigits:2,maximumFractionDigits:2})+'%';
const bal=()=>ME?ME.balance/100:0;
const lsGet=k=>{try{return JSON.parse(localStorage.getItem(k))}catch(e){return null}};
const lsSet=(k,v)=>{try{localStorage.setItem(k,JSON.stringify(v))}catch(e){}};
const left=ms=>{const t=Math.ceil(ms/6e4),h=Math.floor(t/60),m=t%60;return h?`${h} ч${m?` ${m} мин`:''}`:`${m} мин`};

async function net(path,body){
  const opt=body!==undefined?{method:'POST',headers:{'Content-Type':'application/json','x-grum':'1'},body:JSON.stringify(body)}:{};
  const r=await fetch(path,{credentials:'same-origin',...opt});
  const j=await r.json().catch(()=>({error:'Ошибка сети'}));
  if(!r.ok)throw new Error(j.error||'Ошибка');
  return j}
const api=(path,body)=>OFFLINE()?OFF.handle(path,body):net(path,body);
function applyState(j){if('user' in j)ME=j.user;if(j.inventory)INV=j.inventory;renderHeader()}

/* ---------- provably fair (браузер) ---------- */
const enc=new TextEncoder();
const hex=b=>[...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join('');
const rndHex=n=>hex(crypto.getRandomValues(new Uint8Array(n)));
async function sha256hex(s){return hex(await crypto.subtle.digest('SHA-256',enc.encode(s)))}
async function hmacRoll(serverSeed,clientSeed,nonce){
  const key=await crypto.subtle.importKey('raw',enc.encode(serverSeed),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const h=hex(await crypto.subtle.sign('HMAC',key,enc.encode(`${clientSeed}:${nonce}`)));
  return parseInt(h.slice(0,13),16)/2**52}

/* ---------- ОФЛАЙН-движок: те же правила, что на сервере ---------- */
const OFF={
  KEY:'grum_offline_v1',
  async state(){if(this.s)return this.s;let s=lsGet(this.KEY);
    if(!s){const ss=rndHex(32);s={balance:NATIVE?.startBalance??100000,inv:[],n:1,ss,ssHash:await sha256hex(ss),cs:rndHex(8),nonce:0,games:[],lastBonus:0,revealed:[]};}
    this.s=s;this.save();return s},
  save(){lsSet(this.KEY,this.s)},
  err(m){throw new Error(m)},
  price(id){return ITEMS[id]?ITEMS[id].price:0},
  pub(){const s=this.s;const b=CFG.bonus;
    return{user:{id:0,name:NATIVE?'Игрок':'Офлайн-игрок',avatar:null,balance:s.balance,steamId:'offline',tradeUrl:null,isAdmin:false,offline:true,
      nextBonusAt:b?s.lastBonus+b.hours*36e5:null,fair:{serverSeedHash:s.ssHash,clientSeed:s.cs,nonce:s.nonce}},
      inventory:s.inv.map(x=>({uid:x.uid,id:x.id,price:this.price(x.id),status:'owned'}))}},
  game(g){const s=this.s;s.games.unshift({...g,server_seed_hash:s.ssHash,client_seed:s.cs,nonce:s.nonce,created_at:Date.now()});if(s.games.length>300)s.games.length=300;s.nonce++},
  async handle(path,body={}){
    const s=await this.state();let m;
    if(path==='/api/config')return{...(lsGet('grum_config')||{}),...CFG_OFF()};
    if(path==='/api/catalog'){
      if(NATIVE){const r=await fetch('catalog.json');if(r.ok)return r.json()}  // каталог упакован в приложение
      const c=lsGet('grum_catalog');if(!c)this.err('Открой приложение один раз с интернетом, чтобы скачать каталог');return c}
    if(path==='/api/me')return this.pub();
    if(path==='/api/upgrade'){
      const uids=[...new Set((body.uids||[]).map(Number))];const amount=Math.floor(+body.amount||0);const t=ITEMS[+body.target];
      if(!t)this.err('Выберите предмет для апгрейда');
      const its=uids.map(u=>s.inv.find(x=>x.uid===u)||this.err('Предмет недоступен'));
      if(amount<0||amount>s.balance)this.err('Недостаточно баланса');
      const stake=its.reduce((a,x)=>a+this.price(x.id),0)+amount;
      if(stake<=0)this.err('Выберите предметы или баланс');if(t.price<=stake)this.err('Цель должна быть дороже ставки');
      const chance=Math.min(CFG.upgradeMax,stake/t.price*(1-CFG.upgradeEdge));
      const roll=await hmacRoll(s.ss,s.cs,s.nonce),win=roll<chance,nonce=s.nonce;
      s.inv=s.inv.filter(x=>!uids.includes(x.uid));s.balance-=amount;let uid=null;
      if(win){uid=s.n++;s.inv.unshift({uid,id:t.id})}
      this.game({type:'upgrade',stake,chance,roll,win:win?1:0,item_id:t.id,payout:win?t.price:0});this.save();
      if(win)localDrop('upgrade',t.id);
      return{result:{win,roll,chance,nonce,item:t.id,uid},...this.pub()}}
    if((m=path.match(/^\/api\/cases\/(\d+)\/open$/))){
      const c=CASES[+m[1]]||this.err('Кейс не найден');if(s.balance<c.price)this.err('Недостаточно баланса');
      const roll=await hmacRoll(s.ss,s.cs,s.nonce),nonce=s.nonce;let acc=0,it=ITEMS[c.items[c.items.length-1]];
      for(let k=0;k<c.items.length;k++){acc+=c.probs[k];if(roll<acc){it=ITEMS[c.items[k]];break}}
      s.balance-=c.price;const uid=s.n++;s.inv.unshift({uid,id:it.id});
      this.game({type:'case',stake:c.price,chance:null,roll,win:1,item_id:it.id,case_id:c.id,payout:it.price});this.save();localDrop('case',it.id);
      return{result:{item:it.id,uid,roll,nonce},...this.pub()}}
    if(path==='/api/sell'){const uids=(body.uids||[]).map(Number);let total=0;
      for(const u of uids){const x=s.inv.find(i=>i.uid===u)||this.err('Предмет недоступен');total+=this.price(x.id)}
      s.inv=s.inv.filter(x=>!uids.includes(x.uid));s.balance+=total;this.save();return{result:{total},...this.pub()}}
    if(path==='/api/topup'){s.balance+=Math.floor(+body.amount||0);this.save();return{demo:true,...this.pub()}}
    if(path==='/api/bonus'){const b=CFG.bonus||this.err('Бонус выключен');if(Date.now()<s.lastBonus+b.hours*36e5)this.err('Бонус уже получен, приходи позже');
      const r=Math.random(),amount=Math.round(b.min+(b.max-b.min)*r*r);s.balance+=amount;s.lastBonus=Date.now();this.save();return{result:{amount},...this.pub()}}
    if(path==='/api/profile'){const g=s.games,best=g.filter(x=>x.payout>0).sort((a,b)=>b.payout-a.payout)[0];
      return{total:g.length,ups:g.filter(x=>x.type==='upgrade').length,upWins:g.filter(x=>x.type==='upgrade'&&x.win).length,cases:g.filter(x=>x.type==='case').length,won:g.reduce((a,x)=>a+x.payout,0),best:best?{item:best.item_id,price:best.payout}:null}}
    if(path==='/api/top')return s.games.filter(x=>x.payout>0&&x.created_at>Date.now()-864e5).sort((a,b)=>b.payout-a.payout).slice(0,12).map(x=>({item:x.item_id,price:x.payout,kind:x.type,user:'Ты'}));
    if(path==='/api/fair/history')return{revealed:s.revealed,games:s.games.slice(0,50)};
    if(path==='/api/fair/client-seed'){const v=String(body.seed||'').trim();if(!/^[\w-]{1,64}$/.test(v))this.err('Сид: 1–64 символа, латиница/цифры/_/-');s.cs=v;this.save();return this.pub()}
    if(path==='/api/fair/rotate'){const rec={server_seed:s.ss,server_seed_hash:s.ssHash,client_seed:s.cs,last_nonce:s.nonce-1,revealed_at:Date.now()};
      s.revealed.unshift(rec);s.ss=rndHex(32);s.ssHash=await sha256hex(s.ss);s.nonce=0;this.save();return{revealed:{serverSeed:rec.server_seed},...this.pub()}}
    if(path==='/api/trade-url'||path==='/api/withdraw')this.err('Вывод скинов доступен только в онлайн-режиме');
    this.err('Недоступно в офлайн-режиме')}};
const CFG_OFF=()=>NATIVE?{...NATIVE}:({demo:true,offline:true,upgradeEdge:.1,upgradeMax:.75,bonus:{min:500,max:5000,hours:24}});
function resetOffline(){localStorage.removeItem(OFF.KEY);OFF.s=null}

/* ---------- art ---------- */
const RIFLE='M8 40 L58 35 L66 30 L128 29 L132 25 L148 25 L148 29 L194 30 L194 36 L148 37 L138 41 L120 41 L114 62 L101 64 L105 43 L90 43 L82 55 L70 55 L75 43 L58 45 L28 58 L10 58 Z';
const ghost=`<div class="ghostgun"><svg viewBox="0 0 200 80"><path d="${RIFLE}" fill="#888"/></svg></div>`;
let gid=0;
function shade(hx,a){const n=parseInt(hx.slice(1),16);let r=n>>16,g=n>>8&255,b=n&255;const t=a<0?0:255,p=Math.abs(a);r=Math.round((t-r)*p+r);g=Math.round((t-g)*p+g);b=Math.round((t-b)*p+b);return '#'+((1<<24)+(r<<16)+(g<<8)+b).toString(16).slice(1)}
const art=(it,cls='art')=>`<img class="${cls||'ai'}" src="${imgSrc(it)}" loading="lazy" decoding="async" alt="${esc(it.w+' | '+it.s)}" draggable="false">`;
function card(it,o={}){return `<div class="card ${o.cls||''}" data-id="${it.id}" data-r="${it.r}" ${o.u?`data-u="${o.u}"`:''} style="--rc:${R[it.r].c}"><i class="gl"></i>
  <div class="card-top"><span>${money(o.price??it.p)}</span><span class="ext">${o.chance!=null?'':ext(it)}</span></div>${o.chance!=null?`<span class="chance">${o.chance}</span>`:''}
  ${art(it)}<div class="card-name"><small>${esc(it.w)}</small><b>${esc(it.s)}</b></div>${o.extra||''}</div>`}
function caseArt(c){const id='cg'+(gid++);const hi=shade(c.col,.45),lo=shade(c.col,-.55),dk=shade(c.col,-.8),lt=shade(c.col,.7);
 return `<svg viewBox="0 0 160 150"><defs>
  <linearGradient id="${id}f" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${hi}"/><stop offset="1" stop-color="${lo}"/></linearGradient>
  <linearGradient id="${id}s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c.col}"/><stop offset="1" stop-color="${dk}"/></linearGradient>
  <linearGradient id="${id}t" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${lt}"/><stop offset="1" stop-color="${hi}"/></linearGradient>
  <radialGradient id="${id}g"><stop offset="0" stop-color="${c.col}" stop-opacity=".6"/><stop offset="1" stop-color="${c.col}" stop-opacity="0"/></radialGradient></defs>
  <circle cx="80" cy="82" r="74" fill="url(#${id}g)"/><ellipse cx="80" cy="140" rx="56" ry="8" fill="#000" opacity=".5"/>
  <path d="M20 52 L80 72 L80 134 L20 114 Z" fill="url(#${id}f)"/><path d="M140 52 L80 72 L80 134 L140 114 Z" fill="url(#${id}s)"/>
  <path d="M20 52 L80 32 L140 52 L80 72 Z" fill="url(#${id}t)"/><path d="M36 50 L80 35 L96 40 L52 55 Z" fill="#fff" opacity=".22"/>
  <path d="M20 63 L80 83 L140 63" fill="none" stroke="${dk}" stroke-width="2.5" opacity=".7"/>
  <path d="M20 52 L80 72 L140 52 M80 72 V134" fill="none" stroke="${lt}" stroke-width="1.4" opacity=".75"/>
  <path d="M20 52 L80 32 L140 52 L140 114 L80 134 L20 114 Z" fill="none" stroke="${dk}" stroke-width="2"/>
  <g transform="translate(50 98) skewY(18.43)"><path d="M0 -13 L11 -6.5 L11 6.5 L0 13 L-11 6.5 L-11 -6.5Z" fill="${dk}" opacity=".85"/><text x="0" y="5" text-anchor="middle" font-size="14" font-weight="900" font-family="Exo 2,sans-serif" fill="${lt}">G</text></g>
  <g transform="translate(110 98) skewY(-18.43)"><text x="0" y="4" text-anchor="middle" font-size="12" font-weight="900" font-family="Exo 2,sans-serif" fill="${lt}" opacity=".85" letter-spacing="1.5">GRUM</text></g>
  <g fill="${lt}" opacity=".8"><circle cx="25" cy="58" r="1.6"/><circle cx="25" cy="109" r="1.6"/><circle cx="135" cy="58" r="1.6"/><circle cx="135" cy="109" r="1.6"/></g>
  <path class="tw" d="M132 20 l2 6 6 2 -6 2 -2 6 -2 -6 -6 -2 6 -2z" fill="#fff"/>
  <path class="tw" style="animation-delay:-1s" d="M24 30 l1.5 4 4 1.5 -4 1.5 -1.5 4 -1.5 -4 -4 -1.5 4 -1.5z" fill="#fff"/></svg>`}

/* ---------- UI helpers ---------- */
function toast(t){const el=$('#toast');el.textContent=t;el.classList.add('on');clearTimeout(toast.t);toast.t=setTimeout(()=>el.classList.remove('on'),2600)}
function modal(html){$('#modal').innerHTML='<button class="x" data-close>×</button>'+html;$('#modalBg').classList.add('on')}
function closeModal(){$('#modalBg').classList.remove('on')}
$('#modalBg').addEventListener('click',e=>{if(e.target.id==='modalBg'||e.target.closest('[data-close]'))closeModal()});
let AC;function beep(f,d,type='sine',v=.04){if(!P.sound)return;try{AC=AC||new(window.AudioContext||window.webkitAudioContext)();const o=AC.createOscillator(),g=AC.createGain();o.type=type;o.frequency.value=f;g.gain.setValueAtTime(v,AC.currentTime);g.gain.exponentialRampToValueAtTime(.0001,AC.currentTime+d);o.connect(g).connect(AC.destination);o.start();o.stop(AC.currentTime+d)}catch(e){}}
function ticks(ms,n=28){for(let k=1;k<=n;k++)setTimeout(()=>beep(900+Math.random()*200,.04,'square',.015),ms*Math.pow(k/n,2.2))}
function winSound(){[523,659,784,1046].forEach((f,i)=>setTimeout(()=>beep(f,.25,'triangle',.05),i*90))}
function loseSound(){[300,220].forEach((f,i)=>setTimeout(()=>beep(f,.3,'sawtooth',.03),i*140))}
const loginBtns=()=>OFFLINE()?'':`<a class="btn" href="/auth/steam">Войти через Steam</a>${CFG.demo?'<button class="btn ghost" data-demo>Демо-вход</button>':''}<button class="btn ghost" data-go-offline>Играть офлайн</button>`;
function needLogin(){modal(`<h3>Вход в GRUMGrade</h3><p class="note">Войди через Steam или играй офлайн на виртуальном балансе.</p><div class="acts" style="flex-direction:column">${loginBtns()}</div>`)}
document.addEventListener('click',async e=>{
  if(e.target.closest('[data-demo]')){try{applyState(await net('/auth/demo',{}));closeModal();route();toast('Демо-аккаунт создан')}catch(err){toast(err.message)}}
  if(e.target.closest('[data-logout]')){await net('/auth/logout',{}).catch(()=>{});ME=null;INV=[];renderHeader();closeModal();route()}
  if(e.target.closest('[data-go-offline]')){closeModal();setMode('offline')}
});

/* ---------- онлайн / офлайн ---------- */
let ES=null;
async function setMode(mode){
  if(mode===P.mode&&ITEMS.length)return;
  P.mode=mode;savePrefs();if(ES){ES.close();ES=null}
  U.sel.clear();U.add=0;U.target=null;
  try{await loadAll()}catch(e){toast(e.message);if(mode==='offline'){P.mode='online';savePrefs();try{await loadAll()}catch(_){}}return}
  toast(mode==='offline'?'Офлайн-режим: виртуальный баланс в телефоне':'Онлайн-режим');route()}
async function loadAll(){
  const [cfg,cat]=await Promise.all([api('/api/config'),api('/api/catalog')]);
  CFG=cfg;setCatalog(cat);
  if(!OFFLINE()){lsSet('grum_config',cfg);lsSet('grum_catalog',cat)}
  applyState(await api('/api/me'));
  document.body.classList.toggle('offline',OFFLINE());
  if(OFFLINE()){$('#feed').innerHTML=`<div class="fempty">${NATIVE?'Здесь будут твои дропы':'Офлайн: здесь твои дропы'}</div>`;(OFF.s.games||[]).slice(0,14).reverse().forEach(g=>g.payout>0&&addFeed({kind:g.type,item:g.item_id,user:'Ты'}));setStats({online:0,upgrades:OFF.s.games.filter(g=>g.type==='upgrade').length,cases:OFF.s.games.filter(g=>g.type==='case').length})}
  else connectFeed();
  renderHeader()}

/* ---------- header ---------- */
const ICON={tg:'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M21.9 4.3 18.7 19c-.2 1-.9 1.3-1.8.8l-4.8-3.6-2.3 2.2c-.3.3-.5.5-1 .5l.3-4.9 8.9-8c.4-.3-.1-.5-.6-.2L6.4 12.7l-4.7-1.5c-1-.3-1-1 .2-1.5L20.6 2.6c.9-.3 1.6.2 1.3 1.7z"/></svg>',
 shield:'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2 4 5v6c0 5 3.4 9.7 8 11 4.6-1.3 8-6 8-11V5zm-1.4 14.2L7 12.6l1.4-1.4 2.2 2.2 5-5L17 9.8z"/></svg>',
 gift:'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 7h-2.2A3 3 0 0 0 12 3.8 3 3 0 0 0 6.2 7H4a1 1 0 0 0-1 1v3h8V7h2v4h8V8a1 1 0 0 0-1-1zM9 7a1 1 0 1 1 1-1v1zm5 0V6a1 1 0 1 1 1 1zM4 13v7a1 1 0 0 0 1 1h6v-8zm9 8h6a1 1 0 0 0 1-1v-7h-7z"/></svg>',
 plus:'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z"/></svg>',
 wifi:'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 18a2 2 0 1 1 0 4 2 2 0 0 1 0-4zm-4.2-2.8a6 6 0 0 1 8.4 0l-1.4 1.4a4 4 0 0 0-5.6 0zM4.9 12.4a10 10 0 0 1 14.2 0l-1.4 1.4a8 8 0 0 0-11.4 0zM2 9.5a14 14 0 0 1 20 0l-1.4 1.4a12 12 0 0 0-17.2 0z"/></svg>',
 snd:'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M4 9v6h4l5 5V4L8 9H4zm12.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4z"/></svg>',
 bolt:'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>',
 phone:'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm0 3v13h10V5zm5 14.2a1 1 0 1 0 0 2 1 1 0 0 0 0-2z"/></svg>',
 key:'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 14a2 2 0 1 1 0-4 2 2 0 0 1 0 4zm5.6-4A6 6 0 1 0 12.6 14H16v3h3v-3h2v-4z"/></svg>',
 out:'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M10 17v-3H3v-4h7V7l5 5-5 5zm9-14H12v2h7v14h-7v2h7a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2z"/></svg>',
 trash:'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 3h6l1 2h4v2H4V5h4zm-3 6h12l-1 12H7z"/></svg>'};
function renderHeader(){
  $('#sndBtn').classList.toggle('on',P.sound);$('#fastBtn').classList.toggle('on',P.fast);
  const tg=$('#tgBtn');if(CFG.telegram&&!tg)$('#fairBtn').insertAdjacentHTML('beforebegin',`<a class="iconbtn" id="tgBtn" href="${esc(CFG.telegram)}" target="_blank" rel="noopener" title="Наш Telegram">${ICON.tg.replace('<svg','<svg width="18" height="18"')}</a>`);
  const badge=OFFLINE()&&!NATIVE?'<span class="offbadge">ОФЛАЙН</span>':'';
  $('#hUser').innerHTML=ME?`${badge}<div class="balance"><span>${money(bal())}</span><button class="btn sm" id="topupBtn">+<span class="tl"> Пополнить</span></button></div>
    <div class="me" id="meBtn">${ME.avatar?`<img src="${esc(ME.avatar)}" alt="">`:`<span class="ava">${esc((ME.name||'?')[0])}</span>`}<b>${esc(ME.name)}</b></div>`
   :`<button class="btn" id="loginBtn">Войти</button>`;
  const lb=$('#loginBtn');if(lb)lb.onclick=needLogin;
  const tb=$('#topupBtn');if(tb)tb.onclick=topup;const mb=$('#meBtn');if(mb)mb.onclick=openProfile}
$('#sndBtn').onclick=()=>{P.sound=!P.sound;savePrefs();renderHeader()};
$('#fastBtn').onclick=()=>{P.fast=!P.fast;savePrefs();renderHeader();toast(P.fast?'Быстрый режим включён':'Быстрый режим выключен')};
$('#profBtn').onclick=openProfile;
function topup(){
  modal(`<h3>Пополнение баланса</h3><p class="note">${CFG.demo?'Монеты виртуальные.':'Выберите сумму — вы перейдёте на страницу оплаты.'}</p>
  <div class="amts">${[500,1000,5000,10000,50000,100000].map(a=>`<button data-amt="${a}">${money(a)}</button>`).join('')}</div>`);
  $('#modal').querySelectorAll('[data-amt]').forEach(b=>b.onclick=async()=>{
    try{const j=await api('/api/topup',{amount:+b.dataset.amt*100});if(j.url){location.href=j.url;return}
      applyState(j);renderAll();closeModal();toast('Баланс пополнен');beep(880,.2,'triangle')}catch(e){toast(e.message)}})}

/* ---------- профиль ---------- */
async function openProfile(){
  const sw=on=>`<span class="sw ${on?'on':''}"></span>`;
  let st=null;if(ME){try{st=await api('/api/profile')}catch(e){}}
  const best=st&&st.best&&ITEMS[st.best.item];
  const isIOS=/iPhone|iPad|iPod/.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
  modal(`${ME?`<div class="sheet-h">${ME.avatar?`<img src="${esc(ME.avatar)}" alt="">`:`<span class="ava">${esc((ME.name||'?')[0])}</span>`}<div><b>${esc(ME.name)}</b><small>${OFFLINE()?'Офлайн · виртуальный баланс':'Онлайн'} · ${money(bal())}</small></div></div>
    ${st?`<div class="stats"><div>${st.total}<small>игр</small></div><div>${st.ups?Math.round(st.upWins/st.ups*100):0}%<small>побед в апгрейде</small></div><div>${st.cases}<small>кейсов</small></div></div>`:''}
    ${best?`<div class="bonus" style="margin-bottom:12px"><img src="${imgSrc(best,128)}" style="width:64px;height:40px;object-fit:contain" alt=""><div><small>Лучший дроп</small><b>${esc(best.w)} | ${esc(best.s)}</b></div><b style="margin-left:auto">${money(st.best.price/100)}</b></div>`:''}`
   :`<h3>Профиль</h3><p class="note" style="margin-bottom:12px">Войди или играй офлайн</p><div class="acts" style="margin:0 0 14px">${loginBtns()}</div>`}
  <div class="menu">
    ${ME?`<button data-m="topup">${ICON.plus}Пополнить баланс</button>`:''}
    ${ME&&CFG.bonus?`<button data-m="bonus">${ICON.gift}Ежедневный бонус</button>`:''}
    <button data-m="fair">${ICON.shield}Честная игра</button>
    ${NATIVE?'':`<button data-m="mode">${ICON.wifi}Офлайн-режим ${sw(OFFLINE())}</button>`}
    <button data-m="snd">${ICON.snd}Звук ${sw(P.sound)}</button>
    <button data-m="fast">${ICON.bolt}Быстрый режим ${sw(P.fast)}</button>
    ${CFG.telegram?`<a href="${esc(CFG.telegram)}" target="_blank" rel="noopener">${ICON.tg}Наш Telegram</a>`:''}
    ${isIOS&&!standalone()&&!NATIVE?`<button data-m="install">${ICON.phone}Установить на iPhone</button>`:''}
    ${OFFLINE()?`<button data-m="reset">${ICON.trash}Сбросить офлайн-прогресс</button>`:''}
    ${ME&&!OFFLINE()?`<button data-logout>${ICON.out}Выйти</button>`:''}
    ${OFFLINE()?'':`<a href="/admin">${ICON.key}Админ-панель</a>`}
  </div>`);
  $('#modal').querySelectorAll('[data-m]').forEach(b=>b.onclick=async()=>{const m=b.dataset.m;
    if(m==='topup')topup();if(m==='fair')openFair();if(m==='bonus'){closeModal();location.hash='#cases'}
    if(m==='install')showInstall(true);
    if(m==='snd'){P.sound=!P.sound;savePrefs();renderHeader();openProfile()}
    if(m==='fast'){P.fast=!P.fast;savePrefs();renderHeader();openProfile()}
    if(m==='mode'){closeModal();await setMode(OFFLINE()?'online':'offline')}
    if(m==='reset'&&confirm('Удалить офлайн-баланс, инвентарь и историю на этом устройстве?')){resetOffline();closeModal();P.mode='online';await setMode('offline')}})}

/* ---------- живая лента ---------- */
function feedEl(d){const it=ITEMS[d.item];if(!it)return null;const el=document.createElement('div');el.className='fi';el.style.setProperty('--rc',R[it.r].c);
  el.innerHTML=`<span class="tag">${d.kind==='case'?'кейс':'апгрейд'} · ${esc(d.user)}</span>${art(it,'')}<div class="n"><b>${esc(it.s)}</b><small>${esc(it.w)}</small></div>`;return el}
function addFeed(d){const el=feedEl(d);if(!el)return;const f=$('#feed');f.querySelector('.fempty')?.remove();f.prepend(el);while(f.children.length>14)f.lastChild.remove()}
function setStats(s){if(!s)return;$('#online').textContent=OFFLINE()?'офлайн':s.online.toLocaleString('ru-RU');$('#upcnt').textContent=(s.upgrades+s.cases).toLocaleString('ru-RU')}
function localDrop(kind,item){addFeed({kind,item,user:'Ты'});const g=OFF.s.games;setStats({online:0,upgrades:g.filter(x=>x.type==='upgrade').length,cases:g.filter(x=>x.type==='case').length})}
function connectFeed(){if(ES)ES.close();ES=new EventSource('/api/stream');
  ES.onmessage=e=>{if(OFFLINE())return;const m=JSON.parse(e.data);
    if(m.type==='init'){$('#feed').innerHTML=m.feed.length?'':'<div class="fempty">Пока пусто — будь первым!</div>';m.feed.forEach(addFeed);setStats(m.stats)}
    if(m.type==='drop'){addFeed(m.drop);setStats(m.stats)}
    if(m.type==='stats')setStats(m.stats);
    if(m.type==='catalog')reloadCatalog()}}
function setCatalog(cat){ITEMS=cat.items.map(it=>({...it,p:it.price/100}));CASES=cat.cases.map(c=>({...c,p:c.price/100}));CAT_AT=cat.pricesUpdatedAt||0;
  $('#priceInfo').textContent=CAT_AT?`Цены рынка (Skinport) от ${new Date(CAT_AT).toLocaleString('ru-RU',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})}`:''}
async function reloadCatalog(){try{const [cat,me]=await Promise.all([net('/api/catalog'),net('/api/me')]);lsSet('grum_catalog',cat);setCatalog(cat);applyState(me);
  if(U.target)U.target=ITEMS[U.target.id];if(!U.spinning&&!opening)route()}catch(e){}}

/* ---------- АПГРЕЙД ---------- */
const U={sel:new Set(),add:0,target:null,page:0,sort:-1,rot:0,spinning:false};
const PER=20;
const invItems=()=>INV.filter(x=>x.status==='owned').map(x=>({...ITEMS[x.id],u:x.uid,p:x.price/100})).filter(x=>x.id!=null);
function stake(){return invItems().filter(x=>U.sel.has(x.u)).reduce((a,b)=>a+b.p,0)+U.add}
const chanceFor=(s,t)=>Math.min(CFG.upgradeMax,s/t*(1-CFG.upgradeEdge));
function chance(){const t=U.target,s=stake();return !t||s<=0?0:chanceFor(s,t.p)}
function renderSlots(){
 const sel=invItems().filter(x=>U.sel.has(x.u));const L=$('#slotL');
 const chev=`<div class="chev"><svg width="34" height="34" viewBox="0 0 24 24" fill="currentColor"><path d="M12 4 4 12h5v8h6v-8h5z"/></svg></div>`;
 if(!sel.length&&!U.add)L.innerHTML=ghost+`<div class="ph">Выберите предметы и/или баланс для использования<small>Можно выбрать несколько предметов</small></div>`+chev;
 else{let h='<div class="sel-grid">'+sel.slice(0,5).map(it=>`<div class="mini" style="--rc:${R[it.r].c}">${art(it,'')}${fmt(it.p)}</div>`).join('');
  if(sel.length>5)h+=`<div class="mini" style="--rc:#555;display:grid;place-items:center">+${sel.length-5}</div>`;
  if(U.add)h+=`<div class="mini" style="--rc:var(--accent);display:grid;place-items:center">${money(U.add)}</div>`;
  L.innerHTML=h+`</div><div class="tot"><small>Ставка</small>${money(stake())}</div>`}
 const t=U.target;
 $('#slotR').innerHTML=!t?ghost+`<div class="ph">Выберите предмет для апгрейда<small>Или нажмите на множитель ниже</small></div>`+chev
  :`<div class="big-target" style="--rc:${R[t.r].c}">${art(t,'')}<small>${esc(t.w)} · ${ext(t)}</small><b>${esc(t.s)}</b><div class="pp">${money(t.p)}</div></div>`}
const TK=72;$('#ticks').innerHTML=Array.from({length:TK},(_,i)=>{const a=i/TK*Math.PI*2,r1=133,r2=i%6?138:142;
 return `<line x1="${150+Math.sin(a)*r1}" y1="${150-Math.cos(a)*r1}" x2="${150+Math.sin(a)*r2}" y2="${150-Math.cos(a)*r2}" stroke-width="${i%6?1.2:2}" stroke-linecap="round"/>`}).join('');
/* Два режима колеса (углы от верха по часовой):
   «Классика» — стрелка сверху, зона выигрыша идёт от верха по часовой;
   «Снизу»    — стрелка снизу, зона выигрыша растёт от низа в обе стороны.
   Стрелка встаёт на угол start + ролл·360°, поэтому попадает в зону ровно когда ролл < шанс — как решил сервер. */
const arcStart=c=>P.upMode==='top'?0:180-c*180;
const restRot=()=>P.upMode==='top'?180:0; // стрелка нарисована внизу; 180° = наверх
function renderWheel(){const c=chance(),s0=arcStart(c);
 $('#ticks').querySelectorAll('line').forEach((l,i)=>{const d=((i/TK*360-s0)%360+360)%360;l.setAttribute('stroke',c>0&&d<c*360?'#ffc400':'rgba(255,255,255,'+(i%6?.13:.3)+')')});
 const arc=$('#arc');arc.setAttribute('stroke-dasharray',`${(741.4*c).toFixed(1)} 742`);arc.style.transform=`rotate(${s0-90}deg)`;
 if(!U.spinning)$('#chTxt').textContent=pct(c);
 document.querySelectorAll('#modes button').forEach(b=>b.classList.toggle('on',b.dataset.mode===P.upMode));
 $('#upBtn').disabled=U.spinning||(ME&&(!U.target||stake()<=0))}
function parkNeedle(animate){const r0=restRot();U.rot=Math.round((U.rot-r0)/360)*360+r0;const nd=$('#needle');
 nd.style.transition=animate?'transform .7s cubic-bezier(.3,.8,.3,1)':'none';nd.style.transform=`rotate(${U.rot}deg)`}
$('#modes').onclick=e=>{const b=e.target.closest('[data-mode]');if(!b||U.spinning)return;P.upMode=b.dataset.mode;savePrefs();clearRes();parkNeedle(true);renderWheel()};
function renderInv(){const g=$('#invGrid');
 if(!ME){$('#invSum').innerHTML='';g.innerHTML=`<div class="empty" style="grid-column:1/-1"><b style="color:var(--text);font-size:16px">Вы не авторизованы</b><br>Войдите для доступа к апгрейдам<div class="acts" style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap;margin-top:14px">${loginBtns()}</div></div>`;$('.balrow').style.display='none';return}
 $('.balrow').style.display='';const it=invItems();
 $('#invSum').innerHTML=it.length?`${it.length} шт · ${money(it.reduce((a,b)=>a+b.p,0))}`:'';
 g.innerHTML=it.length?it.map(x=>card(x,{u:x.u,cls:U.sel.has(x.u)?'sel':''})).join(''):'<div class="empty" style="grid-column:1/-1">Инвентарь пуст — открой кейс или используй баланс</div>'}
function tgtList(){const q=$('#q').value.trim().toLowerCase(),mn=+$('#pmin').value||0,mx=+$('#pmax').value||Infinity;
 return ITEMS.filter(it=>(it.w+' '+it.s).toLowerCase().includes(q)&&it.p>=mn&&it.p<=mx).sort((a,b)=>(a.p-b.p)*-U.sort)}
function renderTargets(){const list=tgtList();const pages=Math.max(1,Math.ceil(list.length/PER));U.page=Math.min(U.page,pages-1);const s=stake();
 $('#tgtGrid').innerHTML=list.length?list.slice(U.page*PER,U.page*PER+PER).map(it=>card(it,{cls:(U.target&&U.target.id===it.id?'sel':'')+(s>0&&it.p<=s?' dis':''),chance:s>0&&it.p>s?pct(chanceFor(s,it.p)):null})).join(''):'<div class="empty" style="grid-column:1/-1">Ничего не найдено</div>';
 $('#pInfo').textContent=`${U.page+1} / ${pages}`;$('#pPrev').disabled=U.page<=0;$('#pNext').disabled=U.page>=pages-1;$('#sortBtn').textContent=(U.sort<0?'↓':'↑')+' Цена'}
function renderUpgrade(){const owned=new Set(invItems().map(x=>x.u));for(const u of U.sel)if(!owned.has(u))U.sel.delete(u);
 U.add=Math.min(U.add,bal());if(U.target&&stake()>=U.target.p)U.target=null;renderSlots();renderWheel();renderInv();renderTargets()}
$('#mults').innerHTML=[1.5,2,3,5,10,20].map(m=>`<button data-m="${m}">x${String(m).replace('.',',')}</button>`).join('');
$('#mults').onclick=e=>{const m=+e.target.dataset.m;if(!m||U.spinning)return;const s=stake();if(s<=0)return toast('Сначала выберите предметы или баланс');
 const t=ITEMS.filter(it=>it.p>=s*m).sort((a,b)=>a.p-b.p)[0];if(!t)return toast('Нет предмета такой цены');U.target=t;clearRes();renderUpgrade()};
$('#invGrid').onclick=e=>{const c=e.target.closest('.card');if(!c||U.spinning)return;const u=+c.dataset.u;U.sel.has(u)?U.sel.delete(u):U.sel.add(u);clearRes();renderUpgrade()};
$('#tgtGrid').onclick=e=>{const c=e.target.closest('.card');if(!c||U.spinning)return;const it=ITEMS[+c.dataset.id];U.target=U.target&&U.target.id===it.id?null:it;clearRes();renderUpgrade()};
$('#addBal').oninput=e=>{let v=Math.max(0,+e.target.value||0);if(v>bal()){v=Math.floor(bal()*100)/100;e.target.value=v}U.add=v;clearRes();renderSlots();renderWheel();renderTargets()};
$('#addMax').onclick=()=>{U.add=Math.floor(bal()*100)/100;$('#addBal').value=U.add||'';clearRes();renderUpgrade()};
$('#addHalf').onclick=()=>{U.add=Math.floor(bal()*50)/100;$('#addBal').value=U.add||'';clearRes();renderUpgrade()};
['q','pmin','pmax'].forEach(id=>$('#'+id).oninput=()=>{U.page=0;renderTargets()});
$('#sortBtn').onclick=()=>{U.sort*=-1;renderTargets()};
$('#pPrev').onclick=()=>{U.page--;renderTargets()};$('#pNext').onclick=()=>{U.page++;renderTargets()};
function clearRes(){$('#wheel').classList.remove('win','lose');$('#resTxt').textContent='';if(!U.spinning)parkNeedle(true)}
$('#upBtn').onclick=async()=>{
 if(!ME)return needLogin();
 if(U.spinning)return;const t=U.target;if(!t||stake()<=0)return;
 U.spinning=true;$('#wheel').classList.remove('win','lose');$('#resTxt').textContent='';renderWheel();
 let j;try{j=await api('/api/upgrade',{uids:[...U.sel],amount:Math.round(U.add*100),target:t.id})}
 catch(e){U.spinning=false;renderWheel();return toast(e.message)}
 const {roll,win,chance:ch}=j.result,dur=P.fast?1.6:5.2;
 $('#chTxt').textContent=pct(ch);
 const target=((arcStart(ch)+roll*360-180)%360+360)%360;
 U.rot=U.rot-(((U.rot%360)+360)%360)+360*(P.fast?3:6)+target;
 const nd=$('#needle');nd.style.transition=`transform ${dur}s cubic-bezier(.12,.75,.2,1)`;nd.style.transform=`rotate(${U.rot}deg)`;
 ticks(dur*1000,P.fast?12:30);
 setTimeout(()=>{
  $('#wheel').classList.add(win?'win':'lose');$('#resTxt').textContent=win?'Выигрыш!':'Неудача';
  if(win){winSound();confetti(200);
   modal(`<h3 style="color:var(--win)">Апгрейд успешен!</h3><div class="win-art" style="--rc:${R[t.r].c}">${art(t,'')}</div><p class="note">${esc(t.w)}</p><h3>${esc(t.s)}</h3><div style="font-weight:800;font-size:18px">${money(t.p)}</div>
    <p class="note" style="margin-top:8px">Ролл ${roll.toFixed(6)} &lt; шанс ${ch.toFixed(6)} · nonce ${j.result.nonce}</p>
    <div class="acts"><button class="btn" data-close>Забрать</button><a class="btn ghost" href="#inventory" data-close>В инвентарь</a></div>`)}
  else loseSound();
  U.sel.clear();U.add=0;$('#addBal').value='';U.spinning=false;applyState(j);renderUpgrade();
 },dur*1000+150)};

/* ---------- КЕЙСЫ ---------- */
const topN=(c,n)=>c.items.map(i=>ITEMS[i]).filter(Boolean).sort((a,b)=>b.p-a.p).slice(0,n);
const caseCard=c=>`<a class="case" href="#case/${c.id}" style="--cc:${c.col}">${c.hot?'<span class="badge">Хит</span>':''}<div class="peek">${topN(c,3).map(it=>`<img src="${imgSrc(it)}" loading="lazy" alt="">`).join('')}</div>${caseArt(c)}<h3>${esc(c.name)}</h3><span class="cnt">${c.items.length} предметов · до ${fmt(topN(c,1)[0].p)}</span><div class="cp">${money(c.p)}</div></a>`;
function renderCases(){if(!CASES.length)return;const g=CASES.find(c=>c.main)||CASES[0],top=topN(g,1)[0];
 $('#hero').innerHTML=`<div><span class="kicker">Хит недели</span><h1>Кейс <b>${esc(g.name)}</b></h1><p>Все ${g.items.length} предметов в одном кейсе — вплоть до ${esc(top.w)} ${esc(top.s)} за ${fmt(top.p)}</p><a class="btn" href="#case/${g.id}">Открыть за ${money(g.p)}</a></div><div class="hero-art">${caseArt(g)}${topN(g,3).map(it=>`<img src="${imgSrc(it)}" alt="">`).join('')}</div>`;
 const cats=[...CATS,...new Set(CASES.map(c=>c.cat).filter(c=>c&&!CATS.includes(c)))];
 $('#casesGrid').innerHTML=cats.map(cat=>{const list=CASES.filter(c=>(c.cat||'Популярные')===cat);return list.length?`<div class="cat-title">${esc(cat)}</div><div class="cases">${list.map(caseCard).join('')}</div>`:''}).join('');
 renderBonus();renderTop()}
function renderBonus(){const el=$('#bonus');if(!ME||!CFG.bonus){el.style.display='none';return}el.style.display='';
 const wait=(ME.nextBonusAt||0)-Date.now();
 el.innerHTML=`<span class="gift">🎁</span><div><b>Ежедневный бонус</b><small>${wait>0?`Следующий через ${left(wait)}`:`От ${fmt(CFG.bonus.min/100)} до ${fmt(CFG.bonus.max/100)} монет каждые ${CFG.bonus.hours} ч`}</small></div><button class="btn" id="bonusBtn" ${wait>0?'disabled':''}>${wait>0?'Ждём':'Забрать'}</button>`;
 $('#bonusBtn').onclick=async()=>{try{const j=await api('/api/bonus',{});applyState(j);renderBonus();confetti(90);winSound();toast(`+${fmt(j.result.amount/100)} монет!`)}catch(e){toast(e.message)}}}
async function renderTop(){let list=[];try{list=await api('/api/top')}catch(e){}
 $('#topWrap').style.display=list.length?'':'none';
 $('#topdrops').innerHTML=list.map(d=>{const it=ITEMS[d.item];return it?card(it,{price:d.price/100,extra:`<span class="who">${d.kind==='case'?'кейс':'апгрейд'} · ${esc(d.user)}</span>`}):''}).join('')}
let curCase=null,opening=false;
function renderCase(id){const c=CASES[id];if(!c){location.hash='#cases';return}curCase=c;
 const its=c.items.map(i=>ITEMS[i]);
 $('#caseHead').style.setProperty('--cc',c.col);
 $('#caseHead').innerHTML=`${caseArt(c)}<div class="info"><h3>Кейс «${esc(c.name)}»</h3><p>${its.length} предметов · от ${money(Math.min(...its.map(i=>i.p)))} до ${money(Math.max(...its.map(i=>i.p)))}</p>
  <div class="acts"><button class="btn" id="openBtn">Открыть за ${money(c.p)}</button><a class="btn ghost" href="#cases">← Все кейсы</a></div></div>`;
 $('#openBtn').disabled=opening||(ME&&bal()<c.p);$('#openBtn').onclick=()=>openCase(c);
 $('#caseItems').innerHTML=its.map((it,k)=>({it,p:c.probs[k]})).sort((a,b)=>b.it.p-a.it.p).map(o=>card(o.it,{chance:(o.p*100<0.01?'<0,01':(o.p*100).toLocaleString('ru-RU',{maximumFractionDigits:2}))+'%'})).join('');
 if(!opening){$('#strip').innerHTML='';$('#strip').style.transition='none';$('#strip').style.transform='none';$('#rhint').style.display=''}}
function pickLocal(c){let r=Math.random();for(let i=0;i<c.items.length;i++){r-=c.probs[i];if(r<=0)return ITEMS[c.items[i]]}return ITEMS[c.items[c.items.length-1]]}
async function openCase(c){
 if(!ME)return needLogin();if(opening)return;if(bal()<c.p){toast('Недостаточно баланса');return topup()}
 opening=true;$('#openBtn').disabled=true;
 let j;try{j=await api(`/api/cases/${c.id}/open`,{})}catch(e){opening=false;$('#openBtn').disabled=false;return toast(e.message)}
 ME.balance=j.user.balance;renderHeader();
 const win=ITEMS[j.result.item],uid=j.result.uid;$('#rhint').style.display='none';
 const N=60,WI=50,strip=[];for(let i=0;i<N;i++)strip.push(i===WI?win:pickLocal(c)); // соседние карточки — только для красоты
 const st=$('#strip');st.style.transition='none';st.style.transform='translateX(0)';
 st.innerHTML=strip.map(it=>card(it)).join('');st.querySelectorAll('img').forEach(i=>i.loading='eager');
 const box=st.parentElement.clientWidth,W=136,off=(Math.random()-.5)*110,x=WI*W+65-box/2+off,dur=P.fast?2:6.5;
 void st.offsetWidth;st.style.transition=`transform ${dur}s cubic-bezier(.08,.6,.12,1)`;st.style.transform=`translateX(${-x}px)`;
 ticks(dur*1000,P.fast?14:40);
 setTimeout(()=>{st.children[WI].classList.add('won');winSound();confetti(win.p>=c.p?200:50);opening=false;applyState(j);
  modal(`<h3>Тебе выпало!</h3><div class="win-art" style="--rc:${R[win.r].c}">${art(win,'')}</div><p class="note">${esc(win.w)} · ${R[win.r].n}</p><h3>${esc(win.s)}</h3><div style="font-weight:800;font-size:18px">${money(win.p)}</div>
   <p class="note" style="margin-top:8px">Ролл ${j.result.roll.toFixed(6)} · nonce ${j.result.nonce}</p>
   <div class="acts"><button class="btn green" id="mSell">Продать за ${money(win.p)}</button><button class="btn ghost" data-close>Забрать</button><button class="btn ghost" id="mAgain">Ещё раз</button><a class="btn ghost" href="#upgrade" data-close>Апгрейдить</a></div>`);
  $('#mSell').onclick=async()=>{await sell([uid]);closeModal()};
  $('#mAgain').onclick=()=>{closeModal();openCase(c)};
  if(curCase)$('#openBtn').disabled=bal()<curCase.p},dur*1000+200)}

/* ---------- ИНВЕНТАРЬ ---------- */
async function sell(uids){try{const j=await api('/api/sell',{uids});applyState(j);renderAll();toast('Продано за '+fmt(j.result.total/100));beep(1200,.12,'triangle')}catch(e){toast(e.message)}}
function renderInvPage(){
 if(!ME){$('#invTotal').innerHTML='';$('#tradeRow').style.display='none';$('#sellAll').style.display='none';$('#invPage').innerHTML=`<div class="empty" style="grid-column:1/-1">Войдите, чтобы увидеть инвентарь<div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap;margin-top:14px">${loginBtns()}</div></div>`;return}
 $('#tradeRow').style.display=OFFLINE()?'none':'';$('#sellAll').style.display='';
 const tu=$('#tradeUrl');if(document.activeElement!==tu)tu.value=ME.tradeUrl||'';
 const all=INV.map(x=>({...ITEMS[x.id],u:x.uid,p:x.price/100,st:x.status})).filter(x=>x.id!=null);const owned=all.filter(x=>x.st==='owned');
 $('#invTotal').innerHTML=`Предметов: <b>${owned.length}</b> · Стоимость: <b>${money(owned.reduce((a,b)=>a+b.p,0))}</b>`;
 $('#sellAll').disabled=!owned.length;
 $('#invPage').innerHTML=all.length?all.map(x=>card(x,{u:x.u,extra:x.st==='owned'?`<div class="inv-acts"><button class="sell" data-sell="${x.u}">Продать</button>${OFFLINE()?'':`<button class="sell" data-wd="${x.u}">Вывести</button>`}</div>`:'<div class="sell" style="text-align:center;color:var(--accent)">Вывод в обработке</div>'})).join(''):'<div class="empty" style="grid-column:1/-1">Пусто. <a href="#cases" style="color:var(--accent)">Открой кейс</a></div>'}
$('#invPage').onclick=async e=>{const s=e.target.closest('[data-sell]');if(s)return sell([+s.dataset.sell]);
 const w=e.target.closest('[data-wd]');if(w){if(!ME.tradeUrl)return toast('Сначала сохраните трейд-ссылку');
  try{applyState(await api('/api/withdraw',{uid:+w.dataset.wd}));renderAll();toast('Заявка на вывод создана')}catch(err){toast(err.message)}}};
$('#sellAll').onclick=()=>{const u=invItems().map(x=>x.u);if(u.length)sell(u)};
$('#saveTrade').onclick=async()=>{try{applyState(await api('/api/trade-url',{url:$('#tradeUrl').value}));toast('Трейд-ссылка сохранена')}catch(e){toast(e.message)}};

/* ---------- PROVABLY FAIR ---------- */
async function openFair(){
 let hist={revealed:[],games:[]};if(ME){try{hist=await api('/api/fair/history')}catch(e){}}
 const f=ME?.fair;
 modal(`<h3>Честная игра (provably fair)</h3>
  <p class="note" style="text-align:left">Результат = HMAC-SHA256(серверный сид, «клиентский сид:nonce»), первые 52 бита ÷ 2<sup>52</sup>. Хэш серверного сида виден заранее, сам сид раскрывается после смены — можно пересчитать любую игру.</p>
  ${ME?`<div class="fair"><label>Хэш серверного сида<code>${f.serverSeedHash}</code></label>
   <label>Клиентский сид<div class="row"><input id="fCs" value="${esc(f.clientSeed)}" maxlength="64"><button class="btn sm" id="fCsSave">Сохранить</button></div></label>
   <label>Следующий nonce<code>${f.nonce}</code></label>
   <button class="btn ghost sm" id="fRotate">Сменить серверный сид и раскрыть текущий</button>
   ${hist.revealed.length?`<label>Раскрытые сиды</label><div class="flist">${hist.revealed.map(r=>`<div><code>${r.server_seed}</code><small>client ${esc(r.client_seed)} · nonce 0–${r.last_nonce}</small></div>`).join('')}</div>`:''}
   ${hist.games.length?`<label>Последние игры</label><div class="flist">${hist.games.slice(0,10).map(g=>`<div><small>${g.type==='case'?'Кейс':'Апгрейд'} · nonce ${g.nonce} · ролл ${g.roll.toFixed(6)}${g.chance!=null?' · шанс '+g.chance.toFixed(4):''} · ${g.win?'✔':'✘'}</small></div>`).join('')}</div>`:''}</div>`:''}
  <div class="fair"><label>Проверить ролл</label><input id="vS" placeholder="серверный сид"><div class="row"><input id="vC" placeholder="клиентский сид"><input id="vN" placeholder="nonce" style="max-width:90px"></div>
   <button class="btn sm" id="vGo">Посчитать</button><code id="vOut">—</code></div>`);
 $('#vGo').onclick=async()=>{const s=$('#vS').value.trim();if(!s)return;const r=await hmacRoll(s,$('#vC').value.trim(),+$('#vN').value||0);$('#vOut').textContent=`ролл = ${r.toFixed(10)} · sha256(сид) = ${(await sha256hex(s)).slice(0,24)}…`};
 if(ME){$('#fCsSave').onclick=async()=>{try{applyState(await api('/api/fair/client-seed',{seed:$('#fCs').value}));toast('Клиентский сид сохранён')}catch(e){toast(e.message)}};
  $('#fRotate').onclick=async()=>{try{const j=await api('/api/fair/rotate',{});applyState(j);openFair();toast('Серверный сид раскрыт и заменён')}catch(e){toast(e.message)}}}}
$('#fairBtn').onclick=openFair;

/* ---------- установка на iPhone ---------- */
const standalone=()=>navigator.standalone===true||matchMedia('(display-mode: standalone)').matches;
function showInstall(force){const isIOS=/iPhone|iPad|iPod/.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
 if(standalone()||NATIVE)return;if(force){closeModal();$('#install').classList.add('on');return}
 if(isIOS&&!P.installHidden)setTimeout(()=>$('#install').classList.add('on'),2500)}
$('#installX').onclick=()=>{$('#install').classList.remove('on');P.installHidden=true;savePrefs()};
if('serviceWorker' in navigator&&!NATIVE)addEventListener('load',()=>navigator.serviceWorker.register('/sw.js').catch(()=>{}));

/* ---------- конфетти ---------- */
const cv=document.createElement('canvas');cv.id='confetti';document.body.appendChild(cv);const cx2=cv.getContext('2d');let parts=[],raf=0;
function confetti(n=160){cv.width=innerWidth;cv.height=innerHeight;const cols=['#ffd21f','#ff8a1a','#3ddc84','#ffffff','#ff5ab0','#5ad0f0'];
 for(let i=0;i<n;i++)parts.push({x:innerWidth/2+(Math.random()-.5)*240,y:innerHeight*.45,vx:(Math.random()-.5)*18,vy:-Math.random()*15-5,s:5+Math.random()*7,r:Math.random()*6,vr:(Math.random()-.5)*.4,c:cols[i%6],l:1});
 if(!raf)raf=requestAnimationFrame(ctick)}
function ctick(){cx2.clearRect(0,0,cv.width,cv.height);parts=parts.filter(p=>p.l>0&&p.y<cv.height+40);
 for(const p of parts){p.vy+=.38;p.vx*=.985;p.x+=p.vx;p.y+=p.vy;p.r+=p.vr;p.l-=.007;cx2.save();cx2.globalAlpha=Math.min(1,p.l*1.6);cx2.translate(p.x,p.y);cx2.rotate(p.r);cx2.fillStyle=p.c;cx2.fillRect(-p.s/2,-p.s/4,p.s,p.s/2);cx2.restore()}
 raf=parts.length?requestAnimationFrame(ctick):0}

/* ---------- роутер ---------- */
function renderAll(){const pg=(location.hash.slice(1)||'upgrade').split('/')[0];if(pg==='upgrade')renderUpgrade();if(pg==='inventory')renderInvPage();if(pg==='cases')renderBonus();if(pg==='case'&&curCase)$('#openBtn').disabled=opening||(ME&&bal()<curCase.p)}
function route(){const [pg,arg]=(location.hash.slice(1)||'upgrade').split('/');
 const page=pg==='case'?'case':['upgrade','cases','inventory'].includes(pg)?pg:'upgrade';
 document.querySelectorAll('.page').forEach(p=>p.classList.toggle('on',p.id==='p-'+page));
 document.querySelectorAll('[data-nav]').forEach(a=>a.classList.toggle('on',a.dataset.nav===(page==='case'?'cases':page)));
 if(page==='upgrade')renderUpgrade();if(page==='cases')renderCases();if(page==='case')renderCase(+arg);if(page==='inventory')renderInvPage();
 window.scrollTo(0,0)}
addEventListener('hashchange',route);

(async function boot(){
 parkNeedle(false);
 try{await loadAll()}
 catch(e){
  if(!OFFLINE()&&lsGet('grum_catalog')){modal(`<h3>Нет связи с сервером</h3><p class="note">Можно играть офлайн на виртуальном балансе — прогресс хранится в телефоне.</p><div class="acts"><button class="btn" data-go-offline>Играть офлайн</button><button class="btn ghost" onclick="location.reload()">Повторить</button></div>`);return}
  toast('Сервер недоступен: '+e.message);return}
 const lp=new URLSearchParams(location.search).get('login');if(lp){toast(lp==='banned'?'Аккаунт заблокирован':'Не удалось войти через Steam');history.replaceState(null,'',location.pathname+location.hash)}
 route();showInstall(false);
})();
