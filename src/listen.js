// 聞く: ニュースと雑学の声の準備・まとめて流すプレーヤー・聞きながらの質問。
//  - 声は Gemini の読み上げで1本ずつ作る(関数 asayomi-voice)。届いた生の音をこの端末で mp3 にしてクラウドへ置くので、
//    1本につき作るのは1回だけ。ほかの端末やあとで聞くときは、置いてある mp3 を取ってくるだけ。
//  - 「ニュース→雑学」「雑学→ニュース」「片方だけ」を1本の流れ(プレイリスト)にして、
//    画面を消しても止まらないよう、できている分を1つの音声につなげて <audio> で流す(記事の切れ目でアプリの処理がいらない)。
//    ロック画面・イヤホンのボタンで 止める/次の記事/前の記事/10秒戻る ができる。
//  - 質問は声(音声入力)か文字で。答えは画面に出して読み上げ、読み終えたら続きから流す。
import { h, clear, stripMarkup } from './util.js';
import { SB_URL } from './config.js';
import * as store from './store.js';
import { icon } from './art.js';
import { openSheet, toast } from './ui.js';
import { go } from './nav.js';
import { openClaude } from './talk.js';

const FN = SB_URL + '/functions/v1/asayomi-voice';
const SPEEDS = [0.8, 1, 1.25, 1.5, 1.75, 2];
const AUDIO_CACHE = 'asayomi-audio';
const LAME = 'https://cdn.jsdelivr.net/npm/lamejs@1.2.1/lame.min.js';
const OUT_RATE = 24000;
const NAME = { news: 'ニュース', trivia: '雑学' };
const other = (k) => (k === 'news' ? 'trivia' : 'news');
const keyOf = (kind, date, n) => kind + ':' + date + ':' + n;

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
  sig: '',                // いまの流れ(どの種類のどの日を、どの順で)
  groups: [],             // [{ kind, date }] 流す順
  list: [],               // [{ key, kind, date, n }] 流す順の記事
  parts: new Map(),       // key → { buf, dur }
  segs: [],               // つないだ音声の中の位置 [{ key, kind, date, n, start, dur }]
  total: 0, scale: 1, built: '', url: null,
  ready: null,            // サーバーにキーがあるか
  prep: null, again: false, progress: '', error: '', stopped: false,
  make: false,            // 足りない声を作ってよいか(最新の日か、聞くボタンを押した流れだけ)
  audio: null, bar: null, shown: false,
  cur: null, pending: null, waitAfter: null, heard: new Set(), ended: false,
};
const speed = () => { const r = Number(store.pref().listenRate); return SPEEDS.indexOf(r) >= 0 ? r : 1; };
// 続けてもう一方も聞くか(既定は聞く)。設定はクラウドに残り、ほかの端末でも同じ
export const listenBoth = () => store.pref().listenBoth !== false;
const listeners = new Set();
function changed() { paint(); for (const fn of listeners) fn(); }
export function onListen(fn) { listeners.add(fn); return () => listeners.delete(fn); }
const entryOf = (key) => P.list.find((e) => e.key === key) || null;
const itemOfKey = (key) => { const e = entryOf(key); return e ? store.item(e.kind, e.date, e.n) : null; };

// どの日の分を続けるか: 最新の日を見ていればもう一方も最新、前の日を見ていればその日の分(なければ最新)
function dayFor(kind, fromKind, date) {
  if (date === store.latest(fromKind)) return store.latest(kind);
  return store.itemsOf(kind, date).length ? date : store.latest(kind);
}
function groupsFor(kind, date, both) {
  const gs = [{ kind, date }];
  if (both) { const k = other(kind); const d = dayFor(k, kind, date); if (d) gs.push({ kind: k, date: d }); }
  return gs.filter((g) => store.itemsOf(g.kind, g.date).length);
}
const sigOf = (gs) => gs.map((g) => g.kind + '@' + g.date).join('>');

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
    if (pd) { seekTo(pd.key, pd.at); if (pd.play) a.play().catch(() => {}); }
  });
  a.addEventListener('timeupdate', tick);
  a.addEventListener('play', () => { P.ended = false; paint(); setPosition(); });
  a.addEventListener('pause', () => { paint(); setPosition(); });
  a.addEventListener('ratechange', setPosition);
  a.addEventListener('ended', () => {
    if (!a.src.startsWith('blob:')) return;
    const last = P.segs[P.segs.length - 1];
    // まだ作っている途中の記事があれば、できた所で続きを流す
    if (last && P.prep && last.key !== P.list[P.list.length - 1].key) P.waitAfter = last.key;
    else P.ended = true;
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
  return { key: seg.key, kind: seg.kind, date: seg.date, n: seg.n, at: Math.max(0, t - seg.start), dur: seg.dur };
}
function seekTo(key, at) {
  const seg = P.segs.find((s) => s.key === key);
  if (seg) { P.audio.currentTime = (seg.start + (at || 0)) * (P.scale || 1); P.ended = false; }
}
function skip(dir) {
  const pos = where();
  if (!pos) return;
  if (dir < 0 && pos.at > 4) { seekTo(pos.key, 0); return; }
  const i = P.segs.findIndex((s) => s.key === pos.key) + dir;
  if (i >= 0 && i < P.segs.length) seekTo(P.segs[i].key, 0);
}
function nudge(sec) {
  const a = P.audio;
  if (a) a.currentTime = Math.max(0, Math.min((a.duration || 0) - 0.3, a.currentTime + sec));
}
function tick() {
  const pos = where();
  if (!pos) return;
  if (pos.key !== P.cur) { P.cur = pos.key; setMeta(); changed(); }
  // 7割まで聞いたら「読んだ」にする
  if (!P.heard.has(pos.key) && pos.at > pos.dur * 0.7) {
    P.heard.add(pos.key);
    const it = store.item(pos.kind, pos.date, pos.n);
    if (it && !store.isRead(it)) store.markRead(it);
  }
  paintTime(pos);
}
function setMeta() {
  if (!('mediaSession' in navigator)) return;
  const e = entryOf(P.cur);
  const it = itemOfKey(P.cur);
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: it ? it.data.title : 'あさよみ',
      artist: e ? 'あさよみ ' + NAME[e.kind] + ' ' + e.n + '/' + store.itemsOf(e.kind, e.date).length : 'あさよみ',
      album: e ? e.date : '',
      artwork: [{ src: new URL('icons/icon-192.png', location.href).href, sizes: '192x192', type: 'image/png' }],
    });
  } catch (err) { /* 古い端末 */ }
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
  const order = P.list.filter((e) => P.parts.has(e.key));
  const built = order.map((e) => e.key).join(',');
  if (!order.length || built === P.built) return;
  const a = audio();
  const loaded = a.src.startsWith('blob:');
  const pos = loaded ? where() : null;
  const playing = loaded && !a.paused;
  P.segs = [];
  let t = 0;
  for (const e of order) { const p = P.parts.get(e.key); P.segs.push(Object.assign({ start: t, dur: p.dur }, e)); t += p.dur; }
  P.total = t;
  P.built = built;
  const old = P.url;
  P.url = URL.createObjectURL(new Blob(order.map((e) => P.parts.get(e.key).buf), { type: 'audio/mpeg' }));
  if (P.waitAfter) {
    // 最後まで聞き終えて待っていた: できた次の記事から流す
    const i = order.findIndex((e) => e.key === P.waitAfter);
    const nx = order[i + 1];
    if (nx) { P.pending = { key: nx.key, at: 0, play: true }; P.waitAfter = null; a.src = P.url; }
  } else if (P.pending && P.pending.wait) {
    // 押した記事の声ができるのを待っていた
    if (P.segs.some((s) => s.key === P.pending.key)) { P.pending.wait = false; a.src = P.url; }
  } else if (loaded) {
    P.pending = pos ? { key: pos.key, at: pos.at, play: playing } : null;
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
  let from = 0;
  // WAV(頭に RIFF がつく)で返ってきたときは、data の前までを読み飛ばし、速さも頭の情報に合わせる
  if (bin.slice(0, 4) === 'RIFF' && bin.slice(8, 12) === 'WAVE') {
    const u32 = (o) => (bin.charCodeAt(o) | (bin.charCodeAt(o + 1) << 8) | (bin.charCodeAt(o + 2) << 16) | (bin.charCodeAt(o + 3) << 24)) >>> 0;
    let o = 12;
    while (o + 8 <= bin.length) {
      const id = bin.slice(o, o + 4);
      const size = u32(o + 4);
      if (id === 'fmt ') rate = u32(o + 12) || rate;
      if (id === 'data') { from = o + 8; break; }
      o += 8 + size + (size & 1);
    }
  }
  const u8 = new Uint8Array((bin.length - from) & ~1);
  for (let i = 0; i < u8.length; i++) u8[i] = bin.charCodeAt(from + i);
  let pcm = new Int16Array(u8.buffer);
  // つないで1本にするので、どの記事も同じ 24kHz にそろえる(速さのちがう mp3 が混ざると途中で壊れる)
  if (rate !== OUT_RATE) {
    const k = rate / OUT_RATE;
    const res = new Int16Array(Math.floor(pcm.length / k));
    for (let i = 0; i < res.length; i++) {
      const x = i * k, j = Math.floor(x), f = x - j;
      res[i] = (pcm[j] * (1 - f) + (pcm[Math.min(j + 1, pcm.length - 1)] * f)) | 0;
    }
    pcm = res;
    rate = OUT_RATE;
  }
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
      const m = /\/(?:news|trivia)\/(\d{4}-\d{2}-\d{2})\//.exec(req.url);
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

// 流れを決め直す(同じ流れなら何もしない)。声の控え(parts)は流れが変わっても使い回す
function setFlow(gs) {
  const sig = sigOf(gs);
  if (sig === P.sig) return;
  P.sig = sig;
  P.groups = gs;
  P.list = [];
  for (const g of gs) {
    for (const it of store.itemsOf(g.kind, g.date).slice().sort((x, y) => x.n - y.n)) {
      P.list.push({ key: keyOf(g.kind, g.date, it.n), kind: g.kind, date: g.date, n: it.n });
    }
  }
  P.segs = []; P.total = 0; P.built = ''; P.scale = 1;
  P.error = ''; P.progress = ''; P.stopped = false; P.waitAfter = null; P.pending = null; P.make = false; P.ended = false;
  P.cur = P.list.length ? P.list[0].key : null;
}

export function prepare(gs, make) {
  if (!gs || !gs.length) return Promise.resolve();
  if (sigOf(gs) !== P.sig) {
    if (P.audio && !P.audio.paused) return Promise.resolve(); // 別の流れを聞いている間は切り替えない
    setFlow(gs);
  }
  if (make && !P.make) {
    P.make = true; P.stopped = false;
    if (P.prep) P.again = true; // 作らない約束で動いている途中: 終わったらもう一度、今度は作る
  }
  // ぜんぶ声がそろっていれば、聞きに行くまでもない(一覧を描き直すたびに通信しないように)
  if (!P.prep && P.list.length && P.list.every((e) => P.parts.has(e.key))) return Promise.resolve();
  if (!P.prep) {
    const sig = P.sig;
    P.prep = runPrepare(sig).finally(() => {
      P.prep = null;
      // 途中で「作ってよい」になった・流れが変わった: いまの流れでもう一度
      if (P.again || P.sig !== sig) { P.again = false; prepare(P.groups, P.make); }
      changed();
    });
  }
  return P.prep;
}
async function runPrepare(sig) {
  P.error = '';
  const alive = () => P.sig === sig;
  for (let round = 0; round < 12 && alive(); round++) {
    const byKey = new Map();
    for (const g of P.groups) {
      const st = await call('status', { kind: g.kind, date: g.date });
      if (!alive()) return;
      if (st.code) { P.error = ERR[st.code] || st.error || ERR.net; return; }
      P.ready = !!st.ready;
      for (const x of st.items || []) byKey.set(keyOf(g.kind, g.date, x.n), x);
    }
    for (const e of P.list) {
      const x = byKey.get(e.key);
      if (x && x.url && !P.parts.has(e.key)) {
        try { P.parts.set(e.key, { buf: await fetchMp3(x.url), dur: x.dur }); if (alive()) rebuild(); } catch (err) { /* 次の回で取り直す */ }
      }
      if (!alive()) return;
    }
    const missing = P.list.filter((e) => !P.parts.has(e.key));
    if (!missing.length) { P.progress = ''; rebuild(); sweepCache(); return; }
    if (!P.ready || P.stopped || !P.make) return;
    let waiting = false;
    for (const e of missing) {
      if (!alive()) return;
      const x = byKey.get(e.key);
      if (x && (x.url || x.busy)) { waiting = true; continue; } // ほかの端末が作っている
      const done = P.list.filter((y) => P.parts.has(y.key)).length;
      P.progress = '声を作っています ' + (done + 1) + '/' + P.list.length + '(アプリは開いたままで)';
      changed();
      const r = await call('tts', { kind: e.kind, date: e.date, n: e.n }, 150000);
      // 途中で流れが変わっても、できた声は捨てずに置いておく(置かないと、ほかの端末が4分待たされる)
      if (r.done || r.busy) { if (!alive()) return; waiting = true; continue; }
      if (!r.pcm) {
        if (!alive()) return;
        P.error = ERR[r.code] || r.error || ERR.ai;
        if (r.code === 'key' || r.code === 'nokey') P.ready = false;
        if (r.code === 'quota' || r.code === 'cap' || r.code === 'key' || r.code === 'nokey') P.stopped = true;
        P.progress = '';
        return;
      }
      try {
        const mp3 = await toMp3(r.pcm, r.rate || OUT_RATE);
        P.parts.set(e.key, { buf: await mp3.blob.arrayBuffer(), dur: mp3.dur });
        if (alive()) rebuild();
        const put = await call('put', { kind: e.kind, date: e.date, n: e.n, dur: mp3.dur, model: r.model, mp3: await b64Of(mp3.blob) }, 60000);
        if (put.url) { try { const c = await caches.open(AUDIO_CACHE); await c.put(put.url, new Response(mp3.blob, { headers: { 'Content-Type': 'audio/mpeg' } })); } catch (err) { /* 控えなしでも流せる */ } }
      } catch (err) {
        if (!alive()) return;
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

// kind の date の n 本目から流す(n が無ければ最初から)。続けてもう一方も流すかは設定どおり(ボタンを押したその場で呼ぶこと)
export function listen(kind, date, n) {
  const a = audio();
  const gs = groupsFor(kind, date, listenBoth());
  if (!gs.length) { toast('聞ける記事がありません'); return; }
  if (sigOf(gs) !== P.sig) { if (!a.paused) a.pause(); setFlow(gs); }
  const key = n ? keyOf(kind, date, n) : P.list[0].key;
  P.cur = key;
  showBar();
  setMeta();
  if (P.segs.some((s) => s.key === key) && P.url) {
    if (a.src === P.url) { seekTo(key, 0); a.play().catch(() => {}); }
    else { P.pending = { key, at: 0, play: true }; a.src = P.url; a.play().catch(() => {}); }
  } else {
    // まだ声ができていない: 無音を流して許可だけ取り、できたら流す
    P.pending = { key, at: 0, play: true, wait: true };
    a.src = silentUrl();
    a.play().catch(() => {});
  }
  prepare(gs, true).then(() => { if (P.ready === false) openSetup(() => prepare(P.groups, true)); });
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
export function pauseListening() { if (P.audio && !P.audio.paused) P.audio.pause(); }
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
      h('button', { class: 'pl-t', type: 'button', onclick: () => { const e = entryOf(P.cur); if (e) go('#/' + e.kind + '/' + e.date + '/' + e.n); } }, el.num, h('span', { class: 'pl-tx' }, el.title, el.sub)),
      h('button', { class: 'pl-x', type: 'button', 'aria-label': 'プレーヤーを閉じる', onclick: hideBar }, icon('x', 16))),
    h('div', { class: 'pl-ctl' },
      btn('', '10秒戻る', 'back10', () => nudge(-10)),
      btn('', '前の記事', 'prev', () => skip(-1)),
      el.pp,
      btn('', '次の記事', 'next', () => skip(1)),
      el.speed,
      h('button', { class: 'pl-ask', type: 'button', onclick: () => openAsk() }, icon('ask', 20), '質問')));
  document.body.append(P.bar);
}
function paint() {
  if (!P.bar) return;
  const a = P.audio;
  const e = entryOf(P.cur);
  const it = itemOfKey(P.cur);
  el.num.textContent = e ? (e.kind === 'news' ? 'ニュース ' : '雑学 ') + String(e.n).padStart(2, '0') : '';
  P.bar.classList.toggle('tv', !!e && e.kind === 'trivia');
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
  else if (P.ended) sub = P.segs.length < P.list.length ? '声ができている' + P.segs.length + '本を聞き終えました' + (P.error ? '(' + P.error + ')' : '') : 'ぜんぶ聞きました(' + P.list.length + '本)。▶でもう一度';
  else if (pos) sub = fmt(pos.at) + ' / ' + fmt(pos.dur) + (P.progress ? '　' + P.progress : P.error ? '　' + P.error : '');
  else sub = P.error || P.progress;
  el.sub.textContent = sub;
  const a = P.audio;
  el.fill.style.width = pos && pos.dur ? Math.min(100, (pos.at / pos.dur) * 100) + '%' : '0%';
  if (a && a.paused === false) setPosition();
}

/* ---------- キーの登録 ---------- */
export function openSetup(after) {
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
      if (after) after(); else if (P.groups.length) prepare(P.groups, true);
    };
    sheet.append(
      h('h3', null, '読み上げの準備'),
      h('p', { class: 'sd' }, 'ニュースと雑学を自然な声にするのと、聞きながらの質問に答えるのに、Google の Gemini(無料枠)を使います。最初に1回だけ、Gemini のキーを登録してください。キーはあさよみのサーバーにだけ置かれ、ほかの端末ではキーなしで使えます。'));
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
// ニュースは以前からの ask:n:…、雑学は ask:t:…(既読などと同じ頭文字)
const askId = (kind, date, n) => 'ask:' + (kind === 'trivia' ? 't' : 'n') + ':' + date + ':' + n + ':';
export function asksOf(kind, date, n) {
  const out = [];
  store.st.each(askId(kind, date, n), (id, d) => { if (d && d.q) out.push(d); });
  return out.sort((x, y) => (x.at < y.at ? -1 : 1));
}
// いま聞いていたあたりの段落(読み上げの順に並べ、文字数の割合で当てる)
function nearText(it, frac) {
  const d = it.data;
  const paras = [d.title];
  if (it.kind === 'trivia') {
    paras.push(d.gist);
    for (const s of d.sections || []) paras.push(s.h, ...(Array.isArray(s.p) ? s.p : [s.p]));
    paras.push(d.talk, d.extra && d.extra.text);
  } else {
    paras.push(d.lede);
    for (const s of d.secs || d.sections || []) {
      if (Array.isArray(s)) paras.push(s[0], s[1]);
      else if (s) paras.push(s.h, ...(Array.isArray(s.p) ? s.p : [s.p]));
    }
    paras.push(d.life);
  }
  const ps = paras.filter(Boolean).map(stripMarkup);
  const total = ps.reduce((n, p) => n + p.length, 0);
  let acc = 0;
  for (let i = 0; i < ps.length; i++) {
    acc += ps[i].length;
    if (acc / total >= frac) return (i > 0 && ps[i].length < 40 ? ps[i - 1] + ' ' : '') + ps[i];
  }
  return ps[ps.length - 1] || '';
}
// iPhone は、押した直後に一度しゃべらせておかないと、あとから読み上げられない。押したその場で呼ぶ
function primeSpeech() {
  const ss = window.speechSynthesis;
  if (!ss || primeSpeech.done) return;
  try { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; ss.speak(u); primeSpeech.done = true; } catch (e) { /* 読み上げなしでも答えは出る */ }
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

// opt を渡さなければ、いま流している記事について聞く
export function openAsk(opt) {
  const a = audio();
  const pos = a.src.startsWith('blob:') ? where() : null;
  const cur = entryOf(P.cur);
  const kind = (opt && opt.kind) || (pos ? pos.kind : cur && cur.kind);
  const date = (opt && opt.date) || (pos ? pos.date : cur && cur.date);
  const n = (opt && opt.n) || (pos ? pos.n : cur && cur.n);
  const it = kind && store.item(kind, date, n);
  if (!it) return;
  const wasPlaying = !a.paused && a.src.startsWith('blob:');
  if (wasPlaying) a.pause();
  const near = pos && pos.key === keyOf(kind, date, n) ? nearText(it, pos.dur ? pos.at / pos.dur : 0) : '';
  let resume = wasPlaying;
  let rec = null;

  openSheet((sheet, close) => {
    const log = h('div', { class: 'qa' });
    const ta = h('textarea', { rows: 2, placeholder: kind === 'news' ? '例: 連立交渉ってなに？' : '例: それって今もやってるの？', 'aria-label': '質問' });
    const ans = h('div', { class: 'qa-now', hidden: true });
    const sendBtn = h('button', { class: 'pbtn sub', type: 'button' }, '聞く');
    const mic = h('button', { class: 'mic', type: 'button' }, icon('mic', 26), h('span', null, '押して話す'));
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const paintLog = () => {
      clear(log);
      for (const x of asksOf(kind, date, n).slice(-3)) log.append(h('div', { class: 'qa-i' }, h('b', null, x.q), h('p', null, x.a)));
    };
    const ask = async () => {
      const q = ta.value.trim();
      if (!q) return;
      sendBtn.disabled = true; mic.disabled = true;
      ans.hidden = false; clear(ans).append(h('p', { class: 'sd' }, '考えています…'));
      const history = asksOf(kind, date, n).slice(-4).map((x) => ({ q: x.q, a: x.a }));
      const r = await call('ask', { kind, date, n, q, near, history }, 60000);
      sendBtn.disabled = false; mic.disabled = false;
      if (!r.a) {
        clear(ans).append(h('p', { class: 'sd' }, ERR[r.code] && r.code !== 'ai' ? ERR[r.code] : r.error || '答えを作れませんでした'));
        if (r.code === 'nokey' || r.code === 'key') { close(); openSetup(); }
        return;
      }
      store.st.set(askId(kind, date, n) + Date.now(), { q, a: r.a, at: new Date().toISOString() });
      ta.value = '';
      const back = h('button', { class: 'pbtn', type: 'button', onclick: () => { resume = wasPlaying || P.audio.src.startsWith('blob:'); close(); } }, icon('play', 18), '続きを聞く');
      clear(ans).append(h('div', { class: 'qa-i' }, h('b', null, q), h('p', null, r.a)),
        h('div', { class: 'qa-b' }, back, h('button', { class: 'pbtn sub', type: 'button', onclick: () => speak(r.a) }, 'もう一度読む')));
      paintLog();
      if (log.lastChild) log.lastChild.remove(); // いま出している答えと重ねない
      // 読み終えたら、続けて質問していなければ自動で続きへ
      let touched = false;
      const mark = () => { touched = true; };
      ta.addEventListener('focus', mark, { once: true });
      mic.addEventListener('click', mark, { once: true });
      speak(r.a, () => { if (!touched && document.body.contains(sheet) && wasPlaying) { resume = true; close(); } });
    };
    sendBtn.addEventListener('click', () => { primeSpeech(); ask(); });
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); primeSpeech(); ask(); } });
    if (SR) {
      mic.addEventListener('click', () => {
        if (rec) { rec.stop(); return; }
        if (window.speechSynthesis) window.speechSynthesis.cancel();
        primeSpeech();
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
      h('p', { class: 'sd sm' }, 'Claudeと声で話しながら聞きたいときは ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); openClaude(kind, date, n); } }, 'Claudeで開く')));
  }, () => {
    if (rec) { try { rec.abort(); } catch (e) { /* もう止まっている */ } rec = null; }
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    if (resume && P.audio && P.audio.src.startsWith('blob:')) P.audio.play().catch(() => {});
  });
}

/* ---------- 一覧・記事に置く入口 ---------- */
// 一覧の上の「まとめて聞く」。下の小さなボタンで「続けてもう一方も」を切りかえる
export function listenCard(kind, date) {
  const label = h('b');
  const sub = h('small');
  const card = h('button', { class: 'lcard', type: 'button', onclick: () => listen(kind, date, 0) },
    h('span', { class: 'li' }, icon('ear', 24)),
    h('span', { class: 'lt' }, label, sub),
    h('span', { class: 'go' }, icon('play', 18)));
  const chip = h('button', { class: 'lchip', type: 'button', role: 'switch' });
  chip.addEventListener('click', () => {
    store.setPref({ listenBoth: !listenBoth() });
    const gs = groupsFor(kind, date, listenBoth());
    prepare(gs, isLatest(gs));
    paintCard();
  });
  const isLatest = (gs) => gs.every((g) => g.date === store.latest(g.kind));
  const paintCard = () => {
    const gs = groupsFor(kind, date, listenBoth());
    const count = (g) => store.itemsOf(g.kind, g.date).length;
    label.textContent = gs.map((g) => NAME[g.kind] + count(g) + '本').join(' → ') + 'を聞く';
    const both = listenBoth();
    chip.setAttribute('aria-checked', String(both));
    chip.textContent = (both ? '✓ ' : '') + '続けて' + NAME[other(kind)] + 'も';
    chip.hidden = !store.latest(other(kind));
    const mine = P.sig === sigOf(gs);
    const all = gs.reduce((n, g) => n + count(g), 0);
    const done = mine ? P.list.filter((e) => P.parts.has(e.key)).length : 0;
    let t = '画面を消しても流れます・倍速もOK';
    if (mine && done && done < all) t = '声ができた記事 ' + done + '/' + all + (P.progress ? '・作っています' : '');
    if (mine && done === all && P.total) t = '約' + Math.max(1, Math.round(P.total / 60 / speed())) + '分(' + speed() + '×)・画面を消しても流れます';
    if (mine && P.error && !P.prep) t = P.error;
    if (mine && P.ready === false) t = 'はじめに Gemini のキーを1回だけ登録します';
    sub.textContent = t;
  };
  const off = onListen(() => { if (!card.isConnected) { off(); return; } paintCard(); });
  paintCard();
  const gs = groupsFor(kind, date, listenBoth());
  prepare(gs, isLatest(gs));
  return h('div', { class: 'lwrap' }, card, chip);
}
export function listenButton(it) {
  return h('button', { class: 'lbtn', type: 'button', onclick: () => listen(it.kind, it.date, it.n) }, icon('play', 16), 'この記事から聞く');
}
export function askLog(it) {
  const list = asksOf(it.kind, it.date, it.n);
  const box = h('div', { class: 'asklog' + (it.kind === 'news' ? ' terms' : '') }, h('div', { class: 'tl' }, list.length ? '聞きながら質問したこと' : 'わからないことを聞く'));
  for (const x of list) box.append(h('div', { class: 'qa-i' }, h('b', null, x.q), h('p', null, x.a)));
  box.append(h('button', { class: 'term qbtn', type: 'button', onclick: () => openAsk({ kind: it.kind, date: it.date, n: it.n }) }, icon('ask', 18), 'この' + NAME[it.kind] + 'について質問する'));
  return box;
}

// 記事がまだ取り込まれていない間に決めた流れは、届いたら組み直す
store.on('content', () => {
  if (P.groups.length && !P.list.length) { const gs = P.groups; P.sig = ''; setFlow(gs); }
});

/* ---------- 設定画面の「ニュースの読み上げ」 ---------- */
export async function voiceStatus() {
  const gs = ['news', 'trivia'].map((k) => ({ kind: k, date: store.latest(k) })).filter((g) => g.date);
  let ready = false, lastError = null, made = 0;
  for (const g of gs) {
    const st = await call('status', g, 15000);
    if (st.code) return { ok: false };
    ready = !!st.ready; lastError = st.lastError || lastError;
    made += (st.items || []).filter((x) => x.url).length;
  }
  P.ready = ready;
  const total = gs.reduce((n, g) => n + store.itemsOf(g.kind, g.date).length, 0);
  return { ok: true, ready, lastError, made, total };
}
// 新しい版への読み込み直し(index.html)を、聞いている間は待ってもらうため
window.__asayomiPlaying = playingNow;
