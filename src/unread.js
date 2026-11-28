// 未読リスト: まだ読んでも聞いてもいない記事だけを、日付ごとに並べる。ここから続けて聞ける。
//  - 声を置いてあるのは直近8日分。それより前の未読は下にたたんで出す(読むのは自由。聞くと、その場で声を作る)。
//  - 一度に流すのは30本まで(端末で1本の音声につなぐので、長くしすぎない)。聞き終えて押し直すと、続きが流れる。
import { h, clear, jDate, todayJST, stripMarkup } from './util.js';
import * as store from './store.js';
import { icon } from './art.js';
import { go, back } from './nav.js';
import { xButton } from './ui.js';
import { play, onListen, listenMark, currentKey } from './listen.js';

const ORDER = ['news', 'trivia', 'manner', 'study'];
const NAME = { news: 'ニュース', trivia: '雑学', manner: 'マナー', study: '学問' };
const MAX = 30;
const view = { kind: 'all', old: false };

const keyOf = (it) => it.kind + ':' + it.date + ':' + it.n;
const entry = (it) => ({ key: keyOf(it), kind: it.kind, date: it.date, n: it.n });
// 新しい日から。同じ日はニュース → 雑学 → マナー → 学問
const inOrder = (a, b) => (a.date !== b.date ? (a.date < b.date ? 1 : -1) : ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) || a.n - b.n);

export function unreadPage() {
  const body = h('div', { class: 'ul' });
  const page = h('div', { class: 'page' }, h('div', { class: 'wrap' },
    h('div', { class: 'pbar' }, h('h1', null, '未読リスト'), xButton(() => back('#/news'))), body));
  let drawn = '';

  const row = (it, list) => h('div', { class: 'ur k-' + it.kind + (currentKey() === keyOf(it) ? ' now' : '') },
    h('button', { class: 'ur-t', type: 'button', onclick: () => go('#/' + it.kind + '/' + it.date + '/' + it.n) },
      h('em', null, NAME[it.kind] + ' ' + it.n + '本目', listenMark(it)),
      h('b', null, stripMarkup(it.data.title || ''))),
    h('button', { class: 'ur-p', type: 'button', 'aria-label': 'この記事から聞く', onclick: () => {
      const i = list.indexOf(it);
      play(list.slice(i, i + MAX).map(entry), keyOf(it), 0);
    } }, icon('play', 18)));

  const days = (box, items, list) => {
    let date = '';
    for (const it of items) {
      if (it.date !== date) {
        date = it.date;
        const n = items.filter((x) => x.date === date).length;
        box.append(h('div', { class: 'ul-d' }, h('b', null, (date === todayJST() ? '今日 ' : '') + jDate(date)), h('small', null, n + '本')));
      }
      box.append(row(it, list));
    }
  };

  const fill = () => {
    const from = store.recentFrom();
    const all = ORDER.flatMap((k) => store.allItems(k).filter(store.isUnread)).sort(inOrder);
    const pick = all.filter((it) => view.kind === 'all' || it.kind === view.kind);
    const recent = pick.filter((it) => it.date >= from);
    const old = pick.filter((it) => it.date < from);
    // 中身が変わらないときは描き直さない(声の用意のたびに画面がちらつかないように)
    const now = [view.kind, view.old, currentKey(), pick.map(keyOf).join()].join('|');
    if (now === drawn) return;
    drawn = now;
    clear(body);

    const tabs = h('div', { class: 'ul-tabs' });
    for (const k of ['all', ...ORDER]) {
      const n = all.filter((it) => it.date >= from && (k === 'all' || it.kind === k)).length;
      const b = h('button', { type: 'button', 'aria-pressed': String(view.kind === k) }, (k === 'all' ? 'すべて' : NAME[k]) + ' ' + n);
      b.addEventListener('click', () => { view.kind = k; view.old = false; fill(); });
      tabs.append(b);
    }
    body.append(tabs);

    if (recent.length) {
      const count = Math.min(recent.length, MAX);
      body.append(h('button', { class: 'ul-go', type: 'button', onclick: () => play(recent.slice(0, MAX).map(entry), keyOf(recent[0]), 0) },
        icon('play', 20), h('span', null, h('b', null, '未読' + count + '本を続けて聞く'),
          h('small', null, recent.length > MAX ? '全' + recent.length + '本のうち新しい' + MAX + '本。聞き終えたらもう一度押すと続き' : '聞き終えた記事は、このリストから消えます'))));
      days(body, recent, recent);
    } else {
      body.append(h('div', { class: 'empty' }, 'ここ1週間の未読はありません。'));
    }

    if (old.length) {
      const t = h('button', { class: 'morebtn', type: 'button', 'aria-expanded': String(view.old) },
        (view.old ? '▲ ' : '▼ ') + '1週間より前の未読 ' + old.length + '本');
      t.addEventListener('click', () => { view.old = !view.old; fill(); });
      body.append(t);
      if (view.old) {
        body.append(h('p', { class: 'sd sm' }, '前の分は声を置いていないので、▶を押すとその場で作ります(1日に作れる本数に限りがあります)。'));
        // 声を作る回数に限りがあるので、前の分は1本ずつ
        const box = h('div');
        let date = '';
        for (const it of old.slice(0, 120)) {
          if (it.date !== date) { date = it.date; box.append(h('div', { class: 'ul-d' }, h('b', null, jDate(date)))); }
          box.append(row(it, [it]));
        }
        body.append(box);
      }
    }
  };

  fill();
  const off = onListen(() => { if (!page.isConnected) { off(); return; } fill(); });
  return page;
}
