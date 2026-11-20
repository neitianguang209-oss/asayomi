// 画面の共通部品: 重ねる画面(記事・復習など)、下から出るシート、トースト、お知らせ、日付送り
import { h, jDate, mdDate, todayJST } from './util.js';
import { icon } from './art.js';
import * as store from './store.js';
import { go, replace } from './nav.js';

/* ---------- 重ねる画面 ---------- */
let layer = null;
let savedScroll = 0;
export function showLayer(el, anim) {
  const first = !layer;
  if (first) savedScroll = window.scrollY;
  if (layer) layer.remove();
  closeSheet();
  el.classList.add('layer');
  if (first && anim) el.classList.add(anim);
  document.getElementById('layers').append(el);
  layer = el;
  document.body.classList.add('locked');
  el.scrollTop = 0;
  return el;
}
export function closeLayer() {
  closeSheet();
  if (!layer) return false;
  layer.remove();
  layer = null;
  document.body.classList.remove('locked');
  window.scrollTo(0, savedScroll);
  return true;
}
export function hasLayer() { return !!layer; }
export function currentLayer() { return layer; }

/* ---------- 下から出るシート ---------- */
let sheetWrap = null;
let sheetOnClose = null;
export function openSheet(build, onClose) {
  closeSheet();
  const sheet = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true' }, h('div', { class: 'grab' }));
  const wrap = h('div', { class: 'sheet-wrap', onclick: (e) => { if (e.target === wrap) closeSheet(); } }, sheet);
  build(sheet, closeSheet);
  document.body.append(wrap);
  sheetWrap = wrap;
  sheetOnClose = onClose || null;
  return sheet;
}
export function closeSheet() {
  if (sheetWrap) { sheetWrap.remove(); sheetWrap = null; }
  if (sheetOnClose) { const fn = sheetOnClose; sheetOnClose = null; fn(); } // 閉じたあとの片づけ(本文につけた印を消す、など)
}

/* ---------- トースト ---------- */
let toastTimer = 0;
export function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
}

export function xButton(onclick, label) {
  return h('button', { class: 'xbtn', type: 'button', 'aria-label': label || '閉じる', onclick }, icon('x', 18));
}

/* ---------- 一覧の上に出すお知らせ ---------- */
// 今日の分がまだ届いていない／過去の日を見ている
export function dayNotice(kind, date) {
  const latest = store.latest(kind);
  const today = todayJST();
  if (date !== latest) {
    return h('div', { class: 'notice' },
      h('span', null, jDate(date) + 'の分を表示しています。'),
      h('button', { type: 'button', onclick: () => replace('#/' + kind) }, '最新へ'));
  }
  if (date < today) {
    const btn = h('button', { type: 'button' }, '確かめる');
    btn.addEventListener('click', async () => {
      btn.disabled = true; btn.textContent = '確認中…';
      const changed = await store.pull();
      if (!changed) { toast(store.S.status === 'idle' ? 'まだ届いていません' : '通信できませんでした'); btn.disabled = false; btn.textContent = '確かめる'; }
    });
    // 朝7時すぎまでは「まだ来ない」のがふつうなので、そう書く
    const jst = new Date(Date.now() + 9 * 3600 * 1000);
    const early = jst.getUTCHours() * 60 + jst.getUTCMinutes() < 7 * 60 + 20;
    const text = early
      ? '今日（' + mdDate(today) + '）の分は朝7時ごろに届きます。それまで ' + mdDate(date) + ' の分を出しています。'
      : '今日（' + mdDate(today) + '）の分はまだ届いていません。届くまで ' + mdDate(date) + ' の分を出しています。';
    return h('div', { class: 'notice' }, h('span', null, text), btn);
  }
  return null;
}
// 復習がたまっているとき
export function reviewNudge() {
  const n = store.dueCards().length;
  if (!n) return null;
  return h('button', { class: 'nudge', type: 'button', onclick: () => go('#/review') },
    h('span', { class: 'ni' }, icon('cards', 22)),
    h('span', null, h('b', null, '復習が ' + n + ' 問たまっています'), h('small', null, '前に読んだ雑学と用語を、忘れかけた頃にもう一度。')),
    h('span', { class: 'go' }, 'はじめる'));
}
// 前の日・次の日
export function dayNav(kind, date) {
  const ds = store.dates(kind); // 新しい順
  const i = ds.indexOf(date);
  const older = i >= 0 ? ds[i + 1] : null;
  const newer = i > 0 ? ds[i - 1] : null;
  const b = (label, d) => {
    const btn = h('button', { type: 'button', disabled: !d }, label);
    if (d) btn.addEventListener('click', () => { replace('#/' + kind + '/' + d); window.scrollTo(0, 0); });
    return btn;
  };
  return h('div', { class: 'daynav' },
    b(older ? '‹ ' + mdDate(older) + ' の分' : '‹ 前の日', older),
    b(newer ? mdDate(newer) + ' の分 ›' : '次の日 ›', newer));
}
export function readMark() {
  return h('span', { class: 'readmark' }, icon('check', 13), '読んだ');
}

/* ---------- 読み終わりに次の種類へ(ニュース → 雑学 → マナー → 学問 → ニュース) ---------- */
const NEXT = { news: 'trivia', trivia: 'manner', manner: 'study', study: 'news' };
const KNAME = { news: 'ニュース', trivia: '雑学', manner: 'マナー', study: '学問' };
export function crossButton(it) {
  const items = store.itemsOf(it.kind, it.date);
  if (items.indexOf(it) !== items.length - 1) return null;
  for (let k = NEXT[it.kind]; k !== it.kind; k = NEXT[k]) {
    // 同じ日の分。無ければその種類の最新の日
    const day = store.itemsOf(k, it.date).length ? it.date : store.latest(k);
    const list = day ? store.itemsOf(k, day) : [];
    if (!list.length) continue;
    const back = k === 'news';
    return h('button', { class: 'cross', type: 'button', onclick: () => replace('#/' + k + '/' + list[0].date + '/' + list[0].n) },
      h('small', null, back ? '今日の分はここまで。ニュースにもどる' : KNAME[it.kind] + 'はここまで。続けて' + KNAME[k] + 'へ'), h('b', null, list[0].data.title));
  }
  return null;
}

/* ---------- 日付の帯(見逃した日・まだ読んでいない日がひと目でわかる) ---------- */
const KIND_NAME = { news: 'ニュース', trivia: '雑学', manner: 'マナー', study: '学問' };
const toDay = (kind, d) => { replace('#/' + kind + (d === store.latest(kind) ? '' : '/' + d)); window.scrollTo(0, 0); };
// 読んでいない記事がある日(新しい順)。取り込んだ昔の雑学(legacy)は数えない
function unreadDays(kind) {
  const out = [];
  for (const d of store.dates(kind)) {
    const left = store.itemsOf(kind, d).filter((it) => !store.isRead(it) && !(it.data && it.data.legacy));
    if (left.length) out.push({ date: d, left });
  }
  return out;
}
export function dayStrip(kind, curDate) {
  const ds = store.dates(kind).slice(0, 21);
  const wrap = h('div', { class: 'dstrip' });
  const unread = unreadDays(kind);
  const total = unread.reduce((n, x) => n + x.left.length, 0);
  const row = h('div', { class: 'dsr' });
  for (const d of ds) {
    const items = store.itemsOf(kind, d);
    const left = items.filter((it) => !store.isRead(it) && !(it.data && it.data.legacy)).length;
    const p = d.slice(5).replace('-', '/').replace(/^0/, '').replace('/0', '/');
    const b = h('button', { type: 'button', class: 'dc' + (d === curDate ? ' cur' : '') + (left ? ' new' : ' done'), 'aria-label': jDate(d) + (left ? '(未読' + left + '本)' : '(ぜんぶ読んだ)') },
      h('b', null, p), h('small', null, left ? '未読' + left : '✓'));
    b.addEventListener('click', () => toDay(kind, d));
    row.append(b);
  }
  wrap.append(row);
  if (total) {
    wrap.append(h('button', { class: 'dun', type: 'button', onclick: () => openUnread(kind) },
      '📭 まだ読んでいない ' + total + '本(' + unread.length + '日分)を見る ›'));
  } else {
    wrap.append(h('p', { class: 'dun ok' }, '✓ ' + KIND_NAME[kind] + 'は、見逃しなし'));
  }
  // いま帯の中で見えている日が右端に隠れないように
  setTimeout(() => { const c = row.querySelector('.cur'); if (c) row.scrollLeft = Math.max(0, c.offsetLeft - 60); }, 0);
  return wrap;
}
export function openUnread(kind) {
  openSheet((sheet, close) => {
    const days = unreadDays(kind);
    sheet.append(h('h3', null, 'まだ読んでいない' + KIND_NAME[kind]),
      h('p', { class: 'sd' }, '開くと「読んだ」になって、ここから消えます。聞いた記事(7割まで)も読んだ扱いです。'));
    if (!days.length) sheet.append(h('p', { class: 'sd' }, '見逃しはありません。'));
    for (const { date, left } of days.slice(0, 40)) {
      const box = h('div', { class: 'ud' },
        h('button', { class: 'udh', type: 'button', onclick: () => { close(); toDay(kind, date); } }, h('b', null, jDate(date)), h('small', null, '未読' + left.length + '本　この日をひらく ›')));
      for (const it of left) {
        box.append(h('button', { class: 'udr', type: 'button', onclick: () => { close(); go('#/' + kind + '/' + it.date + '/' + it.n); } }, it.data.title));
      }
      sheet.append(box);
    }
  });
}
