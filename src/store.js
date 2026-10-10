// 保存と同期。
//  - 記事(中身)   : クラウド(Supabase)が正。端末の IndexedDB に写しを持ち、開けばすぐ出る・圏外でも読める。
//  - 使った記録   : 既読・保存・復習カード・設定。端末で書いて1件ずつクラウドへ送り、開いたら自動で戻す。
//                   新しい方が勝つ。クラウドが空でも端末の記録は消さず、足りない分を送り直す。
import { SB_URL, SB_KEY, INTERVALS, MASTERED } from './config.js';
import { todayJST, addDays, norm, stripMarkup } from './util.js';

const HEAD = { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json' };

export async function rpc(name, body, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs || 20000);
  try {
    const res = await fetch(SB_URL + '/rest/v1/rpc/' + name, {
      method: 'POST', headers: HEAD, body: JSON.stringify(body || {}), signal: ctl.signal,
    });
    if (!res.ok) {
      let msg = '';
      try { msg = (await res.json()).message || ''; } catch (e) { /* 本文なし */ }
      throw new Error(msg || 'HTTP ' + res.status);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/* ---------- 知らせ ---------- */
const subs = {};
export function on(ev, fn) { (subs[ev] || (subs[ev] = [])).push(fn); }
export function off(ev, fn) { const a = subs[ev] || []; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); }
function emit(ev, arg) {
  for (const fn of (subs[ev] || []).slice()) {
    try { fn(arg); } catch (e) { console.error(e); }
  }
}

/* ---------- IndexedDB(使えなければメモリだけで動く) ---------- */
const STORES = ['items', 'days', 'svgs', 'state', 'outbox', 'meta'];
let db = null;
function openDb() {
  return new Promise((resolve) => {
    let req;
    try { req = indexedDB.open('asayomi', 1); } catch (e) { resolve(null); return; }
    req.onupgradeneeded = () => {
      for (const s of STORES) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s);
    };
    req.onsuccess = () => {
      req.result.onversionchange = () => { req.result.close(); db = null; };
      resolve(req.result);
    };
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
}
function readAll(store) {
  return new Promise((resolve) => {
    if (!db) { resolve([]); return; }
    try {
      const os = db.transaction(store).objectStore(store);
      const vals = os.getAll();
      const keys = os.getAllKeys();
      os.transaction.oncomplete = () => resolve(keys.result.map((k, i) => [k, vals.result[i]]));
      os.transaction.onerror = () => resolve([]);
      os.transaction.onabort = () => resolve([]);
    } catch (e) { resolve([]); }
  });
}
function write(stores, fn) {
  return new Promise((resolve) => {
    if (!db) { resolve(false); return; }
    try {
      const t = db.transaction(stores, 'readwrite');
      fn(t);
      t.oncomplete = () => resolve(true);
      t.onerror = () => resolve(false);
      t.onabort = () => resolve(false);
    } catch (e) { resolve(false); }
  });
}

export const S = {
  items: new Map(),   // "kind|date|n" → { kind, date, n, data, art, rev }
  days: new Map(),    // "kind|date"   → { kind, date, data, rev }
  svgs: new Map(),    // "kind|date|n" → イラスト(SVGの文字列)
  state: new Map(),   // id → { id, data, updatedAt, deleted }
  outbox: new Map(),  // id → 送っていない更新の updatedAt
  meta: {},
  status: 'idle',     // idle | syncing | offline | error
};
const ik = (kind, date, n) => kind + '|' + date + '|' + n;
const dk = (kind, date) => kind + '|' + date;
export const keyOf = (it) => ik(it.kind, it.date, it.n);

function setMeta(k, v) {
  S.meta[k] = v;
  return write(['meta'], (t) => t.objectStore('meta').put(v, k));
}
function setStatus(s) {
  if (S.status !== s) { S.status = s; emit('status', s); }
}

export async function init() {
  db = await openDb();
  const [items, days, state, outbox, meta] = await Promise.all(['items', 'days', 'state', 'outbox', 'meta'].map(readAll));
  for (const [k, v] of items) S.items.set(k, v);
  for (const [k, v] of days) S.days.set(k, v);
  for (const [k, v] of state) S.state.set(k, v);
  for (const [k, v] of outbox) S.outbox.set(k, v);
  for (const [k, v] of meta) S.meta[k] = v;
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) { /* 任意 */ }
}

/* =====================================================================
   記事(中身)
   ===================================================================== */
let cache = {};
function invalidate() { cache = {}; }

function applyContent(days, items, svgs) {
  let changed = false;
  const dropSvg = [];
  for (const d of days || []) {
    const k = dk(d.kind, d.date);
    const cur = S.days.get(k);
    if (!cur || cur.rev !== d.rev) { S.days.set(k, d); changed = true; }
  }
  for (const it of items || []) {
    const k = ik(it.kind, it.date, it.n);
    const cur = S.items.get(k);
    if (!cur || cur.rev !== it.rev) {
      S.items.set(k, it);
      if (cur && !(svgs && svgs.has(k))) { S.svgs.delete(k); dropSvg.push(k); } // 描き直されたかもしれないので取り直す
      changed = true;
    }
  }
  if (svgs) for (const [k, v] of svgs) S.svgs.set(k, v);
  write(['days', 'items', 'svgs'], (t) => {
    for (const d of days || []) t.objectStore('days').put(d, dk(d.kind, d.date));
    for (const it of items || []) t.objectStore('items').put(it, ik(it.kind, it.date, it.n));
    for (const k of dropSvg) t.objectStore('svgs').delete(k);
    if (svgs) for (const [k, v] of svgs) t.objectStore('svgs').put(v, k);
  });
  if (changed) invalidate();
  return changed;
}

async function wipeContent() {
  S.items.clear(); S.days.clear(); S.svgs.clear();
  invalidate();
  await write(['items', 'days', 'svgs'], (t) => { for (const s of ['items', 'days', 'svgs']) t.objectStore(s).clear(); });
  await setMeta('rev', 0);
}

let pulling = null;
// クラウドから、前回より後に変わった分だけ取ってくる
export function pull() {
  if (!pulling) pulling = doPull().finally(() => { pulling = null; });
  return pulling;
}
async function doPull() {
  setStatus('syncing');
  let changed = false;
  try {
    for (let guard = 0; guard < 60; guard++) {
      const since = S.meta.rev || 0;
      const res = await rpc('asayomi_pull', { p_since: since, p_limit: 200 });
      const reset = (S.meta.epoch && res.epoch && res.epoch !== S.meta.epoch) || (res.full && since > 0);
      if (res.epoch && res.epoch !== S.meta.epoch) await setMeta('epoch', res.epoch);
      if (reset) { await wipeContent(); changed = true; continue; }
      if (applyContent(res.days, res.items)) changed = true;
      await setMeta('rev', res.rev || 0);
      if (!res.more) break;
    }
    await setMeta('pulledAt', Date.now());
    setStatus('idle');
  } catch (e) {
    setStatus(navigator.onLine === false ? 'offline' : 'error');
  }
  if (changed) emit('content');
  return changed;
}

// まだ何も無い端末で、最新の1日分だけ先に取って出す
export async function quick(kind) {
  try {
    const res = await rpc('asayomi_day', { p_kind: kind });
    if (res) { takeDay(res); emit('content'); return true; }
  } catch (e) { /* あとで pull が取り直す */ }
  return false;
}
// リンクから直接開いたときなど、まだ端末に無い日を1日分だけ取る
export async function fetchDay(kind, date) {
  try {
    const res = await rpc('asayomi_day', { p_kind: kind, p_date: date });
    if (res) { takeDay(res); emit('content'); return true; }
  } catch (e) { /* 圏外 */ }
  return false;
}
function takeDay(res) {
  const svgs = new Map();
  const items = [];
  for (const r of res.items || []) {
    items.push({ kind: res.kind, date: res.date, n: r.n, data: r.data, art: !!r.svg, rev: r.rev });
    if (r.svg) svgs.set(ik(res.kind, res.date, r.n), r.svg);
  }
  applyContent([{ kind: res.kind, date: res.date, data: res.day, rev: res.rev }], items, svgs);
}

// その日のイラストを使える状態にする(メモリ → 端末 → クラウドの順に探す)
export async function ensureArt(kind, date) {
  const need = itemsOf(kind, date).filter((it) => it.art && !S.svgs.has(keyOf(it)));
  if (!need.length) return;
  if (db) {
    await new Promise((resolve) => {
      try {
        const t = db.transaction('svgs');
        for (const it of need) {
          const k = keyOf(it);
          const r = t.objectStore('svgs').get(k);
          r.onsuccess = () => { if (r.result != null) S.svgs.set(k, r.result); };
        }
        t.oncomplete = resolve; t.onerror = resolve; t.onabort = resolve;
      } catch (e) { resolve(); }
    });
  }
  if (!need.some((it) => !S.svgs.has(keyOf(it)))) return;
  try {
    const res = await rpc('asayomi_day', { p_kind: kind, p_date: date });
    if (res) takeDay(res);
  } catch (e) { /* 圏外: 代わりの絵で出す */ }
}
export function svgOf(it) { return S.svgs.get(keyOf(it)) || null; }

function groups() {
  if (!cache.g) {
    const g = new Map();
    for (const it of S.items.values()) {
      const k = dk(it.kind, it.date);
      let a = g.get(k);
      if (!a) g.set(k, (a = []));
      a.push(it);
    }
    for (const a of g.values()) a.sort((x, y) => x.n - y.n);
    cache.g = g;
  }
  return cache.g;
}
export function itemsOf(kind, date) { return groups().get(dk(kind, date)) || []; }
export function dayOf(kind, date) { const d = S.days.get(dk(kind, date)); return d ? d.data || {} : null; }
export function item(kind, date, n) { return S.items.get(ik(kind, date, n)) || null; }
export function dates(kind) {
  const key = 'dates:' + kind;
  if (!cache[key]) {
    const a = [];
    for (const d of S.days.values()) if (d.kind === kind && itemsOf(kind, d.date).length) a.push(d.date);
    cache[key] = a.sort().reverse();
  }
  return cache[key];
}
export function latest(kind) { return dates(kind)[0] || null; }
// 記事の要点を1文で。gist が無い以前の配信分は、リードか本文の最初の1文で代える
export function briefOf(it) {
  const d = it.data;
  if (d.gist) return d.gist;
  if (d.lede) return stripMarkup(d.lede);
  const s = (d.secs || d.sections || [])[0];
  const p = Array.isArray(s) ? s[1] : s && (Array.isArray(s.p) ? s.p[0] : s.p);
  const t = stripMarkup(p || '');
  const i = t.indexOf('。');
  return i > 0 ? t.slice(0, i + 1) : t.slice(0, 80);
}
export function allItems(kind) {
  const key = 'all:' + kind;
  if (!cache[key]) {
    cache[key] = Array.from(S.items.values()).filter((it) => it.kind === kind)
      .sort((a, b) => (a.date === b.date ? a.n - b.n : a.date < b.date ? 1 : -1));
  }
  return cache[key];
}

// 用語帳: ニュースに出てきた用語を、言葉ごとにまとめる
export function terms() {
  if (!cache.terms) {
    const m = new Map();
    for (const it of allItems('news')) {
      for (const t of Array.isArray(it.data.terms) ? it.data.terms : []) {
        const name = Array.isArray(t) ? t[0] : t && t.t;
        const desc = Array.isArray(t) ? t[1] : t && t.d;
        if (!name || !desc) continue;
        const k = norm(name);
        let e = m.get(k);
        if (!e) m.set(k, (e = { key: k, term: name, desc, last: it.date, uses: [] })); // 新しい日付から回るので最初が最新
        e.uses.push({ date: it.date, n: it.n });
      }
    }
    cache.terms = m;
  }
  return cache.terms;
}
// 流れ: 同じ話題(thread)のニュースを日付をまたいでつなぐ
export function threads() {
  if (!cache.threads) {
    const m = new Map();
    for (const it of allItems('news')) {
      const name = it.data.thread;
      if (!name) continue;
      let e = m.get(name);
      if (!e) m.set(name, (e = { name, items: [], last: it.date, cat: it.data.cat }));
      e.items.push(it);
    }
    cache.threads = m;
  }
  return cache.threads;
}
// 検索用のひとまとめの文
export function searchIndex() {
  if (!cache.search) {
    const out = [];
    const body = (d) => {
      const a = [];
      for (const s of d.sections || d.secs || []) {
        if (Array.isArray(s)) a.push(s[0], s[1]);
        else if (s) a.push(s.h, Array.isArray(s.p) ? s.p.join(' ') : s.p);
      }
      return a.filter(Boolean).join(' ');
    };
    for (const kind of ['trivia', 'news']) {
      for (const it of allItems(kind)) {
        const d = it.data;
        const head = [d.title, d.keyword, d.gist, d.thread].filter(Boolean).join(' ');
        const rest = stripMarkup([d.lede, body(d), d.talk, d.extra && d.extra.text, d.life, d.history].filter(Boolean).join(' '));
        out.push({ type: kind === 'trivia' ? 't' : 'n', it, head: norm(head), rest: norm(rest), raw: rest });
      }
    }
    for (const e of terms().values()) out.push({ type: 'w', term: e, head: norm(e.term), rest: norm(e.desc), raw: e.desc });
    cache.search = out;
  }
  return cache.search;
}

/* =====================================================================
   使った記録(既読・保存・復習カード・設定)
   ===================================================================== */
function nowIso(prev) {
  let t = Date.now();
  if (prev) { const p = Date.parse(prev); if (p >= t) t = p + 1; } // 時計が戻っても必ず新しくする
  return new Date(t).toISOString();
}
function put(rec) {
  S.state.set(rec.id, rec);
  S.outbox.set(rec.id, rec.updatedAt);
  write(['state', 'outbox'], (t) => {
    t.objectStore('state').put(rec, rec.id);
    t.objectStore('outbox').put(rec.updatedAt, rec.id);
  });
  emit('state', rec.id);
  scheduleStateSync(1500);
}
export const st = {
  get(id) { const r = S.state.get(id); return r && !r.deleted ? r.data : undefined; },
  has(id) { const r = S.state.get(id); return !!(r && !r.deleted); },
  set(id, data) { const cur = S.state.get(id); put({ id, data, updatedAt: nowIso(cur && cur.updatedAt), deleted: false }); },
  del(id) { const cur = S.state.get(id); if (cur && !cur.deleted) put({ id, data: null, updatedAt: nowIso(cur.updatedAt), deleted: true }); },
  each(prefix, fn) { for (const [id, r] of S.state) if (!r.deleted && id.indexOf(prefix) === 0) fn(id, r.data); },
  count(prefix) { let n = 0; for (const [id, r] of S.state) if (!r.deleted && id.indexOf(prefix) === 0) n++; return n; },
};

function deviceId() {
  try {
    let v = localStorage.getItem('asayomi:device');
    if (!v) {
      v = (/iPhone|iPad/.test(navigator.userAgent) ? 'iphone' : /Android/.test(navigator.userAgent) ? 'android' : 'pc') +
        '-' + Math.random().toString(36).slice(2, 8);
      localStorage.setItem('asayomi:device', v);
    }
    return v;
  } catch (e) { return 'unknown'; }
}

let stTimer = 0;
let stBusy = null;
function scheduleStateSync(ms) {
  clearTimeout(stTimer);
  stTimer = setTimeout(() => syncState(), ms);
}
export function syncState(opts) {
  if (!stBusy) stBusy = doSyncState(opts || {}).finally(() => { stBusy = null; });
  return stBusy;
}
async function doSyncState(opts) {
  const sending = [];
  for (const id of S.outbox.keys()) {
    const r = S.state.get(id);
    if (r) sending.push({ id, data: r.data, deleted: r.deleted, updatedAt: r.updatedAt });
  }
  // 1日1回は全件を突き合わせる(端末にしか無い記録を送り直す)
  const full = !!opts.full || !S.meta.stateFullAt || Date.now() - S.meta.stateFullAt > 24 * 3600 * 1000;
  const since = full ? 0 : S.meta.stateRev || 0;
  let res;
  try {
    res = await rpc('asayomi_state_sync', { p_changes: sending, p_since: since, p_device: deviceId() });
  } catch (e) {
    emit('status', S.status);
    return false;
  }
  const sent = [];
  for (const c of sending) if (S.outbox.get(c.id) === c.updatedAt) { S.outbox.delete(c.id); sent.push(c.id); }
  let changed = false;
  const seen = new Set();
  const incoming = [];
  for (const r of res.records || []) {
    seen.add(r.id);
    const cur = S.state.get(r.id);
    const ts = Date.parse(r.updatedAt);
    if (!cur || Date.parse(cur.updatedAt) < ts) {
      const rec = { id: r.id, data: r.data, updatedAt: new Date(ts).toISOString(), deleted: !!r.deleted };
      S.state.set(r.id, rec);
      incoming.push(rec);
      changed = true;
    }
  }
  const resend = [];
  if (since === 0 || res.full) {
    for (const [id, r] of S.state) if (!seen.has(id) && !S.outbox.has(id)) { S.outbox.set(id, r.updatedAt); resend.push([id, r.updatedAt]); }
  }
  await write(['state', 'outbox'], (t) => {
    for (const id of sent) t.objectStore('outbox').delete(id);
    for (const rec of incoming) t.objectStore('state').put(rec, rec.id);
    for (const [id, ts] of resend) t.objectStore('outbox').put(ts, id);
  });
  if (since === 0 || res.full) await setMeta('stateFullAt', Date.now());
  await setMeta('stateRev', res.rev || 0);
  await setMeta('stateSyncedAt', Date.now());
  if (resend.length) scheduleStateSync(300);
  if (changed) emit('state', null);
  emit('status', S.status);
  return true;
}

/* ---------- 記録の読み書き(画面から使う形) ---------- */
const K = { trivia: 't', news: 'n' };
const rid = (prefix, it) => prefix + ':' + K[it.kind] + ':' + it.date + ':' + it.n;
export function pref() { return Object.assign({ autoReview: true, quizSize: 10 }, st.get('pref') || {}); }
export function setPref(patch) { st.set('pref', Object.assign(pref(), patch)); }

function bump(field) {
  const id = 'act:' + todayJST();
  const cur = Object.assign({ r: 0, q: 0 }, st.get(id) || {});
  cur[field] = (cur[field] || 0) + 1;
  st.set(id, cur);
}
export function activity(date) { return st.get('act:' + date) || null; }
export function streak() {
  let d = todayJST();
  if (!st.has('act:' + d)) d = addDays(d, -1); // 今日まだ開いていなくても、きのうまでの連続は途切れていない
  let n = 0;
  while (st.has('act:' + d)) { n++; d = addDays(d, -1); }
  return n;
}

export function isRead(it) { return st.has(rid('read', it)); }
export function markRead(it) {
  const id = rid('read', it);
  if (st.has(id)) return false;
  st.set(id, { at: new Date().toISOString() });
  bump('r');
  if (it.kind === 'trivia' && pref().autoReview) addCard(cardIdOf(it));
  return true;
}
export function readCount(kind, date) { return itemsOf(kind, date).filter(isRead).length; }
export function isSaved(it) { return st.has(rid('save', it)); }
export function toggleSave(it) {
  const id = rid('save', it);
  if (st.has(id)) { st.del(id); return false; }
  st.set(id, { at: new Date().toISOString() });
  return true;
}
export function savedItems() {
  const out = [];
  st.each('save:', (id, data) => {
    const p = id.split(':');
    const it = item(p[1] === 't' ? 'trivia' : 'news', p[2], +p[3]);
    if (it) out.push({ it, at: (data && data.at) || '' });
  });
  return out.sort((a, b) => (a.at < b.at ? 1 : -1)).map((x) => x.it);
}
export function recentRead(limit) {
  const out = [];
  st.each('read:', (id, data) => {
    const p = id.split(':');
    const it = item(p[1] === 't' ? 'trivia' : 'news', p[2], +p[3]);
    if (it) out.push({ it, at: (data && data.at) || '' });
  });
  return out.sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, limit).map((x) => x.it);
}
export function sentId(it) { return rid('sent', it); }
export function todoId(it) { return rid('todo', it); }

/* ---------- 復習カード ---------- */
export function cardIdOf(it) { return 'card:t:' + it.date + ':' + it.n; }
export function cardIdTerm(term) { return 'card:w:' + norm(term); }
export function addCard(id) {
  if (st.has(id)) return false;
  st.set(id, { box: 0, due: addDays(todayJST(), 1), added: todayJST(), ok: 0, ng: 0 });
  return true;
}
export function removeCard(id) { st.del(id); }
// カードが指している雑学・用語(まだ中身が届いていなければ null)
export function cardTarget(id) {
  if (id.indexOf('card:t:') === 0) {
    const p = id.split(':');
    const it = item('trivia', p[2], +p[3]);
    return it ? { type: 't', it } : null;
  }
  if (id.indexOf('card:w:') === 0) {
    const e = terms().get(id.slice(7));
    return e ? { type: 'w', term: e } : null;
  }
  return null;
}
export function dueCards() {
  const today = todayJST();
  const out = [];
  st.each('card:', (id, c) => { if (c && c.due && c.due <= today && cardTarget(id)) out.push({ id, c }); });
  return out.sort((a, b) => (a.c.due < b.c.due ? -1 : a.c.due > b.c.due ? 1 : 0));
}
export function grade(id, result) {
  const c = Object.assign({ box: 0, ok: 0, ng: 0, added: todayJST() }, st.get(id) || {});
  const today = todayJST();
  if (result === 'ok') {
    c.box = Math.min((c.box || 0) + 1, INTERVALS.length - 1);
    c.due = addDays(today, INTERVALS[c.box]);
    c.ok = (c.ok || 0) + 1;
  } else if (result === 'mid') {
    c.due = addDays(today, 1);
  } else {
    c.box = 0;
    c.due = addDays(today, 1);
    c.ng = (c.ng || 0) + 1;
  }
  c.last = today;
  st.set(id, c);
  bump('q');
  return c;
}
export function touchQuiz() { bump('q'); }
export function cardStats() {
  const boxes = INTERVALS.map(() => 0);
  let total = 0;
  let mastered = 0;
  st.each('card:', (id, c) => {
    total++;
    const b = Math.min(Math.max((c && c.box) || 0, 0), INTERVALS.length - 1);
    boxes[b]++;
    if (b >= MASTERED) mastered++;
  });
  return { total, mastered, learning: total - mastered, boxes };
}

/* ---------- 設定画面から ---------- */
export function exportAll() {
  return {
    app: 'asayomi', exportedAt: new Date().toISOString(),
    state: Array.from(S.state.values()),
    days: Array.from(S.days.values()),
    items: Array.from(S.items.values()),
  };
}
export async function rebuild() {
  await wipeContent();
  emit('content');
  return pull();
}
