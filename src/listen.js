// ニュースを聞く: 声の準備・まとめて流すプレーヤー・聞きながらの質問。
//  - 声は Gemini の読み上げで1本ずつ作る(関数 asayomi-voice)。届いた生の音をこの端末で mp3 にしてクラウドへ置くので、
//    1本につき作るのは1回だけ。ほかの端末やあとで聞くときは、置いてある mp3 を取ってくるだけ。
//  - 画面を消しても止まらないよう、その日の分を1つの音声につなげて <audio> で流す(記事の切れ目でアプリの処理がいらない)。
//    ロック画面・イヤホンのボタンで 止める/次の記事/前の記事/10秒戻る ができる。
//  - 質問は声(音声入力)か文字で。答えは画面に出して読み上げ、読み終えたら続きから流す。
import { h, clear, stripMarkup } from './util.js';
import { SB_URL, CATS } from './config.js';
import * as store from './store.js';
import { icon } from './art.js';
import { openSheet, closeSheet, toast } from './ui.js';
import { go } from './nav.js';

const FN = SB_URL + '/functions/v1/asayomi-voice';
const SPEEDS = [0.8, 1, 1.25, 1.5, 1.75, 2];
const AUDIO_CACHE = 'asayomi-audio';
const LAME = 'https://cdn.jsdelivr.net/npm/lamejs@1.2.1/lame.min.js';

async function call(action, body, ms) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms || 30000);
  try {
    const res = await fetch(FN, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ action }, body)), signal: ctl.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok && !data.code) data.code = 'net';
    return data;
  } catch (e) {
    return { error: '通信できませんでした', code: 'net' };
  } finally {
    clearTimeout(timer);
  }
}

/* ---------- 状態 ---------- */
const P = {
  date: null,
  items: [],              // その日のニュース(番号順)
  parts: new Map(),       // n → { buf, dur }
  segs: [],               // つないだ音声の中の位置 [{ n, start, dur }]
  total: 0, scale: 1, sig: '', url: null,
  ready: null,            // サーバーにキーがあるか
  prep: null, progress: '', error: '', stopped: false,
  make: false,            // 足りない声を作ってよいか(最新の日か、聞くボタンを押した日だけ)
  audio: null, bar: null, shown: false,
  curN: 0, pending: null, waitAfter: 0, heard: new Set(),
};
const speed = () => { const r = Number(store.pref().listenRate); return SPEEDS.indexOf(r) >= 0 ? r : 1; };
const listeners = new Set();
function changed() { paint(); for (const fn of listeners) fn(); }
export function onListen(fn) { listeners.add(fn); return () => listeners.delete(fn); }

function audio() {
  if (P.audio) return P.audio;
  const a = new Audio();
  a.preload = 'auto';
  a.preservesPitch = true;
  a.addEventListener('loadedmetadata', () => {
    if (!a.src.startsWith('blob:') || a.src !== P.url) return;
    P.scale = P.total && isFinite(a.duration) && a.duration > 0 ? a.duration / P.total : 1;
    a.defaultPlaybackRate = a.playbackRate = speed();
    const pd = P.pending;
    P.pending = null;
    if (pd) { seekTo(pd.n, pd.at); if (pd.play) a.play().catch(() => {}); }
  });
  a.addEventListener('timeupdate', tick);
  a.addEventListener('play', () => { paint(); setPosition(); });
  a.addEventListener('pause', () => { paint(); setPosition(); });
  a.addEventListener('ratechange', setPosition);
  a.addEventListener('ended', () => {
    if (!a.src.startsWith('blob:')) return;
    const last = P.segs[P.segs.length - 1];
    // まだ作っている途中の記事があれば、できた所で続きを流す
    if (last && P.prep && last.n !== P.items[P.items.length - 1].n) P.waitAfter = last.n;
    paint();
  });
  P.audio = a;
  if ('mediaSession' in navigator) {
    const ms = navigator.mediaSession;
    const set = (k, fn) => { try { ms.setActionHandler(k, fn); } catch (e) { /* 対応していない操作 */ } };
    set('play', () => a.play());
    set('pause', () => a.pause());
    set('previoustrack', () => skip(-1));
    set('nexttrack', () => skip(1));
    set('seekbackward', () => nudge(-10));
    set('seekforward', () => nudge(10));
    set('seekto', (e) => { if (e.seekTime != null) a.currentTime = e.seekTime; });
  }
  return a;
}

/* ---------- 位置 ---------- */
function where() {
  const a = P.audio;
  if (!a || !P.segs.length) return null;
  const t = a.currentTime / (P.scale || 1);
  let seg = P.segs[0];
  for (const s of P.segs) if (s.start <= t + 0.05) seg = s;
  return { n: seg.n, at: Math.max(0, t - seg.start), dur: seg.dur };
}
function seekTo(n, at) {
  const seg = P.segs.find((s) => s.n === n);
  if (seg) P.audio.currentTime = (seg.start + (at || 0)) * (P.scale || 1);
}
function skip(dir) {
  const pos = where();
  if (!pos) return;
  if (dir < 0 && pos.at > 4) { seekTo(pos.n, 0); return; }
  const i = P.segs.findIndex((s) => s.n === pos.n) + dir;
  if (i >= 0 && i < P.segs.length) seekTo(P.segs[i].n, 0);
}
function nudge(sec) {
  const a = P.audio;
  if (a) a.currentTime = Math.max(0, Math.min((a.duration || 0) - 0.3, a.currentTime + sec));
}
function tick() {
  const pos = where();
  if (!pos) return;
  if (pos.n !== P.curN) { P.curN = pos.n; setMeta(); changed(); }
  // 7割まで聞いたら「読んだ」にする
  const key = P.date + ':' + pos.n;
  if (!P.heard.has(key) && pos.at > pos.dur * 0.7) {
    P.heard.add(key);
    const it = store.item('news', P.date, pos.n);
    if (it && !store.isRead(it)) store.markRead(it);
  }
  paintTime(pos);
}
function setMeta() {
  if (!('mediaSession' in navigator)) return;
  const it = store.item('news', P.date, P.curN);
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: it ? it.data.title : 'あさよみ',
      artist: 'あさよみ ニュース ' + P.curN + '/' + P.items.length,
      album: P.date || '',
      artwork: [{ src: new URL('icons/icon-192.png', location.href).href, sizes: '192x192', type: 'image/png' }],
    });
  } catch (e) { /* 古い端末 */ }
}
function setPosition() {
  const a = P.audio;
  if (!a || !('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.playbackState = a.paused ? 'paused' : 'playing';
    if (isFinite(a.duration) && a.duration > 0) {
      navigator.mediaSession.setPositionState({ duration: a.duration, position: Math.min(a.currentTime, a.duration), playbackRate: a.playbackRate || 1 });
    }
  } catch (e) { /* 古い端末 */ }
}

/* ---------- つなぐ ---------- */
function rebuild() {
  const order = P.items.filter((it) => P.parts.has(it.n));
  const sig = order.map((it) => it.n).join(',');
  if (!order.length || sig === P.sig) return;
  const a = audio();
  const loaded = a.src.startsWith('blob:');
  const pos = loaded ? where() : null;
  const playing = loaded && !a.paused;
  P.segs = [];
  let t = 0;
  for (const it of order) { const p = P.parts.get(it.n); P.segs.push({ n: it.n, start: t, dur: p.dur }); t += p.dur; }
  P.total = t;
  P.sig = sig;
  const old = P.url;
  P.url = URL.createObjectURL(new Blob(order.map((it) => P.parts.get(it.n).buf), { type: 'audio/mpeg' }));
  if (P.waitAfter) {
    // 最後まで聞き終えて待っていた: できた次の記事から流す
    const i = order.findIndex((it) => it.n === P.waitAfter);
    const nx = order[i + 1];
    if (nx) { P.pending = { n: nx.n, at: 0, play: true }; P.waitAfter = 0; a.src = P.url; }
  } else if (P.pending && P.pending.wait) {
    // 押した記事の声ができるのを待っていた
    if (P.segs.some((s) => s.n === P.pending.n)) { P.pending.wait = false; a.src = P.url; }
  } else if (loaded) {
    P.pending = pos ? { n: pos.n, at: pos.at, play: playing } : null;
    a.src = P.url;
  }
  if (old) setTimeout(() => URL.revokeObjectURL(old), 4000);
  changed();
}

/* ---------- 声の準備 ---------- */
let lame = null;
function loadLame() {
  if (window.lamejs) return Promise.resolve(window.lamejs);
  if (!lame) {
    lame = new Promise((ok, ng) => {
      const s = document.createElement('script');
      s.src = LAME;
      s.onload = () => (window.lamejs ? ok(window.lamejs) : ng(new Error('lame')));
      s.onerror = () => { lame = null; ng(new Error('lame')); };
      document.head.append(s);
    });
  }
  return lame;
}
async function toMp3(b64, rate) {
  const lj = await loadLame();
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length & ~1);
  for (let i = 0; i < u8.length; i++) u8[i] = bin.charCodeAt(i);
  const pcm = new Int16Array(u8.buffer);
  const enc = new lj.Mp3Encoder(1, rate, 48);
  const out = [];
  const B = 1152 * 16;
  for (let i = 0; i < pcm.length; i += B) {
    const b = enc.encodeBuffer(pcm.subarray(i, i + B));
    if (b.length) out.push(new Uint8Array(b));
    if (i % (B * 20) === 0) await new Promise((r) => setTimeout(r, 0)); // 画面が固まらないよう、ときどき手を離す
  }
  const e = enc.flush();
  if (e.length) out.push(new Uint8Array(e));
  return { blob: new Blob(out, { type: 'audio/mpeg' }), dur: pcm.length / rate };
}
const b64Of = (blob) => new Promise((ok, ng) => {
  const r = new FileReader();
  r.onload = () => ok(String(r.result).replace(/^data:[^,]*,/, ''));
  r.onerror = ng;
  r.readAsDataURL(blob);
});
async function fetchMp3(url) {
  let cache = null;
  try { cache = await caches.open(AUDIO_CACHE); } catch (e) { /* 使えない端末 */ }
  if (cache) { const hit = await cache.match(url); if (hit) return hit.arrayBuffer(); }
  const res = await fetch(url);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  if (cache) { try { await cache.put(url, res.clone()); } catch (e) { /* 入らなくても流せる */ } }
  return res.arrayBuffer();
}
// 2週間より前の音声を端末から片づける
async function sweepCache() {
  try {
    const cache = await caches.open(AUDIO_CACHE);
    const keep = new Date(Date.now() + 9 * 3600e3 - 14 * 864e5).toISOString().slice(0, 10);
    for (const req of await cache.keys()) {
      const m = /\/news\/(\d{4}-\d{2}-\d{2})\//.exec(req.url);
      if (m && m[1] < keep) await cache.delete(req);
    }
  } catch (e) { /* 片づけられなくても困らない */ }
}

const ERR = {
  quota: 'Gemini の無料枠を今日は使い切りました。残りは明日作ります',
  cap: '今日の読み上げの回数の上限に達しました',
  key: 'Gemini のキーが使えないようです。登録し直してください',
  nokey: 'Gemini のキーがまだ登録されていません',
  net: '通信できませんでした',
  ai: '声を作れませんでした',
};

function reset(date) {
  if (P.date === date) return;
  P.date = date;
  P.items = store.itemsOf('news', date).slice().sort((x, y) => x.n - y.n);
  P.parts = new Map();
  P.segs = []; P.total = 0; P.sig = ''; P.scale = 1;
  P.error = ''; P.progress = ''; P.stopped = false; P.waitAfter = 0; P.pending = null; P.make = false;
  P.curN = P.items.length ? P.items[0].n : 0;
}

export function prepare(date, make) {
  if (!date) return Promise.resolve();
  if (P.date !== date) {
    if (P.audio && !P.audio.paused) return Promise.resolve(); // 別の日を流している間は切り替えない
    reset(date);
  }
  if (make && !P.make) { P.make = true; P.stopped = false; }
  if (!P.prep) P.prep = runPrepare(date).finally(() => { P.prep = null; changed(); });
  return P.prep;
}
async function runPrepare(date) {
  P.error = '';
  for (let round = 0; round < 12 && P.date === date; round++) {
    const st = await call('status', { date });
    if (st.code) { P.error = ERR[st.code] || st.error || ERR.net; return; }
    P.ready = !!st.ready;
    const byN = new Map((st.items || []).map((x) => [x.n, x]));
    for (const it of P.items) {
      const x = byN.get(it.n);
      if (x && x.url && !P.parts.has(it.n)) {
        try { P.parts.set(it.n, { buf: await fetchMp3(x.url), dur: x.dur }); rebuild(); } catch (e) { /* 次の回で取り直す */ }
      }
    }
    if (P.date !== date) return;
    const missing = P.items.filter((it) => !P.parts.has(it.n));
    if (!missing.length) { P.progress = ''; sweepCache(); return; }
    if (!P.ready || P.stopped || !P.make) return;
    let waiting = false;
    for (const it of missing) {
      if (P.date !== date) return;
      const x = byN.get(it.n);
      if (x && (x.url || x.busy)) { waiting = true; continue; } // ほかの端末が作っている
      P.progress = '声を作っています ' + (P.parts.size + 1) + '/' + P.items.length;
      changed();
      const r = await call('tts', { date, n: it.n }, 150000);
      if (r.done || r.busy) { waiting = true; continue; }
      if (!r.pcm) {
        P.error = ERR[r.code] || r.error || ERR.ai;
        if (r.code === 'key' || r.code === 'nokey') P.ready = false;
        if (r.code === 'quota' || r.code === 'cap' || r.code === 'key' || r.code === 'nokey') P.stopped = true;
        P.progress = '';
        return;
      }
      try {
        const mp3 = await toMp3(r.pcm, r.rate || 24000);
        const buf = await mp3.blob.arrayBuffer();
        P.parts.set(it.n, { buf, dur: mp3.dur });
        rebuild();
        const put = await call('put', { date, n: it.n, dur: mp3.dur, model: r.model, mp3: await b64Of(mp3.blob) }, 60000);
        if (put.url) { try { const c = await caches.open(AUDIO_CACHE); await c.put(put.url, new Response(mp3.blob, { headers: { 'Content-Type': 'audio/mpeg' } })); } catch (e) { /* 控えなしでも流せる */ } }
      } catch (e) {
        P.error = 'この端末で音声にできませんでした';
        P.progress = '';
        return;
      }
    }
    if (!waiting) continue;
    P.progress = 'ほかの端末で作っている声を待っています';
    changed();
    await new Promise((r) => setTimeout(r, 15000));
  }
}

/* ---------- 流す ---------- */
let silent = null;
function silentUrl() {
  // 押した瞬間に音を出す許可を取っておくための、0.2秒の無音
  if (silent) return silent;
  const n = 4800;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVEfmt '); v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 24000, true); v.setUint32(28, 48000, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
  silent = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
  return silent;
}

// 記事の番号 n から流す(ボタンを押したその場で呼ぶこと)
export function listen(date, n) {
  const a = audio();
  if (P.date !== date) { if (!a.paused) a.pause(); reset(date); }
  if (!n) n = P.items.length ? P.items[0].n : 1;
  P.curN = n;
  showBar();
  setMeta();
  if (P.segs.some((s) => s.n === n) && P.url) {
    if (a.src === P.url) { seekTo(n, 0); a.play().catch(() => {}); }
    else { P.pending = { n, at: 0, play: true }; a.src = P.url; a.play().catch(() => {}); }
  } else {
    // まだ声ができていない: 無音を流して許可だけ取り、できたら流す
    P.pending = { n, at: 0, play: true, wait: true };
    a.src = silentUrl();
    a.play().catch(() => {});
  }
  prepare(date, true).then(() => { if (P.ready === false) openSetup(() => prepare(date, true)); });
  changed();
}
export function toggle() {
  const a = audio();
  if (!a.src.startsWith('blob:')) return;
  if (a.paused) a.play().catch(() => {}); else a.pause();
}
function cycleSpeed() {
  const r = SPEEDS[(SPEEDS.indexOf(speed()) + 1) % SPEEDS.length];
  store.setPref({ listenRate: r });
  if (P.audio) P.audio.defaultPlaybackRate = P.audio.playbackRate = r;
  paint();
}
function hideBar() {
  if (P.audio) P.audio.pause();
  P.shown = false;
  if (P.bar) P.bar.hidden = true;
  document.body.classList.remove('has-pl');
}
export const isListening = (date, n) => P.shown && P.date === date && (!n || P.curN === n);
export const playingNow = () => !!(P.audio && !P.audio.paused && P.audio.src.startsWith('blob:'));

/* ---------- 下のプレーヤー ---------- */
const fmt = (s) => { s = Math.max(0, Math.round(s)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
const el = {};
function showBar() {
  if (!P.bar) buildBar();
  P.shown = true;
  P.bar.hidden = false;
  document.body.classList.add('has-pl');
}
function buildBar() {
  const btn = (cls, label, ic, fn) => h('button', { class: cls, type: 'button', 'aria-label': label, onclick: fn }, icon(ic, cls === 'pl-pp' ? 26 : 22));
  el.fill = h('i');
  el.num = h('b');
  el.title = h('span', { class: 'pl-tt' });
  el.sub = h('small');
  el.pp = btn('pl-pp', '再生', 'play', toggle);
  el.speed = h('button', { class: 'pl-sp', type: 'button', 'aria-label': '速さ', onclick: cycleSpeed });
  P.bar = h('div', { class: 'pl', id: 'player', hidden: true },
    h('div', { class: 'pl-prog' }, el.fill),
    h('div', { class: 'pl-top' },
      h('button', { class: 'pl-t', type: 'button', onclick: () => { if (P.curN) go('#/news/' + P.date + '/' + P.curN); } }, el.num, h('span', { class: 'pl-tx' }, el.title, el.sub)),
      h('button', { class: 'pl-x', type: 'button', 'aria-label': 'プレーヤーを閉じる', onclick: hideBar }, icon('x', 16))),
    h('div', { class: 'pl-ctl' },
      btn('', '10秒戻る', 'back10', () => nudge(-10)),
      btn('', '前の記事', 'prev', () => skip(-1)),
      el.pp,
      btn('', '次の記事', 'next', () => skip(1)),
      el.speed,
      h('button', { class: 'pl-ask', type: 'button', onclick: openAsk }, icon('ask', 20), '質問')));
  document.body.append(P.bar);
}
function paint() {
  if (!P.bar) return;
  const a = P.audio;
  const it = store.item('news', P.date, P.curN);
  el.num.textContent = String(P.curN || 0).padStart(2, '0');
  el.title.textContent = it ? it.data.title : '';
  const loaded = a && a.src.startsWith('blob:');
  const playing = loaded && !a.paused;
  el.pp.replaceChildren(icon(playing ? 'pause' : 'play', 26));
  el.pp.setAttribute('aria-label', playing ? '止める' : '再生');
  el.speed.textContent = speed() + '×';
  P.bar.classList.toggle('wait', !!(P.pending && P.pending.wait));
  paintTime(loaded ? where() : null);
}
function paintTime(pos) {
  if (!P.bar) return;
  let sub = '';
  if (P.pending && P.pending.wait) sub = P.error || P.progress || '声を用意しています…';
  else if (pos) sub = fmt(pos.at) + ' / ' + fmt(pos.dur) + (P.progress ? '　' + P.progress : P.error ? '　' + P.error : '');
  else sub = P.error || P.progress;
  el.sub.textContent = sub;
  const a = P.audio;
  el.fill.style.width = pos && pos.dur ? Math.min(100, (pos.at / pos.dur) * 100) + '%' : '0%';
  if (a && a.paused === false) setPosition();
}

/* ---------- キーの登録 ---------- */
function openSetup(after) {
  openSheet((sheet, close) => {
    let local = '';
    try { local = localStorage.getItem('reading-log-gemini-key') || ''; } catch (e) { /* 読めない */ }
    const msg = h('p', { class: 'sd', role: 'status' });
    const input = h('input', { class: 'kin', type: 'password', autocomplete: 'off', placeholder: 'AIza…', 'aria-label': 'Gemini のキー' });
    const send = async (key, b) => {
      b.disabled = true; msg.textContent = '確かめています…';
      const r = await call('set-key', { key });
      b.disabled = false;
      if (!r.ok) { msg.textContent = r.error || ERR.net; return; }
      P.ready = true; P.stopped = false;
      toast('登録しました。声を作りはじめます');
      close();
      if (after) after(); else if (P.date) prepare(P.date, true);
    };
    sheet.append(
      h('h3', null, '読み上げの準備'),
      h('p', { class: 'sd' }, 'ニュースを自然な声にするのと、聞きながらの質問に答えるのに、Google の Gemini(無料枠)を使います。最初に1回だけ、Gemini のキーを登録してください。キーはあさよみのサーバーにだけ置かれ、ほかの端末ではキーなしで使えます。'));
    if (local) {
      const b = h('button', { class: 'pbtn', type: 'button' }, '読書記録アプリに登録してあるキーを使う');
      b.addEventListener('click', () => send(local, b));
      sheet.append(b, h('p', { class: 'sd sm' }, 'またはキーを入れる'));
    }
    const go2 = h('button', { class: 'pbtn sub', type: 'button' }, '登録');
    go2.addEventListener('click', () => send(input.value, go2));
    sheet.append(h('div', { class: 'krow' }, input, go2), msg,
      h('p', { class: 'sd sm' }, 'キーは ', h('a', { href: 'https://aistudio.google.com/apikey', target: '_blank', rel: 'noopener' }, 'Google AI Studio'), ' で無料で作れます。'));
  });
}

/* ---------- 質問 ---------- */
const askId = (date, n) => 'ask:n:' + date + ':' + n + ':';
export function asksOf(date, n) {
  const out = [];
  store.st.each(askId(date, n), (id, d) => { if (d && d.q) out.push(d); });
  return out.sort((x, y) => (x.at < y.at ? -1 : 1));
}
// いま聞いていたあたりの段落(読み上げの順に並べ、文字数の割合で当てる)
function nearText(it, frac) {
  const d = it.data;
  const paras = [d.title, d.lede];
  for (const s of d.secs || d.sections || []) {
    if (Array.isArray(s)) paras.push(s[0], s[1]);
    else if (s) paras.push(s.h, ...(Array.isArray(s.p) ? s.p : [s.p]));
  }
  if (d.life) paras.push(d.life);
  const ps = paras.filter(Boolean).map(stripMarkup);
  const total = ps.reduce((n, p) => n + p.length, 0);
  let acc = 0;
  for (let i = 0; i < ps.length; i++) {
    acc += ps[i].length;
    if (acc / total >= frac) return (i > 0 && ps[i].length < 40 ? ps[i - 1] + ' ' : '') + ps[i];
  }
  return ps[ps.length - 1] || '';
}
function speak(text, onend) {
  const ss = window.speechSynthesis;
  if (!ss) { if (onend) onend(); return; }
  ss.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'ja-JP';
  u.rate = Math.min(1.6, speed());
  const v = ss.getVoices().find((x) => /^ja/i.test(x.lang));
  if (v) u.voice = v;
  u.onend = () => { if (onend) onend(); };
  u.onerror = () => { if (onend) onend(); };
  ss.speak(u);
}

export function openAsk(opt) {
  const a = audio();
  const pos = a.src.startsWith('blob:') ? where() : null;
  const date = (opt && opt.date) || P.date;
  const n = (opt && opt.n) || (pos ? pos.n : P.curN);
  const it = store.item('news', date, n);
  if (!it) return;
  const wasPlaying = !a.paused && a.src.startsWith('blob:');
  if (wasPlaying) a.pause();
  const near = pos && pos.n === n ? nearText(it, pos.dur ? pos.at / pos.dur : 0) : '';
  let resume = wasPlaying;
  let rec = null;

  openSheet((sheet, close) => {
    const log = h('div', { class: 'qa' });
    const ta = h('textarea', { rows: 2, placeholder: '例: 連立交渉ってなに？', 'aria-label': '質問' });
    const ans = h('div', { class: 'qa-now', hidden: true });
    const sendBtn = h('button', { class: 'pbtn sub', type: 'button' }, '聞く');
    const mic = h('button', { class: 'mic', type: 'button' }, icon('mic', 26), h('span', null, '押して話す'));
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const paintLog = () => {
      clear(log);
      for (const x of asksOf(date, n).slice(-3)) log.append(h('div', { class: 'qa-i' }, h('b', null, x.q), h('p', null, x.a)));
    };
    const ask = async () => {
      const q = ta.value.trim();
      if (!q) return;
      resume = false;
      sendBtn.disabled = true; mic.disabled = true;
      ans.hidden = false; clear(ans).append(h('p', { class: 'sd' }, '考えています…'));
      const history = asksOf(date, n).slice(-4).map((x) => ({ q: x.q, a: x.a }));
      const r = await call('ask', { date, n, q, near, history }, 60000);
      sendBtn.disabled = false; mic.disabled = false;
      if (!r.a) {
        clear(ans).append(h('p', { class: 'sd' }, ERR[r.code] && r.code !== 'ai' ? ERR[r.code] : r.error || '答えを作れませんでした'));
        if (r.code === 'nokey' || r.code === 'key') { close(); openSetup(); }
        return;
      }
      store.st.set(askId(date, n) + Date.now(), { q, a: r.a, at: new Date().toISOString() });
      ta.value = '';
      const back = h('button', { class: 'pbtn', type: 'button', onclick: () => { resume = wasPlaying || P.audio.src.startsWith('blob:'); close(); } }, icon('play', 18), '続きを聞く');
      clear(ans).append(h('div', { class: 'qa-i' }, h('b', null, q), h('p', null, r.a)),
        h('div', { class: 'qa-b' }, back, h('button', { class: 'pbtn sub', type: 'button', onclick: () => speak(r.a) }, 'もう一度読む')));
      paintLog();
      log.lastChild && log.lastChild.remove(); // いま出している答えと重ねない
      // 読み終えたら、続けて質問していなければ自動で続きへ
      let touched = false;
      const mark = () => { touched = true; };
      ta.addEventListener('focus', mark, { once: true });
      mic.addEventListener('click', mark, { once: true });
      speak(r.a, () => { if (!touched && document.body.contains(sheet) && wasPlaying) { resume = true; close(); } });
    };
    sendBtn.addEventListener('click', ask);
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); ask(); } });
    if (SR) {
      mic.addEventListener('click', () => {
        if (rec) { rec.stop(); return; }
        window.speechSynthesis && window.speechSynthesis.cancel();
        rec = new SR();
        rec.lang = 'ja-JP';
        rec.interimResults = true;
        rec.continuous = false;
        let text = '';
        mic.classList.add('on'); mic.lastChild.textContent = '聞いています…(もう一度押すと終わる)';
        rec.onresult = (e) => {
          text = Array.from(e.results).map((x) => x[0].transcript).join('');
          ta.value = text;
        };
        rec.onerror = (e) => { if (e.error === 'not-allowed') toast('マイクを使う許可がありません'); };
        rec.onend = () => {
          rec = null; mic.classList.remove('on'); mic.lastChild.textContent = '押して話す';
          if (text.trim()) ask();
        };
        try { rec.start(); } catch (e) { rec = null; mic.classList.remove('on'); }
      });
    } else {
      mic.hidden = true;
    }
    paintLog();
    sheet.append(h('h3', null, '質問する'),
      h('p', { class: 'sd' }, '「' + it.data.title + '」について、わからないことを聞けます。'),
      log, ans, mic, h('div', { class: 'krow' }, ta, sendBtn),
      h('p', { class: 'sd sm' }, 'Claudeと声で話しながら聞きたいときは ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); openClaude(date, n); } }, 'Claudeで開く')));
  }, () => {
    if (rec) { try { rec.abort(); } catch (e) { /* もう止まっている */ } rec = null; }
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    if (resume && P.audio && P.audio.src.startsWith('blob:')) P.audio.play().catch(() => {});
  });
}

/* ---------- 一覧・記事に置く入口 ---------- */
export function listenCard(date) {
  const items = store.itemsOf('news', date);
  const sub = h('small');
  const card = h('button', { class: 'lcard', type: 'button', onclick: () => listen(date, 0) },
    h('span', { class: 'li' }, icon('ear', 24)),
    h('span', { class: 'lt' }, h('b', null, items.length + '本をまとめて聞く'), sub),
    h('span', { class: 'go' }, icon('play', 18)));
  const paintCard = () => {
    const mine = P.date === date;
    const done = mine ? P.parts.size : 0;
    let t = '画面を消しても流れます・倍速もOK';
    if (mine && done && done < items.length) t = '声ができた記事 ' + done + '/' + items.length + (P.progress ? '・作っています' : '');
    if (mine && done === items.length && P.total) t = '約' + Math.max(1, Math.round(P.total / 60 / speed())) + '分(' + speed() + '×)・画面を消しても流れます';
    if (mine && P.error && !P.prep) t = P.error;
    if (mine && P.ready === false) t = 'はじめに Gemini のキーを1回だけ登録します';
    sub.textContent = t;
  };
  const off = onListen(() => { if (!card.isConnected) { off(); return; } paintCard(); });
  paintCard();
  prepare(date, date === store.latest('news'));
  return card;
}
export function listenButton(it) {
  return h('button', { class: 'lbtn', type: 'button', onclick: () => listen(it.date, it.n) }, icon('play', 16), 'この記事から聞く');
}
export function askLog(it) {
  const list = asksOf(it.date, it.n);
  const box = h('div', { class: 'terms asklog' }, h('div', { class: 'tl' }, list.length ? '聞きながら質問したこと' : 'わからないことを聞く'));
  for (const x of list) box.append(h('div', { class: 'qa-i' }, h('b', null, x.q), h('p', null, x.a)));
  box.append(h('button', { class: 'term qbtn', type: 'button', onclick: () => openAsk({ date: it.date, n: it.n }) }, icon('ask', 18), 'この記事について質問する'));
  return box;
}

// 雑学などへ移っても、聞いている間はバーを出したまま。ほかの日のニュースへ移ったら次の準備を始める
store.on('content', () => { if (P.date && !P.items.length) { const d = P.date; P.date = null; reset(d); } });

/* ---------- Claude と話して聞く ----------
   Claude アプリ(音声モード)で話し相手になってもらう。記事は関数の GET から素の文字で読んでもらう。
   開いた先で文が入らないこともあるので、頼む文はコピーもしておく(貼り付ければ同じ) */
export function claudePrompt(date, n) {
  const url = FN + '?d=' + date + (n ? '&n=' + n : '');
  const md = Number(date.slice(5, 7)) + '月' + Number(date.slice(8, 10)) + '日';
  return 'あさよみの' + md + 'の' + (n ? 'ニュース(' + n + '本目)' : 'ニュース') + 'です。まず ' + url + ' を開いて全部読んでください。\n' +
    '私は通勤・通学中に、音声モードで歩きながら聞いています。' +
    (n ? 'この記事を1分くらいで話して、' : '1本ずつ、ニュースキャスターのように1本1分くらいで話して、1本ごとに') +
    '「質問ある？それとも次へ？」と聞いてください。わからない言葉を聞いたら、記事をふまえて短く答えてください。' +
    '記号や箇条書きは使わず、耳で聞いてわかる話し言葉でお願いします。';
}
export function openClaude(date, n) {
  const text = claudePrompt(date, n);
  try { if (navigator.clipboard) navigator.clipboard.writeText(text).catch(() => {}); } catch (e) { /* コピーできなくても開く */ }
  if (P.audio && !P.audio.paused) P.audio.pause();
  toast('頼む文をコピーしました。入っていなければ貼り付けてください');
  window.open('https://claude.ai/new?q=' + encodeURIComponent(text), '_blank', 'noopener');
}
export function claudeButton(date, n) {
  return h('button', { class: 'lbtn cl', type: 'button', onclick: () => openClaude(date, n) }, icon('talk', 16), n ? 'Claudeと話す' : 'Claudeと話して聞く');
}
