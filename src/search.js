// さがす: 雑学・ニュース・用語を全期間まとめて検索。保存した記事と、ジャンル別の一覧もここ。
// 全角半角・大文字小文字・ひらがなカタカナの違いは区別しない。空白で区切ると「どちらも含む」。
import { h, clear, append, norm, mdDate, debounce, dparts } from './util.js';
import { GENRES, CATS } from './config.js';
import * as store from './store.js';
import { icon, glyph, colorOf } from './art.js';
import { go, back } from './nav.js';
import { xButton } from './ui.js';
import { openTermSheet } from './actions.js';

const view = { q: '', filter: 'all', genre: null, shown: 40, scroll: 0 };
// 配列や null が混ざっていてもそのまま足せる append
const put = (target, ...kids) => append(target, kids);

export function presetSearch(filter, genre) {
  view.filter = filter || 'all';
  view.genre = genre && GENRES[genre] ? genre : null;
  view.q = '';
  view.shown = 40;
  view.scroll = 0;
}

// 一致した所に色をつける(正規化で文字数が変わらない文だけ)
function hl(text, tokens) {
  const span = document.createDocumentFragment();
  const s = String(text || '');
  const n = norm(s);
  if (!tokens.length || n.length !== s.length) { span.append(s); return span; }
  const hits = [];
  for (const t of tokens) {
    let i = n.indexOf(t);
    while (i >= 0) { hits.push([i, i + t.length]); i = n.indexOf(t, i + t.length); }
  }
  hits.sort((a, b) => a[0] - b[0]);
  let pos = 0;
  for (const [a, b] of hits) {
    if (a < pos) continue;
    if (a > pos) span.append(s.slice(pos, a));
    span.append(h('mark', null, s.slice(a, b)));
    pos = b;
  }
  if (pos < s.length) span.append(s.slice(pos));
  return span;
}
function snippet(raw, tokens) {
  const s = String(raw || '');
  const n = norm(s);
  if (n.length !== s.length) return s.slice(0, 70);
  let at = -1;
  for (const t of tokens) { const i = n.indexOf(t); if (i >= 0 && (at < 0 || i < at)) at = i; }
  if (at < 0) return '';
  const from = Math.max(0, at - 18);
  return (from > 0 ? '…' : '') + s.slice(from, from + 72) + (from + 72 < s.length ? '…' : '');
}

function itemRow(it, tokens, sub) {
  const d = it.data;
  const news = it.kind === 'news';
  const lab = news
    ? h('span', { class: 'lab', style: { '--c': colorOf(it) } }, h('i'), (CATS[d.cat] || {}).label || 'ニュース')
    : h('span', { class: 'lab', style: { '--c': colorOf(it) } }, h('i'), (d.genreLabel || (GENRES[d.genre] || {}).label || '雑学').split('・')[0]);
  const p = dparts(it.date);
  const line = h('span', { class: 'l' }, lab, h('span', { class: 'd' }, p.y + '/' + p.m + '/' + p.d), news ? 'ニュース' : '雑学');
  if (store.isSaved(it)) line.append(h('span', { class: 'savemark', style: { display: 'inline-flex' } }, icon('save', 13)));
  const row = h('button', { class: 'sr-row', type: 'button', onclick: () => go('#/' + it.kind + '/' + it.date + '/' + it.n) },
    line, h('b', null, hl(d.title, tokens)));
  const text = sub != null ? sub : store.briefOf(it);
  if (text) row.append(h('span', { class: 's' }, hl(text, tokens)));
  return row;
}
function termRow(e, tokens) {
  return h('button', { class: 'sr-row', type: 'button', onclick: () => openTermSheet(e.term) },
    h('span', { class: 'l' }, h('span', { class: 'lab', style: { '--c': 'var(--link)' } }, h('i'), '用語'),
      h('span', { class: 'd' }, e.uses.length + '回 · ' + mdDate(e.last))),
    h('b', null, hl(e.term, tokens)), h('span', { class: 's' }, hl(e.desc, tokens)));
}
function section(title, rows, total) {
  const box = h('div', { class: 'sr-box' }, rows);
  return [h('div', { class: 'sr-h' }, h('span', null, title), total != null ? h('span', null, total + '件') : null), box];
}

export function searchPage() {
  const root = h('div', { class: 'page' });
  const wrap = h('div', { class: 'wrap' });
  root.append(wrap);

  const input = h('input', { type: 'search', placeholder: '雑学・ニュース・用語をさがす', 'aria-label': 'さがす', enterkeyhint: 'search', autocomplete: 'off' });
  input.value = view.q;
  const clr = h('button', { type: 'button', 'aria-label': '消す', hidden: !view.q }, icon('x', 12));
  const filters = h('div', { class: 'sr-f' });
  const sub = h('div', { class: 'sr-f' });
  const out = h('div');
  wrap.append(h('div', { class: 'pbar' }, h('div', { class: 'sr-in' }, icon('search', 18), input, clr), xButton(() => back('#/'))), filters, sub, out);

  const F = [['all', 'すべて'], ['t', '雑学'], ['n', 'ニュース'], ['w', '用語'], ['saved', '保存']];
  const paintFilters = () => {
    clear(filters);
    for (const [k, label] of F) {
      filters.append(h('button', { class: 'chip' + (view.filter === k ? ' on' : ''), type: 'button',
        onclick: () => { view.filter = k; if (k !== 't') view.genre = null; view.shown = 40; paintFilters(); paint(); } }, label));
    }
    clear(sub);
    sub.hidden = view.filter !== 't';
    if (view.filter === 't') {
      sub.append(h('button', { class: 'chip' + (!view.genre ? ' on' : ''), type: 'button', onclick: () => { view.genre = null; paintFilters(); paint(); } }, '全ジャンル'));
      for (const g in GENRES) {
        sub.append(h('button', { class: 'chip' + (view.genre === g ? ' on' : ''), type: 'button', style: { '--c': GENRES[g].color },
          onclick: () => { view.genre = g; view.shown = 40; paintFilters(); paint(); } }, h('i'), GENRES[g].label));
      }
    }
  };

  const more = (total) => (total > view.shown
    ? h('button', { class: 'bigbtn sub', type: 'button', onclick: () => { view.shown += 40; paint(); } }, 'もっと見る（あと ' + (total - view.shown) + ' 件）')
    : null);

  function paint() {
    clear(out);
    clr.hidden = !view.q;
    const tokens = norm(view.q).split(' ').filter(Boolean);
    const f = view.filter;

    if (f === 'saved') {
      let list = store.savedItems();
      if (tokens.length) list = list.filter((it) => { const t = norm(it.data.title + ' ' + (it.data.gist || '') + ' ' + (it.data.keyword || '')); return tokens.every((k) => t.indexOf(k) >= 0); });
      if (!list.length) { out.append(h('div', { class: 'empty' }, tokens.length ? '保存した記事の中には見つかりませんでした。' : '保存した記事はまだありません。記事の下の「保存」を押すと、ここに並びます。')); return; }
      put(out, section('保存した記事', list.slice(0, view.shown).map((it) => itemRow(it, tokens)), list.length), more(list.length));
      return;
    }

    if (!tokens.length) {
      if (f === 'all') { home(out); return; }
      if (f === 't') {
        const list = store.allItems('trivia').filter((it) => !view.genre || it.data.genre === view.genre);
        put(out, section(view.genre ? GENRES[view.genre].label + 'の雑学' : 'これまでの雑学', list.slice(0, view.shown).map((it) => itemRow(it, tokens)), list.length), more(list.length));
      } else if (f === 'n') {
        const list = store.allItems('news');
        put(out, section('これまでのニュース', list.slice(0, view.shown).map((it) => itemRow(it, tokens)), list.length), more(list.length));
      } else {
        const list = Array.from(store.terms().values()).sort((a, b) => (a.last < b.last ? 1 : a.last > b.last ? -1 : 0));
        if (!list.length) out.append(h('div', { class: 'empty' }, 'まだ用語がありません。'));
        else put(out, section('ニュースに出てきた用語', list.slice(0, view.shown).map((e) => termRow(e, tokens)), list.length), more(list.length));
      }
      return;
    }

    const hits = { t: [], n: [], w: [] };
    for (const e of store.searchIndex()) {
      if (f !== 'all' && e.type !== f) continue;
      if (e.type === 't' && view.genre && e.it.data.genre !== view.genre) continue;
      let score = 0;
      let ok = true;
      for (const k of tokens) {
        if (e.head.indexOf(k) >= 0) score += 3;
        else if (e.rest.indexOf(k) >= 0) score += 1;
        else { ok = false; break; }
      }
      if (ok) hits[e.type].push({ e, score, date: e.it ? e.it.date : e.term.last });
    }
    const total = hits.t.length + hits.n.length + hits.w.length;
    if (!total) { out.append(h('div', { class: 'empty' }, '「' + view.q + '」は見つかりませんでした。', h('br'), '言い方を変えるか、短い言葉でためしてみてください。')); return; }
    const sortHits = (a) => a.sort((x, y) => y.score - x.score || (x.date < y.date ? 1 : x.date > y.date ? -1 : 0));
    const cap = f === 'all' ? Math.min(view.shown, 12) : view.shown;
    const itemSub = (x) => {
      const d = x.e.it.data;
      const base = store.briefOf(x.e.it);
      return tokens.some((k) => norm(d.title + ' ' + base).indexOf(k) >= 0) ? base : snippet(x.e.raw, tokens) || base;
    };
    const add = (key, title, build) => {
      const a = sortHits(hits[key]);
      if (!a.length) return;
      put(out, section(title, a.slice(0, cap).map(build), a.length));
      if (a.length > cap) {
        out.append(f === 'all'
          ? h('button', { class: 'bigbtn sub', type: 'button', onclick: () => { view.filter = key; view.shown = 40; paintFilters(); paint(); } }, title + 'をぜんぶ見る（' + a.length + '件）')
          : more(a.length));
      }
    };
    add('t', '雑学', (x) => itemRow(x.e.it, tokens, itemSub(x)));
    add('n', 'ニュース', (x) => itemRow(x.e.it, tokens, itemSub(x)));
    add('w', '用語', (x) => termRow(x.e.term, tokens));
  }

  // 何も入れていないとき: 保存した記事・ジャンル・最近読んだもの
  function home(box) {
    const saved = store.savedItems();
    if (saved.length) {
      put(box, section('保存した記事', saved.slice(0, 4).map((it) => itemRow(it, [])), saved.length));
      if (saved.length > 4) box.append(h('button', { class: 'bigbtn sub', type: 'button', onclick: () => { view.filter = 'saved'; paintFilters(); paint(); } }, '保存した記事をぜんぶ見る'));
    }
    const counts = {};
    for (const it of store.allItems('trivia')) counts[it.data.genre] = (counts[it.data.genre] || 0) + 1;
    const grid = h('div', { class: 'gg' });
    for (const g in GENRES) {
      grid.append(h('button', { type: 'button', style: { '--c': GENRES[g].color }, onclick: () => { view.filter = 't'; view.genre = g; view.shown = 40; paintFilters(); paint(); } },
        glyph(g), h('b', null, GENRES[g].label), h('small', null, (counts[g] || 0) + '本')));
    }
    box.append(h('div', { class: 'sr-h' }, h('span', null, '雑学をジャンルからさがす')), grid);
    const recent = store.recentRead(5);
    if (recent.length) put(box, section('最近読んだ', recent.map((it) => itemRow(it, []))));
  }

  const run = debounce(() => { view.shown = 40; paint(); }, 140);
  input.addEventListener('input', () => { view.q = input.value; run(); });
  clr.addEventListener('click', () => { input.value = ''; view.q = ''; paint(); input.focus(); });
  root.addEventListener('scroll', () => { view.scroll = root.scrollTop; }, { passive: true });

  paintFilters();
  paint();
  // 記事から戻ってきたときは、見ていた位置へ戻す
  const restore = view.scroll;
  requestAnimationFrame(() => { if (restore) root.scrollTop = restore; });
  return root;
}
