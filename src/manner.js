// マナー帳: 毎朝の雑学のうち「マナー・作法」の回(genre: manner)を、場面ごとに集めて読み返せるようにする
import { h, clear, mdDate } from './util.js';
import * as store from './store.js';
import { glyph } from './art.js';
import { go } from './nav.js';

// 場面の分け方(配信の mannerCat。無ければ genreLabel の中の言葉で推し量る)
export const MANNER_CATS = [
  ['ビジネス', /ビジネス|名刺|上座|下座|席次|面接|会議|職場|上司|商談|訪問先/],
  ['食事・お酒', /食事|テーブル|箸|和食|洋食|中華|お酒|乾杯|酒席|飲み会|お酌|会食/],
  ['冠婚葬祭', /結婚|披露宴|ご祝儀|祝儀|葬|通夜|香典|焼香|法事|法要|喪|弔/],
  ['言葉づかい', /敬語|言葉|言い回し|クッション言葉|あいさつ|挨拶/],
  ['贈り物・季節の行事', /贈|のし|熨斗|水引|中元|歳暮|お見舞い|手土産|お返し|年賀|節句/],
  ['手紙・電話・メール', /手紙|電話|メール|はがき|封筒|返信/],
  ['訪問・おつきあい', /訪問|招待|お宅|近所|おもてなし/],
  ['海外', /海外|外国|国の|欧米|チップ/],
];
export function mannerCat(it) {
  const d = it.data;
  if (d.mannerCat && MANNER_CATS.some((c) => c[0] === d.mannerCat)) return d.mannerCat;
  const s = (d.genreLabel || '') + ' ' + (d.title || '');
  for (const [name, re] of MANNER_CATS) if (re.test(s)) return name;
  return 'そのほか';
}
export const mannerItems = () => store.allItems('trivia').filter((it) => it.data.genre === 'manner');

const view = { cat: 'all', shown: 30 };
export function renderManner(root) {
  clear(root);
  root.className = 'tv mn';
  const wrap = h('div', { class: 'wrap' });
  root.append(wrap);
  const all = mannerItems();
  wrap.append(h('header', { class: 'top' }, h('h1', null, 'マナー帳')));
  wrap.append(h('p', { class: 'greet' }, h('span', null, '礼儀・作法・言葉づかいを、場面ごとにためていきます。毎朝の雑学の2本目が、この帳面に入ります。')));
  if (!all.length) {
    wrap.append(h('div', { class: 'boot' }, h('b', null, 'まだ1本もありません'), '次の朝の配信から、毎日1本ずつたまります。'));
    return;
  }
  const unread = all.filter((it) => !store.isRead(it)).length;
  const counts = new Map();
  for (const it of all) counts.set(mannerCat(it), (counts.get(mannerCat(it)) || 0) + 1);

  const tabs = h('nav', { class: 'tabs', 'aria-label': '場面' });
  const feed = h('div', { class: 'feed' });
  const keys = [['all', 'すべて ' + all.length], ...(unread ? [['unread', 'まだ読んでいない ' + unread]] : []),
    ...[...MANNER_CATS.map((c) => c[0]), 'そのほか'].filter((c) => counts.has(c)).map((c) => [c, c + ' ' + counts.get(c)])];
  if (!keys.some((k) => k[0] === view.cat)) view.cat = 'all';
  for (const [k, label] of keys) {
    const b = h('button', { class: 'tab', type: 'button', 'data-k': k }, label);
    b.addEventListener('click', () => { view.cat = k; view.shown = 30; fill(); });
    tabs.append(b);
  }
  wrap.append(tabs, feed);

  function fill() {
    for (const b of tabs.children) b.setAttribute('aria-pressed', String(b.getAttribute('data-k') === view.cat));
    clear(feed);
    const list = all.filter((it) => view.cat === 'all' || (view.cat === 'unread' ? !store.isRead(it) : mannerCat(it) === view.cat));
    const box = h('div', { class: 'mlist' });
    for (const it of list.slice(0, view.shown)) {
      const d = it.data;
      box.append(h('button', { class: 'rowb' + (store.isRead(it) ? ' read' : ''), type: 'button', onclick: () => go('#/trivia/' + it.date + '/' + it.n) },
        h('span', { class: 'mg' }, glyph('manner')),
        h('span', { class: 'rt' },
          h('em', null, mannerCat(it) + '・' + mdDate(it.date)),
          h('b', null, d.title),
          h('small', null, store.briefOf(it)))));
    }
    feed.append(box);
    if (list.length > view.shown) {
      feed.append(h('button', { class: 'morebtn', type: 'button', onclick: () => { view.shown += 30; fill(); } }, 'もっと見る(あと' + (list.length - view.shown) + '本)'));
    }
  }
  fill();
}
