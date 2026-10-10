// 起動・上のバー(雑学／ニュースの切り替え)・画面の行き来
import * as store from './store.js';
import { h, isDate, debounce, jDate } from './util.js';
import { setRouter, go, replace, back } from './nav.js';
import { renderTrivia, triviaArticle } from './trivia.js';
import { renderNews, newsArticle, flowPage } from './news.js';
import { reviewPage } from './review.js';
import { searchPage, presetSearch } from './search.js';
import { mePage } from './me.js';
import { showLayer, closeLayer, hasLayer, xButton } from './ui.js';
import { icon } from './art.js';

const viewEl = document.getElementById('view');
const app = { mode: 'trivia', date: { trivia: null, news: null }, baseKey: '', ver: 0, dirty: false };
try { if (localStorage.getItem('asayomi:mode') === 'news') app.mode = 'news'; } catch (e) { /* 既定のまま */ }

/* ---------- 上のバー ---------- */
const bar = { seg: {}, badge: null };
function buildBar() {
  const el = document.getElementById('bar');
  const seg = h('div', { class: 'seg', role: 'tablist', 'aria-label': '雑学とニュースの切り替え' });
  for (const [mode, label] of [['trivia', '雑学'], ['news', 'ニュース']]) {
    const b = h('button', { type: 'button', role: 'tab' }, label);
    b.addEventListener('click', () => {
      if (app.mode === mode) { window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
      replace('#/' + mode);
      window.scrollTo(0, 0);
    });
    bar.seg[mode] = b;
    seg.append(b);
  }
  bar.badge = h('span', { class: 'badge', hidden: true });
  el.append(h('div', { class: 'bar-in' }, seg, h('div', { class: 'bar-r' },
    h('button', { class: 'ib', type: 'button', 'aria-label': '復習', onclick: () => go('#/review') }, icon('cards'), bar.badge),
    h('button', { class: 'ib', type: 'button', 'aria-label': 'さがす', onclick: () => { presetSearch('all'); go('#/search'); } }, icon('search')),
    h('button', { class: 'ib', type: 'button', 'aria-label': 'きろく・設定', onclick: () => go('#/me') }, icon('me')))));
}
function paintBar() {
  for (const mode of ['trivia', 'news']) {
    const b = bar.seg[mode];
    b.setAttribute('aria-selected', String(app.mode === mode));
    // 開いていない方に、まだ1本も読んでいない最新分があれば赤い点
    const latest = store.latest(mode);
    const fresh = app.mode !== mode && latest && store.readCount(mode, latest) === 0;
    const dot = b.querySelector('i');
    if (fresh && !dot) b.append(h('i', { 'aria-label': '未読あり' }));
    if (!fresh && dot) dot.remove();
  }
  const due = store.dueCards().length;
  bar.badge.hidden = !due;
  bar.badge.textContent = due > 99 ? '99+' : String(due);
}

/* ---------- 一覧(下の層) ---------- */
let baseSeq = 0;
async function renderBase() {
  const kind = app.mode;
  const want = app.date[kind];
  const date = want && store.dayOf(kind, want) ? want : store.latest(kind);
  const key = kind + '|' + date + '|' + app.ver;
  if (key === app.baseKey) return;
  const samePlace = app.baseKey.split('|').slice(0, 2).join('|') === kind + '|' + date;
  const seq = ++baseSeq;
  if (date) await store.ensureArt(kind, date);
  if (seq !== baseSeq) return;
  const y = window.scrollY;
  app.baseKey = key;
  app.dirty = false;
  document.body.classList.toggle('m-news', kind === 'news');
  (kind === 'trivia' ? renderTrivia : renderNews)(viewEl, date);
  if (samePlace) window.scrollTo(0, y);
}
function refreshBase() {
  app.ver++;
  if (hasLayer()) app.dirty = true; // 記事などを開いている間は裏で描き直さない
  else renderBase();
  paintBar();
}

/* ---------- 行き先を決める ---------- */
function parseHash() {
  const s = location.hash.replace(/^#\/?/, '');
  const old = /^d(\d{4})(\d{2})(\d{2})n(\d+)$/.exec(s); // 以前の雑学ページのリンクの形
  if (old) return ['trivia', old[1] + '-' + old[2] + '-' + old[3], old[4]];
  return s.split('/').filter(Boolean).map((x) => { try { return decodeURIComponent(x); } catch (e) { return x; } });
}
function missingPage(kind, date) {
  return h('div', { class: 'page' }, h('div', { class: 'wrap' },
    h('div', { class: 'pbar' }, h('h1', null, '見つかりません'), xButton(() => back('#/' + kind))),
    h('div', { class: 'empty' }, (isDate(date) ? jDate(date) + 'の' : 'リンク先の') + (kind === 'trivia' ? '雑学' : 'ニュース') + 'が見つかりませんでした。', h('br'),
      '通信できる所でもう一度ひらくと出てくるかもしれません。')));
}

let routeSeq = 0;
async function route() {
  const seq = ++routeSeq;
  const p = parseHash();
  const head = p[0];

  if (head === 'trivia' || head === 'news') {
    if (p[2] && isDate(p[1])) {
      // 記事。下の一覧はそのまま(まだ何も出していなければ、その種類の最新を出しておく)
      if (!app.baseKey) { app.mode = head; renderBase(); }
      const n = parseInt(p[2], 10);
      if (!store.item(head, p[1], n)) await store.fetchDay(head, p[1]);
      await store.ensureArt(head, p[1]);
      if (seq !== routeSeq) return;
      const it = store.item(head, p[1], n);
      if (!it) { showLayer(missingPage(head, p[1]), 'in-u'); paintBar(); return; }
      store.markRead(it); // 先に既読にする(下のボタンに「復習に入った」ことを出すため)
      showLayer(head === 'trivia' ? triviaArticle(it) : newsArticle(it), head === 'trivia' ? 'in-r' : 'in-u');
      paintBar();
      return;
    }
    app.mode = head;
    try { localStorage.setItem('asayomi:mode', head); } catch (e) { /* 覚えられなくても動く */ }
    app.date[head] = isDate(p[1]) ? p[1] : null;
    closeLayer();
    await renderBase();
    paintBar();
    return;
  }

  const pages = {
    review: () => reviewPage(),
    search: () => {
      if (p[1]) { presetSearch(p[1], p[2]); history.replaceState(history.state, '', '#/search'); }
      return searchPage();
    },
    me: () => mePage(),
    flow: () => flowPage(p[1] || ''),
  };
  if (pages[head]) {
    if (!app.baseKey) renderBase();
    showLayer(pages[head](), 'in-u');
    paintBar();
    return;
  }

  // 何も指定がない: 前に見ていた方(雑学かニュース)の最新
  history.replaceState(history.state, '', '#/' + app.mode);
  app.date[app.mode] = null;
  closeLayer();
  await renderBase();
  paintBar();
}

/* ---------- 起動 ---------- */
let lastRefresh = 0;
function refresh(force) {
  if (!force && Date.now() - lastRefresh < 60000) return;
  lastRefresh = Date.now();
  store.pull();
  store.syncState();
}

async function boot() {
  buildBar();
  viewEl.append(h('div', { class: 'boot' }, h('div', { class: 'spin' }), '読み込んでいます…'));
  await store.init();
  store.on('content', refreshBase);
  store.on('state', debounce(refreshBase, 200));
  setRouter(route);
  if (!store.latest('trivia') && !store.latest('news')) {
    // はじめて開いた端末: 最新の1日分だけ先に取ってすぐ出す(残りは裏で取り込む)
    await Promise.all([store.quick('trivia'), store.quick('news')]);
  }
  await route();
  refresh(true);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(false); });
  window.addEventListener('focus', () => refresh(false));
  window.addEventListener('online', () => refresh(true));
  setInterval(() => { if (document.visibilityState === 'visible') refresh(false); }, 10 * 60 * 1000);
}
boot();
