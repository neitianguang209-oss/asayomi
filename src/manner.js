// マナー帳と学問ノート: 毎朝届くマナー・学問の回を、場面・分野ごとに集めて読み返せるようにする(どちらも同じ作りの「帳面」)
import { h, clear, mdDate, todayJST } from './util.js';
import * as store from './store.js';
import { glyph } from './art.js';
import { go } from './nav.js';
import { listenCard } from './listen.js';
import { claudeButton } from './talk.js';

// 大ジャンル(配信の mannerCat = カリキュラムの genre)。11/4 までの記事は古い分け方なので、言葉から推し量る
export const MANNER_CATS = [
  ['食事・テーブルマナー', /食事|テーブル|箸|和食|洋食|中華|寿司|天ぷら|そば|フランス|イタリア|アフタヌーン|立食|会食|ナプキン/],
  ['お酒・飲み物', /お酒|乾杯|酒席|飲み会|お酌|ワイン|シャンパン|ビール|バー|カクテル|日本酒|お茶|コーヒー|紅茶/],
  ['ビジネス', /ビジネス|名刺|上座|下座|席次|面接|会議|職場|上司|商談|メール|電話|敬語|承知|了解|就活/],
  ['言葉づかい・会話', /言葉づかい|言い回し|クッション言葉|あいさつ|挨拶|断り方|謝り|手紙|はがき|時候/],
  ['結婚式・お祝い', /結婚|披露宴|ご祝儀|祝儀|お祝い|祝い|内祝/],
  ['お葬式・弔事', /葬|通夜|香典|焼香|法事|法要|喪|弔|訃報|お悔やみ/],
  ['訪問・おもてなし', /訪問|お宅|手土産|和室|畳|座布団|床の間|おもてなし|お迎え/],
  ['社交・フォーマルな場', /パーティー|社交|フォーマル|劇場|コンサート|美術館|式典|茶会|ドレスコード/],
  ['服装・身だしなみ', /服装|身だしなみ|スーツ|ネクタイ|着物|浴衣|靴|香水/],
  ['日本の礼法・しきたり', /お辞儀|礼法|神社|お寺|参拝|のし|熨斗|水引|中元|歳暮|お年玉|しきたり/],
  ['旅行・公共の場', /旅行|旅館|温泉|ホテル|新幹線|飛行機|電車|タクシー|公共|病院|お見舞い/],
  ['国際マナー', /海外|外国|国際|チップ|欧米|握手|ハグ|ハラール/],
];
export function mannerCat(it) {
  const d = it.data;
  if (d.mannerCat && MANNER_CATS.some((c) => c[0] === d.mannerCat)) return d.mannerCat;
  const s = (d.topic || '') + ' ' + (d.genreLabel || '') + ' ' + (d.title || '');
  for (const [name, re] of MANNER_CATS) if (re.test(s)) return name;
  return 'そのほか';
}
// 11/3 までは雑学の2本目に入れていた(genre: manner)。11/4 からはマナーとして別に届く(kind: manner)
export const mannerItems = () => store.allItems('manner').concat(store.allItems('trivia').filter((it) => it.data.genre === 'manner'));

// 学問の分け方(配信の area。無ければ分野名から推し量る)
export const STUDY_AREAS = [
  ['人文', /哲学|倫理|宗教|神学|歴史|考古|言語|文学|民俗|美学|美術|思想|神話/],
  ['社会', /経済|経営|政治|法学|法律|社会学|地政学|国際関係|心理|教育|人類学|都市|マーケティング|行動/],
  ['自然', /天文|宇宙|物理|化学|生物|進化|生態|遺伝|地質|地球|気象|海洋|植物|動物/],
  ['数理・情報', /数学|統計|確率|論理|ゲーム理論|情報|計算|暗号|AI/],
  ['医学・からだ', /医学|医療|公衆衛生|脳|神経|栄養|睡眠|からだ|免疫|薬/],
  ['芸術・建築', /音楽|建築|デザイン|映画|写真|色彩/],
];
export function studyArea(it) {
  const d = it.data;
  if (d.area && STUDY_AREAS.some((c) => c[0] === d.area)) return d.area;
  const s = (d.field || '') + ' ' + (d.genreLabel || '') + ' ' + (d.title || '');
  for (const [name, re] of STUDY_AREAS) if (re.test(s)) return name;
  return 'そのほか';
}
// 分野名(「学問・宗教学」→「宗教学」)
export const studyField = (it) => it.data.field || String(it.data.genreLabel || '').replace(/^学問・?/, '') || '学問';
// 11/4 までは雑学の1本目に入れていた(genre: study)。11/5 からは学問として別に届く(kind: study)
export const studyItems = () => store.allItems('study').concat(store.allItems('trivia').filter((it) => it.data.genre === 'study'));

const SHELF = {
  manner: { title: 'マナー帳', name: 'マナー', lead: '礼儀・作法・言葉づかいを、場面ごとにためていきます。毎朝ニュース・雑学と一緒に届きます。',
    items: mannerItems, cat: mannerCat, cats: [...MANNER_CATS.map((c) => c[0]), 'そのほか'], tag: (it) => mannerCat(it), aria: '場面' },
  study: { title: '学問ノート', name: '学問', lead: '前提知識がなくても読める、いろいろな学問の入口です。分野ごとにたまっていきます。',
    items: studyItems, cat: studyArea, cats: [...STUDY_AREAS.map((c) => c[0]), 'そのほか'], tag: (it) => studyField(it), aria: '分野' },
};
const views = { manner: { cat: 'all', shown: 30 }, study: { cat: 'all', shown: 30 } };
function row(it, conf) {
  return h('button', { class: 'rowb' + (store.isRead(it) ? ' read' : ''), type: 'button', onclick: () => go('#/' + it.kind + '/' + it.date + '/' + it.n) },
    h('span', { class: 'mg' }, glyph(it.kind === 'manner' || it.data.genre === 'manner' ? 'manner' : 'study')),
    h('span', { class: 'rt' },
      h('em', null, conf.tag(it) + '・' + mdDate(it.date)),
      h('b', null, it.data.title),
      h('small', null, store.briefOf(it))));
}
export const renderManner = (root) => renderShelf(root, 'manner');
export const renderStudy = (root) => renderShelf(root, 'study');
function renderShelf(root, kind) {
  const conf = SHELF[kind];
  const view = views[kind];
  clear(root);
  root.className = 'tv mn';
  const wrap = h('div', { class: 'wrap' });
  root.append(wrap);
  const all = conf.items();
  wrap.append(h('header', { class: 'top' }, h('h1', null, conf.title)));
  wrap.append(h('p', { class: 'greet' }, h('span', null, conf.lead)));
  if (!all.length) {
    wrap.append(h('div', { class: 'boot' }, h('b', null, 'まだ1本もありません'), '次の朝の配信から、毎日たまっていきます。'));
    return;
  }
  // 今日の分(いちばん新しい日)と、聞くボタン
  const last = store.latest(kind);
  if (last) {
    wrap.append(h('div', { class: 'lgrp tvl' }, listenCard(kind, last),
      h('div', { class: 'lalt' }, claudeButton(kind, last), h('small', null, 'Claudeアプリの音声モードで、話しながら聞く'))));
    const today = h('div', { class: 'mlist' }, h('div', { class: 'mh' }, (last === todayJST() ? '今日の' : mdDate(last) + 'の') + conf.name));
    for (const it of store.itemsOf(kind, last)) today.append(row(it, conf));
    wrap.append(today);
  }
  if (kind === 'manner') wrap.append(curriculumBox());
  const unread = all.filter((it) => !store.isRead(it)).length;
  const counts = new Map();
  for (const it of all) counts.set(conf.cat(it), (counts.get(conf.cat(it)) || 0) + 1);

  const tabs = h('nav', { class: 'tabs', 'aria-label': conf.aria });
  const feed = h('div', { class: 'feed' });
  const keys = [['all', 'すべて ' + all.length], ...(unread ? [['unread', 'まだ読んでいない ' + unread]] : []),
    ...conf.cats.filter((c) => counts.has(c)).map((c) => [c, c + ' ' + counts.get(c)])];
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
    const list = all.filter((it) => view.cat === 'all' || (view.cat === 'unread' ? !store.isRead(it) : conf.cat(it) === view.cat));
    const box = h('div', { class: 'mlist' });
    for (const it of list.slice(0, view.shown)) box.append(row(it, conf));
    feed.append(box);
    if (list.length > view.shown) {
      feed.append(h('button', { class: 'morebtn', type: 'button', onclick: () => { view.shown += 30; fill(); } }, 'もっと見る(あと' + (list.length - view.shown) + '本)'));
    }
  }
  fill();
}

/* ---------- カリキュラム(全テーマと進み具合) ---------- */
// 毎朝の配信は、まだやっていないテーマを大ジャンルを回しながら順に取り上げる。ここでは全体のどこまで進んだかを見せる
const CUR_KEY = 'asayomi:curriculum:manner';
let curCache = null;
try { curCache = JSON.parse(localStorage.getItem(CUR_KEY) || 'null'); } catch (e) { /* 無くてよい */ }
const curOpen = new Set();
function curriculumBox() {
  const box = h('div', { class: 'cur' });
  const paint = (rows) => {
    clear(box);
    if (!rows || !rows.length) { box.append(h('div', { class: 'tl' }, 'カリキュラム'), h('p', { class: 'sd' }, '読み込んでいます…')); return; }
    const done = rows.filter((r) => r.on).length;
    // 一巡したら何周も回る(おさらい＋新しい応用テーマ)。いちばん少ない回数＋1 が今の周回
    const round = Math.min(...rows.map((r) => r.times || 0)) + 1;
    box.append(h('div', { class: 'tl' }, 'カリキュラム', h('small', null, (round > 1 ? round + '周目・' : '') + '全' + rows.length + 'テーマ中 ' + done + ' 済み')));
    const genres = [];
    for (const r of rows) {
      let g = genres.find((x) => x.name === r.genre);
      if (!g) genres.push(g = { name: r.genre, subs: [] });
      let s = g.subs.find((x) => x.name === r.sub);
      if (!s) g.subs.push(s = { name: r.sub, rows: [] });
      s.rows.push(r);
    }
    for (const g of genres) {
      const list = g.subs.flatMap((s) => s.rows);
      const n = list.filter((r) => r.on).length;
      const head = h('button', { class: 'cg' + (curOpen.has(g.name) ? ' open' : ''), type: 'button' },
        h('b', null, g.name), h('span', { class: 'bar' }, h('i', { style: { width: Math.round(n / list.length * 100) + '%' } })), h('small', null, n + '/' + list.length));
      const body = h('div', { class: 'cgb', hidden: !curOpen.has(g.name) });
      for (const s of g.subs) {
        body.append(h('div', { class: 'cs' }, s.name));
        for (const r of s.rows) {
          const tag = (r.times > 1 ? ' ×' + r.times : '') + (r.level === '応用' ? '' : '');
          const lv = r.level === '応用' ? h('i', { class: 'lv' }, '応用') : null;
          body.append(r.on && r.n
            ? h('button', { class: 'ct on', type: 'button', onclick: () => go('#/manner/' + r.on + '/' + r.n) }, '✓ ' + r.topic + tag, lv)
            : h('div', { class: 'ct' }, r.topic, lv));
        }
      }
      head.addEventListener('click', () => {
        if (curOpen.has(g.name)) curOpen.delete(g.name); else curOpen.add(g.name);
        head.classList.toggle('open'); body.hidden = !body.hidden;
      });
      box.append(head, body);
    }
  };
  paint(curCache);
  store.rpc('asayomi_curriculum_view', { p_kind: 'manner' }).then((rows) => {
    if (!Array.isArray(rows)) return;
    curCache = rows;
    try { localStorage.setItem(CUR_KEY, JSON.stringify(rows)); } catch (e) { /* 覚えられなくても動く */ }
    if (box.isConnected) paint(rows);
  }).catch(() => { if (!curCache) { clear(box); box.append(h('div', { class: 'tl' }, 'カリキュラム'), h('p', { class: 'sd' }, '通信できるときに、全体の進み具合が出ます')); } });
  return box;
}
