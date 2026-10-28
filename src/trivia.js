// 今日の雑学: 一覧(大カード／2枚並び)と記事。見た目は元の「今朝の雑学カード」をそのまま引き継ぐ。
import { h, clear, rich, jDate, mdDate, dparts, DOW, todayJST } from './util.js';
import { GENRES } from './config.js';
import * as store from './store.js';
import { illust, icon, colorOf } from './art.js';
import { go, replace, back } from './nav.js';
import { dayNotice, reviewNudge, dayNav, readMark, xButton, toast } from './ui.js';
import { actionBar } from './actions.js';
import { openCalendar } from './me.js';
import { claudeButton } from './talk.js';

const view = { tab: 'all', past: 10 };

function genreLabel(it, short) {
  const d = it.data;
  const full = d.genreLabel || (GENRES[d.genre] ? GENRES[d.genre].label : '雑学');
  return short ? full.split('・')[0] : full;
}
function meta(it, opts) {
  const o = opts || {};
  const d = it.data;
  const m = h('div', { class: 'meta' },
    h('span', { class: 'lab', style: { '--c': colorOf(it) } }, h('i'), genreLabel(it)));
  if (d.keyword) m.append(h('span', { class: 'kw' }, d.keyword));
  if (o.date) m.append(h('span', null, jDate(it.date)));
  if (o.marks && store.isRead(it)) m.append(readMark());
  if (o.marks && store.isSaved(it)) m.append(h('span', { class: 'readmark savemark' }, icon('save', 13), '保存'));
  return m;
}
const open = (it) => go('#/trivia/' + it.date + '/' + it.n);

/* ---------- 一覧 ---------- */
export function renderTrivia(root, date) {
  clear(root);
  root.className = 'tv';
  const wrap = h('div', { class: 'wrap' });
  root.append(wrap);
  if (!date) {
    wrap.append(h('div', { class: 'boot' }, h('b', null, 'まだ雑学が届いていません'), '毎朝7時ごろに5本届きます。'));
    return;
  }
  const day = store.dayOf('trivia', date) || {};
  const items = store.itemsOf('trivia', date);
  const p = dparts(date);
  const isLatest = date === store.latest('trivia');

  wrap.append(h('header', { class: 'top' },
    h('h1', { class: isLatest ? '' : 'past' }, isLatest ? '今日の雑学' : p.m + '月' + p.d + '日の雑学'),
    h('button', { class: 'date', type: 'button', 'aria-label': '日付をえらぶ（' + jDate(date) + '）', onclick: () => openCalendar('trivia', date) },
      h('small', null, DOW[p.w] + '曜'), h('b', null, p.m + '/' + p.d))));

  const read = store.readCount('trivia', date);
  const greet = h('p', { class: 'greet' }, h('span', null, day.greeting || jDate(date) + 'の雑学' + items.length + '選です。'));
  if (day.intro) greet.append(h('span', null, day.intro));
  if (read) greet.append(h('span', null, read >= items.length ? '✓ ' + items.length + '本ぜんぶ読みました' : items.length + '本中 ' + read + '本 読みました'));
  wrap.append(greet);

  const notice = dayNotice('trivia', date);
  if (notice) wrap.append(notice);
  wrap.append(h('div', { class: 'lalt tvl' }, claudeButton('trivia', date), h('small', null, 'Claudeアプリの音声モードで、話しながら聞く(続けてニュースも)')));
  if (isLatest) { const nudge = reviewNudge(); if (nudge) wrap.append(nudge); }

  // タブ: すべて → その日に出たジャンル → これまでの雑学
  const tabs = [{ key: 'all', label: 'すべて' }];
  for (const it of items) {
    const g = it.data.genre || 'word';
    if (!tabs.some((t) => t.key === g)) tabs.push({ key: g, label: genreLabel(it, true), color: colorOf(it) });
  }
  const missed = isLatest ? store.missedTrivia() : [];
  if (missed.length) tabs.push({ key: 'missed', label: '見逃した ' + missed.length });
  if (store.dates('trivia').length > 1) tabs.push({ key: 'past', label: 'これまでの雑学' });
  if (!tabs.some((t) => t.key === view.tab)) view.tab = 'all';

  const tabsEl = h('nav', { class: 'tabs', 'aria-label': 'ジャンル' });
  const feed = h('div', { class: 'feed' });
  for (const t of tabs) {
    const b = h('button', { class: 'tab', type: 'button', 'data-k': t.key });
    if (t.color) b.append(h('i', { style: { '--c': t.color } }));
    b.append(t.label);
    b.addEventListener('click', () => { view.tab = t.key; view.past = 10; fill(); });
    tabsEl.append(b);
  }
  wrap.append(tabsEl, feed);

  function fill() {
    for (const b of tabsEl.children) b.setAttribute('aria-pressed', String(b.getAttribute('data-k') === view.tab));
    clear(feed);
    if (view.tab === 'past') { fillPast(feed, date); return; }
    if (view.tab === 'missed') { fillMissed(feed, missed); return; }
    const list = items.filter((it) => view.tab === 'all' || (it.data.genre || 'word') === view.tab);
    let k = 0;
    let big = true;
    while (k < list.length) {
      if (big || k === list.length - 1) { feed.append(bigCard(list[k])); k += 1; }
      else { feed.append(pairCard(list[k], list[k + 1])); k += 2; }
      big = !big;
    }
    if (view.tab === 'all' && missed.length) feed.append(missedBox(missed));
    if (view.tab === 'all' && day.pick && day.pick.text) {
      feed.append(h('div', { class: 'pick' },
        h('span', { class: 'eyebrow' }, '今日のひとこと'),
        day.pick.title ? h('b', null, day.pick.title) : null,
        h('p', null, day.pick.text)));
    }
    feed.append(dayNav('trivia', date));
  }
  fill();
}

function bigCard(it) {
  return h('button', { class: 'card', type: 'button', 'aria-label': it.data.title, onclick: () => open(it) },
    illust(it),
    h('div', { class: 'txt' }, h('h2', null, it.data.title), meta(it, { marks: true })));
}
function pairCard(a, b) {
  const cell = (it) => h('button', { class: 'cell', type: 'button', onclick: () => open(it) },
    h('div', { class: 'thumb' }, illust(it, { thumb: true })),
    h('h3', null, it.data.title), meta(it, { marks: true }));
  return h('div', { class: 'pair' }, cell(a), cell(b));
}

// 見逃した雑学: 今日の5本の下に、まだ開いていない前の日の雑学を3本だけもう一度出す。
// 並びは日ごとに変わり、同じ日のうちは変わらない(読んだら抜けて次が入る)。
const MISSED_SHOW = 3;
function seeded(it, seed) {
  let x = 2166136261;
  for (const c of seed + it.date + it.n) x = Math.imul(x ^ c.charCodeAt(0), 16777619);
  x = Math.imul(x ^ (x >>> 16), 2246822507);
  x = Math.imul(x ^ (x >>> 13), 3266489909);
  return (x ^ (x >>> 16)) >>> 0;
}
function missedRow(it) {
  return h('div', { class: 'mrow' },
    h('button', { class: 'rowb', type: 'button', onclick: () => open(it) },
      h('span', { class: 'lab', style: { '--c': colorOf(it) } }, h('i'), genreLabel(it, true)),
      h('span', { class: 'rt' }, h('b', null, it.data.title), h('small', null, mdDate(it.date) + 'の雑学' + (it.data.gist ? '　' + it.data.gist : '')))),
    h('button', { class: 'skip', type: 'button', 'aria-label': 'もう出さない', title: 'もう出さない',
      onclick: () => { store.skipMissed(it); toast('「' + it.data.title + '」はもう出しません'); } }, '×'));
}
function showTab(key) {
  const b = document.querySelector('.tv .tabs [data-k="' + key + '"]');
  if (b) { b.click(); window.scrollTo(0, 0); }
}
function missedBox(missed) {
  const today = todayJST();
  const picks = missed.slice().sort((a, b) => seeded(a, today) - seeded(b, today)).slice(0, MISSED_SHOW);
  const box = h('div', { class: 'day missed' },
    h('h3', null, '見逃した雑学をもう一度',
      missed.length > picks.length ? h('button', { type: 'button', onclick: () => showTab('missed') }, 'ぜんぶで' + missed.length + '本 ›') : null));
  for (const it of picks) box.append(missedRow(it));
  return box;
}
function fillMissed(feed, missed) {
  feed.append(h('p', { class: 'mnote' }, 'まだ開いていない雑学です。開くと「読んだ」になってここから消えます。興味のないものは × で外せます。'));
  let cur = null;
  let box = null;
  for (const it of missed) {
    if (it.date !== cur) {
      cur = it.date;
      box = h('div', { class: 'day' }, h('h3', null, jDate(it.date)));
      feed.append(box);
    }
    box.append(missedRow(it));
  }
}

// これまでの雑学: 日付ごとの箱。10日分ずつ出す。
function fillPast(feed, curDate) {
  const links = h('div', { class: 'pastlinks' });
  for (const g in GENRES) {
    links.append(h('button', { type: 'button', style: { '--c': GENRES[g].color }, onclick: () => go('#/search/t/' + g) }, h('i'), GENRES[g].label));
  }
  feed.append(links);
  const ds = store.dates('trivia');
  for (const d of ds.slice(0, view.past)) {
    const box = h('div', { class: 'day' });
    box.append(h('h3', null, jDate(d) + (d === curDate ? '（表示中）' : ''),
      h('button', { type: 'button', onclick: () => { view.tab = 'all'; replace('#/trivia/' + d); window.scrollTo(0, 0); } }, 'この日をひらく ›')));
    for (const it of store.itemsOf('trivia', d)) {
      box.append(h('button', { class: 'rowb' + (store.isRead(it) ? ' read' : ''), type: 'button', onclick: () => open(it) },
        h('span', { class: 'lab', style: { '--c': colorOf(it) } }, h('i'), genreLabel(it, true)),
        h('span', { class: 'rt' }, h('b', null, it.data.title), it.data.gist ? h('small', null, it.data.gist) : null)));
    }
    feed.append(box);
  }
  if (ds.length > view.past) {
    feed.append(h('button', { class: 'morebtn', type: 'button', onclick: () => { view.past += 10; clear(feed); fillPast(feed, curDate); } },
      'もっと前を見る（あと ' + (ds.length - view.past) + ' 日分）'));
  }
}

/* ---------- 記事 ---------- */
export function triviaArticle(it) {
  const d = it.data;
  const items = store.itemsOf('trivia', it.date);
  const isLatest = it.date === store.latest('trivia');
  const art = h('article', { class: 'art' });

  art.append(h('h1', null, d.title), meta(it, { date: true }), claudeButton('trivia', it.date, it.n));
  if (store.svgOf(it)) art.append(h('div', { class: 'fig' }, illust(it)));
  if (d.gist) {
    art.append(h('div', { class: 'gist' }, h('span', null, d.legacy ? 'この話のメモ' : 'ひとことで言うと'), h('p', null, d.gist)));
  }
  for (const s of d.sections || []) {
    if (s.h) art.append(h('h2', null, s.h));
    for (const para of Array.isArray(s.p) ? s.p : [s.p]) if (para) art.append(rich(h('p', { class: 'body' }), para));
  }
  if (d.talk) {
    const face = h('div', { class: 'face' }, icon('talk', 22));
    face.firstChild.style.color = '#14743c';
    art.append(h('div', { class: 'talk' }, face,
      h('div', { class: 'bub' }, h('span', null, '会話で使える一言'), h('p', null, d.talk))));
  }
  if (d.extra && d.extra.text) {
    art.append(h('div', { class: 'extra' }, h('span', null, d.extra.label || 'ひとこと'), rich(h('p'), d.extra.text)));
  }
  art.append(actionBar(it));

  if (items.length > 1) {
    const i = items.indexOf(it);
    const nx = items[(i + 1) % items.length];
    art.append(h('button', { class: 'next', type: 'button', onclick: () => replace('#/trivia/' + nx.date + '/' + nx.n) },
      h('div', { class: 'thumb' }, illust(nx, { thumb: true })),
      h('div', { style: { 'min-width': '0' } },
        h('small', null, i < items.length - 1 ? '次の雑学' : '最初の雑学にもどる'), h('b', null, nx.data.title))));
  }

  const crumb = (isLatest ? '今日の雑学 ' : jDate(it.date) + 'の雑学 ') + it.n + '/' + items.length + (d.keyword ? '　' + d.keyword : '');
  return h('div', { class: 'tv' },
    h('div', { class: 'wrap' },
      h('div', { class: 'abar' }, h('div', { class: 'crumb' }, crumb), xButton(() => back('#/trivia/' + it.date), '一覧に戻る')),
      art));
}
