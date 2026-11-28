// 聞く: ニュースと雑学の声の準備・まとめて流すプレーヤー・聞きながらの質問。
//  - 声は Gemini の読み上げで1本ずつ作る(関数 asayomi-voice)。毎朝の配信のあと、サーバーが先に全部作ってクラウドに置いておくので、
//    この端末は置いてある mp3 を取ってくるだけ(開いて押したらすぐ流れる)。足りない分だけ、押したときにサーバーに作ってもらう。
//    Gemini から mp3 でもらえなかったときだけ、届いた生の音をこの端末で mp3 にして置く。
//  - 「ニュース→雑学」「雑学→ニュース」「片方だけ」を1本の流れ(プレイリスト)にして、
//    画面を消しても止まらないよう、できている分を1つの音声につなげて <audio> で流す(記事の切れ目でアプリの処理がいらない)。
//    ロック画面・イヤホンのボタンで 止める/次の記事/前の記事/5秒戻る・5秒進む ができる。
//  - 聞き終えた記事は「読んだ」になり、次に押すとまだの記事から始まる。その日の分をぜんぶ聞き終えると、締めの一言が流れる。
//  - 質問は声(音声入力)か文字で。答えは画面に出して読み上げ、読み終えたら続きから流す。
import { h, clear, stripMarkup, stableUuid } from './util.js';
import { SB_URL, MEMO_TAG } from './config.js';
import { memoOf } from './actions.js';
import * as store from './store.js';
import { icon } from './art.js';
import { openSheet, toast } from './ui.js';
import { go } from './nav.js';

const FN = SB_URL + '/functions/v1/asayomi-voice';
const SPEEDS = [0.8, 1, 1.25, 1.5, 1.75, 2];
const AUDIO_CACHE = 'asayomi-audio';
const LAME = 'https://cdn.jsdelivr.net/npm/lamejs@1.2.1/lame.min.js';
const OUT_RATE = 44100; // サーバーが置く mp3(Gemini の 44.1kHz・1ch・128kbps)と同じ形にそろえる
const OUT_KBPS = 128;
const NAME = { news: 'ニュース', trivia: '雑学', manner: 'マナー', study: '学問' };
// 流す順はニュース → 雑学 → マナー → 学問。途中から聞きはじめたら、その先をつないで最後に頭へ戻る
const ORDER = ['news', 'trivia', 'manner', 'study'];
const rest = (k) => { const i = ORDER.indexOf(k); return [...ORDER.slice(i + 1), ...ORDER.slice(0, i)]; };
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
  sig: '',                // いまの流れ(流す記事の並び)
  groups: [],             // [{ kind, date }] 流れに入っている種類と日
  list: [],               // [{ key, kind, date, n }] 流す順の記事
  parts: new Map(),       // key → { buf, dur }
  avail: new Set(),       // サーバーに声が置いてある記事
  durs: new Map(),        // key → 長さ(秒)。まだ取ってきていない記事の分も
  segs: [],               // つないだ音声の中の位置 [{ key, kind, date, n, start, dur }]
  total: 0, scale: 1, built: '', url: null,
  ready: null,            // サーバーにキーがあるか
  checked: '', checkedAt: 0, // 最後にサーバーへ確かめた流れと時刻
  prep: null, again: false, progress: '', error: '', stopped: false,
  make: false,            // 足りない声を作ってよいか(最新の日か、聞くボタンを押した流れだけ)
  audio: null, bar: null, shown: false,
  cur: null, pending: null, waitAfter: null, ended: false,
  last: null,             // ひとつ前の timeupdate の位置(自然に流れたのか、飛ばしたのかを見分ける)
  closeKey: null,         // この記事のあとで締めの一言(その日の分をぜんぶ聞き終える所)
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
  if (both) for (const k of rest(kind)) { const d = dayFor(k, kind, date); if (d) gs.push({ kind: k, date: d }); }
  return gs.filter((g) => store.itemsOf(g.kind, g.date).length);
}
const entriesOf = (gs) => gs.flatMap((g) => store.itemsOf(g.kind, g.date).slice().sort((x, y) => x.n - y.n)
  .map((it) => ({ key: keyOf(g.kind, g.date, it.n), kind: g.kind, date: g.date, n: it.n })));
const sigOf = (list) => list.map((e) => e.key).join('>');
const unreadEntry = (e) => { const it = store.item(e.kind, e.date, e.n); return !!it && !store.isRead(it); };
// start の記事から流すとき: 前の記事は「前の記事」ボタンで戻れるように残し、先は聞いていない・読んでいない記事だけにする
function onward(list, startKey) {
  const i = list.findIndex((e) => e.key === startKey);
  return list.filter((e, j) => j <= i || unreadEntry(e));
}

/* ---------- その日の分と、締めの一言 ---------- */
const CLOSING_TEXT = '今日も一日、頑張ってね。';
const newestDay = () => ORDER.map((k) => store.latest(k)).filter(Boolean).sort().pop() || '';
const dayEntries = () => { const d = newestDay(); return entriesOf(ORDER.map((k) => ({ kind: k, date: d }))); };
// この流れを聞き終えると今日の分がぜんぶ終わるなら、今日の分でいちばん後の記事。そうでなければ null
function closingKeyOf(list) {
  const today = dayEntries();
  if (!today.length) return null;
  const inFlow = new Set(list.map((e) => e.key));
  if (!today.every((e) => inFlow.has(e.key) || !unreadEntry(e))) return null;
  const ids = new Set(today.map((e) => e.key));
  const mine = list.filter((e) => ids.has(e.key));
  return mine.length ? mine[mine.length - 1].key : null;
}
const allTodayHeard = () => dayEntries().every((e) => !unreadEntry(e));

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
    if (pd) {
      seekTo(pd.key, pd.at);
      // 端末によっては読み込み直後の位置合わせが効かず、頭から流れてしまう(同じ記事を2回聞くことになる)。流れ出してから確かめ直す
      P.goal = a.currentTime; P.goalTries = 0;
      if (pd.play) a.play().catch(() => {});
    }
  });
  a.addEventListener('timeupdate', tick);
  a.addEventListener('seeking', () => { P.last = null; });
  a.addEventListener('play', () => { P.ended = false; changed(); setPosition(); beat(true); });
  a.addEventListener('pause', () => { remember(true); changed(); setPosition(); beat(true); });
  a.addEventListener('ratechange', setPosition);
  a.addEventListener('ended', () => {
    if (a.src !== P.url) return;
    const last = P.segs[P.segs.length - 1];
    if (last) heard(last);
    // まだ届いていない・つないでいない記事があれば、そろった所で続きを流す
    if (last && (P.prep || P.dirty) && last.key !== P.list[P.list.length - 1].key) {
      P.waitAfter = last.key;
      if (P.dirty) rebuild();
    } else {
      P.ended = true;
      if (last && last.key === P.list[P.list.length - 1].key) forgetLast(); // 最後まで聞いた: 「続きから」は出さない
      // 締めの一言の声がまだサーバーに無いときは、端末の読み上げで言う
      if (last && P.closeKey && !P.segs.some((s) => s.post) && allTodayHeard()) { speak(CLOSING_TEXT); toast(CLOSING_TEXT); }
    }
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
    set('seekbackward', () => nudge(-5));
    set('seekforward', () => nudge(5));
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
// at が負なら、その記事の前の「切りかえの一言」から
function seekTo(key, at) {
  const seg = P.segs.find((s) => s.key === key);
  if (seg) { P.audio.currentTime = Math.max(0, seg.start + Math.max(-(seg.pre || 0), at || 0)) * (P.scale || 1); P.ended = false; }
}
function skip(dir) {
  const pos = where();
  if (!pos) return;
  if (dir > 0 && pos.at > pos.dur * 0.7) heard(pos); // ほとんど聞いてから次へ: 聞いた扱い
  // 「前の記事」はいつでも1つ前の記事の頭へ(いまの記事の頭に戻るだけにしない)。いちばん最初の記事なら、その頭へ
  const i = P.segs.findIndex((s) => s.key === pos.key) + dir;
  if (i >= 0 && i < P.segs.length) seekTo(P.segs[i].key, -(P.segs[i].pre || 0));
  else if (dir < 0) seekTo(pos.key, 0);
}
function nudge(sec) {
  const a = P.audio;
  if (a) a.currentTime = Math.max(0, Math.min((a.duration || 0) - 0.3, a.currentTime + sec));
}
function tick() {
  const a = P.audio;
  // 読み込み直しの途中(位置合わせ前)は、頭の位置を「いま」と取り違えないよう何もしない
  if (P.pending || !a.src.startsWith('blob:')) return;
  if (P.goal != null) {
    if (Math.abs(a.currentTime - P.goal) > 2 && P.goalTries++ < 3) { a.currentTime = P.goal; return; }
    P.goal = null;
  }
  const pos = where();
  if (!pos) return;
  markPassed();
  // 飛ばして締めの一言まで来たが、まだ聞いていない記事が残っているときは、一言を飛ばす
  const seg = P.segs.find((s) => s.key === pos.key);
  if (seg && seg.post && pos.at >= seg.dur && !a.paused && !allTodayHeard()) {
    const next = P.segs[P.segs.indexOf(seg) + 1];
    if (next) { seekTo(next.key, -next.pre); return; }
    if (isFinite(a.duration) && a.currentTime < a.duration - 0.3) { a.currentTime = a.duration - 0.1; return; }
  }
  if (pos.key !== P.cur) { P.cur = pos.key; setMeta(); changed(); }
  // 届いたのにまだつないでいない記事がある: 今の分が残り少なくなったらつなぐ(聞いている最中に何度も読み込み直さない)
  if (P.dirty && (!isFinite(a.duration) || a.duration - a.currentTime < 90)) rebuild();
  remember(false);
  beat(false);
  paintTime(pos);
}
// 聞き終えた記事を「読んだ」にする
function heard(e) {
  const it = store.item(e.kind, e.date, e.n);
  const v = loadPos(); // 途中の位置の印(「▶ 1:00まで聞いた」)は消す
  if (v.map[e.key]) { delete v.map[e.key]; savePos(v); }
  if (it && !store.isRead(it)) store.markRead(it);
}
// 流れて通り過ぎた記事(終わりの手前=85%の所か、最後の1.5秒を越えた)を聞いた扱いにする。
// 画面を消している間に処理が間引かれても、その間に流れた分はまとめて拾う。早送りで飛ばした分は数えない
function markPassed() {
  const a = P.audio;
  const t = a.currentTime / (P.scale || 1);
  const prev = P.last;
  P.last = { t, at: Date.now(), url: P.url };
  if (!prev || prev.url !== P.url || a.paused) return;
  const moved = t - prev.t;
  if (moved <= 0 || moved > (Date.now() - prev.at) / 1000 * (a.playbackRate || 1) + 3) return;
  for (const s of P.segs) {
    if ([s.start + s.dur * 0.85, s.start + s.dur - 1.5].some((m) => m > prev.t && m <= t)) heard(s);
  }
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

/* ---------- いま聞いている話をクラウドに知らせる ----------
   iPhone のロック画面・車の画面の「再生中」を押すと、同じ住所の別のアプリ(ひきがたり)が開いてしまう。
   そのとき、ひきがたり側で「いま聞いていた話を思考メモに保存」を出せるよう、今の記事とひとつ前の記事を置いておく。 */
const NOW = { at: 0, key: null, prev: null };
function beat(force) {
  const a = P.audio;
  if (!a || !P.cur) return;
  const t = Date.now();
  if (!force && P.cur === NOW.key && t - NOW.at < 30000) return;
  if (NOW.key && NOW.key !== P.cur) NOW.prev = NOW.key;
  NOW.at = t; NOW.key = P.cur;
  const pack = (key) => {
    const it = key && itemOfKey(key);
    if (!it) return null;
    const m = memoOf(it);
    return { key, kind: it.kind, name: NAME[it.kind], n: it.n, title: stripMarkup(it.data.title || ''), id: stableUuid(m.seed), body: m.body };
  };
  const data = { cur: pack(P.cur), prev: pack(NOW.prev), playing: !a.paused, tag: MEMO_TAG };
  store.rpc('asayomi_now_set', { p_data: data }, 8000).catch(() => { NOW.at = 0; });
}

/* ---------- どこまで聞いたか(この端末に残す) ---------- */
// last: 最後に聞いていた所 { key, at, t }。map: 記事ごとの途中の位置(秒)。途中で切れても、次はそこから聞ける
const POS = 'asayomi:listenPos';
function loadPos() {
  try { const v = JSON.parse(localStorage.getItem(POS) || 'null'); if (v && typeof v === 'object') return { last: v.last || null, map: v.map || {} }; } catch (e) { /* 読めない */ }
  return { last: null, map: {} };
}
function savePos(v) { try { localStorage.setItem(POS, JSON.stringify(v)); } catch (e) { /* 残せなくても流せる */ } }
let savedAt = 0;
function remember(now) {
  const a = P.audio;
  if (!a || P.pending || !a.src.startsWith('blob:')) return;
  if (!now && Date.now() - savedAt < 5000) return;
  const pos = where();
  if (!pos) return;
  savedAt = Date.now();
  const v = loadPos();
  const at = Math.min(pos.at, pos.dur);
  const it = store.item(pos.kind, pos.date, pos.n);
  // ほぼ聞き終えた記事は、途中の位置を消す
  if (at > pos.dur - 6 || (at >= pos.dur * 0.85 && it && store.isRead(it))) delete v.map[pos.key];
  else if (at > 3) v.map[pos.key] = Math.round(at);
  const keys = Object.keys(v.map);
  if (keys.length > 40) for (const k of keys.slice(0, keys.length - 40)) delete v.map[k];
  v.last = { key: pos.key, at: Math.round(at), dur: Math.round(pos.dur || 0), t: Date.now() };
  savePos(v);
}
// 画面を閉じる・別のアプリへ移る・電話で中断される、そのたびに位置を残す(5秒おきの保存だけだと、切れた直前の分が消える)
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') remember(true); });
window.addEventListener('pagehide', () => remember(true));
function forgetLast() { const v = loadPos(); v.last = null; savePos(v); }
const fmtAt = (s) => Math.floor(s / 60) + ':' + String(Math.round(s) % 60).padStart(2, '0');
/* ---------- つなぐ ---------- */
// 切りかえの一言(「続いては、学問のお話です」など)は種類が変わる所の前に、締めの一言(closing)は今日の分の終わりに入れる。サーバーに無ければ入れない
const BRIDGE = new Map(); // kind | 'closing' → { buf, dur }
let bridgesAsked = 0;
async function loadBridges() {
  if (Date.now() - bridgesAsked < 10 * 60e3 || BRIDGE.size === ORDER.length + 1) return;
  bridgesAsked = Date.now();
  const r = await call('bridges', {}, 15000);
  for (const [k, x] of Object.entries(r.items || {})) {
    if (BRIDGE.has(k) || !x || !x.url) continue;
    try { BRIDGE.set(k, { buf: await fetchMp3(x.url), dur: x.dur }); } catch (e) { /* 一言なしでも流せる */ }
  }
}
// 聞いている最中は、届いた分をすぐにはつながない(つなぐたびに読み込み直すので)。
// 再生していない・待っている・今の分が残り少ない、のどれかのときだけつなぐ。あとは tick が残り90秒でつなぐ
function soft() {
  const a = P.audio;
  const loaded = a && a.src.startsWith('blob:');
  if (!loaded || a.paused || P.waitAfter || (P.pending && P.pending.wait)) { rebuild(); return; }
  if (!isFinite(a.duration) || a.duration - a.currentTime < 90) rebuild(); else P.dirty = true;
}
function rebuild() {
  P.dirty = false;
  // 流す順に並べる。まだ届くかもしれない記事(用意の途中)の先はつながない: 抜けたまま次の種類へ飛ぶと、
  // 飛ばした記事が「もう通り過ぎた所」に入ってしまい、最後まで流れなくなる
  const anchor = (P.pending && P.pending.key) || P.cur;
  const ai = Math.max(0, P.list.findIndex((e) => e.key === anchor));
  const order = [];
  for (let i = 0; i < P.list.length; i++) {
    const e = P.list[i];
    if (P.parts.has(e.key)) order.push(e);
    else if (i > ai && P.prep) break;
  }
  const bufs = [];
  const segs = [];
  let t = 0;
  for (const e of order) {
    const prev = segs[segs.length - 1];
    const br = prev && prev.kind !== e.kind ? BRIDGE.get(e.kind) : null;
    if (br) { bufs.push(br.buf); t += br.dur; }
    const p = P.parts.get(e.key);
    bufs.push(p.buf);
    const seg = Object.assign({ start: t, dur: p.dur, pre: br ? br.dur : 0, post: 0 }, e);
    segs.push(seg);
    t += p.dur;
    const end = e.key === P.closeKey ? BRIDGE.get('closing') : null;
    if (end) { bufs.push(end.buf); seg.post = end.dur; t += end.dur; }
  }
  const built = segs.map((s) => (s.pre ? '+' : '') + s.key + (s.post ? '$' : '')).join(',');
  if (!order.length || built === P.built) return;
  const a = audio();
  const loaded = a.src.startsWith('blob:');
  // 読み込み直しの途中(まだ位置合わせしていない)なら、そのとき決めた位置を引き継ぐ。
  // ここで今の位置を読むと 0 秒(=頭)になり、同じ記事を頭から2回流してしまう
  const held = P.pending && !P.pending.wait ? P.pending : null;
  const pos = held ? { key: held.key, at: held.at } : loaded ? where() : null;
  const playing = held ? held.play : loaded && !a.paused;
  P.segs = segs;
  P.total = t;
  P.built = built;
  const old = P.url;
  P.url = URL.createObjectURL(new Blob(bufs, { type: 'audio/mpeg' }));
  if (P.waitAfter) {
    // 最後まで聞き終えて待っていた: できた次の記事から流す(種類が変わるなら切りかえの一言から)
    const i = segs.findIndex((s) => s.key === P.waitAfter);
    const nx = segs[i + 1];
    if (nx) { P.pending = { key: nx.key, at: -nx.pre, play: true }; P.waitAfter = null; a.src = P.url; }
  } else if (P.pending && P.pending.wait) {
    // 押した記事の声ができるのを待っていた
    if (segs.some((s) => s.key === P.pending.key)) { P.pending.wait = false; a.src = P.url; }
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
  // つないで1本にするので、どの記事もサーバーの mp3 と同じ 44.1kHz にそろえる(形のちがう mp3 が混ざると途中で壊れる)
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
  const enc = new lj.Mp3Encoder(1, rate, OUT_KBPS);
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
// 8日より前の音声を端末から片づける(サーバーに置いておく日数と同じ)
async function sweepCache() {
  try {
    const cache = await caches.open(AUDIO_CACHE);
    const keep = new Date(Date.now() + 9 * 3600e3 - 8 * 864e5).toISOString().slice(0, 10);
    for (const req of await cache.keys()) {
      const m = /\/(?:news|trivia)\/(\d{4}-\d{2}-\d{2})\//.exec(req.url);
      if (m && m[1] < keep) await cache.delete(req);
    }
  } catch (e) { /* 片づけられなくても困らない */ }
}

const ERR = {
  quota: 'Gemini の無料枠がいっぱいです。少し時間をおくと、また作れます',
  cap: '今日の読み上げの回数の上限に達しました',
  key: 'Gemini のキーが使えないようです。登録し直してください',
  nokey: 'Gemini のキーがまだ登録されていません',
  net: '通信できませんでした',
  ai: '声を作れませんでした',
};

// 流れを決め直す(同じ流れなら何もしない)。声の控え(parts)は流れが変わっても使い回す
function setFlow(list) {
  const sig = sigOf(list);
  if (sig === P.sig) return;
  P.sig = sig;
  P.list = list;
  P.groups = [];
  for (const e of list) if (!P.groups.some((g) => g.kind === e.kind && g.date === e.date)) P.groups.push({ kind: e.kind, date: e.date });
  P.segs = []; P.total = 0; P.built = ''; P.scale = 1; P.dirty = false; P.goal = null; P.last = null;
  P.error = ''; P.progress = ''; P.stopped = false; P.waitAfter = null; P.pending = null; P.make = false; P.ended = false;
  P.closeKey = closingKeyOf(list);
  P.cur = list.length ? list[0].key : null;
}

export function prepare(list, make) {
  if (!list || !list.length) return Promise.resolve();
  if (sigOf(list) !== P.sig) {
    // 聞いている流れがある間は、一覧を開いただけでは切り替えない(止めた所を失わないように)
    if ((P.audio && !P.audio.paused) || (!make && P.shown)) return Promise.resolve();
    setFlow(list);
  }
  if (make && !P.make) {
    P.make = true; P.stopped = false;
    if (P.prep) P.again = true; // 作らない約束で動いている途中: 終わったらもう一度、今度は作る
  }
  { const sig = P.sig; loadBridges().then(() => { if (P.sig === sig) soft(); }); }
  // ぜんぶ声がそろっていれば、聞きに行くまでもない(一覧を描き直すたびに通信しないように)。
  // 見ているだけのときも、1分以内に確かめたばかりなら聞きに行かない
  if (!P.prep && P.list.every((e) => P.parts.has(e.key))) return Promise.resolve();
  if (!P.prep && !P.make && P.checked === P.sig && Date.now() - P.checkedAt < 60e3) return Promise.resolve();
  if (!P.prep) {
    const sig = P.sig;
    P.prep = runPrepare(sig).finally(() => {
      P.prep = null;
      // 用意が終わった: 作れなかった記事があれば、それを飛ばして残りをつなぐ
      if (P.sig === sig) soft();
      // 途中で「作ってよい」になった・流れが変わった: いまの流れでもう一度
      if (P.again || P.sig !== sig) { P.again = false; prepare(P.list, P.make); }
      changed();
    });
  }
  return P.prep;
}
async function runPrepare(sig) {
  P.error = '';
  P.checked = sig; P.checkedAt = Date.now();
  const alive = () => P.sig === sig;
  for (let round = 0; round < 40 && alive(); round++) { // サーバーが作っている分を待つのは5分ほどまで
    const byKey = new Map();
    for (const g of P.groups) {
      const st = await call('status', { kind: g.kind, date: g.date });
      if (!alive()) return;
      if (st.code) { P.error = ERR[st.code] || st.error || ERR.net; return; }
      P.ready = !!st.ready;
      for (const x of st.items || []) { byKey.set(keyOf(g.kind, g.date, x.n), x); if (x.url) { P.avail.add(keyOf(g.kind, g.date, x.n)); P.durs.set(keyOf(g.kind, g.date, x.n), x.dur); } }
    }
    changed();
    // 置いてある声を取ってくる。聞くボタンを押す前(一覧を見ているだけ)は、それぞれの1本目だけ先に取っておく(通信を使いすぎない)
    const firsts = new Set(P.groups.map((g) => (P.list.find((e) => e.kind === g.kind && e.date === g.date) || {}).key));
    // 聞きはじめた記事から順に(途中の記事から聞くとき、その前の記事を待たなくていいように)
    const from = Math.max(0, P.list.findIndex((e) => e.key === ((P.pending && P.pending.key) || P.cur)));
    const order = P.list.slice(from).concat(P.list.slice(0, from));
    for (const e of order) {
      const x = byKey.get(e.key);
      if (x && x.url && !P.parts.has(e.key) && (P.make || firsts.has(e.key))) {
        try { P.parts.set(e.key, { buf: await fetchMp3(x.url), dur: x.dur }); if (alive()) soft(); } catch (err) { /* 次の回で取り直す */ }
      }
      if (!alive()) return;
    }
    const missing = order.filter((e) => !P.parts.has(e.key));
    if (!missing.length) { P.progress = ''; rebuild(); sweepCache(); return; }
    if (!P.ready || P.stopped || !P.make) return;
    let waiting = false;
    for (const e of missing) {
      if (!alive()) return;
      const x = byKey.get(e.key);
      if (x && (x.url || x.busy)) { waiting = true; continue; } // 取り直しそこねた・サーバーが作っている最中
      const left = P.list.filter((y) => !P.avail.has(y.key)).length;
      P.progress = '声を用意しています(あと' + left + '本)';
      changed();
      const r = await call('make', { kind: e.kind, date: e.date, n: e.n }, 150000);
      // サーバーが作って置いた: 取ってきて流れに足す(途中で流れが変わっても、作った声はサーバーに残っている)
      if (r.url) {
        P.avail.add(e.key); P.durs.set(e.key, r.dur);
        try { P.parts.set(e.key, { buf: await fetchMp3(r.url), dur: r.dur }); if (alive()) soft(); } catch (err) { waiting = true; }
        if (!alive()) return;
        continue;
      }
      if (r.busy) { if (!alive()) return; waiting = true; continue; }
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
        if (alive()) soft();
        const put = await call('put', { kind: e.kind, date: e.date, n: e.n, dur: mp3.dur, model: r.model, mp3: await b64Of(mp3.blob) }, 60000);
        if (put.url) {
          P.avail.add(e.key); P.durs.set(e.key, mp3.dur);
          try { const c = await caches.open(AUDIO_CACHE); await c.put(put.url, new Response(mp3.blob, { headers: { 'Content-Type': 'audio/mpeg' } })); } catch (err) { /* 控えなしでも流せる */ }
        }
      } catch (err) {
        if (!alive()) return;
        P.error = 'この端末で音声にできませんでした';
        P.progress = '';
        return;
      }
    }
    if (!waiting) continue;
    P.progress = '声を用意しています(できしだい流します)';
    changed();
    await new Promise((r) => setTimeout(r, 8000));
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

// kind の date の n 本目から流す(n が無ければまだの記事から。ぜんぶ聞いていれば最初から)。
// 続けてもう一方も流すかは設定どおり(ボタンを押したその場で呼ぶこと)。at を渡すと、その記事の at 秒目から
export function listen(kind, date, n, at) {
  const all = entriesOf(groupsFor(kind, date, listenBoth()));
  if (!all.length) { toast('聞ける記事がありません'); return; }
  let key = n ? keyOf(kind, date, n) : null;
  if (!key) { const first = all.find(unreadEntry); if (!first) { play(all, all[0].key, 0); return; } key = first.key; at = loadPos().map[key]; }
  play(onward(all, key), key, at);
}
// 決まった並び list の key の記事から流す(ボタンを押したその場で呼ぶこと)
export function play(list, key, at) {
  const a = audio();
  if (!list.length) { toast('聞ける記事がありません'); return; }
  primeSpeech();
  if (sigOf(list) !== P.sig) { if (!a.paused) a.pause(); setFlow(list); }
  else P.closeKey = closingKeyOf(list);
  at = at > 0 ? Math.max(0, at - 3) : 0; // 続きからは、切れた所の少し前から
  P.cur = key;
  P.waitAfter = null; P.ended = false; P.last = null;
  showBar();
  setMeta();
  if (P.segs.some((s) => s.key === key) && P.url) {
    if (a.src === P.url && !P.pending) { seekTo(key, at); a.play().catch(() => {}); }
    else { P.pending = { key, at, play: true }; a.src = P.url; a.play().catch(() => {}); }
  } else {
    // まだ声ができていない: 無音を流して許可だけ取り、できたら流す
    P.pending = { key, at, play: true, wait: true };
    a.src = silentUrl();
    a.play().catch(() => {});
  }
  prepare(list, true).then(() => { if (P.ready === false) openSetup(() => prepare(P.list, true)); });
  if (list.every((e) => P.parts.has(e.key))) soft(); // 声がぜんぶ手元にある: すぐつなぐ
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
export const currentKey = () => (P.shown ? P.cur : null);
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
      btn('', '前の記事', 'prev', () => skip(-1)),
      btn('', '5秒戻る', 'back5', () => nudge(-5)),
      el.pp,
      btn('', '5秒進む', 'fwd5', () => nudge(5)),
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
  el.num.textContent = e ? NAME[e.kind] + ' ' + e.n + '/' + store.itemsOf(e.kind, e.date).length : '';
  P.bar.classList.toggle('tv', !!e && e.kind !== 'news');
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
  else if (P.ended) sub = P.segs.length < P.list.length ? '用意できた' + P.segs.length + '本を聞き終えました' + (P.error ? '(' + P.error + ')' : '') : P.closeKey && allTodayHeard() ? '今日の分はぜんぶ聞きました。' + CLOSING_TEXT : 'ぜんぶ聞きました(' + P.list.length + '本)。▶でもう一度';
  else if (pos) sub = fmt(Math.min(pos.at, pos.dur)) + ' / ' + fmt(pos.dur) + (P.progress ? '　' + P.progress : P.error ? '　' + P.error : '');
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
      toast('登録しました。声を用意します');
      close();
      if (after) after(); else if (P.list.length) prepare(P.list, true);
    };
    sheet.append(
      h('h3', null, '読み上げの準備'),
      h('p', { class: 'sd' }, 'ニュースと雑学の読み上げと、聞きながらの質問への答えには、Google の Gemini(無料枠)を使います。最初に1回だけ、Gemini のキーを登録してください。キーはあさよみのサーバーにだけ置くので、ほかの端末では登録しなくても使えます。毎朝の配信のあとは、サーバーが声を先に作っておきます。'));
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
const askId = (kind, date, n) => 'ask:' + ({ trivia: 't', manner: 'm', study: 's' }[kind] || 'n') + ':' + date + ':' + n + ':';
export function asksOf(kind, date, n) {
  const out = [];
  store.st.each(askId(kind, date, n), (id, d) => { if (d && d.q) out.push(d); });
  return out.sort((x, y) => (x.at < y.at ? -1 : 1));
}
// いま聞いていたあたりの段落(読み上げの順に並べ、文字数の割合で当てる)
function nearText(it, frac) {
  const d = it.data;
  const paras = [d.title];
  if (it.kind !== 'news') {
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
      log, ans, mic, h('div', { class: 'krow' }, ta, sendBtn));
  }, () => {
    if (rec) { try { rec.abort(); } catch (e) { /* もう止まっている */ } rec = null; }
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    if (resume && P.audio && P.audio.src.startsWith('blob:')) P.audio.play().catch(() => {});
  });
}

/* ---------- 一覧・記事に置く入口 ---------- */
// 一覧の上の「まとめて聞く」。聞いた・読んだ分があれば、まだの記事から始まる。下の小さなボタンで「続けてもう一方も」を切りかえる
export function listenCard(kind, date) {
  const label = h('b');
  const sub = h('small');
  const card = h('button', { class: 'lcard', type: 'button' },
    h('span', { class: 'li' }, icon('ear', 24)),
    h('span', { class: 'lt' }, label, sub),
    h('span', { class: 'go' }, icon('play', 18)));
  const chip = h('button', { class: 'lchip', type: 'button', role: 'switch' });
  const again = h('button', { class: 'lchip', type: 'button', hidden: true }, '↺ 最初から全部聞く');
  const isLatest = (list) => list.every((e) => e.date === store.latest(e.kind));
  // いま押したら流れる並び
  const flow = () => {
    const all = entriesOf(groupsFor(kind, date, listenBoth()));
    const left = all.filter(unreadEntry);
    return { all, left, list: left.length ? onward(all, left[0].key) : all };
  };
  card.addEventListener('click', () => {
    const f = flow();
    const first = f.left[0] || f.all[0];
    if (first) play(f.list, first.key, f.left.length ? loadPos().map[first.key] : 0);
  });
  again.addEventListener('click', () => { const f = flow(); if (f.all.length) play(f.all, f.all[0].key, 0); });
  chip.addEventListener('click', () => {
    store.setPref({ listenBoth: !listenBoth() });
    const f = flow();
    prepare(f.list, isLatest(f.list));
    paintCard();
  });
  const paintCard = () => {
    const gs = groupsFor(kind, date, listenBoth());
    const f = flow();
    const partial = f.left.length > 0 && f.left.length < f.all.length;
    if (!f.left.length) label.textContent = '✓ ぜんぶ聞きました。もう一度聞く';
    else if (partial) label.textContent = '続きから聞く(' + NAME[f.left[0].kind] + f.left[0].n + '本目〜・あと' + f.left.length + '本)';
    else label.textContent = gs.map((g) => NAME[g.kind] + store.itemsOf(g.kind, g.date).length + '本').join(' → ') + 'を聞く';
    again.hidden = !partial;
    const both = listenBoth();
    chip.setAttribute('aria-checked', String(both));
    const more = rest(kind).filter((k) => store.latest(k));
    chip.textContent = (both ? '✓ ' : '') + '続けて' + more.map((k) => NAME[k]).join('・') + 'も';
    chip.hidden = !more.length;
    const target = f.left.length ? f.left : f.all;
    const mine = P.sig === sigOf(f.list);
    const ready = target.filter((e) => P.avail.has(e.key));
    const sec = ready.reduce((n, e) => n + (P.durs.get(e.key) || 0), 0);
    let t = '画面を消しても流れます・倍速もOK';
    if (mine && ready.length && ready.length < target.length) t = P.progress || '声の用意 ' + ready.length + '/' + target.length + '本(残りは聞きはじめると作ります)';
    if (ready.length && ready.length === target.length && sec) t = '約' + Math.max(1, Math.round(sec / 60 / speed())) + '分(' + speed() + '×)・すぐ流せます・画面を消しても流れます';
    if (mine && P.error && !P.prep) t = P.error;
    if (mine && P.ready === false) t = 'はじめに Gemini のキーを1回だけ登録します';
    sub.textContent = t;
  };
  const off = onListen(() => { if (!card.isConnected) { off(); return; } paintCard(); });
  paintCard();
  const f = flow();
  prepare(f.list, isLatest(f.list));
  return h('div', { class: 'lwrap' }, card, h('div', { class: 'lchips' }, again, chip));
}
// どの一覧の上にも出す「続きから」。聞きかけの記事があればその位置から、聞き終えていれば次のまだの記事から
export function resumeBanner() {
  const box = h('div', { class: 'rbn', hidden: true });
  const target = () => {
    const { last } = loadPos();
    if (!last || Date.now() - last.t > 7 * 864e5) return null;
    const [kind, date, num] = last.key.split(':');
    const it = store.item(kind, date, Number(num));
    if (!it) return null;
    if (!store.isRead(it)) return { kind, date, n: Number(num), at: last.at, dur: last.dur || P.durs.get(last.key) || 0, last };
    const all = entriesOf(groupsFor(kind, date, listenBoth()));
    const i = all.findIndex((e) => e.key === last.key);
    const next = all.slice(i + 1).concat(all.slice(0, i + 1)).find(unreadEntry);
    if (!next) return null;
    return { kind: next.kind, date: next.date, n: next.n, at: loadPos().map[next.key] || 0, dur: P.durs.get(next.key) || 0, last, next: true };
  };
  const paintBanner = () => {
    const r = playingNow() ? null : target();
    if (!r) { box.hidden = true; return; }
    const it = store.item(r.kind, r.date, r.n);
    const items = store.itemsOf(r.kind, r.date);
    const ago = Math.round((Date.now() - r.last.t) / 60000);
    const when = ago < 1 ? 'さっき' : ago < 60 ? ago + '分前' : ago < 1440 ? Math.round(ago / 60) + '時間前' : Math.round(ago / 1440) + '日前';
    const note = r.at ? '🔖 ここまで聞いた ' + fmtAt(r.at) + (r.dur ? ' / ' + fmtAt(r.dur) : '')
      : r.next ? '前の記事までは聞き終わり。この記事から' : 'この記事のはじめから';
    clear(box).append(
      h('button', { class: 'rbn-b', type: 'button', onclick: () => listen(r.kind, r.date, r.n, r.at) },
        h('span', { class: 'rbn-i' }, icon('play', 20)),
        h('span', { class: 'rbn-t' },
          h('small', null, '続きから聞く・' + when + 'まで聞いていました'),
          h('b', null, NAME[r.kind] + ' ' + r.n + '/' + items.length + '本目　' + stripMarkup(it.data.title || '')),
          r.at ? h('span', { class: 'rbn-p' }, h('i', { style: { width: (r.dur ? Math.min(100, r.at / r.dur * 100) : 0) + '%' } })) : null,
          h('em', null, note + '　(' + mdShort(r.date) + ')'))),
      h('button', { class: 'rbn-x', type: 'button', 'aria-label': '続きからを消す', onclick: () => { forgetLast(); box.hidden = true; } }, icon('x', 14)));
    box.hidden = false;
  };
  const off = onListen(() => { if (!box.isConnected && box.dataset.on) { off(); return; } paintBanner(); });
  setTimeout(() => { box.dataset.on = '1'; }, 0);
  paintBanner();
  return box;
}
const mdShort = (d) => Number(d.slice(5, 7)) + '/' + Number(d.slice(8, 10));
// 一覧の各記事に出す「▶ 2:31まで聞いた」の印
export function listenMark(it) {
  const at = loadPos().map[keyOf(it.kind, it.date, it.n)];
  return at > 3 ? h('span', { class: 'readmark lpart' }, icon('play', 11), fmtAt(at) + 'まで聞いた') : null;
}
export function listenButton(it) {
  const at = loadPos().map[keyOf(it.kind, it.date, it.n)];
  if (at > 3) {
    return h('button', { class: 'lbtn', type: 'button', onclick: () => listen(it.kind, it.date, it.n, at) }, icon('play', 16), '続きから聞く(' + fmtAt(at) + 'から)');
  }
  return h('button', { class: 'lbtn', type: 'button', onclick: () => listen(it.kind, it.date, it.n) }, icon('play', 16), 'この記事から聞く');
}
export function askLog(it) {
  const list = asksOf(it.kind, it.date, it.n);
  const box = h('div', { class: 'asklog' + (it.kind === 'news' ? ' terms' : '') }, h('div', { class: 'tl' }, list.length ? '聞きながら質問したこと' : 'わからないことを聞く'));
  for (const x of list) box.append(h('div', { class: 'qa-i' }, h('b', null, x.q), h('p', null, x.a)));
  box.append(h('button', { class: 'term qbtn', type: 'button', onclick: () => openAsk({ kind: it.kind, date: it.date, n: it.n }) }, icon('ask', 18), 'この' + NAME[it.kind] + 'について質問する'));
  return box;
}

/* ---------- 設定画面の「ニュースの読み上げ」 ---------- */
export async function voiceStatus() {
  const gs = ORDER.map((k) => ({ kind: k, date: store.latest(k) })).filter((g) => g.date);
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
