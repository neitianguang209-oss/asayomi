// 今日のニュース8選: 一覧(トップ／ランキング／世界・日本・AI／決算)と記事。
// 見た目は元の「今日のニュース8選」をそのまま引き継ぎ、「流れ」(続報をつなぐ)と「用語帳」を足している。
import { h, clear, rich, jDate, mdDate, dparts, DOW_EN, MON_EN, diffDays, todayJST, norm } from './util.js';
import { CATS } from './config.js';
import * as store from './store.js';
import { illust, icon, colorOf } from './art.js';
import { go, replace, back } from './nav.js';
import { dayNotice, reviewNudge, dayNav, xButton } from './ui.js';
import { actionBar } from './actions.js';
import { openTermSheet, attachLookup } from './lookup.js';
import { openCalendar } from './me.js';
import { listenCard, listenButton, askLog } from './listen.js';
import { claudeButton } from './talk.js';

const view = { tab: 'top', termQ: '', termSort: 'new', termShown: 60 };

const open = (it) => go('#/news/' + it.date + '/' + it.n);
const catName = (d) => d.catn || (CATS[d.cat] ? CATS[d.cat].label : '');
const newMark = () => h('span', { class: 'newm' }, 'NEW');
function secsOf(d) {
  const out = [];
  for (const s of d.secs || d.sections || []) {
    if (Array.isArray(s)) out.push({ h: s[0], ps: [s[1]] });
    else if (s) out.push({ h: s.h, ps: Array.isArray(s.p) ? s.p : [s.p] });
  }
  return out;
}
function safeLink(url, text) {
  if (!/^https?:\/\//i.test(url || '')) return h('span', null, text || '');
  return h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, text || url);
}

function metaLine(it) {
  const d = it.data;
  const m = h('div', { class: 'meta' }, h('span', { class: 'cat ' + d.cat }, catName(d)));
  if (d.src) m.append('・', h('span', null, d.src));
  m.append('・', h('span', null, mdDate(it.date)));
  if (d.isNew) m.append(newMark());
  return m;
}
function big(it) {
  return h('button', { class: 'card' + (store.isRead(it) ? ' read' : ''), type: 'button', onclick: () => open(it) },
    illust(it), h('div', { class: 'cbody' }, h('h2', null, it.data.title), metaLine(it)));
}
function row(it, withRole) {
  const b = h('button', { class: 'row' + (store.isRead(it) ? ' read' : ''), type: 'button', onclick: () => open(it) }, it.data.title);
  if (it.data.isNew) b.append(newMark());
  if (withRole) b.append(h('small', null, catName(it.data) + (it.data.role ? '・' + it.data.role : '')));
  return b;
}
function tile(it) {
  const p = h('p', null, it.data.title);
  if (it.data.isNew) p.append(' ', newMark());
  return h('button', { class: 'tile' + (store.isRead(it) ? ' read' : ''), type: 'button', onclick: () => open(it) }, illust(it, { thumb: true }), p);
}
const tiles = (a, solo) => h('div', { class: 'tiles' + (solo ? ' solo' : '') }, a.map(tile));

/* ---------- 一覧 ---------- */
export function renderNews(root, date) {
  clear(root);
  root.className = 'nw';
  const wrap = h('div', { class: 'wrap' });
  if (!date) {
    root.append(wrap);
    wrap.append(h('div', { class: 'boot' }, h('b', null, 'まだニュースが届いていません'), '毎朝7時ごろに8本届きます。'));
    return;
  }
  const day = store.dayOf('news', date) || {};
  const items = store.itemsOf('news', date);
  const p = dparts(date);
  const isLatest = date === store.latest('news');
  const lite = !items.some((it) => it.art);

  const brand = h('h1', { class: 'brand' }, isLatest ? '今日の' : p.m + '/' + p.d + 'の', h('span', null, items.length + '選'));
  root.append(h('div', { class: 'band' }, h('div', { class: 'wrap' }, h('header', { class: 'hdr' }, h('div', { class: 'hrow' }, brand,
    h('button', { class: 'datec', type: 'button', 'aria-label': '日付をえらぶ（' + jDate(date) + '）', onclick: () => openCalendar('news', date) },
      h('b', null, p.d), h('small', null, MON_EN[p.m - 1] + '·' + DOW_EN[p.w])))))));

  const tabs = [];
  if (Array.isArray(day.rank) && day.rank.length) tabs.push(['rank', 'ランキング']);
  tabs.push(['top', 'トップ'], ['world', '世界'], ['japan', '日本'], ['ai', 'AI']);
  if (day.earn) tabs.push(['earn', '決算']);
  tabs.push(['flow', '流れ', true], ['terms', '用語帳']);
  if (!tabs.some((t) => t[0] === view.tab)) view.tab = 'top';

  const tabsEl = h('nav', { class: 'tabs', 'aria-label': 'カテゴリ' });
  const feed = h('div', { class: 'feed' });
  for (const t of tabs) {
    const b = h('button', { class: 'tab' + (t[2] ? ' sep' : ''), type: 'button', 'data-k': t[0] }, t[1]);
    if (CATS[t[0]] && items.some((it) => it.data.cat === t[0] && !store.isRead(it))) b.append(h('i', { class: 'gd' })); // まだ読んでいない記事がある
    b.addEventListener('click', () => { view.tab = t[0]; view.termShown = 60; fill(); window.scrollTo(0, 0); });
    tabsEl.append(b);
  }
  root.append(h('div', { class: 'band stick' }, h('div', { class: 'wrap' }, tabsEl)), wrap);
  wrap.append(feed);

  const foot = () => h('div', { class: 'foot' },
    '今日の' + items.length + '選 · ' + DOW_EN[p.w] + ' ' + MON_EN[p.m - 1] + ' ' + p.d + ' ' + p.y + ' · JST');

  function fill() {
    for (const b of tabsEl.children) b.classList.toggle('on', b.getAttribute('data-k') === view.tab);
    clear(feed);
    const v = view.tab;
    if (v === 'flow') { fillFlow(feed); return; }
    if (v === 'terms') { fillTerms(feed); return; }
    if (v === 'top') {
      const notice = dayNotice('news', date);
      if (notice) feed.append(notice);
      feed.append(h('div', { class: 'lgrp' }, listenCard('news', date), h('div', { class: 'lalt' }, claudeButton('news', date), h('small', null, 'Claudeアプリの音声モードで、話しながら聞く(続けて雑学も)'))));
      if (isLatest) { const nudge = reviewNudge(); if (nudge) feed.append(nudge); }
      if (day.lead) feed.append(h('div', { class: 'leadline' }, h('b', null, jDate(date) + 'の' + items.length + '選。'), day.lead));
      topLayout(feed, items, lite);
      if (day.earn) feed.append(earnBox(day.earn));
      if (Array.isArray(day.rank) && day.rank.length) feed.append(rankBox(day.rank, date));
      feed.append(sources(items, day));
      feed.append(dayNav('news', date));
    } else if (v === 'rank') {
      feed.append(rankBox(day.rank, date));
      feed.append(h('div', { class: 'mix' }, h('div', { class: 'mixh' }, items.length + '本をまとめて'), items.map((it) => row(it))));
    } else if (v === 'earn') {
      feed.append(earnBox(day.earn));
    } else {
      const list = items.filter((it) => it.data.cat === v);
      if (!list.length) feed.append(h('div', { class: 'empty' }, 'この日はありません。'));
      else if (lite) feed.append(h('div', { class: 'mix' }, list.map((it) => row(it, true))));
      else list.forEach((it) => feed.append(big(it)));
    }
    feed.append(foot());
  }
  fill();
}

// トップの並び: 世界の主要(大)→日本(見出し2行＋タイル2枚)→AIパート(大＋タイル2枚)
function topLayout(feed, items, lite) {
  const of = (c) => items.filter((it) => it.data.cat === c);
  const w = of('world');
  const j = of('japan');
  const a = of('ai');
  if (!lite && w.length === 2 && j.length === 3 && a.length === 3) {
    feed.append(big(w[0]));
    feed.append(h('div', { class: 'mix' }, h('div', { class: 'mixh' }, '日本のニュース'), row(j[0]), row(j[1]), tiles([w[1], j[2]])));
    feed.append(h('div', { class: 'sech' }, h('i', { style: { background: 'var(--ai)' } }), 'AIパート'));
    feed.append(big(a[0]));
    feed.append(h('div', { class: 'mix' }, tiles([a[1], a[2]], true)));
    return;
  }
  // イラストの無い以前の配信分など: カテゴリごとに見出しの行で並べる
  for (const [c, list] of [['world', w], ['japan', j], ['ai', a]]) {
    if (!list.length) continue;
    feed.append(h('div', { class: 'sech' }, h('i', { style: { background: CATS[c].color } }), c === 'ai' ? 'AIパート' : CATS[c].label + 'のニュース'));
    if (lite) feed.append(h('div', { class: 'mix' }, list.map((it) => row(it, true))));
    else list.forEach((it) => feed.append(big(it)));
  }
}

function earnBox(e) {
  const box = h('section', { class: 'earn' },
    h('h3', null, '📅 今週の注目決算・イベント'),
    h('p', { class: 'es' }, e.sub || 'ここだけ「これから起きること」の先読みです。'));
  const today = todayJST();
  for (const ev of e.events || []) {
    const head = h('div', { class: 'evh' }, h('span', { class: 'evd' }, ev.when || ''));
    if (/^\d{4}-\d{2}-\d{2}$/.test(ev.date || '')) {
      const left = diffDays(ev.date, today);
      if (left >= 0 && left <= 14) head.append(h('span', { class: 'left' }, left === 0 ? '今日' : left === 1 ? 'あした' : 'あと' + left + '日'));
    }
    head.append(h('span', { class: 'evn' }, ev.name || ''));
    if (ev.hot) head.append(h('span', { class: 'hot' }, '最注目'));
    const card = h('div', { class: 'ev' }, head);
    if (Array.isArray(ev.points) && ev.points.length) card.append(h('ul', null, ev.points.map((t) => rich(h('li'), t))));
    for (const t of [].concat(ev.text || [])) card.append(rich(h('p'), t));
    box.append(card);
  }
  if (e.note) box.append(rich(h('p', { class: 'enote' }), e.note));
  return box;
}
function rankBox(rank, date) {
  const box = h('section', { class: 'rank' }, h('h3', null, '🔥 今日のキーワード'));
  rank.forEach((r, i) => {
    box.append(h('button', { class: 'rk' + (i < 3 ? ' top' : ''), type: 'button', onclick: () => go('#/news/' + date + '/' + r[2]) },
      h('span', { class: 'n' }, i + 1), h('span', { class: 'k' }, r[0]), h('span', { class: 'c' }, r[1] || '')));
  });
  return box;
}
function sources(items, day) {
  const d = h('details', { class: 'src' }, h('summary', null, '出典・参考リンクをまとめて見る'));
  for (const it of items) for (const l of it.data.links || []) d.append(safeLink(l[1], l[0]));
  for (const l of day.sources || []) d.append(safeLink(l[1], l[0]));
  return d;
}

/* ---------- 流れ(続いている話題) ---------- */
function fillFlow(feed) {
  const all = Array.from(store.threads().values());
  const byLast = (x, y) => (x.last === y.last ? y.items.length - x.items.length : x.last < y.last ? 1 : -1);
  const multi = all.filter((t) => t.items.length >= 2).sort(byLast);
  const single = all.filter((t) => t.items.length === 1).sort(byLast);
  feed.append(h('div', { class: 'hint' }, '同じ話題のニュースを、日付をまたいで時系列でつなぎます。「前はどうだったっけ？」をここでたどれます。'));
  if (!all.length) { feed.append(h('div', { class: 'empty' }, 'まだ話題がありません。')); return; }
  if (multi.length) {
    const box = h('div', { class: 'box' }, h('div', { class: 'boxh' }, '続いている話題'));
    for (const t of multi) {
      box.append(h('button', { class: 'th', type: 'button', style: { '--acc': (CATS[t.cat] || CATS.world).color }, onclick: () => go('#/flow/' + encodeURIComponent(t.name)) },
        h('span', { class: 'cnt' }, t.items.length),
        h('span', { class: 'tb' }, h('b', null, t.name), h('small', null, mdDate(t.last) + '　' + t.items[0].data.title))));
    }
    feed.append(box);
  }
  if (single.length) {
    feed.append(h('div', { class: 'box' }, h('div', { class: 'boxh' }, 'まだ1回だけの話題'),
      h('div', { class: 'chips' }, single.slice(0, 60).map((t) =>
        h('button', { type: 'button', onclick: () => go('#/flow/' + encodeURIComponent(t.name)) }, t.name)))));
  }
}
function timeline(list, cur) {
  const ol = h('ol', { class: 'tline' });
  for (const it of list) {
    const isCur = cur && it === cur;
    const inner = [h('span', { class: 'fd' }, jDate(it.date) + (isCur ? '　いま読んでいる記事' : '')), h('span', { class: 'ft' }, it.data.title)];
    if (!cur && store.briefOf(it)) inner.push(h('span', { class: 'fg' }, store.briefOf(it)));
    ol.append(h('li', { class: isCur ? 'cur' : '' },
      isCur ? h('div', null, inner) : h('button', { type: 'button', onclick: () => (cur ? replace : go)('#/news/' + it.date + '/' + it.n) }, inner)));
  }
  return ol;
}
export function flowPage(name) {
  const t = store.threads().get(name);
  const wrap = h('div', { class: 'wrap' },
    h('div', { class: 'pbar' }, h('h1', null, name), xButton(() => back('#/news'))));
  if (!t) {
    wrap.append(h('div', { class: 'empty' }, 'この話題の記事は見つかりませんでした。'));
  } else {
    const first = t.items[t.items.length - 1];
    wrap.append(h('p', { class: 'rv-sub' }, t.items.length + '本・' + mdDate(first.date) + ' 〜 ' + mdDate(t.last) + '（新しい順）'));
    wrap.append(h('div', { class: 'sr-box', style: { padding: '14px 16px 4px' } }, timeline(t.items, null)));
  }
  return h('div', { class: 'page', style: { '--acc': t ? (CATS[t.cat] || CATS.world).color : 'var(--red)' } }, wrap);
}

/* ---------- 用語帳 ---------- */
function fillTerms(feed) {
  const all = Array.from(store.terms().values());
  const input = h('input', { type: 'search', placeholder: '用語をさがす', 'aria-label': '用語をさがす', value: view.termQ, enterkeyhint: 'search' });
  const sortBtn = h('button', { type: 'button' });
  const list = h('div', { class: 'box' });
  const more = h('div');
  const paint = () => {
    sortBtn.textContent = view.termSort === 'new' ? '新しい順' : 'よく出る順';
    const q = norm(view.termQ).trim();
    let rows = q ? all.filter((e) => e.key.indexOf(q) >= 0 || norm(e.desc).indexOf(q) >= 0) : all.slice();
    rows.sort((x, y) => (view.termSort === 'new'
      ? (x.last < y.last ? 1 : x.last > y.last ? -1 : 0)
      : y.uses.length - x.uses.length || (x.last < y.last ? 1 : -1)));
    clear(list); clear(more);
    list.append(h('div', { class: 'boxh' }, q ? '見つかった用語（' + rows.length + '）' : 'ニュースに出てきた用語（' + rows.length + '）'));
    if (!rows.length) list.append(h('div', { class: 'empty' }, all.length ? '見つかりませんでした。' : 'まだ用語がありません。'));
    for (const e of rows.slice(0, view.termShown)) {
      const name = h('b', null, e.term);
      if (store.st.has(store.cardIdTerm(e.term))) name.append(h('i', null, '復習中'));
      list.append(h('button', { class: 'gl', type: 'button', onclick: () => openTermSheet(e.term) },
        name, h('span', null, e.desc), h('small', null, e.uses.length + '回 · 最後 ' + mdDate(e.last))));
    }
    if (rows.length > view.termShown) {
      more.append(h('button', { class: 'morebtn', type: 'button', onclick: () => { view.termShown += 60; paint(); } }, 'もっと見る'));
    }
  };
  input.addEventListener('input', () => { view.termQ = input.value; view.termShown = 60; paint(); });
  sortBtn.addEventListener('click', () => { view.termSort = view.termSort === 'new' ? 'freq' : 'new'; paint(); });
  feed.append(h('div', { class: 'hint' }, 'ニュースの「用語メモ」がここにたまっていきます。タップすると、くわしく調べたり、復習に入れたり思考メモに送ったりできます。'),
    h('div', { class: 'tsearch' }, input, sortBtn), list, more);
  paint();
}

/* ---------- 記事 ---------- */
export function newsArticle(it) {
  const d = it.data;
  const items = store.itemsOf('news', it.date);
  const p = dparts(it.date);
  const ain = h('article', { class: 'ain', style: { '--acc': colorOf(it) } });

  const ameta = h('div', { class: 'ameta' }, h('span', null, '配信 ' + p.y + '年' + p.m + '月' + p.d + '日'));
  if (d.src) ameta.append(h('span', null, d.src));
  ameta.append(h('span', { class: 'cat ' + d.cat }, catName(d) + (d.role ? '・' + d.role : '')));
  ain.append(h('h1', null, d.title), ameta, h('div', { class: 'lrow' }, listenButton(it), claudeButton('news', it.date, it.n)));
  if (store.svgOf(it)) ain.append(illust(it));
  if (d.lede) ain.append(rich(h('p', { class: 'lede' }), d.lede));
  for (const s of secsOf(d)) {
    if (s.h) ain.append(h('h2', null, s.h));
    for (const para of s.ps) if (para) ain.append(rich(h('p', { class: 'b' }), para));
  }
  ain.append(h('p', { class: 'lkhint' }, icon('search', 13), 'わからない言葉は、長押しで調べられます'));
  attachLookup(ain, it);

  const terms = (d.terms || []).filter((t) => Array.isArray(t) && t[0] && t[1]);
  if (terms.length) {
    const box = h('div', { class: 'terms' }, h('div', { class: 'tl' }, '用語メモ', h('small', null, 'タップでくわしく・復習へ')));
    for (const t of terms) {
      const tt = h('span', { class: 'tt' }, t[0]);
      if (store.st.has(store.cardIdTerm(t[0]))) tt.append(h('i', null, '復習中'));
      box.append(h('button', { class: 'term', type: 'button', onclick: () => openTermSheet(t[0], { it }) }, tt, h('span', { class: 'td' }, t[1])));
    }
    ain.append(box);
  }
  if (d.life) ain.append(h('div', { class: 'life' }, h('div', { class: 'tl' }, d.lifeLabel || '暮らしに効く'), rich(h('p'), d.life)));

  // この話題の流れ(同じ thread のほかの日の記事)
  const th = d.thread ? store.threads().get(d.thread) : null;
  if (th && th.items.length >= 2) {
    const i = th.items.indexOf(it);
    const from = Math.max(0, Math.min(i - 1, th.items.length - 4));
    const box = h('div', { class: 'flow' }, h('div', { class: 'tl' }, 'この話題の流れ', h('b', null, d.thread)),
      timeline(th.items.slice(from, from + 4), it));
    box.append(h('button', { class: 'all', type: 'button', onclick: () => go('#/flow/' + encodeURIComponent(d.thread)) },
      '時系列でぜんぶ見る（' + th.items.length + '本）'));
    ain.append(box);
  }

  const links = (d.links || []).filter((l) => Array.isArray(l) && l[1]);
  if (links.length) {
    const src = h('div', { class: 'asrc' }, '出典：');
    links.forEach((l, i) => { if (i) src.append(' / '); src.append(safeLink(l[1], l[0])); });
    ain.append(src);
  }
  ain.append(askLog(it));
  ain.append(actionBar(it));

  if (items.length > 2) {
    const i = items.indexOf(it);
    const nx = [items[(i + 1) % items.length], items[(i + 2) % items.length]];
    const to = (x) => () => replace('#/news/' + x.date + '/' + x.n);
    const next = h('div', { class: 'next' }, h('div', { class: 'nh' }, '次に読む'));
    if (nx.some((x) => x.art)) {
      next.append(h('div', { class: 'tiles' }, nx.map((x) => {
        const pp = h('p', null, x.data.title);
        if (x.data.isNew) pp.append(' ', newMark());
        return h('button', { class: 'tile', type: 'button', onclick: to(x) }, illust(x, { thumb: true }), pp);
      })));
    } else {
      nx.forEach((x) => next.append(h('button', { class: 'row', type: 'button', onclick: to(x) }, x.data.title)));
    }
    ain.append(next);
  }

  const pill = h('div', { class: 'apill' }, h('b', null, String(it.n).padStart(2, '0')), '　' + catName(d) + (d.role ? '・' + d.role : ''));
  return h('div', { class: 'nw' },
    h('div', { class: 'abar' }, pill, xButton(() => back('#/news/' + it.date), '記事を閉じる')),
    ain);
}
